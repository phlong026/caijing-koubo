import { getDb } from '../../db/index.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { signMediaUrl } from '../video/routes.js'
import { getVideoJob } from '../video/repo.js'
import type { TimelineItem } from '../video/types.js'
import { getBaseVideo } from '../video/base.js'
import { isOssEnabled, signedUrl } from '../../integrations/aliyun-oss/client.js'
import { config } from '../../config.js'
import {
  computeContentHash,
  computeCutTextHash,
  getCut,
  getCutByJobVersion,
  getDraft,
  listVersions,
  resetReviewIfHashDrifted,
  upsertDraft,
  casStatus,
  appendEvent,
  createVersionFromDraft,
  latestApprovedCutByCopy,
} from './repo.js'
import { validateStyle } from './subtitle.js'
import { getBgm } from './bgm-store.js'
import { enqueueCutRender } from './worker.js'
import type { BreatheParams, CutConfigInput, CutSegment, FinalVideoPayload, SubtitleStyle, VideoCut } from './types.js'

/**
 * 剪辑业务层（任务书 FR-C / FR-J / FR-X，CE0/CE4/CE6）：
 * 配置草稿（draft version_no=0 upsert）、渲染版本创建、取消 / 重试、final 发布契约。
 */

function toDbTime(v: string | null): string | null {
  return v
}

export interface CutConfigView {
  draft: VideoCut | null
  base: {
    videoJobId: string
    versionNo: number
    url: string
    coverUrl: string | null
    durationMs: number
    width: number
    height: number
    timeline: TimelineItem[]
    timelineSource: string
    riskText: string | null
  }
  engine: 'ffmpeg' | 'mock'
  defaults: { noiseDb: number; minSilenceMs: number; keepGapMs: number; bgmVolume: number; riskTailSeconds: number }
  versions: VideoCut[]
}

/** FR-C2：取配置（无草稿按默认值生成）；base 未完成 409 */
export async function getCutConfig(videoJobId: string): Promise<CutConfigView> {
  const base = await getBaseVideo(videoJobId).catch((e) => {
    throw e
  })
  const job = await getVideoJob(videoJobId)
  let draft = await getDraft(videoJobId)
  if (!draft) {
    draft = await buildInitialDraft(videoJobId, base)
  }
  const { engineCapability } = await import('./engine.js')
  const { engine } = await engineCapability()
  const versions = (await listVersions(videoJobId)).filter((v) => v.versionNo > 0)
  return {
    draft,
    base: {
      videoJobId: base.videoJobId,
      versionNo: base.versionNo,
      url: base.url,
      coverUrl: base.coverUrl,
      durationMs: base.durationMs,
      width: base.width,
      height: base.height,
      timeline: base.timeline,
      timelineSource: base.timelineSource,
      riskText: base.riskText,
    },
    engine,
    defaults: {
      noiseDb: config.cut.defaultNoiseDb,
      minSilenceMs: config.cut.minSilenceMs,
      keepGapMs: config.cut.keepGapMs,
      bgmVolume: config.cut.bgmVolume,
      riskTailSeconds: config.cut.riskTailSeconds,
    },
    versions,
    ...(job ? {} : {}),
  }
}

/** 初始草稿：时间轴全量 + 默认样式 + 默认开关（字幕开 / 剪气口关 / BGM 关 / 尾页开） */
async function buildInitialDraft(videoJobId: string, base: Awaited<ReturnType<typeof getBaseVideo>>): Promise<VideoCut> {
  const segments: CutSegment[] = base.timeline.map((t) => ({
    index: t.index,
    text: t.text,
    startMs: t.startMs,
    endMs: t.endMs,
    kind: t.kind,
    edited: false,
  }))
  const style = (await import('./types.js')).DEFAULT_SUBTITLE_STYLE
  const contentHash = computeContentHash({
    baseVersionNo: base.versionNo,
    segments,
    riskTailEnabled: true,
    riskTailText: base.riskText,
    riskTailSeconds: config.cut.riskTailSeconds,
    subtitleEnabled: true,
    subtitleStyle: style,
    bgmEnabled: false,
    bgmId: null,
    bgmVolume: config.cut.bgmVolume,
    bgmFadeIn: config.cut.bgmFadeMs,
    bgmFadeOut: config.cut.bgmFadeMs,
    breatheEnabled: false,
    breatheParams: null,
  })
  return upsertDraft({
    videoJobId,
    baseVersionNo: base.versionNo,
    durationMs: base.durationMs,
    width: base.width,
    height: base.height,
    config: {
      subtitleEnabled: true,
      riskTailEnabled: Boolean(base.riskText),
      riskTailSeconds: config.cut.riskTailSeconds,
      bgmEnabled: false,
      bgmId: null,
      bgmVolume: config.cut.bgmVolume,
      bgmFadeIn: config.cut.bgmFadeMs,
      bgmFadeOut: config.cut.bgmFadeMs,
      breatheEnabled: false,
    },
    style,
    segments,
    riskTailText: base.riskText,
    breatheParams: null,
    cutTextHash: computeCutTextHash(segments),
    contentHash,
    operator: 'system',
  })
}

/** FR-C3：存草稿（risk 段锁定 / 文本超长 / index 对齐校验；hash 变化时按 FR-V3 重置过审状态） */
export async function saveCutConfig(videoJobId: string, input: CutConfigInput, operator: string): Promise<VideoCut> {
  const base = await getBaseVideo(videoJobId)
  const current = (await getDraft(videoJobId)) ?? (await buildInitialDraft(videoJobId, base))

  // segments 校验：index 与 base 时间轴一一对应；risk 锁定；超长拦截。
  // 提供的分段是「部分编辑」，必须合并进全量（FR-C3：segments 与时间轴一一对应，未提及的保持原样）
  let segments = current.segments
  if (input.segments) {
    const baseById = new Map(base.timeline.map((t) => [t.index, t]))
    const currentById = new Map(current.segments.map((s) => [s.index, s]))
    const edited = new Map<number, string>()
    for (const s of input.segments) {
      const t = baseById.get(s.index)
      if (!t) throw err.badRequest(`字幕分段 index ${s.index} 与基础视频时间轴不匹配`)
      const prev = currentById.get(s.index)
      if (t.kind === 'risk' && prev && s.text !== prev.text && s.text !== t.text) throw err.cutRiskLocked(`分段 ${s.index} 为风险提示话术，不可编辑`)
      if (t.kind !== 'risk' && s.text.length > config.cut.maxSegmentsTextLen) throw err.cutTextTooLong(`分段 ${s.index} 文本超过 ${config.cut.maxSegmentsTextLen} 字`)
      edited.set(s.index, s.text)
    }
    segments = base.timeline
      .map((t) => {
        const prev = currentById.get(t.index)
        const text = edited.has(t.index) ? edited.get(t.index)! : (prev?.text ?? t.text)
        const isRisk = t.kind === 'risk'
        return { index: t.index, text, startMs: t.startMs, endMs: t.endMs, kind: t.kind, edited: !isRisk && text !== t.text }
      })
      .sort((a, b) => a.index - b.index)
  }

  const style = input.subtitleStyle ? validateStyle(input.subtitleStyle) : current.subtitleStyle
  const subtitleEnabled = input.subtitleEnabled ?? current.subtitleEnabled
  const bgmEnabled = input.bgmEnabled ?? current.bgmEnabled
  const bgmId = input.bgmId !== undefined ? input.bgmId : current.bgmId
  if (bgmEnabled && bgmId && !(await getBgm(bgmId))) throw err.bgmNotFound()
  const breatheEnabled = input.breatheEnabled ?? current.breatheEnabled
  let breatheParams: BreatheParams | null = current.breatheParams
  if (input.breatheParams || (breatheEnabled && !breatheParams)) {
    const p = { ...current.breatheParams } as Partial<BreatheParams>
    const merged = { noiseDb: p.noiseDb ?? config.cut.defaultNoiseDb, minSilenceMs: p.minSilenceMs ?? config.cut.minSilenceMs, keepGapMs: p.keepGapMs ?? config.cut.keepGapMs, ...(input.breatheParams ?? {}) }
    if (merged.noiseDb < -60 || merged.noiseDb > -20) throw err.badRequest('静音阈值须在 -60~-20dB')
    if (merged.minSilenceMs < 200 || merged.minSilenceMs > 2000) throw err.badRequest('最短静音须在 200~2000ms')
    if (merged.keepGapMs < 0 || merged.keepGapMs > 500) throw err.badRequest('保留间隙须在 0~500ms')
    breatheParams = merged
  }
  const riskTailEnabled = input.riskTailEnabled ?? current.riskTailEnabled
  const riskTailText = riskTailEnabled ? current.riskTailText ?? base.riskText : current.riskTailText ?? base.riskText
  const riskTailSeconds = Math.min(Math.max(1, input.riskTailSeconds ?? current.riskTailSeconds), config.cut.riskTailMaxSeconds)
  if (riskTailEnabled && !riskTailText) throw err.cutRiskTextEmpty()

  const contentHash = computeContentHash({
    baseVersionNo: base.versionNo,
    segments,
    riskTailEnabled,
    riskTailText,
    riskTailSeconds,
    subtitleEnabled,
    subtitleStyle: style,
    bgmEnabled,
    bgmId,
    bgmVolume: input.bgmVolume ?? current.bgmVolume,
    bgmFadeIn: input.bgmFadeIn ?? current.bgmFadeIn,
    bgmFadeOut: input.bgmFadeOut ?? current.bgmFadeOut,
    breatheEnabled,
    breatheParams,
  })

  const updated = await upsertDraft({
    videoJobId,
    baseVersionNo: base.versionNo,
    durationMs: base.durationMs,
    width: base.width,
    height: base.height,
    config: {
      subtitleEnabled,
      riskTailEnabled,
      riskTailSeconds,
      bgmEnabled,
      bgmId,
      bgmVolume: input.bgmVolume ?? current.bgmVolume,
      bgmFadeIn: input.bgmFadeIn ?? current.bgmFadeIn,
      bgmFadeOut: input.bgmFadeOut ?? current.bgmFadeOut,
      breatheEnabled,
    },
    style,
    segments,
    riskTailText,
    breatheParams,
    cutTextHash: computeCutTextHash(segments),
    contentHash,
    operator,
  })

  // FR-V3 / P0-1：hash 变化只改草稿行；存在过审版本且 hash 漂移 → 重置其 review_status
  await resetReviewIfHashDrifted(videoJobId)
  return updated
}

/** FR-C4：创建渲染版本（Idempotency-Key 由路由层透传，这里做互斥与入队） */
export async function createCutVersion(videoJobId: string, operator: string): Promise<VideoCut> {
  const active = await listVersions(videoJobId)
  if (active.some((v) => ['queued', 'rendering', 'cancelling'].includes(v.status))) {
    throw err.cutRenderBusy()
  }
  const draft = await getDraft(videoJobId)
  if (!draft) throw err.cutNotDraft('配置草稿不存在，请先保存配置')
  const version = await createVersionFromDraft(draft, operator)
  await appendEvent(version.id, 'draft', 'queued', { operator })
  await enqueueCutRender(version.id).catch(async (e) => {
    logger.error({ err: (e as Error).message, cutId: version.id }, 'cut.enqueue_failed')
    await casStatus(version.id, ['queued'], 'failed', { errorCode: 'CUT_RENDER_FAILED', errorMessage: '任务入队失败，请重试' })
    throw e
  })
  return version
}

/** FR-C5：取消 */
export async function cancelCut(cutId: string, operator: string): Promise<VideoCut> {
  const cut = await getCut(cutId)
  if (!cut) throw err.notFound('成片版本不存在')
  if (cut.status === 'queued') {
    if (!(await casStatus(cutId, ['queued'], 'cancelled'))) throw err.invalidState('状态已变化，请刷新')
  } else if (cut.status === 'rendering') {
    if (!(await casStatus(cutId, ['rendering'], 'cancelling'))) throw err.invalidState('状态已变化，请刷新')
  } else {
    throw err.invalidState(`当前状态 ${cut.status} 不可取消`)
  }
  await appendEvent(cutId, cut.status, cut.status === 'queued' ? 'cancelled' : 'cancelling', { operator })
  return (await getCut(cutId))!
}

/** FR-J2：失败重试（复用配置新建版本） */
export async function retryRender(cutId: string, operator: string): Promise<VideoCut> {
  const cut = await getCut(cutId)
  if (!cut) throw err.notFound('成片版本不存在')
  if (cut.status !== 'failed') throw err.invalidState('仅渲染失败的版本可以重试')
  const draft = await getDraft(cut.videoJobId)
  if (!draft) throw err.cutNotDraft('配置草稿不存在')
  const version = await createVersionFromDraft(draft, operator)
  await appendEvent(version.id, null, 'queued', { detail: { retriedFrom: cut.versionNo }, operator })
  await enqueueCutRender(version.id)
  return version
}

/** FR-X1：final 发布契约（completed + approved + hash 一致；否则 FINAL_NOT_READY 带原因） */
export async function getFinalVideo(cutId: string): Promise<FinalVideoPayload> {
  const cut = await getCut(cutId)
  if (!cut) throw err.notFound('成片版本不存在')
  if (cut.status !== 'completed' || !cut.resultKey) throw err.finalNotReady('成片尚未渲染完成')
  if (cut.reviewStatus !== 'approved') throw err.finalNotReady(`成片未通过复审（${cut.reviewStatus}）`)
  const draftRow = await getDraft(cut.videoJobId)
  if (draftRow?.contentHash && draftRow.contentHash !== cut.approvedContentHash) {
    throw err.finalNotReady('剪辑配置在过审后有实质修改，需重新渲染并复审')
  }
  const job = await getVideoJob(cut.videoJobId)
  if (!job) throw err.notFound('视频任务不存在')
  const mode = isOssEnabled() ? 'oss' : 'local'
  const url = mode === 'oss' ? await signedUrl(cut.resultKey) : signMediaUrl(cut.resultKey)
  const coverUrl = cut.coverKey ? (mode === 'oss' ? await signedUrl(cut.coverKey) : signMediaUrl(cut.coverKey)) : null
  return {
    cutId: cut.id,
    videoJobId: cut.videoJobId,
    versionNo: cut.versionNo,
    copyId: job.copyId,
    copyVersionId: job.copyVersionId,
    copyVersionNo: job.copyVersionNo,
    url,
    coverUrl,
    durationMs: cut.durationMs,
    width: cut.width,
    height: cut.height,
    timeline: cut.timeline ?? [],
    reviewStatus: cut.reviewStatus,
    isMock: cut.isMock,
  }
}

/**
 * FR-X2：发布取输入解析（EC11）。
 * 显式 videoJobId：该 job 的过审成片优先、回落该 base；
 * 缺省：copy 下最新过审成片，无则回落该 copy 最新 completed base，再无则 VIDEO_NOT_READY。
 * 返回发布侧需要的最小消费集（videoJobId + 输入版本号 + 来源）。
 */
export async function resolvePublishInput(copyId: string, videoJobId?: string | null): Promise<{ videoJobId: string; versionNo: number; source: 'cut' | 'base' }> {
  if (videoJobId) {
    const cut = await latestApprovedCutOfJob(videoJobId)
    if (cut) {
      const job = await getVideoJob(videoJobId)
      if (job && job.copyId !== copyId) throw err.badRequest('基础视频与文案不匹配')
      return { videoJobId, versionNo: cut.versionNo, source: 'cut' }
    }
    const base = await getBaseVideo(videoJobId)
    if (base.copyId !== copyId) throw err.badRequest('基础视频与文案不匹配')
    return { videoJobId, versionNo: base.versionNo, source: 'base' }
  }
  const cut = await latestApprovedCutByCopy(copyId)
  if (cut) return { videoJobId: cut.videoJobId, versionNo: cut.versionNo, source: 'cut' }
  const row = await getDb().get<{ id: string; version_no: number }>(
    "SELECT `id`, `version_no` FROM `video_job` WHERE `copy_id` = ? AND `phase` = 'completed' AND `result_key` IS NOT NULL ORDER BY `version_no` DESC LIMIT 1",
    [copyId],
  )
  if (!row) throw err.videoNotReady('该文案没有可发布的基础视频或过审成片')
  return { videoJobId: row.id, versionNo: Number(row.version_no), source: 'base' }
}

async function latestApprovedCutOfJob(videoJobId: string): Promise<VideoCut | null> {
  const versions = await listVersions(videoJobId)
  return (
    versions
      .filter((v) => v.status === 'completed' && v.reviewStatus === 'approved' && v.contentHash && v.contentHash === v.approvedContentHash)
      .sort((a, b) => b.versionNo - a.versionNo)[0] ?? null
  )
}

void toDbTime
void getCutByJobVersion
