import type {
  AuthorizationScope,
  AuthorizationStatus,
  EffectiveStatus,
  PersonaExtraTag,
  PersonaLine,
} from './types.js'
import { EFFECTIVE_STATUS_LABELS } from './types.js'
import { fromDb } from '../../lib/time.js'

/**
 * 人物有效状态派生（R23 平移众墅之家 character_policy）。
 * 纯函数：入库前判定 + 单测覆盖 §3.2 全部分支（AC-U7）。
 * 「存储状态 + 授权状态 + 到期时间」→ 有效状态；到期**读时判定**，不依赖定时任务。
 */

export interface AuthorizationLike {
  id: string
  status: string // pending | verified | rejected | revoked
  scopes: AuthorizationScope[]
  expiresAt: string | null
}

export interface PersonaPolicyInput {
  line: PersonaLine
  enabled: boolean
  archivedAt: string | null
  /** 授权是否强制（经理/KOS 必须，素人不强制） */
  authRequired: boolean
}

export interface DerivedStatus {
  status: EffectiveStatus
  label: string
  usable: boolean
  /** 不可用的结构化原因（前端展示 / 下游报错） */
  reasons: Array<{ code: string; message: string }>
  extraTags: PersonaExtraTag[]
  /** 覆盖肖像 / 声音的有效授权 id（供分身 / 声音可用性判定） */
  validPortraitAuthIds: string[]
  validVoiceAuthIds: string[]
  /** 覆盖「允许共享」的有效授权 id */
  validShareAuthIds: string[]
  /** 30 天内到期的授权 id */
  expiringAuthIds: string[]
}

/** 名称规范化：忽略首尾空白与全半角差异（FR-L2）。NFKC 统一全半角，折叠内部空白 */
export function normalizeNameKey(name: string): string {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/** 读时派生授权状态：verified 且已到期 → expired（FR-U3） */
export function authorizationEffectiveStatus(
  auth: { status: string; expiresAt: string | null },
  now: Date = new Date(),
): AuthorizationStatus {
  if (auth.status === 'revoked') return 'revoked'
  if (auth.status === 'rejected') return 'rejected'
  if (auth.status === 'pending') return 'pending'
  if (auth.status !== 'verified') return auth.status as AuthorizationStatus
  if (!auth.expiresAt) return 'verified'
  const expires = fromDb(auth.expiresAt)
  if (!expires) return 'verified'
  return new Date(expires).getTime() <= now.getTime() ? 'expired' : 'verified'
}

/** 授权是否有效（verified 且未过期） */
export function isAuthorizationValid(
  auth: { status: string; expiresAt: string | null },
  now: Date = new Date(),
): boolean {
  return authorizationEffectiveStatus(auth, now) === 'verified'
}

/** 30 天内到期（含已过期当天之前） */
export function isExpiringSoon(
  auth: { status: string; expiresAt: string | null },
  now: Date = new Date(),
  days = 30,
): boolean {
  if (authorizationEffectiveStatus(auth, now) !== 'verified' || !auth.expiresAt) return false
  const expires = fromDb(auth.expiresAt)
  if (!expires) return false
  const ms = new Date(expires).getTime() - now.getTime()
  return ms > 0 && ms <= days * 86_400_000
}

export interface ExtraStateInput {
  avatars: Array<{ status: string; deletedAt: string | null }>
  voices: Array<{ status: string; confirmed: boolean; deletedAt: string | null }>
  /** 是否已有 ready 默认分身（用于「待完善」判定） */
  hasDefaultAvatar: boolean
  hasConfirmedDefaultVoice: boolean
  /** readiness(avatar_video) 是否全过（用于「已配置」；素人线用 copy） */
  configured: boolean
}

/**
 * §3.2 有效状态派生：按顺序取第一个命中。
 * 归档 > 停用 > 授权撤销 > 授权过期 > 授权待核验 > active。
 */
export function deriveStatus(
  persona: PersonaPolicyInput,
  auths: AuthorizationLike[],
  extra: ExtraStateInput,
  now: Date = new Date(),
): DerivedStatus {
  const reasons: DerivedStatus['reasons'] = []
  const extraTags = new Set<PersonaExtraTag>()

  const live = auths.filter((a) => a.status !== 'revoked' && a.status !== 'rejected')
  const valid = live.filter((a) => isAuthorizationValid(a, now))
  const revoked = live.filter((a) => a.status === 'revoked')
  const expired = live.filter((a) => authorizationEffectiveStatus(a, now) === 'expired')
  const pending = live.filter((a) => a.status === 'pending')

  const validPortraitAuthIds = valid.filter((a) => a.scopes.includes('portrait')).map((a) => a.id)
  const validVoiceAuthIds = valid.filter((a) => a.scopes.includes('voice')).map((a) => a.id)
  const validShareAuthIds = valid.filter((a) => a.scopes.includes('share')).map((a) => a.id)
  const expiringAuthIds = live.filter((a) => isExpiringSoon(a, now)).map((a) => a.id)

  // 附加标签（不影响 usable）
  const uncertain = [...extra.avatars, ...extra.voices].some((x) => x.status === 'uncertain' && !x.deletedAt)
  const inProgress = [...extra.avatars, ...extra.voices].some(
    (x) => (x.status === 'pending' || x.status === 'submitting' || x.status === 'running') && !x.deletedAt,
  )
  const unconfirmedVoice = extra.voices.some((v) => v.status === 'ready' && !v.confirmed && !v.deletedAt)
  if (unconfirmedVoice) extraTags.add('voice_unconfirmed')
  if (inProgress) extraTags.add('avatar_in_progress')
  if (uncertain) extraTags.add('uncertain')
  if (expiringAuthIds.length) extraTags.add('auth_expiring')
  if (persona.authRequired && (!extra.hasDefaultAvatar || !extra.hasConfirmedDefaultVoice)) extraTags.add('incomplete')
  if (extra.configured) extraTags.add('configured')

  let status: EffectiveStatus = 'active'
  if (persona.archivedAt) status = 'archived'
  else if (!persona.enabled) status = 'disabled'
  else if (persona.authRequired && valid.length === 0) {
    // 无有效授权：撤销 > 过期 > 待核验
    if (revoked.length) status = 'auth_revoked'
    else if (expired.length) status = 'auth_expired'
    else if (pending.length) status = 'auth_pending'
    else status = 'auth_pending'
  }

  if (status === 'archived') reasons.push({ code: 'PERSONA_ARCHIVED', message: '人物已归档' })
  if (status === 'disabled') reasons.push({ code: 'PERSONA_DISABLED', message: '人物已停用' })
  if (status === 'auth_revoked') reasons.push({ code: 'AUTH_REVOKED', message: '授权已撤销，人物不可用' })
  if (status === 'auth_expired') reasons.push({ code: 'AUTH_EXPIRED', message: '授权已过期，人物不可用' })
  if (status === 'auth_pending') reasons.push({ code: 'AUTH_PENDING', message: '授权待核验，人物不可用' })

  return {
    status,
    label: EFFECTIVE_STATUS_LABELS[status],
    usable: status === 'active',
    reasons,
    extraTags: [...extraTags],
    validPortraitAuthIds,
    validVoiceAuthIds,
    validShareAuthIds,
    expiringAuthIds,
  }
}

/** 资产可用性判定（§3.2） */
export function isAssetUsable(status: string, deletedAt: string | null): boolean {
  return status === 'approved' && !deletedAt
}

export function isAvatarUsable(
  avatar: { status: string; deletedAt: string | null; authorizationId: string },
  validAuthIds: string[],
): boolean {
  return avatar.status === 'ready' && !avatar.deletedAt && validAuthIds.includes(avatar.authorizationId)
}

export function isVoiceUsable(
  voice: { status: string; confirmed: boolean; deletedAt: string | null; authorizationId: string },
  validAuthIds: string[],
  opts: { requireShare?: boolean; shareAuthIds?: string[] } = {},
): boolean {
  if (voice.status !== 'ready' || !voice.confirmed || voice.deletedAt) return false
  if (!validAuthIds.includes(voice.authorizationId)) return false
  if (opts.requireShare && !(opts.shareAuthIds ?? []).includes(voice.authorizationId)) return false
  return true
}
