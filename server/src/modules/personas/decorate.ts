import { config, hasHifly } from '../../config.js'
import { getDb, type Db } from '../../db/index.js'
import { fromDb } from '../../lib/time.js'
import { jdec } from '../../lib/util.js'
import { deriveStatus, type AuthorizationLike, type DerivedStatus } from './policy.js'
import type { Persona } from './repo.js'
import { LINE_RULES, type AuthorizationScope } from './types.js'

/**
 * 人物列表装饰（FR-L1 / FR-X1）：派生状态 + 计数 + 封面 + 「已配置」。
 *
 * 逐人物各发约 10 条查询会在 500 人时超过 AC-L6 的 300ms（N+1）。这里按 id 批量取回
 * 授权 / 分身 / 声音 / 计数 / 封面，再在内存里用纯函数 `deriveStatus` 派生，查询数与人物数无关。
 * 派生规则仍是 policy.ts 同一份；「已配置」与 readiness(avatar_video) 同口径（由验收脚本交叉校验）。
 */

const CHUNK = 400

async function inChunks<T>(db: Db, ids: string[], sql: (ph: string) => string): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    out.push(...(await db.all<T>(sql(part.map(() => '?').join(',')), part)))
  }
  return out
}

function group<T extends Record<string, any>>(rows: T[], key: string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = String(r[key])
    const list = m.get(k)
    if (list) list.push(r)
    else m.set(k, [r])
  }
  return m
}

export interface DecoratedPersona extends Persona {
  status: DerivedStatus['status']
  statusLabel: string
  usable: boolean
  statusReasons: DerivedStatus['reasons']
  extraTags: string[]
  counts: { photos: number; avatars: number; voices: number; bindings: number }
  coverUrl: string | null
  currentVersionId: string | null
}

export async function decoratePersonas(list: Persona[], db: Db = getDb(), now: Date = new Date()): Promise<DecoratedPersona[]> {
  if (!list.length) return []
  const ids = list.map((p) => p.id)

  const [authRows, avatarRows, voiceRows, photoRows, bindingRows] = await Promise.all([
    inChunks<Record<string, any>>(db, ids, (ph) => `SELECT \`persona_id\`, \`id\`, \`status\`, \`scopes\`, \`expires_at\` FROM \`persona_authorization\` WHERE \`persona_id\` IN (${ph})`),
    inChunks<Record<string, any>>(db, ids, (ph) => `SELECT \`persona_id\`, \`id\`, \`status\`, \`vendor_avatar_id\`, \`deleted_at\` FROM \`persona_avatar\` WHERE \`persona_id\` IN (${ph})`),
    inChunks<Record<string, any>>(db, ids, (ph) => `SELECT \`persona_id\`, \`id\`, \`status\`, \`confirmed\`, \`vendor_voice_id\`, \`deleted_at\` FROM \`persona_voice\` WHERE \`is_sample\` = 0 AND \`persona_id\` IN (${ph})`),
    inChunks<Record<string, any>>(db, ids, (ph) => `SELECT \`persona_id\`, COUNT(*) AS c FROM \`persona_asset\` WHERE \`kind\` = 'photo' AND \`status\` = 'approved' AND \`deleted_at\` IS NULL AND \`persona_id\` IN (${ph}) GROUP BY \`persona_id\``),
    inChunks<Record<string, any>>(db, ids, (ph) => `SELECT \`persona_id\`, COUNT(*) AS c FROM \`persona_account_binding\` WHERE \`released_at\` IS NULL AND \`persona_id\` IN (${ph}) GROUP BY \`persona_id\``),
  ])
  const coverIds = list.map((p) => p.coverAssetId).filter((x): x is string => !!x)
  const coverRows = coverIds.length
    ? await inChunks<Record<string, any>>(db, coverIds, (ph) => `SELECT \`id\`, \`thumb_key\` FROM \`persona_asset\` WHERE \`id\` IN (${ph})`)
    : []

  const auths = group(authRows, 'persona_id')
  const avatars = group(avatarRows, 'persona_id')
  const voices = group(voiceRows, 'persona_id')
  const photos = new Map(photoRows.map((r) => [String(r.persona_id), Number(r.c)]))
  const bindings = new Map(bindingRows.map((r) => [String(r.persona_id), Number(r.c)]))
  const coverThumb = new Map(coverRows.map((r) => [String(r.id), r.thumb_key as string | null]))
  const hiflyOk = hasHifly() || config.mockFallback

  return list.map((p) => {
    const myAuths: AuthorizationLike[] = (auths.get(p.id) ?? []).map((r) => ({
      id: r.id,
      status: r.status,
      scopes: jdec<string[]>(r.scopes, []) as AuthorizationScope[],
      expiresAt: fromDb(r.expires_at),
    }))
    const myAvatars = avatars.get(p.id) ?? []
    const myVoices = voices.get(p.id) ?? []
    const derived = deriveStatus(
      { line: p.line, enabled: p.enabled, archivedAt: p.archivedAt, authRequired: LINE_RULES[p.line].authRequired },
      myAuths,
      {
        avatars: myAvatars.map((a) => ({ status: a.status, deletedAt: fromDb(a.deleted_at) })),
        voices: myVoices.map((v) => ({ status: v.status, confirmed: !!v.confirmed, deletedAt: fromDb(v.deleted_at) })),
        hasDefaultAvatar: !!p.defaultAvatarId,
        hasConfirmedDefaultVoice: !!p.defaultVoiceId,
        configured: false,
      },
      now,
    )

    // 「已配置」= readiness(avatar_video) 全过；素人线 = readiness(copy) 全过（§3.2）
    let configured = false
    if (derived.usable) {
      if (p.line === 'persona') configured = true
      else {
        const av = myAvatars.find((a) => a.id === p.defaultAvatarId)
        const vo = myVoices.find((v) => v.id === p.defaultVoiceId)
        configured =
          !!av && av.status === 'ready' && !av.deleted_at && !!av.vendor_avatar_id &&
          !!vo && vo.status === 'ready' && !!vo.confirmed && !vo.deleted_at && !!vo.vendor_voice_id &&
          derived.validPortraitAuthIds.length > 0 && derived.validVoiceAuthIds.length > 0 && hiflyOk
      }
    }
    const extraTags = configured && !derived.extraTags.includes('configured') ? [...derived.extraTags, 'configured'] : [...derived.extraTags]

    return {
      ...p,
      status: derived.status,
      statusLabel: derived.label,
      usable: derived.usable,
      statusReasons: derived.reasons,
      extraTags,
      counts: {
        photos: photos.get(p.id) ?? 0,
        avatars: myAvatars.filter((a) => a.status === 'ready' && !a.deleted_at).length,
        voices: myVoices.filter((v) => v.status === 'ready' && !!v.confirmed && !v.deleted_at).length,
        bindings: bindings.get(p.id) ?? 0,
      },
      coverUrl: p.coverAssetId && coverThumb.get(p.coverAssetId) ? `/api/persona-assets/${p.coverAssetId}/file?variant=thumb` : null,
      currentVersionId: p.currentVersionId,
    }
  })
}
