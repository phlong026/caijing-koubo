/**
 * 视频创作模块共享类型（任务书 §3 状态机 / §4 数据模型 / V1~V14 决策）。
 * 阶段语义平移众墅之家 `oral_tasks`（QUEUED→waiting/preparing、SUBMITTING→submitting、
 * RUNNING→generating/recovering、ARCHIVING→downloading/verifying、SUCCEEDED→completed、
 * ARCHIVE_FAILED→save_failed、SUBMISSION_UNCERTAIN→submission_unknown、FAILED→failed），
 * 增加 aligning（时间轴对齐）与混剪的 tts / composing。
 */

/** video_job 阶段（§3.1） */
export type VideoPhase =
  // 数字人口播主链
  | 'waiting'
  | 'preparing'
  | 'submitting'
  | 'generating'
  | 'recovering'
  | 'downloading'
  | 'verifying'
  | 'aligning'
  | 'completed'
  // 混剪专属（配音 / 合成）
  | 'tts'
  | 'composing'
  // 异常与半终态（需人工动作）
  | 'failed'
  | 'save_failed'
  | 'submission_unknown'
  | 'paused'
  | 'cancelled'

/** 终态：不再推进 */
export const TERMINAL_PHASES: readonly VideoPhase[] = ['completed', 'failed', 'cancelled']
/** 半终态：等待人工动作（重试下载 / 查询原任务 / 继续查询） */
export const SEMI_TERMINAL_PHASES: readonly VideoPhase[] = ['save_failed', 'submission_unknown', 'paused']

export function isTerminalPhase(p: VideoPhase): boolean {
  return TERMINAL_PHASES.includes(p)
}
export function isSemiTerminalPhase(p: VideoPhase): boolean {
  return SEMI_TERMINAL_PHASES.includes(p)
}

/** 非终态引用（FR-S3 删除守卫口径：waiting…aligning，含半终态） */
export function isNonTerminalPhase(p: VideoPhase): boolean {
  return !isTerminalPhase(p)
}

/**
 * 进度下限（单调不回退，R1 `PHASE_FLOORS` 同构）。
 * generating 内按「已耗时 / 预计生成秒数」在 8→89 推进；
 * 混剪 composing 按 ffmpeg out_time_us 在 20→93 推进。
 */
export const PHASE_FLOORS: Record<VideoPhase, number> = {
  waiting: 0,
  preparing: 2,
  tts: 2,
  submitting: 5,
  generating: 8,
  recovering: 8,
  downloading: 90,
  verifying: 94,
  aligning: 97,
  composing: 20,
  completed: 100,
  failed: 0,
  save_failed: 0,
  submission_unknown: 0,
  paused: 0,
  cancelled: 0,
}

export type VideoMode = 'avatar' | 'mixcut'
export type GenMode = 'tts' | 'audio'
export type TimelineSource = 'aligned' | 'estimated' | 'measured'

/** 口播文本快照分段（FR-P1；风险段为最后一段 kind=risk） */
export interface TextSegment {
  index: number
  sectionIndex: number
  kind: 'normal' | 'risk'
  text: string
}

/** 时间轴条目：字幕文本永远取过审原文（V6，ASR 只借时间不借文字） */
export interface TimelineItem {
  index: number
  kind: 'normal' | 'risk'
  text: string
  startMs: number
  endMs: number
}

/** 口播文本快照（不可变，与 copy_version_id 一一对应） */
export interface TextSnapshot {
  segments: TextSegment[]
  /** 各段原文按顺序以换行拼接，逐字等于过审原文 + 风险话术 */
  submitText: string
  textHash: string
  charCount: number
  estSeconds: number
}

/** 创建时冻结的人物资产快照（FR-A6 / FR-S2） */
export interface ConfigSnapshot {
  personaVersionId: string | null
  avatar: {
    avatarId: string
    vendorAvatarId: string
    name: string
    backgroundLabel: string | null
    sourceWidth: number | null
    sourceHeight: number | null
  } | null
  voice: {
    voiceId: string
    vendorVoiceId: string
    name: string
    language: string
    speechRate: number
    volume: number
    pitch: number
  } | null
  genMode: GenMode
  /** 飞影提交参数（V14）：aigc_flag、st_show=0、短引用标题 */
  submitParams: {
    vendorTitle: string
    aigcFlag: number
    subtitle: { st_show: 0 }
  }
  /** 混剪配置快照（FR-M1 / FR-M3；仅 mode=mixcut） */
  mixcut?: MixcutConfig
}

/** 混剪配置快照（FR-M1 / FR-M3） */
export interface MixcutConfig {
  packIds: string[]
  keywordGroupIds: string[]
  backgroundAssetId: string | null
  voiceSource: 'persona' | 'public'
  publicVoiceId: string | null
  display: 'fullscreen' | 'pip'
}

/** 配置检查项（V10；人物项 key 加 persona. 前缀，前端据此跳人物库对应 Tab） */
export interface PrecheckItem {
  key: string
  level: 'hard' | 'soft'
  pass: boolean
  message: string
  /** 建议动作（前端跳转入口） */
  action?: string
}

/** 任务中心「下一步动作」（FR-X2，平移众墅之家 oral_task_available_actions） */
export type NextAction =
  | 'view_progress'
  | 'retry_download'
  | 'query_original'
  | 'bind_remote'
  | 'continue_edit'
  | 'realign'
  | 'regenerate'

/** 混剪替换点（FR-M4，供剪辑模块调整与追溯） */
export interface MaterialReplacement {
  index: number
  keyword: string
  groupName: string
  itemId: string
  startMs: number
  endMs: number
}
