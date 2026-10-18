import { config } from '../../config.js'

/**
 * 文案工坊领域常量（任务书 §2/§3）。
 * 所有可调参数集中在 config.copy，便于校准（AC-R3 / F5）。
 */

export type CopySource = 'news' | 'benchmark' | 'article' | 'manual'
export type CopyLine = 'manager' | 'kos' | 'persona'
export type CopyStatus = 'draft' | 'in_review' | 'approved' | 'rejected' | 'archived'
/** 列表派生状态（不入库，§3.1）：draft 且无稿 = pending_write；draft 且有 approved_version_id = revising */
export type CopyDerivedStatus = 'pending_write' | 'writing' | 'in_review' | 'rejected' | 'approved' | 'revising'
export type DurationTier = 'short' | 'medium' | 'long' | 'custom'
export type GenerationMode = CopySource
export type GenerationStatus = 'pending' | 'running' | 'done' | 'partial' | 'failed'
export type VersionOrigin = 'ai_generate' | 'manual_save' | 'variant' | 'restore' | 'submit'
export type DraftOrigin = 'ai' | 'manual' | 'variant' | 'copy'

/** §3.3 时长档：字数区间 = 时长 × 3–4 字/秒 */
export interface DurationTierDef {
  key: DurationTier
  name: string
  minSeconds: number
  maxSeconds: number
  minWords: number
  maxWords: number
  /** custom 由调用方传 durationSeconds 换算 */
  custom?: boolean
}

export const DURATION_TIERS: DurationTierDef[] = [
  { key: 'short', name: '短（15–30 秒）', minSeconds: 15, maxSeconds: 30, minWords: 45, maxWords: 120 },
  { key: 'medium', name: '中（45–60 秒）', minSeconds: 45, maxSeconds: 60, minWords: 135, maxWords: 240 },
  { key: 'long', name: '长（90–120 秒）', minSeconds: 90, maxSeconds: 120, minWords: 270, maxWords: 480 },
  {
    key: 'custom',
    name: '自定义',
    minSeconds: config.copy.customDurationMin,
    maxSeconds: config.copy.customDurationMax,
    minWords: config.copy.customDurationMin * 3,
    maxWords: config.copy.customDurationMax * 4,
    custom: true,
  },
]

export function tierOf(key: string): DurationTierDef | undefined {
  return DURATION_TIERS.find((t) => t.key === key)
}

/**
 * 计算目标字数区间。
 * custom：N×3 – N×4（v1.1 Q3）；三档用固定区间。
 */
export function wordRangeOf(tier: string, durationSeconds?: number | null): { min: number; max: number; seconds: number | null } {
  const def = tierOf(tier) ?? tierOf('medium')!
  if (def.key === 'custom') {
    const sec = Number(durationSeconds)
    if (!Number.isFinite(sec) || sec <= 0) {
      const s = def.minSeconds
      return { min: s * 3, max: s * 4, seconds: s }
    }
    return { min: Math.round(sec * 3), max: Math.round(sec * 4), seconds: Math.round(sec) }
  }
  return { min: def.minWords, max: def.maxWords, seconds: def.maxSeconds }
}

/** 建议字数（区间中值），用于提示词里的「建议 N 字左右」 */
export function targetWordsOf(tier: string, durationSeconds?: number | null): number {
  const r = wordRangeOf(tier, durationSeconds)
  return Math.round((r.min + r.max) / 2)
}

/** 审核单状态（§3.1，审核模块所有，桩同构） */
export type SubmissionStatus =
  | 'submitted'
  | 'gate1'
  | 'gate2'
  | 'gate3'
  | 'pending_manual'
  | 'approved'
  | 'rejected'
  | 'withdrawn'

/** 三关名称（步骤条与提示文案） */
export const GATE_LABELS: Record<string, string> = {
  submitted: '已提交',
  gate1: '第 1 关 · 合规词与禁用表述',
  gate2: '第 2 关 · 事实与风险点',
  gate3: '第 3 关 · 风险提示追加',
  pending_manual: '待人工复核',
  manual: '人工复核', // 人工退回时 rejected_gate 的取值
  approved: '审核通过',
  rejected: '已退回',
  withdrawn: '已撤回',
}

/** 可撤回的状态（W12：进入 pending_manual 之前） */
export const WITHDRAWABLE_STATUSES: SubmissionStatus[] = ['submitted', 'gate1', 'gate2', 'gate3']

/** 来源中文名（列表、来源卡） */
export const SOURCE_LABELS: Record<string, string> = {
  news: '爆款选题 / 资讯',
  benchmark: '对标改写',
  article: '文章',
  manual: '手动输入',
}

export const DERIVED_STATUS_LABELS: Record<CopyDerivedStatus, string> = {
  pending_write: '待写作',
  writing: '写作中',
  in_review: '审核中',
  rejected: '已退回',
  approved: '已通过',
  revising: '修订中',
}

export const LINE_LABELS: Record<string, string> = {
  manager: '经理 IP',
  kos: '员工 KOS',
  persona: '素人矩阵',
}

/** 审核单状态文案（前端审核进度块直接展示） */
export const SUBMISSION_STATUS_LABELS: Record<string, string> = {
  submitted: '已提交',
  gate1: '预检中（合规）',
  gate2: '预检中（事实）',
  gate3: '预检中（风格）',
  pending_manual: '待人工复核',
  approved: '已通过',
  rejected: '已驳回',
  withdrawn: '已撤回',
}

/** 结构化正文段落（W4：纯文本） */
export interface Section {
  label: string
  text: string
  /** article 模式：对应大纲节点序号，需非递减（AC-G3） */
  sourceRefs?: number[]
}

/** 风险提示块默认文案（模板未配 riskHint 时兜底） */
export const DEFAULT_RISK_HINT = '本内容仅供参考，不构成投资建议。市场有风险，投资须谨慎。'
