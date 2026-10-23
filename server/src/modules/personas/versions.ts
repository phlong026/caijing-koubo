import { getDb, type Db } from '../../db/index.js'
import crypto from 'node:crypto'
import { jdec, jenc, newId, canonicalJson } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { isDuplicateKey } from '../../db/index.js'
import { readProfile, type Persona } from './repo.js'
import { listAuthorizationsForPolicy } from './repo.js'
import { isAuthorizationValid } from './policy.js'

/**
 * 人物版本快照（L7 / §3.4，平移众墅之家 CharacterVersion.persona_snapshot_json）。
 * 触发：① 保存定位且规范化 hash 变化；② 默认分身 / 默认声音变化；③ 声音参数变化。
 * 版本不可改、不可删；snapshot_hash 与最新版本相同则不新建。
 */

export type VersionTrigger = 'profile' | 'default_asset' | 'voice_settings' | 'migrate'

export const VERSION_TRIGGER_LABELS: Record<VersionTrigger, string> = {
  profile: 'IP 定位变更',
  default_asset: '默认分身 / 声音变更',
  voice_settings: '声音参数变更',
  migrate: '存量迁移',
}

export interface PersonaVersionRow {
  id: string
  personaId: string
  versionNo: number
  snapshot: Record<string, unknown>
  snapshotHash: string
  trigger: string
  createdBy: string | null
  createdAt: string | null
}

interface DefaultAvatarInfo {
  id: string
  name: string
  vendorAvatarId: string | null
  backgroundLabel: string | null
  sourceSha256: string | null
}

interface DefaultVoiceInfo {
  id: string
  name: string
  vendorVoiceId: string | null
  language: string
  speechRate: number
  volume: number
  pitch: number
}

/** 组装快照内容（§3.4） */
export async function buildSnapshot(
  persona: Persona,
  db: Db = getDb(),
): Promise<Record<string, unknown>> {
  let defaultAvatar: DefaultAvatarInfo | null = null
  let defaultVoice: DefaultVoiceInfo | null = null
  if (persona.defaultAvatarId) {
    const a = await db.get<Record<string, any>>(
      'SELECT `id`, `name`, `vendor_avatar_id`, `background_label`, `source_asset_id` FROM `persona_avatar` WHERE `id` = ? AND `deleted_at` IS NULL',
      [persona.defaultAvatarId],
    )
    if (a) {
      const asset = await db.get<{ sha256: string | null; compat_sha256: string | null }>(
        'SELECT `sha256`, `compat_sha256` FROM `persona_asset` WHERE `id` = ?',
        [a.source_asset_id],
      )
      defaultAvatar = {
        id: a.id,
        name: a.name,
        vendorAvatarId: a.vendor_avatar_id ?? null,
        backgroundLabel: a.background_label ?? null,
        sourceSha256: asset?.compat_sha256 ?? asset?.sha256 ?? null,
      }
    }
  }
  if (persona.defaultVoiceId) {
    const v = await db.get<Record<string, any>>(
      'SELECT `id`, `name`, `vendor_voice_id`, `language`, `speech_rate`, `volume`, `pitch` FROM `persona_voice` WHERE `id` = ? AND `deleted_at` IS NULL',
      [persona.defaultVoiceId],
    )
    if (v) {
      defaultVoice = {
        id: v.id,
        name: v.name,
        vendorVoiceId: v.vendor_voice_id ?? null,
        language: v.language,
        speechRate: Number(v.speech_rate ?? 1),
        volume: Number(v.volume ?? 1),
        pitch: Number(v.pitch ?? 1),
      }
    }
  }
  const auths = (await listAuthorizationsForPolicy(persona.id, db)).filter((a) => isAuthorizationValid(a))
  return {
    personaId: persona.id,
    name: persona.name,
    line: persona.line,
    ownerSubject: persona.ownerSubject,
    description: persona.description,
    bindingMode: persona.bindingMode,
    profileRevision: persona.profileRevision,
    ipProfile: readProfile(jdec<unknown>(awaitRawProfile(persona.id, db), null)),
    defaultAvatar,
    defaultVoice,
    authorizations: auths.map((a) => ({ id: a.id, scopes: a.scopes, expiresAt: a.expiresAt })),
  }
}

async function awaitRawProfile(personaId: string, db: Db): Promise<unknown> {
  const row = await db.get<{ ip_profile: string | null }>('SELECT `ip_profile` FROM `persona` WHERE `id` = ?', [personaId])
  return row?.ip_profile ?? null
}

/** 规范化 JSON 的 SHA-256。必须用 canonicalJson：JSON.stringify 的数组参数是全层级白名单，会丢弃嵌套对象字段且不排序嵌套键 */
export function snapshotHash(snapshot: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalJson(snapshot)).digest('hex')
}

/**
 * 确保版本存在（内容变化才新建）。
 * 返回新建的版本；未变化返回 null。
 */
export async function ensurePersonaVersion(
  persona: Persona,
  trigger: VersionTrigger,
  operator: string,
  db: Db = getDb(),
): Promise<PersonaVersionRow | null> {
  const snapshot = await buildSnapshot(persona, db)
  const hash = snapshotHash(snapshot)
  const latest = await db.get<Record<string, any>>(
    'SELECT `id`, `version_no`, `snapshot_hash` FROM `persona_version` WHERE `persona_id` = ? ORDER BY `version_no` DESC LIMIT 1',
    [persona.id],
  )
  if (latest && latest.snapshot_hash === hash) return null

  for (let attempt = 0; attempt < 3; attempt++) {
    const no = ((latest?.version_no as number) ?? 0) + 1 + attempt
    const id = newId('pv')
    try {
      await db.run(
        `INSERT INTO \`persona_version\` (\`id\`, \`persona_id\`, \`version_no\`, \`snapshot\`, \`snapshot_hash\`, \`trigger\`, \`created_by\`, \`created_at\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, persona.id, no, jenc(snapshot), hash, trigger, operator, toDb(utcNow())],
      )
      await db.run('UPDATE `persona` SET `current_version_id` = ?, `updated_at` = ? WHERE `id` = ?', [
        id,
        toDb(utcNow()),
        persona.id,
      ])
      return {
        id,
        personaId: persona.id,
        versionNo: no,
        snapshot,
        snapshotHash: hash,
        trigger,
        createdBy: operator,
        createdAt: toDb(utcNow()),
      }
    } catch (e) {
      // UNIQUE(persona_id, version_no) 兜底：并发下取到最新 version_no 重试
      if (isDuplicateKey(e)) continue
      throw e
    }
  }
  return null
}

/** 版本列表（最新在前） */
export async function listVersions(personaId: string, db: Db = getDb()): Promise<PersonaVersionRow[]> {
  const rows = await db.all<Record<string, any>>(
    'SELECT * FROM `persona_version` WHERE `persona_id` = ? ORDER BY `version_no` DESC LIMIT 100',
    [personaId],
  )
  return rows.map((r) => ({
    id: r.id,
    personaId: r.persona_id,
    versionNo: Number(r.version_no),
    snapshot: jdec<Record<string, unknown>>(r.snapshot, {}),
    snapshotHash: r.snapshot_hash,
    trigger: r.trigger,
    createdBy: r.created_by,
    createdAt: r.created_at ? new Date(String(r.created_at).replace(' ', 'T') + 'Z').toISOString() : null,
  }))
}

/** 单条版本 */
export async function getVersion(versionId: string, db: Db = getDb()): Promise<PersonaVersionRow | null> {
  const r = await db.get<Record<string, any>>('SELECT * FROM `persona_version` WHERE `id` = ?', [versionId])
  if (!r) return null
  return {
    id: r.id,
    personaId: r.persona_id,
    versionNo: Number(r.version_no),
    snapshot: jdec<Record<string, unknown>>(r.snapshot, {}),
    snapshotHash: r.snapshot_hash,
    trigger: r.trigger,
    createdBy: r.created_by,
    createdAt: r.created_at ? new Date(String(r.created_at).replace(' ', 'T') + 'Z').toISOString() : null,
  }
}
