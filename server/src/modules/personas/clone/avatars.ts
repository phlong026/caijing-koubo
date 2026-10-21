import { getDb, isDuplicateKey } from '../../../db/index.js'
import crypto from 'node:crypto'
import { newId, uniq } from '../../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../../lib/time.js'
import { err } from '../../../errors.js'
import { recordOperation } from '../../audit/repo.js'
import { enqueue, QUEUE_NAMES, dedupOpts } from '../../../queue/index.js'
import { logger } from '../../../log.js'
import { getPersonaById } from '../repo.js'
import { getAssetById } from '../assets.js'
import { assertConsentValid } from '../consent.js'
import { validAuthorizationsOf } from '../authorizations.js'
import { AVATAR_STATUS_LABELS, LINE_RULES, type AvatarStatus } from '../types.js'
import { buildVendorTitle, uniqueShortRef } from './short-ref.js'
import { ensurePersonaVersion } from '../versions.js'

/**
 * 口播分身（FR-C1~C6，平移众墅之家 oral_avatars）。
 * 发起制作（createAvatar）只做校验与落库；提交 / 轮询 / 核对由 clone/worker.ts 执行
 * （飞影调用一律在事务外，db.tx 不可嵌套）。
 */

export interface PersonaAvatar {
  id: string
  personaId: string
  name: string
  sourceAssetId: string
  sourceKind: string
  backgroundLabel: string | null
  provider: string
  vendorTitle: string
  shortRef: string
  vendorTaskId: string | null
  vendorAvatarId: string | null
  status: AvatarStatus
  error: string | null
  consentId: string
  authorizationId: string
  idempotencyKey: string
  requestHash: string
  attempts: number
  submittedAt: string | null
  lastPolledAt: string | null
  nextPollAt: string | null
  readyAt: string | null
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
  deletedAt: string | null
  deletedBy: string | null
}

export function mapAvatarRow(r: Record<string, any>): PersonaAvatar {
  return {
    id: r.id,
    personaId: r.persona_id,
    name: r.name,
    sourceAssetId: r.source_asset_id,
    sourceKind: r.source_kind,
    backgroundLabel: r.background_label ?? null,
    provider: r.provider ?? 'hifly',
    vendorTitle: r.vendor_title,
    shortRef: r.short_ref,
    vendorTaskId: r.vendor_task_id ?? null,
    vendorAvatarId: r.vendor_avatar_id ?? null,
    status: r.status as AvatarStatus,
    error: r.error ?? null,
    consentId: r.consent_id,
    authorizationId: r.authorization_id,
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash,
    attempts: Number(r.attempts ?? 0),
    submittedAt: fromDb(r.submitted_at),
    lastPolledAt: fromDb(r.last_polled_at),
    nextPollAt: fromDb(r.next_poll_at),
    readyAt: fromDb(r.ready_at),
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
    deletedAt: fromDb(r.deleted_at),
    deletedBy: r.deleted_by ?? null,
  }
}

const SELECT = 'SELECT * FROM `persona_avatar`'

export async function getAvatarById(id: string, includeDeleted = false): Promise<PersonaAvatar | null> {
  const r = await getDb().get<Record<string, any>>(`${SELECT} WHERE \`id\` = ?`, [id])
  if (!r) return null
  if (!includeDeleted && r.deleted_at) return null
  return mapAvatarRow(r)
}

export async function listAvatars(personaId: string, includeDeleted = false): Promise<PersonaAvatar[]> {
  const where = includeDeleted ? '`persona_id` = ?' : '`persona_id` = ? AND `deleted_at` IS NULL'
  const rows = await getDb().all<Record<string, any>>(
    `${SELECT} WHERE ${where} ORDER BY \`created_at\` DESC`,
    [personaId],
  )
  return rows.map(mapAvatarRow)
}

/* ── 发起制作（FR-C1）───────────────────────────────────────────── */

export interface CreateAvatarInput {
  personaId: string
  name?: string
  sourceAssetId: string
  consentId: string
  /** 幂等键（请求头 Idempotency-Key，必填） */
  idempotencyKey: string
  /** 同一素材已有分身时的二次确认（FR-C1） */
  confirmDuplicate?: boolean
  operator: string
}

/** 规范化请求的 hash（R13：同键同参才算幂等命中） */
function requestHashOf(input: { personaId: string; name: string; sourceAssetId: string; consentId: string }): string {
  const normalized = JSON.stringify({
    personaId: input.personaId,
    name: input.name,
    sourceAssetId: input.sourceAssetId,
    consentId: input.consentId,
  })
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

const IN_PROGRESS: AvatarStatus[] = ['pending', 'submitting', 'running']

export async function createAvatar(input: CreateAvatarInput): Promise<{ avatar: PersonaAvatar; replayed: boolean }> {
  const db = getDb()
  const idemKey = String(input.idempotencyKey ?? '').trim()
  if (!idemKey) throw err.badRequest('缺少 Idempotency-Key 请求头（幂等键必填）')
  if (idemKey.length > 64) throw err.badRequest('Idempotency-Key 过长（≤64 字符）')

  const persona = await getPersonaById(input.personaId, true)
  if (!persona) throw err.personaNotFound()
  if (persona.archivedAt) throw err.personaArchived()
  const rule = LINE_RULES[persona.line]
  if (!rule.avatarAllowed) throw err.lineNotAllowed('素人矩阵不提供数字人口播，不能制作分身')

  // ① 授权与 consent（R12 五元组校验：授权 + 文本版本 + 素材 SHA-256 + 用途 + 来源）
  const asset = await getAssetById(input.sourceAssetId)
  if (!asset || asset.personaId !== input.personaId) throw err.notFound('分身素材不存在')
  if (asset.kind !== 'avatar_source') throw err.badRequest('sourceAssetId 不是分身素材')
  if (asset.status !== 'approved' || asset.deletedAt) {
    throw err.assetNotApproved('分身素材尚未审核通过，不能发起制作')
  }
  const sourceSha256 = asset.compatSha256 ?? asset.sha256
  const consent = await assertConsentValid({
    consentId: input.consentId,
    purpose: 'AVATAR_CLONE',
    sourceKind: 'avatar_source',
    sourceId: asset.id,
    sourceSha256,
  })
  // 授权当前仍有效（consent 校验已覆盖，这里再取有效授权集合供默认设置判定复用）
  const auths = await validAuthorizationsOf(input.personaId)
  if (!auths.some((a) => a.id === consent.authorizationId && a.scopes.includes('portrait'))) {
    throw err.authorizationRequired('该授权当前不可用或范围不含「肖像」', { authorizationId: consent.authorizationId })
  }

  // ② 名称（≤60 字，默认「人物名 · 背景名」）
  const defaultName = asset.backgroundLabel ? `${persona.name} · ${asset.backgroundLabel}` : persona.name
  const name = String(input.name ?? '').trim() || defaultName
  if (name.length > 60) throw err.badRequest('分身名称不能超过 60 字')

  const requestHash = requestHashOf({
    personaId: input.personaId,
    name,
    sourceAssetId: asset.id,
    consentId: consent.id,
  })

  // 幂等（R13）：同键同参返回原记录；同键异参 409
  const existing = await db.get<Record<string, any>>(
    'SELECT * FROM `persona_avatar` WHERE `idempotency_key` = ?',
    [idemKey],
  )
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw err.idempotencyConflict('同一 Idempotency-Key 的请求参数不一致', {
        idempotencyKey: idemKey,
      })
    }
    return { avatar: mapAvatarRow(existing), replayed: true }
  }

  // 同一素材重复制作：ready / 进行中需二次确认；uncertain 禁止重提（AC-C5）
  const siblings = await db.all<Record<string, any>>(
    'SELECT * FROM `persona_avatar` WHERE `source_asset_id` = ? AND `deleted_at` IS NULL',
    [asset.id],
  )
  const uncertain = siblings.find((s) => s.status === 'uncertain')
  if (uncertain) {
    throw err.cloneUncertain('该素材已有「待核对」的分身，请先核对状态，勿重复创建', {
      avatarId: uncertain.id,
      shortRef: uncertain.short_ref,
    })
  }
  const active = siblings.find((s) => IN_PROGRESS.includes(s.status) || s.status === 'ready')
  if (active && !input.confirmDuplicate) {
    throw err.personaConflict(
      `该素材已制作分身（${active.name}，${AVATAR_STATUS_LABELS[active.status as AvatarStatus]}），确认要再制作一个吗？`,
      { avatarId: active.id, status: active.status, requireConfirm: true },
    )
  }

  const id = newId('pav')
  const shortRef = await uniqueShortRef('persona_avatar', id)
  const now = toDb(utcNow())
  try {
    await db.run(
      `INSERT INTO \`persona_avatar\`
        (\`id\`, \`persona_id\`, \`name\`, \`source_asset_id\`, \`source_kind\`, \`background_label\`, \`provider\`,
         \`vendor_title\`, \`short_ref\`, \`status\`, \`consent_id\`, \`authorization_id\`,
         \`idempotency_key\`, \`request_hash\`, \`created_by\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, ?, ?, ?, 'hifly', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.personaId,
        name,
        asset.id,
        'video',
        asset.backgroundLabel,
        buildVendorTitle(name, shortRef),
        shortRef,
        consent.id,
        consent.authorizationId,
        idemKey,
        requestHash,
        input.operator,
        now,
        now,
      ],
    )
  } catch (e) {
    if (isDuplicateKey(e)) {
      // 并发同键：回查先写者并按幂等语义返回
      const dup = await db.get<Record<string, any>>(
        'SELECT * FROM `persona_avatar` WHERE `idempotency_key` = ?',
        [idemKey],
      )
      if (dup) {
        if (dup.request_hash !== requestHash) throw err.idempotencyConflict('同一 Idempotency-Key 的请求参数不一致')
        return { avatar: mapAvatarRow(dup), replayed: true }
      }
    }
    throw e
  }

  await recordOperation({
    operator: input.operator,
    action: 'persona.avatar_create',
    targetType: 'persona',
    targetId: input.personaId,
    detail: { avatarId: id, name, sourceAssetId: asset.id, consentId: consent.id, shortRef },
  })

  // 入队提交（提交步骤不自动重试：失败即 failed / uncertain，L9）
  await enqueue(
    QUEUE_NAMES.personaClone,
    'avatar_submit',
    { kind: 'avatar', recordId: id },
    dedupOpts(`avatar-submit-${id}`),
  ).catch((e) => {
    logger.error({ avatarId: id, err: (e as Error).message }, 'persona.clone.enqueue_failed')
  })

  return { avatar: (await getAvatarById(id))!, replayed: false }
}

/* ── 使用与默认（FR-C4）────────────────────────────────────────── */

export async function setDefaultAvatar(id: string, operator: string): Promise<PersonaAvatar> {
  const db = getDb()
  const avatar = await getAvatarById(id)
  if (!avatar) throw err.notFound('分身不存在')
  if (avatar.deletedAt) throw err.invalidState('分身已删除')
  if (avatar.status !== 'ready') {
    throw err.cloneNotReady(`分身尚未制作完成（${AVATAR_STATUS_LABELS[avatar.status]}），不能设为默认`)
  }
  if (!avatar.vendorAvatarId) {
    throw err.cloneNotReady('分身缺少飞影标识，不能设为默认（请先核对状态）')
  }
  // 默认分身须肖像授权有效（FR-C4）
  const auths = await validAuthorizationsOf(avatar.personaId)
  if (!auths.some((a) => a.id === avatar.authorizationId && a.scopes.includes('portrait'))) {
    throw err.authorizationRequired('该分身的肖像授权已失效，不能设为默认', {
      authorizationId: avatar.authorizationId,
    })
  }
  await db.run('UPDATE `persona` SET `default_avatar_id` = ?, `updated_at` = ?, `updated_by` = ? WHERE `id` = ?', [
    id,
    toDb(utcNow()),
    operator,
    avatar.personaId,
  ])
  await recordOperation({
    operator,
    action: 'persona.avatar_set_default',
    targetType: 'persona',
    targetId: avatar.personaId,
    detail: { avatarId: id },
  })
  // 默认分身变化 → 人物版本（L7）
  const persona = await getPersonaById(avatar.personaId, true)
  if (persona) await ensurePersonaVersion(persona, 'default_asset', operator)
  return (await getAvatarById(id))!
}

/* ── 重命名与删除（FR-C5 / R18 / R19）──────────────────────────── */

export async function patchAvatar(id: string, patch: { name?: string }, operator: string): Promise<PersonaAvatar> {
  const db = getDb()
  const avatar = await getAvatarById(id)
  if (!avatar) throw err.notFound('分身不存在')
  if (avatar.deletedAt) throw err.invalidState('分身已删除')
  if (patch.name === undefined) return avatar
  const name = String(patch.name).trim()
  if (!name) throw err.badRequest('名称不能为空')
  if (name.length > 60) throw err.badRequest('分身名称不能超过 60 字')
  // R18：重命名只改本地（vendor_title 保留，短引用核对不受影响）
  await db.run('UPDATE `persona_avatar` SET `name` = ?, `updated_at` = ? WHERE `id` = ?', [name, toDb(utcNow()), id])
  await recordOperation({
    operator,
    action: 'persona.avatar_rename',
    targetType: 'persona',
    targetId: avatar.personaId,
    detail: { avatarId: id, name },
  })
  return (await getAvatarById(id))!
}

export async function softDeleteAvatar(id: string, operator: string): Promise<void> {
  const db = getDb()
  const avatar = await getAvatarById(id, true)
  if (!avatar) throw err.notFound('分身不存在')
  if (avatar.deletedAt) return // 幂等
  // R19：制作中 / 不确定态不可删
  if (IN_PROGRESS.includes(avatar.status) || avatar.status === 'uncertain') {
    throw err.invalidState(
      avatar.status === 'uncertain' ? '状态待核对，不能删除（请先核对）' : '分身制作中，不能删除',
      { status: avatar.status },
    )
  }
  // 默认分身须先换默认
  const persona = await getPersonaById(avatar.personaId, true)
  if (persona?.defaultAvatarId === id) {
    throw err.invalidState('该分身是默认分身，请先设置其他默认分身')
  }
  const now = toDb(utcNow())
  await db.run('UPDATE `persona_avatar` SET `deleted_at` = ?, `deleted_by` = ?, `updated_at` = ? WHERE `id` = ?', [
    now,
    operator,
    now,
    id,
  ])
  await recordOperation({
    operator,
    action: 'persona.avatar_delete',
    targetType: 'persona',
    targetId: avatar.personaId,
    detail: { avatarId: id, name: avatar.name },
  })
}

/** 列表附带素材信息（封面 / 分辨率 / 时长，FR-C4 卡片） */
export async function listAvatarsWithAsset(personaId: string): Promise<
  Array<PersonaAvatar & { coverUrl: string | null; sourceWidth: number | null; sourceHeight: number | null; sourceDurationMs: number | null }>
> {
  const avatars = await listAvatars(personaId)
  if (!avatars.length) return []
  const db = getDb()
  const assetIds = uniq(avatars.map((a) => a.sourceAssetId))
  const ph = assetIds.map(() => '?').join(', ')
  const rows = await db.all<Record<string, any>>(
    `SELECT \`id\`, \`thumb_key\`, \`width\`, \`height\`, \`duration_ms\` FROM \`persona_asset\` WHERE \`id\` IN (${ph})`,
    assetIds,
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  return avatars.map((a) => {
    const asset = byId.get(a.sourceAssetId)
    return {
      ...a,
      coverUrl: asset?.thumb_key ? `/api/persona-assets/${a.sourceAssetId}/file?variant=thumb` : null,
      sourceWidth: asset?.width === null || asset?.width === undefined ? null : Number(asset.width),
      sourceHeight: asset?.height === null || asset?.height === undefined ? null : Number(asset.height),
      sourceDurationMs: asset?.duration_ms === null || asset?.duration_ms === undefined ? null : Number(asset.duration_ms),
    }
  })
}
