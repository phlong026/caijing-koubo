import type {
  AssetStatus,
  AuthorizationScope,
  AuthorizationStatus,
  EffectiveStatus,
  PersonaAuthorization,
  PersonaExtraTag,
  PersonaListItem,
} from '@/api/personas'

/** 人物库界面文案与标签色（与服务端 types.ts 的标签保持一致） */

export interface TagView {
  text: string
  cls: string
}

const STATUS_TAG: Record<EffectiveStatus, TagView> = {
  active: { text: '可用', cls: 'mw-tag-green' },
  auth_pending: { text: '授权待核验', cls: 'mw-tag-yellow' },
  auth_expired: { text: '授权已过期', cls: 'mw-tag-red' },
  auth_revoked: { text: '授权已撤销', cls: 'mw-tag-red' },
  disabled: { text: '已停用', cls: 'mw-tag-gray' },
  archived: { text: '已归档', cls: 'mw-tag-gray' },
}

const EXTRA_TAG: Record<PersonaExtraTag, TagView> = {
  configured: { text: '已配置', cls: 'mw-tag-green' },
  incomplete: { text: '待完善', cls: 'mw-tag-yellow' },
  voice_unconfirmed: { text: '声音待确认', cls: 'mw-tag-yellow' },
  avatar_in_progress: { text: '分身制作中', cls: 'mw-tag-blue' },
  uncertain: { text: '状态待核对', cls: 'mw-tag-orange' },
  auth_expiring: { text: '授权将到期', cls: 'mw-tag-orange' },
}

/** 卡片状态标签：有效状态（非可用时）+ 附加标签 */
export function personaTags(p: Pick<PersonaListItem, 'status' | 'extraTags'>): TagView[] {
  const tags: TagView[] = []
  if (p.status !== 'active') tags.push(STATUS_TAG[p.status])
  for (const t of p.extraTags) tags.push(EXTRA_TAG[t])
  if (!tags.length) tags.push(STATUS_TAG.active)
  return tags
}

export const ASSET_STATUS_TAG: Record<AssetStatus, TagView> = {
  uploaded: { text: '处理中', cls: 'mw-tag-blue' },
  processing: { text: '处理中', cls: 'mw-tag-blue' },
  pending_review: { text: '待审核', cls: 'mw-tag-yellow' },
  approved: { text: '已通过', cls: 'mw-tag-green' },
  rejected: { text: '已驳回', cls: 'mw-tag-red' },
  failed: { text: '质检未过', cls: 'mw-tag-red' },
}

/** 分身 / 声音的克隆状态（声音 running 显示「克隆中」） */
export function cloneStatusTag(status: string, kind: 'avatar' | 'voice'): TagView {
  const map: Record<string, TagView> = {
    pending: { text: '排队中', cls: 'mw-tag-blue' },
    submitting: { text: '提交中', cls: 'mw-tag-blue' },
    running: { text: kind === 'voice' ? '克隆中' : '制作中', cls: 'mw-tag-blue' },
    ready: { text: '可用', cls: 'mw-tag-green' },
    failed: { text: '失败', cls: 'mw-tag-red' },
    uncertain: { text: '待核对', cls: 'mw-tag-orange' },
  }
  return map[status] ?? { text: status, cls: 'mw-tag-gray' }
}

export const AUTH_STATUS_TAG: Record<AuthorizationStatus, TagView> = {
  pending: { text: '待核验', cls: 'mw-tag-yellow' },
  verified: { text: '已核验', cls: 'mw-tag-green' },
  rejected: { text: '已驳回', cls: 'mw-tag-red' },
  revoked: { text: '已撤销', cls: 'mw-tag-red' },
  expired: { text: '已过期', cls: 'mw-tag-red' },
}

export const SCOPE_LABELS: Record<AuthorizationScope, string> = {
  portrait: '肖像',
  voice: '声音',
  share: '允许共享',
}

export function scopeText(scopes: AuthorizationScope[]): string {
  return scopes.map((s) => SCOPE_LABELS[s]).join(' / ')
}

/** 日期只取 YYYY-MM-DD（后端返回 ISO 或日期串） */
export function dateOnly(v: string | null | undefined): string {
  return v ? v.slice(0, 10) : '—'
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms && ms !== 0) return ''
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const EXPIRING_DAYS = 30

/** 授权摘要（详情面板「授权材料」一行） */
export function authorizationSummary(auths: PersonaAuthorization[]): TagView {
  const verified = auths.filter((a) => a.status === 'verified' && !isExpired(a))
  if (verified.length) {
    // 有任一份不设到期日的授权即视为长期有效
    if (verified.some((a) => !a.expiresAt)) return { text: '已核验 · 长期有效', cls: 'mw-tag-green' }
    const latest = verified.map((a) => a.expiresAt as string).sort().reverse()[0]
    const days = (new Date(latest).getTime() - Date.now()) / 86_400_000
    if (days <= EXPIRING_DAYS) return { text: `即将到期 · ${dateOnly(latest)}`, cls: 'mw-tag-orange' }
    return { text: `已核验 · 至 ${dateOnly(latest)}`, cls: 'mw-tag-green' }
  }
  if (auths.some((a) => a.status === 'pending')) return { text: '待核验', cls: 'mw-tag-yellow' }
  if (auths.some((a) => a.status === 'expired')) return { text: '已过期', cls: 'mw-tag-red' }
  if (auths.some((a) => a.status === 'revoked')) return { text: '已撤销', cls: 'mw-tag-red' }
  return { text: '未上传', cls: 'mw-tag-gray' }
}

/** 可选用于克隆的授权：已核验、未过期、范围包含指定项 */
export function usableAuthorizations(auths: PersonaAuthorization[], scope: AuthorizationScope): PersonaAuthorization[] {
  return auths.filter((a) => a.status === 'verified' && !isExpired(a) && a.scopes.includes(scope))
}

/** 后端读时派生 expired，这里再按到期时间兜底一次（页面停留跨过到期时刻的情况） */
function isExpired(a: PersonaAuthorization): boolean {
  return a.status === 'expired' || (!!a.expiresAt && new Date(a.expiresAt).getTime() <= Date.now())
}

/** 幂等键：每次打开制作 / 克隆弹窗生成一次，重复点击提交复用同一个（沿用文案生成的写法） */
export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
