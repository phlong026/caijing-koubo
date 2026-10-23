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
      // P2-1：共享人物的声音用于多个账号即构成声音共享（FR-V9），授权还须含「允许共享」。
      // 与肖像 / 声音授权同口径：任一有效的声音授权含「允许共享」即可（补授权后旧声音无需重建）
      if (persona.bindingMode === 'shared') {
        const shareOk = auths.some((a) => a.scopes.includes('voice') && a.scopes.includes('share'))
        checks.push(hard('voice_share_auth', shareOk, shareOk ? '声音共享授权有效' : '共享人物的声音授权须包含「允许共享」'))
      }
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

export type ProductionPurpose = 'avatar_video' | 'mixcut'

export interface ProductionProfile {
  personaId: string
  purpose: ProductionPurpose
  versionId: string | null
  versionNo: number | null
  name: string
  line: string
  provider: 'hifly'
  /** mixcut 恒为 null：混剪不使用数字人形象 */
  avatar: {
    avatarId: string
    vendorAvatarId: string
    name: string
    backgroundLabel: string | null
    coverUrl: string | null
    sourceWidth: number | null
    sourceHeight: number | null
  } | null
  /** 素人线无克隆声音时为 null：M3 用公共音色 / 预置配音兜底（Q12） */
  voice: {
    voiceId: string
    vendorVoiceId: string
    name: string
    language: string
    speechRate: number
    volume: number
    pitch: number
    demoUrl: string | null
  } | null
}

/**
 * M3 取用契约。purpose=avatar_video（默认，数字人口播）：readiness(avatar_video) 硬项全过才返回分身 + 声音；
 * purpose=mixcut（混剪）：不取分身；经理 / KOS 须有已确认的克隆声音（Q12 本人声音口播），素人可空。
 * 可选 ?avatarId= 指定非默认分身（视频创作屏的「背景」切换，L15）。
 * 硬项不过 → 409 PERSONA_NOT_READY（带 checks）。
 */
export async function getProductionProfile(
  personaId: string,
  opts: { avatarId?: string; purpose?: ProductionPurpose } = {},
  db: Db = getDb(),
): Promise<ProductionProfile> {
  const purpose = opts.purpose ?? 'avatar_video'
  const readiness = await checkReadiness(personaId, purpose === 'mixcut' ? 'mixcut' : 'avatar_video', db)
  if (!readiness.pass) {
    throw err.personaNotReady(
      purpose === 'mixcut' ? '人物不可用（已归档或停用）' : '人物尚未准备就绪（形象与声音未绑定）',
      { checks: readiness.checks, status: readiness.status },
    )
  }
  const persona = (await getPersonaById(personaId, true))!
  const version = persona.currentVersionId
    ? await db.get<{ id: string; version_no: number }>('SELECT `id`, `version_no` FROM `persona_version` WHERE `id` = ?', [
        persona.currentVersionId,
      ])
    : null
  const base = {
    personaId,
    purpose,
    versionId: persona.currentVersionId,
    versionNo: version ? Number(version.version_no) : null,
    name: persona.name,
    line: persona.line,
    provider: 'hifly' as const,
  }

  if (purpose === 'mixcut') {
    const rule = LINE_RULES[persona.line]
    const voice = persona.defaultVoiceId
      ? await db.get<Record<string, any>>(
          'SELECT * FROM `persona_voice` WHERE `id` = ? AND `is_sample` = 0 AND `deleted_at` IS NULL',
          [persona.defaultVoiceId],
        )
      : null
    const voiceUsable = !!voice && voice.status === 'ready' && !!voice.confirmed && !!voice.vendor_voice_id
    if (voiceUsable) {
      if (rule.authRequired) {
        const auths = await validAuthorizationsOf(personaId, db)
        if (!auths.some((a) => a.scopes.includes('voice'))) {
          throw err.personaNotReady('声音授权缺失或已失效', { voiceId: voice!.id, status: readiness.status })
        }
      }
      return {
        ...base,
        avatar: null,
        voice: {
          voiceId: voice!.id,
          vendorVoiceId: voice!.vendor_voice_id,
          name: voice!.name,
          language: voice!.language,
          speechRate: Number(voice!.speech_rate ?? 1),
          volume: Number(voice!.volume ?? 1),
          pitch: Number(voice!.pitch ?? 1),
          demoUrl: voice!.demo_key ? `/api/persona-voices/${voice!.id}/demo` : null,
        },
      }
    }
    if (rule.authRequired) {
      throw err.personaNotReady('混剪要求已确认的默认声音（口播须本人克隆声音）', { status: readiness.status })
    }
    return { ...base, avatar: null, voice: null }
  }

  const targetAvatarId = opts.avatarId || persona.defaultAvatarId!
  // P1-4：指定分身必须属于该人物——否则可用 B 人物的声音配 A 人物的分身生成视频（冒用肖像）。
  // 肖像授权按「该人物任一有效肖像授权」判定（场景 3：补授权后旧分身无需重建），已由上面的 readiness 校验
  const avatar = await db.get<Record<string, any>>(
    'SELECT * FROM `persona_avatar` WHERE `id` = ? AND `persona_id` = ? AND `deleted_at` IS NULL',
    [targetAvatarId, personaId],
  )
  if (!avatar || avatar.status !== 'ready' || !avatar.vendor_avatar_id) {
    throw err.personaNotReady('指定分身不可用（不属于该人物、非 ready 或缺少厂商标识）', {
      avatarId: targetAvatarId,
      status: avatar?.status ?? null,
    })
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
  return {
    ...base,
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
