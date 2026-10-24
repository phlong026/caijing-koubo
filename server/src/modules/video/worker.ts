import { config } from '../../config.js'
import { logger } from '../../log.js'
import { getDb } from '../../db/index.js'
import { toDb, utcNow, fromDb } from '../../lib/time.js'
import { dedupOpts, enqueue, QUEUE_NAMES, registerWorker, scheduleRepeatable } from '../../queue/index.js'
import { createVideoEngine } from './engine.js'
import { appendJobEvent, casTransition, getVideoJob } from './repo.js'
import { markJobFailed } from './repo.js'
import { runSubmitStage, markPollTimeout } from './submit.js'
import { runArchiveStage, runAlignStage } from './archive.js'
import { nextPollBackoffMs } from './progress.js'
import type { VideoJob } from './repo.js'

/**
 * 视频任务编排装配（V4，🔁 Z6/Z7/Z8）：
 *
 * video-generate worker（并发 = VIDEO_WORKER_CONCURRENCY）：本地阶段
 *   submit（preparing→submitting→飞影）/ archive（下载/规范化/上传）/ align（时间轴对齐）。
 * video-poll-sweep（每 VIDEO_POLL_INTERVAL_MS）：① waiting FIFO 推进（飞影并发闸）
 *   ② generating/recovering 到期轮询（异常退避、2 小时转人工）。
 * reconcileOnBoot（FR-P6 / Z8）：进程重启按阶段续跑，绝不重复付费提交。
 */

export function registerVideoWorker(): void {
  registerWorker(
    QUEUE_NAMES.videoGenerate,
    async (job) => {
      const { jobId } = (job.data ?? {}) as { jobId?: string }
      if (!jobId) return
      if (job.name === 'submit') await runSubmitStage(jobId)
      else if (job.name === 'archive') await runArchiveStage(jobId)
      else if (job.name === 'align') await runAlignStage(jobId)
      else if (job.name === 'tts') await (await import('./mixcut/service.js')).runTtsStage(jobId)
      else if (job.name === 'compose') await (await import('./mixcut/service.js')).runComposeStage(jobId)
    },
    { concurrency: config.video.workerConcurrency },
  )
}

export async function scheduleVideoPollSweep(): Promise<void> {
  // 周期 job 投到独立队列，必须有消费者：缺了它 waiting 永不推进、生成中永不轮询（smoke 手动调 runVideoSweep 掩盖过）
  registerWorker(QUEUE_NAMES.videoPollSweep, async () => {
    await runVideoSweep().catch((e) => logger.error({ err: (e as Error).message }, 'video.sweep_failed'))
  })
  await scheduleRepeatable(QUEUE_NAMES.videoPollSweep, 'video-poll-sweep', config.video.pollIntervalMs, 'sweep')
  await runVideoSweep().catch((e) => logger.warn({ err: (e as Error).message }, 'video.sweep.boot_failed'))
}

/** sweep 主体：① waiting 推进 ② 生成中轮询（也注册为 sweep job 的处理器） */
export async function runVideoSweep(): Promise<void> {
  await promoteWaitingJobs()
  await pollDueJobs()
}

/**
 * waiting FIFO 推进（§3.1 并发闸）：
 * 全局 submitting/generating/recovering 数 < VIDEO_GEN_CONCURRENCY 时，按 queued_at
 * 逐个把 waiting → preparing 并入队 submit；同 copy 有其他非终态任务时跳过（FR-A6）。
 */
async function promoteWaitingJobs(): Promise<void> {
  const db = getDb()
  const now = toDb(utcNow())
  const activeRow = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM `video_job` WHERE `archived_at` IS NULL AND `phase` IN ('submitting', 'generating', 'recovering')",
  )
  let slots = config.video.genConcurrency - Number(activeRow?.n ?? 0)
  if (slots <= 0) return
  const waiting = await db.all<{ id: string; copy_id: string; queued_at: string | null }>(
    "SELECT `id`, `copy_id`, `queued_at` FROM `video_job` WHERE `archived_at` IS NULL AND `phase` = 'waiting' ORDER BY `queued_at` ASC LIMIT 20",
  )
  for (const w of waiting) {
    if (slots <= 0) break
    // 同 copy 只允许一个非终态任务：跳过仍有占用者的 copy
    const busy = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM `video_job` WHERE `copy_id` = ? AND `id` != ? AND `archived_at` IS NULL AND `phase` NOT IN ('completed', 'failed', 'cancelled')",
      [w.copy_id, w.id],
    )
    if (Number(busy?.n ?? 0) > 0) continue
    const moved = await casTransition(db, w.id, 'waiting', 'preparing', {
      statusMessage: '正在准备人物素材',
      progressFloor: 2,
      queuedAt: now,
    })
    if (moved) {
      slots -= 1
      await appendJobEvent({ jobId: w.id, fromPhase: 'waiting', toPhase: 'preparing', operator: 'system' }, db)
      await enqueue(QUEUE_NAMES.videoGenerate, 'submit', { jobId: w.id }, dedupOpts(`video-submit-${w.id}`)).catch(() => undefined)
    }
  }
}

/** 生成中轮询（FR-P3 / Z7）：到期任务逐个 video/task；退避与超时转人工 */
async function pollDueJobs(): Promise<void> {
  const db = getDb()
  const now = toDb(utcNow())
  const due = await db.all<{ id: string }>(
    "SELECT `id` FROM `video_job` WHERE `archived_at` IS NULL AND `phase` IN ('generating', 'recovering') AND `next_poll_at` IS NOT NULL AND `next_poll_at` <= ? ORDER BY `next_poll_at` ASC LIMIT 10",
    [now],
  )
  for (const row of due) {
    await pollOneJob(row.id).catch((e) => logger.warn({ err: (e as Error).message, jobId: row.id }, 'video.poll_failed'))
  }
}

async function pollOneJob(jobId: string): Promise<void> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  if (!job || !(job.phase === 'generating' || job.phase === 'recovering') || !job.remoteTaskId) return

  // 2 小时轮询窗口（FR-P3 / Q11；Z7 ORAL_MAX_POLL_AGE 同构）
  const submittedIso = fromDb(job.submittedAt)
  const submittedMs = submittedIso ? new Date(submittedIso).getTime() : Number.NaN
  if (Number.isFinite(submittedMs) && Date.now() - submittedMs > config.hifly.pollMaxAgeMs) {
    await markPollTimeout(jobId)
    return
  }

  const engine = createVideoEngine()
  let nextPollAt: string
  try {
    const r = await engine.poll(job.remoteTaskId, jobId)
    if (r.state === 'WAITING' || r.state === 'PROCESSING') {
      nextPollAt = toDb(new Date(Date.now() + config.video.pollIntervalMs))
      await db.run('UPDATE `video_job` SET `next_poll_at` = ?, `poll_failures` = 0, `updated_at` = ? WHERE `id` = ? AND `phase` IN (?, ?)', [
        nextPollAt,
        toDb(utcNow()),
        jobId,
        'generating',
        'recovering',
      ])
      return
    }
    if (r.state === 'FAILED') {
      const reason = r.failReason || '生成服务返回失败，未附原因'
      await markJobFailed(jobId, ['generating', 'recovering'], 'VIDEO_VENDOR_REJECTED', reason, {
        vendorCode: r.vendorCode,
        remoteTaskId: job.remoteTaskId,
      })
      return
    }
    // DONE：有成片地址 → downloading + 入队归档；无地址 → 继续等待（FR-P3）
    if (r.videoUrl) {
      const moved = await casTransition(db, jobId, ['generating', 'recovering'], 'downloading', {
        remoteResultUrl: r.videoUrl,
        remoteDurationSec: r.durationSec,
        statusMessage: '成片下载中',
        progressFloor: 90,
      })
      if (moved) {
        await appendJobEvent({ jobId, fromPhase: job.phase, toPhase: 'downloading', detail: { durationSec: r.durationSec, mock: engine.mock } }, db)
        await enqueue(QUEUE_NAMES.videoGenerate, 'archive', { jobId }, dedupOpts(`video-archive-${jobId}`)).catch(() => undefined)
      }
      return
    }
    nextPollAt = toDb(new Date(Date.now() + config.video.pollIntervalMs))
    await db.run('UPDATE `video_job` SET `next_poll_at` = ?, `poll_failures` = 0, `updated_at` = ? WHERE `id` = ? AND `phase` IN (?, ?)', [
      nextPollAt,
      toDb(utcNow()),
      jobId,
      'generating',
      'recovering',
    ])
  } catch (e) {
    // 查询异常：退避继续等待，不判失败（FR-P3）
    const failures = job.pollFailures + 1
    nextPollAt = toDb(new Date(Date.now() + nextPollBackoffMs(job.pollFailures)))
    await db.run('UPDATE `video_job` SET `next_poll_at` = ?, `poll_failures` = ?, `updated_at` = ? WHERE `id` = ? AND `phase` IN (?, ?)', [
      nextPollAt,
      failures,
      toDb(utcNow()),
      jobId,
      'generating',
      'recovering',
    ])
    logger.warn({ err: (e as Error).message, jobId, failures }, 'video.poll_query_failed')
  }
}

/**
 * 重启续跑（FR-P6 / Z8 `_quarantine_expired_submissions`，租约简化为阶段 CAS）：
 *  - preparing（未调用飞影）→ waiting 重新排队；
 *  - submitting 有 remote_task_id → generating 续查；无 → submission_unknown；
 *  - generating / recovering → 续查（next_poll_at 置为立即）；
 *  - downloading / verifying → 重新下载一次（下载不计费）；
 *  - aligning → 重新对齐。
 */
export async function reconcileVideoJobs(): Promise<void> {
  const db = getDb()
  const rows = await db.all<{ id: string; phase: string; remote_task_id: string | null; result_key: string | null }>(
    "SELECT `id`, `phase`, `remote_task_id`, `result_key` FROM `video_job` WHERE `archived_at` IS NULL AND `phase` IN ('preparing', 'submitting', 'generating', 'recovering', 'downloading', 'verifying', 'aligning')",
  )
  if (!rows.length) return
  const now = toDb(utcNow())
  let handled = 0
  for (const r of rows) {
    const jobId = r.id
    switch (r.phase) {
      case 'preparing': {
        const moved = await casTransition(db, jobId, 'preparing', 'waiting', { queuedAt: now, statusMessage: '排队中，等待生成资源', progressFloor: 0 })
        if (moved) handled++
        break
      }
      case 'submitting': {
        if (r.remote_task_id) {
          const moved = await casTransition(db, jobId, 'submitting', 'generating', { nextPollAt: now, statusMessage: '口播画面生成中' })
          if (moved) handled++
        } else {
          const { toSubmissionUnknown } = await import('./submit.js')
          const moved = await toSubmissionUnknown(jobId, 'submitting', '供应商提交结果未知，已停止自动重试', { kind: 'reconcile' })
          if (moved) handled++
        }
        break
      }
      case 'generating':
      case 'recovering': {
        await db.run('UPDATE `video_job` SET `next_poll_at` = ?, `updated_at` = ? WHERE `id` = ?', [now, now, jobId])
        handled++
        break
      }
      case 'downloading':
      case 'verifying': {
        // 归档中断：重新下载一次（下载不计费），再失败自然落 save_failed（Z8 改造点）
        const moved = await casTransition(db, jobId, ['downloading', 'verifying'], 'downloading', {
          statusMessage: '成片下载中',
          progressFloor: 90,
        })
        if (moved) {
          await appendJobEvent({ jobId, fromPhase: r.phase, toPhase: 'downloading', detail: { kind: 'reconcile' } }, db)
          await enqueue(QUEUE_NAMES.videoGenerate, 'archive', { jobId }, dedupOpts(`video-archive-${jobId}`)).catch(() => undefined)
          handled++
        }
        break
      }
      case 'aligning': {
        await enqueue(QUEUE_NAMES.videoGenerate, 'align', { jobId }, dedupOpts(`video-align-${jobId}`)).catch(() => undefined)
        handled++
        break
      }
      default:
        break
    }
  }
  if (handled) logger.info({ total: rows.length, handled }, 'video.reconcile_done')
}

export type { VideoJob }
