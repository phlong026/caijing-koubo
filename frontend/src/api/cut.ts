import { apiDel, apiGet, apiPost, apiPut, type QueryValue } from './client'
import type { TimelineItem } from './video'

/** 视频剪辑模块 API（任务书 §6 / §7 工程）。 */

export type CutStatus = 'draft' | 'queued' | 'rendering' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
export type CutStage = 'idle' | 'download' | 'breathe' | 'subtitle' | 'bgm' | 'tail' | 'normalize' | 'uploading'
export type CutReviewStatus = 'none' | 'in_review' | 'approved' | 'rejected'

export interface SubtitleStyle {
  fontName: string
  fontSize: number
  fontColor: string
  outlineColor: string
  outlineWidth: number
  backgroundEnabled: boolean
  backgroundColor: string
  backgroundOpacity: number
  position: 'top' | 'center' | 'bottom'
  alignment: 'center' | 'left' | 'right'
}

export interface CutSegment {
  index: number
  text: string
  startMs: number
  endMs: number
  kind: 'normal' | 'risk'
  edited: boolean
}

export interface BgmItem {
  id: string
  name: string
  storageKey: string
  durationMs: number
  sizeBytes: number
  enabled: boolean
  createdAt: string | null
}

export interface VideoCut {
  id: string
  videoJobId: string
  versionNo: number
  status: CutStatus
  renderStage: CutStage
  progress: number
  baseVersionNo: number
  subtitleEnabled: boolean
  subtitleStyle: SubtitleStyle
  segments: CutSegment[]
  riskTailEnabled: boolean
  riskTailText: string | null
  riskTailSeconds: number
  bgmEnabled: boolean
  bgmId: string | null
  bgmVolume: number
  bgmFadeIn: number
  bgmFadeOut: number
  breatheEnabled: boolean
  breatheParams: { noiseDb: number; minSilenceMs: number; keepGapMs: number } | null
  resultKey: string | null
  durationMs: number
  width: number
  height: number
  timeline: TimelineItem[] | null
  contentHash: string | null
  reviewStatus: CutReviewStatus
  approvedContentHash: string | null
  isMock: boolean
  errorCode: string | null
  errorMessage: string | null
  createdAt: string | null
}

export interface CutConfig {
  draft: VideoCut
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

export interface CutConfigInput {
  subtitleEnabled?: boolean
  subtitleStyle?: Partial<SubtitleStyle>
  segments?: Array<{ index: number; text: string }>
  riskTailEnabled?: boolean
  riskTailSeconds?: number
  bgmEnabled?: boolean
  bgmId?: string | null
  bgmVolume?: number
  bgmFadeIn?: number
  bgmFadeOut?: number
  breatheEnabled?: boolean
  breatheParams?: { noiseDb?: number; minSilenceMs?: number; keepGapMs?: number }
}

export interface CutReviewSubmission {
  id: string
  cutId: string
  cutVersionNo: number
  contentHash: string | null
  status: 'submitted' | 'gate1' | 'gate2' | 'gate3' | 'pending_manual' | 'approved' | 'rejected'
  gates: Array<{ gate: string; result: 'pass' | 'fail'; reason: string }> | null
  riskPoints: string[] | null
  decisionBy: string | null
  decisionAt: string | null
  decisionReason: string | null
  createdAt: string | null
}

export interface CutVersionView {
  cut: VideoCut
  url: string | null
  coverUrl: string | null
  submission: CutReviewSubmission | null
}

export interface FinalVideo {
  cutId: string
  videoJobId: string
  versionNo: number
  copyId: string
  copyVersionId: string
  copyVersionNo: number
  url: string
  coverUrl: string | null
  durationMs: number
  width: number
  height: number
  timeline: TimelineItem[]
  reviewStatus: CutReviewStatus
  isMock: boolean
}

export interface CutReviewQueueItem {
  cut: VideoCut
  submission: CutReviewSubmission | null
  copyTitle: string | null
  url: string | null
}

export const cutApi = {
  getConfig: (jobId: string) => apiGet<CutConfig>(`/video/jobs/${jobId}/cut-config`),
  saveConfig: (jobId: string, input: CutConfigInput) => apiPut<VideoCut>(`/video/jobs/${jobId}/cut-config`, input),
  createVersion: (jobId: string, idempotencyKey: string) =>
    apiPost<{ cut: VideoCut; idempotent: boolean }>(
      `/video/jobs/${jobId}/cut-versions`,
      {},
      { 'Idempotency-Key': idempotencyKey },
    ),
  listVersions: (jobId: string) => apiGet<{ versions: VideoCut[] }>(`/video/jobs/${jobId}/cut-versions`),
  getCut: (cutId: string) => apiGet<CutVersionView>(`/video/cuts/${cutId}`),
  cancel: (cutId: string) => apiPost<VideoCut>(`/video/cuts/${cutId}/cancel`),
  retryRender: (cutId: string) => apiPost<VideoCut>(`/video/cuts/${cutId}/retry-render`),
  submitReview: (cutId: string) =>
    apiPost<{ submission: CutReviewSubmission; idempotent: boolean }>(`/video/cuts/${cutId}/review`),
  getReview: (cutId: string) =>
    apiGet<{
      submission: CutReviewSubmission | null
      diff: Array<{ index: number; original: string; edited: string; kind: string }>
    }>(`/video/cuts/${cutId}/review`),
  decide: (cutId: string, result: 'approved' | 'rejected', reason?: string) =>
    apiPost<CutReviewSubmission>(`/video/cuts/${cutId}/review/decision`, { result, reason }),
  reviewQueue: (query?: { status?: string; line?: string }) =>
    apiGet<{ items: CutReviewQueueItem[] }>('/cut-review/queue', query as Record<string, QueryValue>),
  getFinal: (cutId: string) => apiGet<FinalVideo>(`/video/cuts/${cutId}/final`),
  listBgm: () => apiGet<{ items: BgmItem[] }>('/cut/bgm'),
  uploadBgm: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return fetch(`/api/cut/bgm`, { method: 'POST', body: fd, headers: authedHeaders() }).then(async (res) => {
      const raw = await res.json().catch(() => ({}))
      if (!res.ok || raw?.ok === false) throw new Error(raw?.error?.message || 'BGM 上传失败')
      return raw.data as { item: BgmItem }
    })
  },
  deleteBgm: (id: string) => apiDel(`/cut/bgm/${id}`),
}

function authedHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem('mw_token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

export function fmtMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export const CUT_STATUS_LABELS: Record<CutStatus, string> = {
  draft: '草稿',
  queued: '排队中',
  rendering: '渲染中',
  cancelling: '取消中',
  completed: '已完成',
  failed: '渲染失败',
  cancelled: '已取消',
}

export const CUT_REVIEW_LABELS: Record<CutReviewStatus, string> = {
  none: '未送审',
  in_review: '复审中',
  approved: '复审通过',
  rejected: '复审退回',
}
