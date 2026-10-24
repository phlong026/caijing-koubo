import type { TimelineItem } from '../video/types.js'

/**
 * 视频剪辑模块类型（任务书 §2/§3/§4）。
 * 输入消费视频创作 FR-X1（base.ts BaseVideoPayload：url / timeline / riskText）。
 */

export type CutStatus = 'draft' | 'queued' | 'rendering' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
export type CutStage = 'idle' | 'download' | 'breathe' | 'subtitle' | 'bgm' | 'tail' | 'normalize' | 'uploading'
export type CutReviewStatus = 'none' | 'in_review' | 'approved' | 'rejected'

export interface SubtitleStyle {
  /** 字体文件名（白名单：内置字体目录内文件，不含路径分隔符） */
  fontName: string
  fontSize: number
  fontColor: string
  outlineColor: string
  outlineWidth: number
  /** 背景框开关与不透明度（BorderStyle 3） */
  backgroundEnabled: boolean
  backgroundColor: string
  backgroundOpacity: number
  position: 'top' | 'center' | 'bottom'
  alignment: 'center' | 'left' | 'right'
}

/** 字幕分段编辑结果：index 与 base 时间轴一一对应；risk 段锁定 */
export interface CutSegment {
  index: number
  text: string
  startMs: number
  endMs: number
  kind: 'normal' | 'risk'
  edited: boolean
}

export interface BreatheParams {
  noiseDb: number
  minSilenceMs: number
  keepGapMs: number
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
  breatheParams?: Partial<BreatheParams>
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
  breatheParams: BreatheParams | null
  resultKey: string | null
  coverKey: string | null
  durationMs: number
  width: number
  height: number
  timeline: TimelineItem[] | null
  cutTextHash: string | null
  contentHash: string | null
  reviewStatus: CutReviewStatus
  approvedContentHash: string | null
  isMock: boolean
  errorCode: string | null
  errorMessage: string | null
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** 静音段（秒，silencedetect 输出） */
export interface SilenceSpan {
  startSec: number
  endSec: number
}

/** 保留段（毫秒，剪气口补集） */
export interface KeepSpan {
  startMs: number
  endMs: number
}

/** 成片取用契约（EC11：含发布消费字段的同形 payload，非 FR-X1 全量同构） */
export interface FinalVideoPayload {
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

export interface BgmItem {
  id: string
  name: string
  storageKey: string
  durationMs: number
  sizeBytes: number
  enabled: boolean
  createdAt: string | null
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontName: 'default',
  fontSize: 64,
  fontColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 2,
  backgroundEnabled: false,
  backgroundColor: '#000000',
  backgroundOpacity: 0.5,
  position: 'bottom',
  alignment: 'center',
}
