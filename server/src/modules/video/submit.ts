import { config } from '../../config.js'
import { err, isApiError } from '../../errors.js'
import { getDb } from '../../db/index.js'
import { toDb, utcNow } from '../../lib/time.js'
import { HiflySubmissionUncertain, HiflyVendorError } from '../../integrations/hifly/index.js'
import { createVideoEngine } from './engine.js'
import { appendJobEvent, casTransition, getVideoJob, markJobFailed } from './repo.js'
import { getPersonaProductionProfile } from './persona-bridge.js'
import type { VideoJob } from './repo.js'
import type { VideoPhase } from './types.js'

/**
 * 提交（FR-P2，🔁 Z2 平移众墅之家 oral_worker#task_submit + oral.py 提交段）：
 *
 * preparing——事务外重取 production-profile，vendorAvatarId / vendorVoiceId / 声音参数与快照
 *   不一致 → failed(VIDEO_PERSONA_CHANGED)；人物不再 ready → failed(PERSONA_NOT_READY)；均不调用飞影。
 * submitting——**事务外**调 createVideoByTts，拿到 task_id 立即 CAS 落库进入 generating。
 * 异常分类（V4）：HiflySubmissionUncertain / 超时 / 未知 → submission_unknown 不自动重提；
 *   业务码明确拒绝 → failed(VIDEO_VENDOR_REJECTED)；其中 1001/1015（并发或提交数上限）
 *   属未受理 → 回 waiting 延后重排，最多 submitResecMax 次。
 */

const REQUEUE_CODES = new Set([1001, 1015])

/** 复核快照与人物库当前值是否一致（FR-P2 preparing） */
function snapshotMismatch(job: VideoJob, profile: Awaited<ReturnType<typeof getPersonaProductionProfile>>): string | null {
  const snap = job.configSnapshot
  if (!snap) return '任务缺少配置快照'
  if (job.mode === 'avatar') {
    if (!profile.avatar || !snap.avatar) return '人物已无可用的口播分身'
    if (profile.avatar.vendorAvatarId !== snap.avatar.vendorAvatarId) return '分身在排队期间被更换'
  }
  if (profile.voice && snap.voice) {
    const v = profile.voice
    const s = snap.voice
    if (v.vendorVoiceId !== s.vendorVoiceId) return '声音在排队期间被更换'
    if (Number(v.speechRate) !== Number(s.speechRate) || Number(v.volume) !== Number(s.volume) || Number(v.pitch) !== Number(s.pitch)) {
      return '声音参数（语速/音量/音调）在排队期间被修改'
    }
  }
  if (profile.versionId && job.personaVersionId && profile.versionId !== job.personaVersionId) {
    return '人物版本已更新（分身或声音被重新制作）'
  }
  return null
}

export async function runSubmitStage(jobId: string): Promise<void> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  if (!job || job.phase !== 'preparing') return

  // preparing：重取 production-profile 复核（FR-P2；不调用飞影）
  let profile
  try {
    profile = await getPersonaProductionProfile(job.personaId, {
      ...(job.mode === 'avatar' && job.configSnapshot?.avatar?.avatarId ? { avatarId: job.configSnapshot.avatar.avatarId } : {}),
      ...(job.mode === 'mixcut' ? { purpose: 'mixcut' as const } : {}),
    })
  } catch (e) {
    const code = isApiError(e) && e.code === 'PERSONA_NOT_READY' ? 'PERSONA_NOT_READY' : 'PERSONA_NOT_READY'
    await markJobFailed(jobId, 'preparing', code, e instanceof Error ? e.message : '人物不再可用', { phase: 'preparing' })
    return
  }
  const mismatch = snapshotMismatch(job, profile)
  if (mismatch) {
    await markJobFailed(jobId, 'preparing', 'VIDEO_PERSONA_CHANGED', mismatch)
    return
  }

  // 混剪：无飞影视频任务，preparing → tts（配音在 worker 内合成，§3.1 混剪链）
  if (job.mode === 'mixcut') {
    const toTts = await casTransition(db, jobId, 'preparing', 'tts', {
      statusMessage: '正在合成配音',
      progressFloor: 2,
    })
    if (toTts) {
      await appendJobEvent({ jobId, fromPhase: 'preparing', toPhase: 'tts', operator: 'system' }, db)
      const { enqueue, QUEUE_NAMES, dedupOpts } = await import('../../queue/index.js')
      await enqueue(QUEUE_NAMES.videoGenerate, 'tts', { jobId }, dedupOpts(`video-tts-${jobId}`)).catch(() => undefined)
    }
    return
  }

  // preparing → submitting（CAS）
  const ok = await casTransition(db, jobId, 'preparing', 'submitting', {
    statusMessage: '正在提交生成任务',
    submittedAt: null,
  })
  if (!ok) return
  await appendJobEvent({ jobId, fromPhase: 'preparing', toPhase: 'submitting', operator: 'system' }, db)

  // submitting：飞影调用在事务外（A10）
  const engine = createVideoEngine()
  const snap = job.configSnapshot!
  try {
    const acc = await engine.submit({
      vendorAvatarId: snap.avatar?.vendorAvatarId ?? '',
      vendorVoiceId: snap.voice?.vendorVoiceId ?? '',
      submitText: job.textSnapshot?.submitText ?? '',
      vendorTitle: snap.submitParams.vendorTitle,
      genMode: 'tts',
      jobId,
    })
    // 拿到 task_id 立即 CAS 落库（Z2：WHERE phase='submitting'）
    const now = toDb(utcNow())
    const moved = await casTransition(db, jobId, 'submitting', 'generating', {
      remoteTaskId: acc.remoteTaskId,
      submittedAt: now,
      nextPollAt: now,
      pollFailures: 0,
      statusMessage: '口播画面生成中',
      progressFloor: 8,
    })
    if (moved) {
      await appendJobEvent({ jobId, fromPhase: 'submitting', toPhase: 'generating', detail: { remoteTaskId: acc.remoteTaskId, mock: engine.mock } }, db)
    }
    return
  } catch (e) {
    await handleSubmitError(jobId, e)
  }
}

export async function handleSubmitError(jobId: string, e: unknown): Promise<void> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  if (!job || job.phase !== 'submitting') return // 已被其他动作接手（取消等）

  if (e instanceof HiflySubmissionUncertain) {
    // V4：创建请求已发出但没拿到业务码 / task_id → 不自动重提，人工核对
    await toSubmissionUnknown(jobId, 'submitting', e.message, { kind: 'submission_uncertain' })
    return
  }
  if (e instanceof HiflyVendorError) {
    if (e.vendorCode && REQUEUE_CODES.has(e.vendorCode)) {
      // 1001/1015：飞影明确未受理 → 回 waiting 延后重排（FR-P2）
      const attempts = job.submitAttempts + 1
      if (attempts <= config.video.submitResecMax) {
        const requeueAt = toDb(new Date(Date.now() + config.video.submitResecSec * 1000))
        const moved = await casTransition(db, jobId, 'submitting', 'waiting', {
          submitAttempts: attempts,
          queuedAt: requeueAt,
          statusMessage: `生成服务繁忙（${e.vendorCode}），已自动重新排队`,
        })
        if (moved) {
          await appendJobEvent({ jobId, fromPhase: 'submitting', toPhase: 'waiting', errorCode: 'VIDEO_VENDOR_REQUEUE', detail: { vendorCode: e.vendorCode, attempts } }, db)
          return
        }
      }
      await markJobFailed(jobId, 'submitting', 'VIDEO_VENDOR_REJECTED', `生成服务繁忙（业务码 ${e.vendorCode}），已重试 ${job.submitAttempts} 次仍未受理`, { vendorCode: e.vendorCode })
      return
    }
    const { vendorErrorOf } = await import('../../integrations/hifly/client.js')
    const mapped = vendorErrorOf(e.vendorCode ?? 0, e.message)
    await markJobFailed(jobId, 'submitting', 'VIDEO_VENDOR_REJECTED', mapped.message ?? e.message, { vendorCode: e.vendorCode })
    return
  }
  // 未知异常（网络抖动等）按 uncertain 处理，不自动重提（V4）
  await toSubmissionUnknown(jobId, 'submitting', e instanceof Error ? e.message : '提交异常', { kind: 'unknown_error' })
}

/** 转入 submission_unknown（保留 remote_task_id 与飞影标题，绝不自动付费重试） */
export async function toSubmissionUnknown(
  jobId: string,
  fromPhase: VideoPhase | VideoPhase[],
  message: string,
  detail?: unknown,
): Promise<boolean> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  const moved = await casTransition(db, jobId, fromPhase, 'submission_unknown', {
    errorCode: 'VIDEO_SUBMISSION_UNKNOWN',
    errorDetail: detail == null ? message : JSON.stringify(detail).slice(0, 4000),
    statusMessage: '提交结果待确认，重新生成可能产生额外费用',
    finishedAt: null,
  })
  if (moved) {
    await appendJobEvent({ jobId, fromPhase: job?.phase ?? null, toPhase: 'submission_unknown', errorCode: 'VIDEO_SUBMISSION_UNKNOWN', detail }, db).catch(() => undefined)
  }
  return moved
}

/** 轮询超 2 小时转人工（FR-P3 / Z7：保留任务号，绝不自动重试） */
export async function markPollTimeout(jobId: string): Promise<void> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  if (!job) return
  const moved = await casTransition(db, jobId, ['generating', 'recovering'], 'submission_unknown', {
    errorCode: 'VIDEO_POLL_TIMEOUT',
    errorDetail: '数字人服务任务超过自动轮询窗口（2 小时），已停止自动轮询',
    statusMessage: '数字人服务任务超过自动轮询窗口，已转入人工核对',
  })
  if (moved) {
    await appendJobEvent({ jobId, fromPhase: job.phase, toPhase: 'submission_unknown', errorCode: 'VIDEO_POLL_TIMEOUT', detail: { remoteTaskId: job.remoteTaskId } }, db)
  }
}
