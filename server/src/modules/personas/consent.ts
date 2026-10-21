import { getDb } from '../../db/index.js'
import { newId } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { recordOperation } from '../../modules/audit/repo.js'
import { getPersonaById } from './repo.js'
import { isAuthorizationValid } from './policy.js'
import { getAuthorizationById } from './authorizations.js'
import { getAssetById } from './assets.js'
import { CONSENT_PURPOSE_LABELS, type ConsentPurpose, type ConsentSourceKind } from './types.js'
import { CONSENT_TEXT_VERSION, CONSENT_TEXTS } from './options.js'

/**
 * 克隆授权确认（L6 / R12 平移众墅之家 create_oral_consent / _require_valid_consent）。
 * 每次分身 / 声音克隆须绑定「授权记录 + 确认文本版本 + 素材 SHA-256 + 用途」，
 * 校验五元组一致才放行——防止用 A 的授权克隆 B、或替换素材。
 */

export interface PersonaConsent {
  id: string
  personaId: string
  authorizationId: string
  purpose: ConsentPurpose
  sourceKind: ConsentSourceKind
  sourceId: string
  sourceSha256: string
  consentTextVersion: string
  consentedBy: string
  consentedAt: string | null
}

function mapRow(r: Record<string, any>): PersonaConsent {
  return {
    id: r.id,
    personaId: r.persona_id,
    authorizationId: r.authorization_id,
    purpose: r.purpose,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    sourceSha256: r.source_sha256,
    consentTextVersion: r.consent_text_version,
    consentedBy: r.consented_by,
    consentedAt: r.consented_at ? new Date(String(r.consented_at).replace(' ', 'T') + 'Z').toISOString() : null,
  }
}

/** 用途 → 授权范围要求 */
const PURPOSE_SCOPE: Record<ConsentPurpose, 'portrait' | 'voice'> = {
  AVATAR_CLONE: 'portrait',
  VOICE_CLONE: 'voice',
}

export interface CreateConsentInput {
  personaId: string
  authorizationId: string
  purpose: ConsentPurpose
  sourceKind: ConsentSourceKind
  sourceId: string
  consentTextVersion: string
  operator: string
}

/** 生成 consent（FR-C1② / FR-V2） */
export async function createConsent(input: CreateConsentInput): Promise<PersonaConsent> {
  const db = getDb()
  const persona = await getPersonaById(input.personaId, true)
  if (!persona) throw err.personaNotFound()
  if (persona.archivedAt) throw err.personaArchived()

  // 1) 授权必须存在、有效、覆盖用途所需范围
  const auth = await getAuthorizationById(input.authorizationId)
  if (!auth || auth.personaId !== input.personaId) throw err.authorizationRequired('授权记录不存在或不属于该人物')
  const needScope = PURPOSE_SCOPE[input.purpose]
  if (!auth.scopes.includes(needScope)) {
    throw err.authorizationRequired(
      `该授权范围不含「${needScope === 'portrait' ? '肖像' : '声音'}」，不能用于${CONSENT_PURPOSE_LABELS[input.purpose]}`,
      { scopes: auth.scopes, need: needScope },
    )
  }
  if (!isAuthorizationValid(auth)) {
    throw err.authorizationRequired(`授权当前不可用（${auth.status === 'expired' ? '已过期' : auth.status}）`, {
      authorizationId: auth.id,
      status: auth.status,
    })
  }

  // 2) 确认文本版本必须当前有效（Q12：旧版本 consent 不可用于新克隆）
  if (input.consentTextVersion !== CONSENT_TEXT_VERSION) {
    throw err.consentMismatch(
      `授权确认文本版本已更新（当前 ${CONSENT_TEXT_VERSION}），请重新阅读并勾选最新确认文本`,
      { expected: CONSENT_TEXT_VERSION, received: input.consentTextVersion },
    )
  }

  // 3) 素材存在且属于该人物；记录其 SHA-256
  let sourceSha256: string
  if (input.sourceKind === 'avatar_source') {
    const asset = await getAssetById(input.sourceId)
    if (!asset || asset.personaId !== input.personaId) throw err.notFound('分身素材不存在')
    if (asset.kind !== 'avatar_source') throw err.badRequest('sourceId 不是分身素材')
    if (asset.status !== 'approved') {
      throw err.assetNotApproved('分身素材尚未审核通过，不能发起克隆制作')
    }
    sourceSha256 = asset.compatSha256 ?? asset.sha256
  } else {
    const voice = await db.get<Record<string, any>>(
      'SELECT * FROM `persona_voice` WHERE `id` = ? AND `deleted_at` IS NULL',
      [input.sourceId],
    )
    if (!voice || voice.persona_id !== input.personaId) throw err.notFound('声音样本不存在')
    sourceSha256 = voice.sample_sha256
  }

  const id = newId('consent')
  const now = toDb(utcNow())
  await db.run(
    `INSERT INTO \`persona_consent\`
      (\`id\`, \`persona_id\`, \`authorization_id\`, \`purpose\`, \`source_kind\`, \`source_id\`, \`source_sha256\`, \`consent_text_version\`, \`consented_by\`, \`consented_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.personaId, input.authorizationId, input.purpose, input.sourceKind, input.sourceId, sourceSha256, input.consentTextVersion, input.operator, now],
  )
  await recordOperation({
    operator: input.operator,
    action: 'persona.consent_created',
    targetType: 'persona',
    targetId: input.personaId,
    detail: { consentId: id, purpose: input.purpose, authorizationId: input.authorizationId, sourceKind: input.sourceKind, sourceId: input.sourceId },
  })
  return (await getConsentById(id))!
}

export async function getConsentById(id: string): Promise<PersonaConsent | null> {
  const r = await getDb().get<Record<string, any>>('SELECT * FROM `persona_consent` WHERE `id` = ?', [id])
  return r ? mapRow(r) : null
}

export interface ConsentCheckInput {
  consentId: string
  purpose: ConsentPurpose
  sourceKind: ConsentSourceKind
  sourceId: string
  sourceSha256: string
  authorizationId?: string
}

/**
 * 五元组校验（R12 _require_valid_consent）：
 * consent 存在 + 授权仍有效且覆盖范围 + 素材 hash 一致 + 文本版本当前 + 用途 / 来源一致。
 */
export async function assertConsentValid(input: ConsentCheckInput): Promise<PersonaConsent> {
  const consent = await getConsentById(input.consentId)
  if (!consent) throw err.consentMismatch('授权确认记录不存在，请重新勾选确认文本')
  if (consent.purpose !== input.purpose) throw err.consentMismatch('授权确认用途不一致')
  if (consent.sourceKind !== input.sourceKind || consent.sourceId !== input.sourceId) {
    throw err.consentMismatch('授权确认绑定的素材与本次提交不一致')
  }
  if (consent.sourceSha256 !== input.sourceSha256) {
    throw err.consentMismatch('素材内容已变化（SHA-256 不一致），请重新审核素材并再次确认授权')
  }
  if (consent.consentTextVersion !== CONSENT_TEXT_VERSION) {
    throw err.consentMismatch(
      `授权确认文本版本已更新（当前 ${CONSENT_TEXT_VERSION}），请重新阅读并勾选最新确认文本`,
      { expected: CONSENT_TEXT_VERSION, received: consent.consentTextVersion },
    )
  }
  const auth = await getAuthorizationById(consent.authorizationId)
  if (!auth) throw err.authorizationRequired('授权记录不存在')
  const needScope = PURPOSE_SCOPE[consent.purpose]
  if (!auth.scopes.includes(needScope) || !isAuthorizationValid(auth)) {
    throw err.authorizationRequired(
      auth.status === 'expired' ? '授权已过期，请更新授权材料后重试' : '授权当前不可用或范围不足',
      { authorizationId: auth.id, status: auth.status },
    )
  }
  if (input.authorizationId && input.authorizationId !== consent.authorizationId) {
    throw err.consentMismatch('授权记录与确认记录不一致')
  }
  return consent
}

/** 确认文本（前端展示 + options 下发） */
export function consentTextOf(purpose: ConsentPurpose): { title: string; body: string; version: string } {
  return { ...CONSENT_TEXTS[purpose], version: CONSENT_TEXT_VERSION }
}
