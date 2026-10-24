import { config } from '../../config.js'
import { fromDb } from '../../lib/time.js'
import type { VideoJob } from './repo.js'
import { PHASE_FLOORS, type VideoPhase } from './types.js'

/**
 * 生成进度估算（FR-A7；🔧 R1 平移 AI-Studio video-generation-queue-core.mjs）。
 * 阶段集合换成 §3.1，百分比映射改用本模块 PHASE_FLOORS；阶段机推进本身以 worker 为准。
 * 全部纯函数，可直接单测。
 */

interface GenSample {
  generationSeconds: number
  audioSeconds: number
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * 预计生成秒数：按飞影最近 N 次「生成耗时 / 口播秒数」中位数自适应；
 * 样本 <3 时按 PoC 实测系数兜底 max(180, 预计秒 × 4)。
 */
export function estimateGenerationSeconds(audioSec: number, samples: GenSample[] = []): number {
  const duration = Math.max(0, Number(audioSec) || 0)
  const fallback = Math.max(config.video.genSecondsMin, duration * config.video.genSecondsFactor)
  const ratios = samples
    .slice(-config.video.progressSamples)
    .map((s) => Number(s.generationSeconds) / Number(s.audioSeconds))
    .filter((r) => Number.isFinite(r) && r > 0 && r <= 60)
  if (ratios.length < 3) return fallback
  return Math.max(1, Math.round(duration * median(ratios)))
}

/** generating 阶段内 8→89 推进曲线（R1 generationPercent 口径） */
export function generationPercent(elapsedSec: number, expectedSec: number): number {
  const ratio = Math.max(0, Number(elapsedSec) || 0) / Math.max(1, Number(expectedSec) || 1)
  if (ratio <= 0.7) return 15 + 65 * (ratio / 0.7)
  if (ratio <= 1) return 80 + 10 * ((ratio - 0.7) / 0.3)
  return Math.min(89, 84 + 5 * (1 - Math.exp(-(ratio - 1) / 0.5)))
}

function phaseRamp(start: number, end: number, elapsedSec: number, durationSec: number): number {
  const ratio = Math.min(1, Math.max(0, elapsedSec / durationSec))
  return start + (end - start) * ratio
}

/** 任务当前进度（单调不回退，下限 progressFloor；completed 恒 100） */
export function computeJobProgress(job: Pick<VideoJob, 'phase' | 'progressFloor' | 'submittedAt' | 'startedAt' | 'expectedGenSeconds'>, now = Date.now()): number {
  const phase = job.phase as VideoPhase
  if (phase === 'completed') return 100
  const floor = Math.max(job.progressFloor || 0, PHASE_FLOORS[phase] ?? 0)
  const startedMs = fromDb(job.submittedAt ?? job.startedAt)
  const elapsedSec = Math.max(0, (now - (startedMs ? new Date(startedMs).getTime() : now)) / 1000)
  let computed: number
  switch (phase) {
    case 'preparing':
      computed = phaseRamp(2, 4, elapsedSec, 5)
      break
    case 'tts':
      computed = phaseRamp(2, 15, elapsedSec, 60)
      break
    case 'submitting':
      computed = phaseRamp(5, 7, elapsedSec, 10)
      break
    case 'generating':
    case 'recovering':
      computed = generationPercent(elapsedSec, job.expectedGenSeconds ?? config.video.genSecondsMin)
      break
    case 'downloading':
      computed = phaseRamp(90, 93, elapsedSec, 60)
      break
    case 'verifying':
      computed = 94
      break
    case 'aligning':
      computed = phaseRamp(97, 99, elapsedSec, 90)
      break
    case 'composing':
      computed = phaseRamp(20, 93, elapsedSec, 300)
      break
    default:
      computed = floor
      break
  }
  return Math.max(floor, Math.round(Math.min(computed, 99.9) * 10) / 10)
}

/** 查询异常退避序列：5 / 10 / 20 / 30 秒（R1 nextPollBackoffMs） */
export function nextPollBackoffMs(failureCount: number): number {
  return config.video.pollBackoffMs[Math.min(config.video.pollBackoffMs.length - 1, Math.max(0, failureCount))]!
}

const PHASE_MESSAGES: Partial<Record<VideoPhase, string>> = {
  waiting: '排队中，等待生成资源',
  preparing: '正在准备人物素材',
  tts: '正在合成配音',
  submitting: '正在提交生成任务',
  generating: '口播画面生成中',
  recovering: '正在恢复查询任务状态',
  downloading: '成片下载中',
  verifying: '成片校验与规范化中',
  aligning: '时间轴对齐中',
  composing: '素材合成中',
  completed: '已完成',
  failed: '生成失败，可重新生成',
  save_failed: '视频已生成，但保存失败，请重试下载',
  cancelled: '已取消',
  paused: '已停止等待，可继续查询',
  submission_unknown: '提交结果待确认，重新生成可能产生额外费用',
}

/** 阶段提示语（沿用 R1 queueTaskMessage 文案口径，按本模块阶段改写） */
export function phaseMessage(job: Pick<VideoJob, 'phase' | 'errorCode'>): string {
  const byCode: Record<string, string> = {
    VIDEO_POLL_TIMEOUT: '数字人服务任务超过自动轮询窗口，已转入人工核对',
    VIDEO_VENDOR_REJECTED: '生成服务拒绝了本次任务',
    VIDEO_SAVE_FAILED: '视频已生成，但保存失败，请重试下载',
    VIDEO_PERSONA_CHANGED: '人物形象或声音已变更，请重新生成',
  }
  return (job.errorCode && byCode[job.errorCode]) || PHASE_MESSAGES[job.phase as VideoPhase] || '任务处理中'
}
