import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import { getDb, type Db } from '../../db/index.js'
import { jdec, newId } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { MAGIC_HEAD_BYTES, validateUploadFile } from '../../lib/upload.js'
import { putObjectFromFile } from '../../integrations/aliyun-oss/client.js'
import { recordOperation } from '../../modules/audit/repo.js'
import { getPersonaById } from './repo.js'
import { authorizationEffectiveStatus, isAuthorizationValid } from './policy.js'
import { UPLOAD_LIMITS, type AuthorizationScope, type AuthorizationStatus } from './types.js'

/**
 * 授权材料（FR-U1~U4 / L5 / L6）。
 *  - 上传（pdf / jpg / png ≤20MB）+ 授权人 + 范围（肖像 / 声音 / 允许共享）+ 生效 / 到期日期；
 *  - 核验通过 → verified（记核验人、时间）；驳回 → rejected（原因必填）；撤销 → revoked（原因必填，终态）；
 *  - 到期**读时派生** expired，不依赖定时任务（R23）；每日扫描生成提醒（FR-U3）。
 */

export interface PersonaAuthorization {
  id: string
  personaId: string
  grantorName: string
  scopes: AuthorizationScope[]
  fileKey: string
  fileMime: string
  fileSize: number
  fileSha256: string
  effectiveFrom: string | null
  expiresAt: string | null
  status: AuthorizationStatus
  decisionReason: string | null
  verifiedBy: string | null
  verifiedAt: string | null
  revokedBy: string | null
  revokedAt: string | null
  remindSentAt: string | null
  note: string | null
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
}

function mapRow(r: Record<string, any>): PersonaAuthorization {
  return {
    id: r.id,
    personaId: r.persona_id,
    grantorName: r.grantor_name,
    scopes: jdec<AuthorizationScope[]>(r.scopes, []),
    fileKey: r.file_key,
    fileMime: r.file_mime,
    fileSize: Number(r.file_size ?? 0),
    fileSha256: r.file_sha256,
    effectiveFrom: r.effective_from ?? null,
    expiresAt: fromDb(r.expires_at),
    // 读时派生：verified 且已到期 → expired
    status: authorizationEffectiveStatus({ status: r.status, expiresAt: fromDb(r.expires_at) }),
    decisionReason: r.decision_reason ?? null,
    verifiedBy: r.verified_by ?? null,
    verifiedAt: fromDb(r.verified_at),
    revokedBy: r.revoked_by ?? null,
    revokedAt: fromDb(r.revoked_at),
    remindSentAt: fromDb(r.remind_sent_at),
    note: r.note ?? null,
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}

const AUTH_SCOPES: AuthorizationScope[] = ['portrait', 'voice', 'share']
const MAX_AUTH_YEARS = 3

export interface UploadAuthorizationInput {
  personaId: string
  grantorName: string
  scopes: AuthorizationScope[]
  effectiveFrom: string
  expiresAt: string
  note?: string
  filePath: string
  filename: string
  size: number
  head: Buffer
  operator: string
}

/** 上传授权材料（FR-U1） */
export async function uploadAuthorization(input: UploadAuthorizationInput): Promise<PersonaAuthorization> {
  const db = getDb()
  const persona = await getPersonaById(input.personaId, true)
  if (!persona) throw err.personaNotFound()
  if (persona.archivedAt) throw err.personaArchived()

  const grantorName = String(input.grantorName ?? '').trim()
  if (!grantorName) throw err.badRequest('授权人姓名必填')
  if (grantorName.length > 60) throw err.badRequest('授权人姓名不能超过 60 字')
  const scopes = Array.from(new Set((input.scopes ?? []).filter((s) => AUTH_SCOPES.includes(s)))) as AuthorizationScope[]
  if (!scopes.length) throw err.badRequest('授权范围至少选择一项（肖像 / 声音 / 允许共享）')

  // Q4：必须填到期日期（最长 3 年）
  const effectiveFrom = String(input.effectiveFrom ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw err.badRequest('生效日期格式应为 YYYY-MM-DD')
  const expiresAt = String(input.expiresAt ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) throw err.badRequest('到期日期必填，格式应为 YYYY-MM-DD（Q4：不允许长期有效）')
  const from = new Date(`${effectiveFrom}T00:00:00Z`)
  const to = new Date(`${expiresAt}T00:00:00Z`)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw err.badRequest('日期不合法')
  if (to <= from) throw err.badRequest('到期日期必须晚于生效日期')
  const maxExpiry = new Date(from)
  maxExpiry.setUTCFullYear(maxExpiry.getUTCFullYear() + MAX_AUTH_YEARS)
  if (to > maxExpiry) throw err.badRequest(`授权有效期最长 ${MAX_AUTH_YEARS} 年`, { maxExpiry: toDb(maxExpiry).slice(0, 10) })

  const limits = UPLOAD_LIMITS.authorization
  const meta = validateUploadFile(input.filename, input.size, input.head.subarray(0, MAGIC_HEAD_BYTES), {
    allowedExts: [...limits.exts],
    maxBytes: limits.maxBytes,
  })
  const buf = await fsp.readFile(input.filePath)
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')

  const id = newId('auth')
  const fileKey = `persona/${input.personaId}/authorization/${id}${meta.ext}`
  const now = toDb(utcNow())
  await putObjectFromFile(input.filePath, fileKey, '')
  await db.run(
    `INSERT INTO \`persona_authorization\`
      (\`id\`, \`persona_id\`, \`grantor_name\`, \`scopes\`, \`file_key\`, \`file_mime\`, \`file_size\`, \`file_sha256\`,
       \`effective_from\`, \`expires_at\`, \`status\`, \`note\`, \`created_by\`, \`created_at\`, \`updated_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [
      id,
      input.personaId,
      grantorName,
      JSON.stringify(scopes),
      fileKey,
      meta.mime,
      input.size,
      sha256,
      effectiveFrom,
      `${expiresAt} 23:59:59`,
      String(input.note ?? '').trim().slice(0, 255) || null,
      input.operator,
      now,
      now,
    ],
  )
  await recordOperation({
    operator: input.operator,
    action: 'persona.authorization_upload',
    targetType: 'persona',
    targetId: input.personaId,
    detail: { authorizationId: id, grantorName, scopes, effectiveFrom, expiresAt },
  })
  return (await getAuthorizationById(id))!
}

export async function getAuthorizationById(id: string, db: Db = getDb()): Promise<PersonaAuthorization | null> {
  const r = await db.get<Record<string, any>>('SELECT * FROM `persona_authorization` WHERE `id` = ?', [id])
  return r ? mapRow(r) : null
}

export async function listAuthorizations(personaId: string, db: Db = getDb()): Promise<PersonaAuthorization[]> {
  const rows = await db.all<Record<string, any>>(
    'SELECT * FROM `persona_authorization` WHERE `persona_id` = ? ORDER BY `created_at` DESC',
    [personaId],
  )
  return rows.map(mapRow)
}

/** 核验 / 驳回（FR-U2） */
export async function decideAuthorization(
  id: string,
  input: { decision: 'verified' | 'rejected'; reason?: string; operator: string },
): Promise<PersonaAuthorization> {
  const db = getDb()
  const auth = await getAuthorizationById(id)
  if (!auth) throw err.notFound('授权记录不存在')
  if (auth.status === 'revoked') throw err.invalidState('授权已撤销，不能再次核验')
  // P0-1 四眼原则：上传人不能核验自己上传的授权材料
  if (auth.createdBy && auth.createdBy === input.operator) {
    throw err.forbidden('授权材料须由上传人以外的审核员核验')
  }
  const reason = String(input.reason ?? '').trim()
  if (input.decision === 'rejected' && !reason) throw err.badRequest('驳回必须填写原因')
  const now = toDb(utcNow())
  await db.run(
    'UPDATE `persona_authorization` SET `status` = ?, `decision_reason` = ?, `verified_by` = ?, `verified_at` = ?, `updated_at` = ? WHERE `id` = ?',
    [
      input.decision === 'verified' ? 'verified' : 'rejected',
      reason || null,
      input.operator,
      input.decision === 'verified' ? now : null,
      now,
      id,
    ],
  )
  await recordOperation({
    operator: input.operator,
    action: input.decision === 'verified' ? 'persona.authorization_verify' : 'persona.authorization_reject',
    targetType: 'persona',
    targetId: auth.personaId,
    detail: { authorizationId: id, decision: input.decision, reason: reason || null },
  })
  return (await getAuthorizationById(id))!
}

/** 撤销（FR-U2：原因必填，终态） */
export async function revokeAuthorization(id: string, reason: string, operator: string): Promise<PersonaAuthorization> {
  const db = getDb()
  const auth = await getAuthorizationById(id)
  if (!auth) throw err.notFound('授权记录不存在')
  if (auth.status === 'revoked') throw err.invalidState('授权已撤销')
  const r = String(reason ?? '').trim()
  if (!r) throw err.badRequest('撤销必须填写原因')
  const now = toDb(utcNow())
  await db.run(
    'UPDATE `persona_authorization` SET `status` = ?, `decision_reason` = ?, `revoked_by` = ?, `revoked_at` = ?, `updated_at` = ? WHERE `id` = ?',
    ['revoked', r, operator, now, now, id],
  )
  await recordOperation({
    operator,
    action: 'persona.authorization_revoke',
    targetType: 'persona',
    targetId: auth.personaId,
    detail: { authorizationId: id, reason: r },
  })
  return (await getAuthorizationById(id))!
}

/** 授权文件读取目标（流式代理 + 敏感访问审计，FR-U6） */
export function authorizationFileTarget(auth: PersonaAuthorization): { storageKey: string; filename: string } {
  const ext = auth.fileKey.slice(auth.fileKey.lastIndexOf('.'))
  return { storageKey: auth.fileKey, filename: `${auth.grantorName || '授权材料'}${ext}` }
}

/** 供 clone / readiness 使用：人物当前有效授权 */
export async function validAuthorizationsOf(
  personaId: string,
  db: Db = getDb(),
): Promise<PersonaAuthorization[]> {
  return (await listAuthorizations(personaId, db)).filter((a) => isAuthorizationValid(a))
}

/** 每日扫描：到期前 30 天提醒 + 到期当日落 operation_log（FR-U3） */
export async function scanAuthExpiry(): Promise<{ expiring: number; expired: number }> {
  const db = getDb()
  const now = new Date()
  const rows = await db.all<Record<string, any>>(
    'SELECT * FROM `persona_authorization` WHERE `status` = ?',
    ['verified'],
  )
  let expiring = 0
  let expired = 0
  const { createReminder } = await import('./reminders.js')
  for (const r of rows) {
    const auth = mapRow(r)
    if (!auth.expiresAt) continue
    const expires = new Date(auth.expiresAt)
    if (expires.getTime() <= now.getTime()) {
      // 已到期：落 operation_log + 提醒（读时派生已使其失效，这里只做通知）
      expired += 1
      await recordOperation({
        operator: 'system',
        action: 'persona.authorization_expired',
        targetType: 'persona',
        targetId: auth.personaId,
        detail: { authorizationId: auth.id, expiresAt: auth.expiresAt },
      })
      await createReminder({
        personaId: auth.personaId,
        kind: 'auth_expired',
        refId: auth.id,
        message: `授权已到期（${auth.expiresAt.slice(0, 10)}），依赖它的分身 / 声音已不可用`,
        operator: 'system',
      }).catch(() => undefined)
      continue
    }
    const daysLeft = (expires.getTime() - now.getTime()) / 86_400_000
    if (daysLeft <= 30 && !auth.remindSentAt) {
      expiring += 1
      await createReminder({
        personaId: auth.personaId,
        kind: 'auth_expiring',
        refId: auth.id,
        message: `授权将于 ${Math.ceil(daysLeft)} 天后到期（${auth.expiresAt.slice(0, 10)}），请及时续期`,
        operator: 'system',
      }).catch(() => undefined)
      await db.run('UPDATE `persona_authorization` SET `remind_sent_at` = ? WHERE `id` = ?', [toDb(now), auth.id])
    }
  }
  return { expiring, expired }
}
