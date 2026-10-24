import fs from 'node:fs/promises'
import path from 'node:path'
import { config, paths } from '../../config.js'
import { logger } from '../../log.js'
import { dedupOpts, enqueue, QUEUE_NAMES, registerWorker, scheduleRepeatable } from '../../queue/index.js'
import { getVideoJob } from '../video/repo.js'
import { getCut, appendEvent, casStatus, finishRender, listCutsByStatus, advanceProgress } from './repo.js'
import { downloadBase, renderCut, cleanupWorkDir, makeWorkDir, CancelledError } from './render.js'
import type { CutStatus } from './types.js'

/**
 * 剪辑渲染编排装配（任务书 CE4）：
 *  - video-cut worker（并发 = CUT_WORKER_CONCURRENCY）：单 jobName render，§3.4 流水线；
 *  - video-cut-sweep（每 CUT_SWEEP_INTERVAL_MS）：rendering 超时兜底 / cancelling 收尾 / queued 重投；
 *  - reconcileCuts（FR-J3）：进程重启后续跑 queued / rendering。
 */

export function registerCutWorker(): void {
  registerWorker(
    QUEUE_NAMES.videoCut,
    async (job) => {
      const { cutId } = (job.data ?? {}) as { cutId?: string }
      if (!cutId) return
      await runRenderJob(cutId)
    },
    { concurrency: config.cut.workerConcurrency },
  )
}

export async function enqueueCutRender(cutId: string): Promise<void> {
  await enqueue(QUEUE_NAMES.videoCut, 'render', { cutId }, dedupOpts(`cut-render-${cutId}`))
}

/** 渲染单任务（§3.1 CAS 领取 → §3.4 流水线 → 终态落库） */
export async function runRenderJob(cutId: string): Promise<void> {
  const cut = await getCut(cutId)
  if (!cut || cut.status !== 'queued') return
  const fromStatus: CutStatus = cut.status
  if (!(await casStatus(cutId, ['queued'], 'rendering', { renderStage: 'download', progress: 2 }))) return
  await appendEvent(cutId, fromStatus, 'rendering', { stage: 'download' })

  const job = await getVideoJob(cut.videoJobId)
  if (!job?.resultKey) {
    await failRender(cut, 'VIDEO_NOT_READY', '基础视频产物不存在或已被清理')
    return
  }

  const workDir = await makeWorkDir(cutId)
  const startedAt = Date.now()
  try {
    const basePath = await downloadBase(cut.videoJobId, job.resultKey, workDir)
    let bgmLocalPath: string | null = null
    if (cut.bgmEnabled && cut.bgmId) {
      bgmLocalPath = await resolveBgmFile(cut.bgmId, workDir).catch((e) => {
        logger.warn({ err: (e as Error).message, cutId, bgmId: cut.bgmId }, 'cut.bgm_fetch_failed')
        return null
      })
      if (!bgmLocalPath) {
        await failRender(cut, 'BGM_NOT_FOUND', 'BGM 素材不存在或已被清理')
        return
      }
    }

    const outcome = await renderCut(cut, basePath, bgmLocalPath, workDir, cut.contentHash ?? '', {
      onStage: async (stage, progress) => {
        await advanceProgress(cutId, stage, progress)
      },
      isCancelled: async () => {
        const fresh = await getCut(cutId)
        return fresh?.status === 'cancelling'
      },
    })
    const okFin = await finishRender(cutId, outcome)
    if (okFin) {
      await appendEvent(cutId, 'rendering', 'completed', {
        stage: 'idle',
        detail: { durationMs: outcome.durationMs, isMock: outcome.isMock, elapsedMs: Date.now() - startedAt },
      })
    } else {
      logger.info({ cutId }, 'cut.finish_cas_lost_cancel_won')
    }
  } catch (e) {
    const fresh = await getCut(cutId)
    if (e instanceof CancelledError || fresh?.status === 'cancelling') {
      if (await casStatus(cutId, ['rendering', 'cancelling'], 'cancelled')) await appendEvent(cutId, 'rendering', 'cancelled')
    } else {
      await failRender(cut, 'CUT_RENDER_FAILED', (e as Error).message)
    }
  } finally {
    await cleanupWorkDir(cutId).catch(() => undefined)
  }
}

async function failRender(cut: { id: string }, code: string, message: string): Promise<void> {
  // cancelling 中失败也落 failed（§3.1 cancelling→failed 出边）
  if (await casStatus(cut.id, ['queued', 'rendering', 'cancelling'], 'failed', { errorCode: code, errorMessage: message.slice(0, 499) })) {
    await appendEvent(cut.id, 'rendering', 'failed', { errorCode: code })
  }
}

/** BGM 素材落地（OSS 直读 / 本地 dataDir/oss 拷贝） */
async function resolveBgmFile(bgmId: string, workDir: string): Promise<string | null> {
  const { getBgm } = await import('./bgm-store.js')
  const item = await getBgm(bgmId)
  if (!item?.storageKey) return null
  const dest = path.join(workDir, `bgm_${path.extname(item.storageKey) || '.mp3'}`)
  const { isOssEnabled, downloadObjectToFile } = await import('../../integrations/aliyun-oss/client.js')
  if (isOssEnabled()) {
    await downloadObjectToFile(item.storageKey, dest)
  } else {
    await fs.copyFile(path.join(paths.dataDir, 'oss', item.storageKey), dest)
  }
  return dest
}

/** sweep 主体（FR-J3 / §3.1）：超时兜底 + cancelling 收尾 + queued 重投 */
export async function runCutSweep(): Promise<void> {
  const stuck = await listCutsByStatus(['rendering'], config.cut.renderTimeoutMs)
  for (const c of stuck) {
    if (await casStatus(c.id, ['rendering'], 'failed', { errorCode: 'CUT_RENDER_TIMEOUT', errorMessage: '渲染超时，请重试' })) {
      await appendEvent(c.id, 'rendering', 'failed', { errorCode: 'CUT_RENDER_TIMEOUT' })
      logger.warn({ cutId: c.id }, 'cut.render_timeout')
    }
  }
  const cancelling = await listCutsByStatus(['cancelling'], config.cut.cancellingTimeoutMs)
  for (const c of cancelling) {
    if (await casStatus(c.id, ['cancelling'], 'cancelled')) await appendEvent(c.id, 'cancelling', 'cancelled', { detail: { reason: 'sweep_timeout' } })
  }
  // queued 滞留重投（worker 崩溃丢消息兜底；dedup 键带 attempt 语义不足，直接复用同键靠 BullMQ 未完成去重）
  const queued = await listCutsByStatus(['queued'])
  for (const c of queued) {
    const age = c.updatedAt ? Date.now() - new Date(c.updatedAt.replace(' ', 'T') + 'Z').getTime() : Infinity
    if (age > 120000) await enqueueCutRender(c.id).catch(() => undefined)
  }
}

export async function scheduleCutSweep(): Promise<void> {
  await scheduleRepeatable(QUEUE_NAMES.videoCutSweep, 'video-cut-sweep', config.cut.sweepIntervalMs, 'sweep')
  await runCutSweep().catch((e) => logger.warn({ err: (e as Error).message }, 'cut.sweep.boot_failed'))
}

/** 重启续跑（FR-J3）：queued / rendering 重投（rendering 重投后 CAS 已是 rendering——worker 需容忍） */
export async function reconcileCuts(): Promise<void> {
  const active = await listCutsByStatus(['queued', 'rendering'])
  for (const c of active) {
    // rendering 滞留由 sweep 超时兜底，这里只重投 queued
    if (c.status === 'queued') await enqueueCutRender(c.id).catch((e) => logger.warn({ err: (e as Error).message }, 'cut.reconcile_enqueue_failed'))
  }
}
