import { getDb } from '../../db/index.js'
import { err } from '../../errors.js'
import { toDb, utcNow } from '../../lib/time.js'
import { recordOperation } from '../audit/repo.js'
import { casTransition, appendJobEvent, getVideoJob } from './repo.js'
import { toSubmissionUnknown } from './submit.js'
import { resolveJobTempDir } from './temp-dir.js'
import { paths } from '../../config.js'
import fsp from 'node:fs/promises'

/**
 * 任务动作（FR-A9 / FR-P7；🔁 Z3 refresh / Z9 retry-download / Z5 available_actions）。
 * 每个动作：阶段 CAS（期望阶段不符即 409 INVALID_STATE）→ 事件流水 → operation_log。
 */

async function op(action: string, jobId: string, operator: string, detail?: unknown): Promise<void> {
  await recordOperation({ action, targetType: 'video_job', targetId: jobId, detail, operator }).catch(() => undefined)
}

function requireJob(jobId: string) {
  return getVideoJob(jobId).then((j) => {
    if (!j) throw err.notFound('视频任务不存在')
    return j!
  })
}

/** 立即查询一次飞影（generating / recovering 且有任务号；Z3 手动刷新语义） */
export async function refreshJob(jobId: string, operator: string): Promise<void> {
  const job = await requireJob(jobId)
  if (!(job.phase === 'generating' || job.phase === 'recovering')) throw err.invalidState('当前阶段不可刷新查询')
  if (!job.remoteTaskId) throw err.invalidState('缺少生成服务任务号')
  const db = getDb()
  await db.run('UPDATE `video_job` SET `next_poll_at` = ?, `updated_at` = ? WHERE `id` = ?', [toDb(utcNow()), toDb(utcNow()), jobId])
  await op('video.refresh', jobId, operator, { from: job.phase })
}

/** 取消 / 停止等待（FR-P7）：waiting/preparing → cancelled；混剪 tts/composing → cancelled；generating/recovering → paused */
export async function cancelJob(jobId: string, operator: string): Promise<{ phase: string }> {
  const job = await requireJob(jobId)
  const db = getDb()
  if (job.phase === 'waiting' || job.phase === 'preparing' || job.phase === 'tts' || job.phase === 'composing') {
    const moved = await casTransition(db, jobId, ['waiting', 'preparing', 'tts', 'composing'], 'cancelled', {
      statusMessage: '已取消',
      finishedAt: toDb(utcNow()),
    })
    if (!moved) throw err.invalidState('任务状态已变化，请刷新后重试')
    await appendJobEvent({ jobId, fromPhase: job.phase, toPhase: 'cancelled', operator })
    await cleanupTemp(jobId)
    await op('video.cancel', jobId, operator, { from: job.phase })
    return { phase: 'cancelled' }
  }
  if (job.phase === 'generating' || job.phase === 'recovering') {
    // 停止等待：飞影无取消接口，积分照扣（FR-A9 界面须明示）
    const moved = await casTransition(db, jobId, ['generating', 'recovering'], 'paused', {
      statusMessage: '已停止等待；生成服务无取消接口，已消耗的费用不予退还',
      errorCode: null,
    })
    if (!moved) throw err.invalidState('任务状态已变化，请刷新后重试')
    await appendJobEvent({ jobId, fromPhase: job.phase, toPhase: 'paused', operator })
    await op('video.pause', jobId, operator, { from: job.phase })
    return { phase: 'paused' }
  }
  throw err.invalidState('当前阶段不可取消（提交中的任务需等待其结果）')
}

/** 继续查询：paused → recovering */
export async function resumeJob(jobId: string, operator: string): Promise<void> {
  const job = await requireJob(jobId)
  if (job.phase !== 'paused') throw err.invalidState('仅停止等待的任务可继续查询')
  const db = getDb()
  const moved = await casTransition(db, jobId, 'paused', 'recovering', {
    statusMessage: '正在恢复查询任务状态',
    // 停止等待可能持续任意久：人工恢复即重新起算 2 小时轮询窗口（FR-P3）
    submittedAt: toDb(utcNow()),
    nextPollAt: toDb(utcNow()),
  })
  if (!moved) throw err.invalidState('任务状态已变化，请刷新后重试')
  await appendJobEvent({ jobId, fromPhase: 'paused', toPhase: 'recovering', operator })
  await op('video.resume', jobId, operator)
}

/** 重试下载（FR-A9 / Z9）：save_failed → downloading，只重下载不重提交 */
export async function retryDownload(jobId: string, operator: string): Promise<void> {
  const job = await requireJob(jobId)
  if (job.phase !== 'save_failed') throw err.invalidState('仅保存失败的任务可重试下载')
  if (!job.remoteResultUrl && !job.remoteTaskId) throw err.invalidState('缺少成片地址与任务号，无法重试下载')
  const db = getDb()
  const moved = await casTransition(db, jobId, 'save_failed', 'downloading', {
    statusMessage: '成片下载中',
    errorCode: null,
    errorDetail: null,
    progressFloor: 90,
  })
  if (!moved) throw err.invalidState('任务状态已变化，请刷新后重试')
  await appendJobEvent({ jobId, fromPhase: 'save_failed', toPhase: 'downloading', operator })
  await op('video.retry_download', jobId, operator, { remoteTaskId: job.remoteTaskId })
  const { enqueue, QUEUE_NAMES, dedupOpts } = await import('../../queue/index.js')
  await enqueue(QUEUE_NAMES.videoGenerate, 'archive', { jobId }, dedupOpts(`video-archive-${jobId}`)).catch(() => undefined)
}

/** 查询原任务（FR-A9 / Z3）：submission_unknown / failed 且有任务号 → recovering */
export async function queryOriginal(jobId: string, operator: string): Promise<void> {
  const job = await requireJob(jobId)
  if (!(job.phase === 'submission_unknown' || job.phase === 'failed')) throw err.invalidState('当前阶段不可查询原任务')
  if (!job.remoteTaskId) throw err.invalidState('缺少生成服务任务号，请改用「补录任务号」')
  const db = getDb()
  const moved = await casTransition(db, jobId, ['submission_unknown', 'failed'], 'recovering', {
    statusMessage: '正在恢复查询任务状态',
    errorCode: null,
    errorDetail: null,
    // 超窗转人工后恢复：重置 submitted_at，重新获得完整轮询窗口（否则 sweep 立即再次判超窗）
    submittedAt: toDb(utcNow()),
    nextPollAt: toDb(utcNow()),
  })
  if (!moved) throw err.invalidState('任务状态已变化，请刷新后重试')
  await appendJobEvent({ jobId, fromPhase: job.phase, toPhase: 'recovering', operator, detail: { remoteTaskId: job.remoteTaskId } })
  await op('video.query_original', jobId, operator, { remoteTaskId: job.remoteTaskId })
}

/** 补录任务号（FR-A9）：submission_unknown 且无任务号，按飞影后台标题短引用找回后填入 */
export async function bindRemoteTaskId(jobId: string, remoteTaskId: string, operator: string): Promise<void> {
  const job = await requireJob(jobId)
  if (job.phase !== 'submission_unknown') throw err.invalidState('仅提交结果待确认的任务可补录任务号')
  if (job.remoteTaskId) throw err.invalidState('任务已有生成服务任务号，请使用「查询原任务」')
  const trimmed = String(remoteTaskId ?? '').trim()
  if (!trimmed || trimmed.length > 128) throw err.badRequest('任务号格式不正确')
  const db = getDb()
  const moved = await casTransition(db, jobId, 'submission_unknown', 'recovering', {
    remoteTaskId: trimmed,
    statusMessage: '已补录任务号，正在恢复查询',
    errorCode: null,
    errorDetail: null,
    submittedAt: toDb(utcNow()),
    nextPollAt: toDb(utcNow()),
  })
  if (!moved) throw err.invalidState('任务状态已变化，请刷新后重试')
  await appendJobEvent({ jobId, fromPhase: 'submission_unknown', toPhase: 'recovering', operator, detail: { remoteTaskId: trimmed, kind: 'bind_remote' } })
  await op('video.bind_remote', jobId, operator, { remoteTaskId: trimmed })
}

/** 确认未提交并重新提交（FR-A9）：二次确认，submit_attempts+1 → preparing */
export async function confirmResubmit(jobId: string, confirm: boolean, operator: string): Promise<void> {
  const job = await requireJob(jobId)
  if (job.phase !== 'submission_unknown') throw err.invalidState('仅提交结果待确认的任务可确认重提')
  if (confirm !== true) throw err.badRequest('缺少二次确认（confirm: true）')
  if (job.remoteTaskId) throw err.invalidState('任务已有生成服务任务号，请先「查询原任务」')
  const db = getDb()
  const moved = await casTransition(db, jobId, 'submission_unknown', 'preparing', {
    submitAttempts: job.submitAttempts + 1,
    statusMessage: '已确认未提交，重新准备提交',
    errorCode: null,
    errorDetail: null,
  })
  if (!moved) throw err.invalidState('任务状态已变化，请刷新后重试')
  await appendJobEvent({ jobId, fromPhase: 'submission_unknown', toPhase: 'preparing', operator, detail: { submitAttempts: job.submitAttempts + 1 } })
  await op('video.confirm_resubmit', jobId, operator, { submitAttempts: job.submitAttempts + 1 })
  const { enqueue, QUEUE_NAMES, dedupOpts } = await import('../../queue/index.js')
  await enqueue(QUEUE_NAMES.videoGenerate, 'submit', { jobId }, dedupOpts(`video-submit-${jobId}`)).catch(() => undefined)
}

/** 重新对齐时间轴（FR-P5）：completed → aligning → completed，不调用飞影 */
export async function realignJob(jobId: string, operator: string): Promise<void> {
  const job = await requireJob(jobId)
  if (job.phase !== 'completed') throw err.invalidState('仅已完成的任务可重新对齐')
  if (!job.resultKey) throw err.invalidState('任务缺少成片对象')
  const { runAlignStage } = await import('./archive.js')
  await op('video.realign', jobId, operator)
  await runAlignStage(jobId)
}

/** 归档（FR §6.1：不在列表显示，产物按留存策略清理） */
export async function archiveJob(jobId: string, operator: string): Promise<void> {
  const job = await requireJob(jobId)
  if (job.archivedAt) return
  const db = getDb()
  const moved = await casTransition(db, jobId, ['completed', 'failed', 'cancelled'], job.phase, { archivedAt: toDb(utcNow()) })
  if (!moved) throw err.invalidState('任务状态已变化，请刷新后重试')
  await op('video.archive', jobId, operator)
}

/** FR-X2：下一步动作（🔁 Z5 oral_task_available_actions） */
export function nextActionsOf(job: { phase: string; remoteTaskId: string | null; remoteResultUrl: string | null; timelineSource: string | null }): string[] {
  switch (job.phase) {
    case 'waiting':
    case 'preparing':
    case 'submitting':
    case 'generating':
      return ['view_progress']
    case 'tts':
    case 'composing':
      // 混剪专属阶段（配音 / 合成）此前落入 default 无动作，任务中心归一表要求进行中即可查看进度
      return ['view_progress']
    case 'recovering':
      return ['view_progress']
    case 'downloading':
    case 'verifying':
    case 'aligning':
      return ['view_progress']
    case 'save_failed':
      return job.remoteResultUrl || job.remoteTaskId ? ['retry_download'] : []
    case 'submission_unknown':
      return job.remoteTaskId ? ['query_original'] : ['bind_remote']
    case 'paused':
      return ['view_progress']
    case 'completed':
      return job.timelineSource === 'estimated' ? ['continue_edit', 'realign'] : ['continue_edit']
    case 'failed':
      return ['regenerate']
    default:
      return []
  }
}

async function cleanupTemp(jobId: string): Promise<void> {
  try {
    await fsp.rm(resolveJobTempDir(paths.tempDir, jobId), { recursive: true, force: true })
  } catch {
    // 清理失败不影响动作本身
  }
}
