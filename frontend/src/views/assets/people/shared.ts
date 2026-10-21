import { Message } from '@arco-design/web-vue'
import { ApiError } from '@/api/client'
import type { AssetKind, AssetStatus, AuthorizationStatus, EffectiveStatus, PersonaExtraTag, PersonaOptions } from '@/api/personas'

/** 把任意异常转成给用户看的一句话（业务码已由后端翻译成中文） */
export function errMsg(e: unknown, fallback = '操作失败'): string {
  if (e instanceof ApiError) return e.message || fallback
  if (e instanceof Error) return e.message || fallback
  return fallback
}

export function toastError(e: unknown, fallback?: string): void {
  Message.error(errMsg(e, fallback))
}

export function isApiCode(e: unknown, code: string): boolean {
  return e instanceof ApiError && e.code === code
}

/** 幂等键：一次「打开弹窗」只生成一个，重试沿用，避免网络抖动时重复扣费（R13） */
export function newIdempotencyKey(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${rand}`
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '—'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`
}

export function fmtSize(bytes: number | null | undefined): string {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return '—'
  return String(v).slice(0, 10)
}

export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 有效状态 → 标签样式（对应 §3.2） */
export const STATUS_TAG: Record<EffectiveStatus, string> = {
  active: 'mw-tag-green',
  auth_pending: 'mw-tag-yellow',
  auth_expired: 'mw-tag-red',
  auth_revoked: 'mw-tag-red',
  disabled: 'mw-tag-gray',
  archived: 'mw-tag-gray',
}

export const EXTRA_TAGS: Record<PersonaExtraTag, { text: string; cls: string }> = {
  voice_unconfirmed: { text: '声音待确认', cls: 'mw-tag-yellow' },
  avatar_in_progress: { text: '分身制作中', cls: 'mw-tag-blue' },
  uncertain: { text: '状态待核对', cls: 'mw-tag-orange' },
  auth_expiring: { text: '授权将到期', cls: 'mw-tag-orange' },
  incomplete: { text: '待完善', cls: 'mw-tag-gray' },
  configured: { text: '已配置', cls: 'mw-tag-green' },
}

export const ASSET_STATUS: Record<AssetStatus, { text: string; cls: string }> = {
  uploaded: { text: '处理中', cls: 'mw-tag-blue' },
  processing: { text: '处理中', cls: 'mw-tag-blue' },
  pending_review: { text: '待审核', cls: 'mw-tag-yellow' },
  approved: { text: '已通过', cls: 'mw-tag-green' },
  rejected: { text: '已驳回', cls: 'mw-tag-red' },
  failed: { text: '处理失败', cls: 'mw-tag-red' },
}

export const AUTH_STATUS: Record<AuthorizationStatus, { text: string; cls: string }> = {
  pending: { text: '待核验', cls: 'mw-tag-yellow' },
  verified: { text: '已核验', cls: 'mw-tag-green' },
  rejected: { text: '已驳回', cls: 'mw-tag-red' },
  revoked: { text: '已撤销', cls: 'mw-tag-red' },
  expired: { text: '已过期', cls: 'mw-tag-red' },
}

export const SCOPE_LABEL: Record<string, string> = { portrait: '肖像', voice: '声音', share: '允许共享' }

export const CLONE_STATUS: Record<string, { text: string; cls: string }> = {
  pending: { text: '排队中', cls: 'mw-tag-blue' },
  submitting: { text: '提交中', cls: 'mw-tag-blue' },
  running: { text: '制作中', cls: 'mw-tag-blue' },
  ready: { text: '可用', cls: 'mw-tag-green' },
  failed: { text: '失败', cls: 'mw-tag-red' },
  uncertain: { text: '状态待核对', cls: 'mw-tag-orange' },
}

export const LINE_LABEL: Record<string, string> = { manager: '经理 IP', kos: '员工 KOS', persona: '素人矩阵' }

export const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  kuaishou: '快手',
  shipinhao: '视频号',
}

export const TRIGGER_LABEL: Record<string, string> = {
  migrate: '存量迁移',
  profile: '保存定位',
  default_avatar: '默认分身变化',
  default_voice: '默认声音变化',
  voice_settings: '声音参数变化',
}

/** 今天 / 若干天后的 YYYY-MM-DD（授权日期默认值） */
export function dayOffset(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 克隆能力是否对该线开放（素人线不使用数字人口播，Q3） */
export function lineSupportsClone(line: string): boolean {
  return line === 'manager' || line === 'kos'
}

/** 上传前的本地预检（扩展名 / 大小）：与后端 UPLOAD_LIMITS 同口径，避免大文件白传；魔数与结构仍以服务端为准 */
export function checkUploadFile(options: PersonaOptions | null, kind: AssetKind, file: File): string | null {
  const limit = options?.uploadLimits?.[kind]
  if (!limit) return null
  const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`
  if (!limit.exts.includes(ext)) return `仅支持 ${limit.exts.join(' / ')}`
  if (file.size > limit.maxBytes) return `文件超过 ${Math.round(limit.maxBytes / 1024 / 1024)}MB 上限`
  return null
}

/** 已核验、未过期、范围含指定项的授权（制作分身 / 克隆声音时可选） */
export function usableAuthorizations<T extends { status: string; scopes: string[] }>(auths: T[], scope: 'portrait' | 'voice'): T[] {
  return auths.filter((a) => a.status === 'verified' && a.scopes.includes(scope))
}
