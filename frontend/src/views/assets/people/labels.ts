import type { AssetStatus, AuthorizationScope, EffectiveStatus, PersonaExtraTag, PersonaReminder } from '@/api/personas'

/** 人物库界面用到的状态文案与配色（与服务端 types.ts 保持一致） */

type Tone = 'green' | 'yellow' | 'red' | 'gray' | 'blue'

export const toneClass = (tone: Tone): string => `mw-tag-${tone}`

export const PERSONA_STATUS: Record<EffectiveStatus, { label: string; tone: Tone }> = {
  active: { label: '可用', tone: 'green' },
  auth_pending: { label: '授权待核验', tone: 'yellow' },
  auth_expired: { label: '授权已过期', tone: 'red' },
  auth_revoked: { label: '授权已撤销', tone: 'red' },
  disabled: { label: '已停用', tone: 'gray' },
  archived: { label: '已归档', tone: 'gray' },
}

export const EXTRA_TAGS: Record<PersonaExtraTag, { label: string; tone: Tone }> = {
  voice_unconfirmed: { label: '声音待确认', tone: 'yellow' },
  avatar_in_progress: { label: '分身制作中', tone: 'blue' },
  uncertain: { label: '状态待核对', tone: 'red' },
  auth_expiring: { label: '授权将到期', tone: 'yellow' },
  incomplete: { label: '待完善', tone: 'gray' },
  configured: { label: '已配置', tone: 'green' },
}

export const ASSET_STATUS: Record<AssetStatus, { label: string; tone: Tone }> = {
  uploaded: { label: '已上传', tone: 'gray' },
  processing: { label: '处理中', tone: 'blue' },
  pending_review: { label: '待审核', tone: 'yellow' },
  approved: { label: '已通过', tone: 'green' },
  rejected: { label: '已驳回', tone: 'red' },
  failed: { label: '处理失败', tone: 'red' },
}

export const CLONE_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '排队中', tone: 'gray' },
  submitting: { label: '提交中', tone: 'blue' },
  running: { label: '制作中', tone: 'blue' },
  ready: { label: '可用', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  uncertain: { label: '待核对', tone: 'red' },
}

export const AUTH_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '待核验', tone: 'yellow' },
  verified: { label: '已核验', tone: 'green' },
  rejected: { label: '已驳回', tone: 'red' },
  revoked: { label: '已撤销', tone: 'gray' },
  expired: { label: '已过期', tone: 'red' },
}

export const SCOPE_LABELS: Record<AuthorizationScope, string> = {
  portrait: '肖像',
  voice: '声音',
  share: '允许共享',
}

export const REMINDER_LABELS: Record<PersonaReminder['kind'], string> = {
  auth_expiring: '授权即将到期',
  auth_expired: '授权已到期',
  clone_uncertain: '克隆状态待核对',
  clone_failed: '克隆失败',
}

export function fmtTime(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('zh-CN', { hour12: false })
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return '—'
  return String(v).slice(0, 10)
}

export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`
}

/** 幂等键：同一次点击重试复用，新操作换新键 */
export function newIdempotencyKey(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  return `${prefix}-${rand}`.slice(0, 64)
}
