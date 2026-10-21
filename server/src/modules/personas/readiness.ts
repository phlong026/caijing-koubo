import { getDb, type Db } from '../../db/index.js'
import { err } from '../../errors.js'
import { hasHifly, config } from '../../config.js'
import { isOssEnabled } from '../../integrations/aliyun-oss/client.js'
import { describeHifly } from '../../integrations/hifly/client.js'
import { getPersonaById, derivePersonaStatus } from './repo.js'
import { validAuthorizationsOf } from './authorizations.js'
import { LINE_RULES, type EffectiveStatus } from './types.js'

/**
 * 对接：readiness 与 production-profile（FR-X4 / FR-X5）。
 *
 * readiness 返回 checks[{key, level, pass, message}]：
 *  - copy        = 启用 / 未归档 / 授权有效（按线）；
 *  - avatar_video = 以上 + 默认分身 ready + 默认声音 ready 且已确认 + 肖像 / 声音授权有效 + 飞影已配置（或 mock）；
 *  - mixcut      = 启用 + 空镜 ≥1（软）。
 * production-profile 是 M3（视频创作）的取用契约：硬项不过返回 409 PERSONA_NOT_READY。
 */

export type ReadinessPurpose = 'copy' | 'avatar_video' | 'mixcut'

export interface ReadinessCheck {
  key: string
  level: 'hard' | 'soft'
  pass: boolean
  message: string
}

export interface ReadinessResult {
  personaId: string
  purpose: ReadinessPurpose
  status: EffectiveStatus
  pass: boolean
  checks: ReadinessCheck[]
}

function passOf(checks: ReadinessCheck[]): boolean {
  // 软项（如空镜）只提示，不阻硬性通过（§2.7）
  return checks.filter((c) => c.level === 'hard').every((c) => c.pass)
}

function hard(key: string, pass: boolean, message: string): ReadinessCheck {
  return { key, level: 'hard', pass, message }
}
function soft(key: string, pass: boolean, message: string): ReadinessCheck {
  return { key, level: 'soft', pass, message }
}

export async function checkReadiness(
  personaId: string,
  purpose: ReadinessPurpose,
  db: Db = getDb(),
): Promise<ReadinessResult> {
  const persona = await getPersonaById(personaId, true)
  if (!persona) throw err.personaNotFound()
  const derived = await derivePersonaStatus(persona, db)
  const rule = LINE_RULES[persona.line]
  const checks: ReadinessCheck[] = []

  // 基础项：启用 / 未归档
  checks.push(hard('enabled', persona.enabled && !persona.archivedAt, persona.archivedAt ? '人物已归档' : persona.enabled ? '人物已启用' : '人物已停用'))

  if (purpose === 'copy') {
    // 授权有效（按线）：素人不强制
    if (rule.authRequired) {
      const ok = derived.status === 'active'
      checks.push(hard('authorization', ok, ok ? '授权有效' : derived.reasons.map((r) => r.message).join('；') || '授权待核验'))
    } else {
      checks.push(hard('authorization', true, '素人矩阵不强制授权'))
    }
    return { personaId, purpose, status: derived.status, pass: passOf(checks), checks }
  }

  if (purpose === 'avatar_video') {
    if (rule.authRequired) {
      const ok = derived.status === 'active'
      checks.push(hard('authorization', ok, ok ? '授权有效' : derived.reasons.map((r) => r.message).join('；') || '授权待核验'))
    } else {
      checks.push(hard('authorization', true, '素人矩阵不强制授权'))
    }
    // 默认分身 ready（authorization_id 必须选出，否则肖像授权校验恒假）
    const avatar = persona.defaultAvatarId
      ? await db.get<Record<string, any>>(
          'SELECT `id`, `status`, `vendor_avatar_id`, `authorization_id`, `deleted_at` FROM `persona_avatar` WHERE `id` = ?',
          [persona.defaultAvatarId],
        )
      : null
    const avatarReady = !!avatar && avatar.status === 'ready' && !avatar.deleted_at && !!avatar.vendor_avatar_id
    checks.push(hard('default_avatar', avatarReady, avatarReady ? '默认分身已就绪' : avatar ? `默认分身状态：${avatar.status}` : '尚未设置默认分身'))
    // 肖像授权有效（默认分身绑定）
    if (avatar) {
      const auths = await validAuthorizationsOf(personaId, db)
      const authOk = auths.some((a) => a.scopes.includes('portrait'))
      checks.push(hard('portrait_auth', authOk, authOk ? '肖像授权有效' : '肖像授权缺失或已失效'))
    }
    // 默认声音 ready 且已确认
    const voice = persona.defaultVoiceId
      ? await db.get<Record<string, any>>(
          'SELECT `id`, `status`, `confirmed`, `vendor_voice_id`, `deleted_at`, `authorization_id` FROM `persona_voice` WHERE `id` = ? AND `is_sample` = 0',
          [persona.defaultVoiceId],
        )
      : null
    const voiceReady = !!voice && voice.status === 'ready' && !!voice.confirmed && !voice.deleted_at && !!voice.vendor_voice_id
    checks.push(
      hard('default_voice', voiceReady, voiceReady ? '默认声音已就绪并确认' : voice ? `默认声音状态：${voice.status}${voice.confirmed ? '' : '（未确认）'}` : '尚未设置默认声音'),
    )
    // 声音授权有效（默认声音绑定）
    if (voice) {
      const auths = await validAuthorizationsOf(personaId, db)
      const authOk = auths.some((a) => a.scopes.includes('voice'))
      checks.push(hard('voice_auth', authOk, authOk ? '声音授权有效' : '声音授权缺失或已失效'))
    }
    // 飞影已配置（或 mock）
    const hiflyOk = hasHifly() || config.mockFallback
    checks.push(hard('hifly', hiflyOk, hiflyOk ? `飞影已配置（${describeHifly()}）` : '飞影未配置（HIFLY_API_KEY 缺失）'))
    return { personaId, purpose, status: derived.status, pass: passOf(checks), checks }
  }

  // mixcut：启用 + 空镜 ≥1（软）
  const broll = await db.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM `persona_asset` WHERE `persona_id` = ? AND `kind` = ? AND `status` = ? AND `deleted_at` IS NULL',
    [personaId, 'broll_video', 'approved'],
  )
  const brollCount = Number(broll?.c ?? 0)
  checks.push(soft('broll', brollCount >= 1, brollCount >= 1 ? `空镜 ${brollCount} 个` : '暂无空镜素材（混剪时将无空镜可用）'))
  return { personaId, purpose, status: derived.status, pass: passOf(checks), checks }
}

/* ── production-profile（FR-X5 / M3 契约）────────────────────── */

export interface ProductionProfile {
  personaId: string
  versionId: string | null
  versionNo: number | null
  name: string
  line: string
  provider: 'hifly'
  avatar: {
    avatarId: string
    vendorAvatarId: string
    name: string
    backgroundLabel: string | null
    coverUrl: string | null
    sourceWidth: number | null
    sourceHeight: number | null
  }
  voice: {
    voiceId: string
    vendorVoiceId: string
    name: string
    language: string
    speechRate: number
    volume: number
    pitch: number
    demoUrl: string | null
  }
}

/**
 * M3 取用契约。可选 ?avatarId= 指定非默认分身（视频创作屏的「背景」切换，L15）。
 * readiness(avatar_video) 硬项不过 → 409 PERSONA_NOT_READY（带 checks）。
 */
export async function getProductionProfile(personaId: string, avatarId?: string, db: Db = getDb()): Promise<ProductionProfile> {
  const readiness = await checkReadiness(personaId, 'avatar_video', db)
  if (!readiness.pass) {
    throw err.personaNotReady('人物尚未准备就绪（形象与声音未绑定）', {
      checks: readiness.checks,
      status: readiness.status,
    })
  }
  const persona = (await getPersonaById(personaId, true))!
  const targetAvatarId = avatarId || persona.defaultAvatarId!
  const avatar = await db.get<Record<string, any>>(
    'SELECT * FROM `persona_avatar` WHERE `id` = ? AND `deleted_at` IS NULL',
    [targetAvatarId],
  )
  if (!avatar || avatar.status !== 'ready' || !avatar.vendor_avatar_id) {
    throw err.personaNotReady('指定分身不可用（非 ready 或缺少厂商标识）', { avatarId: targetAvatarId, status: avatar?.status ?? null })
  }
  const voice = await db.get<Record<string, any>>(
    'SELECT * FROM `persona_voice` WHERE `id` = ? AND `is_sample` = 0 AND `deleted_at` IS NULL',
    [persona.defaultVoiceId!],
  )
  if (!voice || voice.status !== 'ready' || !voice.confirmed || !voice.vendor_voice_id) {
    throw err.personaNotReady('默认声音不可用（未就绪 / 未确认）')
  }
  const asset = await db.get<Record<string, any>>('SELECT `thumb_key`, `width`, `height` FROM `persona_asset` WHERE `id` = ?', [
    avatar.source_asset_id,
  ])
  const version = await db.get<{ id: string; version_no: number }>(
    'SELECT `id`, `version_no` FROM `persona_version` WHERE `id` = ?',
    [persona.currentVersionId ?? ''],
  )
  return {
    personaId,
    versionId: persona.currentVersionId,
    versionNo: version ? Number(version.version_no) : null,
    name: persona.name,
    line: persona.line,
    provider: 'hifly',
    avatar: {
      avatarId: avatar.id,
      vendorAvatarId: avatar.vendor_avatar_id,
      name: avatar.name,
      backgroundLabel: avatar.background_label ?? null,
      coverUrl: asset?.thumb_key ? `/api/persona-assets/${avatar.source_asset_id}/file?variant=thumb` : null,
      sourceWidth: asset?.width === null || asset?.width === undefined ? null : Number(asset.width),
      sourceHeight: asset?.height === null || asset?.height === undefined ? null : Number(asset.height),
    },
    voice: {
      voiceId: voice.id,
      vendorVoiceId: voice.vendor_voice_id,
      name: voice.name,
      language: voice.language,
      speechRate: Number(voice.speech_rate ?? 1),
      volume: Number(voice.volume ?? 1),
      pitch: Number(voice.pitch ?? 1),
      demoUrl: voice.demo_key ? `/api/persona-voices/${voice.id}/demo` : null,
    },
  }
}

/** 存储形态提示（options 用：OSS 或本地兜底） */
export function storageMode(): 'oss' | 'local' {
  return isOssEnabled() ? 'oss' : 'local'
}
