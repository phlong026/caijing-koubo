import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getDb, isDuplicateKey, type Db } from '../../db/index.js'
import { jdec, jenc, newId, uniq } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { paths } from '../../config.js'
import { logger } from '../../log.js'
import { putObjectFromFile, getObjectStream, isOssEnabled } from '../../integrations/aliyun-oss/client.js'
import { MAGIC_HEAD_BYTES, validateUploadFile } from '../../lib/upload.js'
import { enqueue, QUEUE_NAMES, dedupOpts } from '../../queue/index.js'
import { getPersonaById } from './repo.js'
import {
  ASSET_KIND_LABELS,
  ASSET_LIMITS,
  LINE_RULES,
  UPLOAD_LIMITS,
  type AssetKind,
  type AssetStatus,
} from './types.js'
import { checkImageStructure } from './assets/quality.js'

/**
 * 人物素材（FR-A1~A5 / §2.3 通用规则）。
 *  - multipart 单文件；扩展名 + 魔数 + 结构三重校验；
 *  - 私有存储（L12）：OSS 私有桶或本地 .data 兜底；
 *  - 同一人物同类资产按 SHA-256 去重；
 *  - 异步处理（persona-asset-process）→ 自动质检 → pending_review → 人工审核；
 *  - 删除为软删。
 */

export interface PersonaAsset {
  id: string
  personaId: string
  kind: AssetKind
  name: string
  backgroundLabel: string | null
  status: AssetStatus
  storageKey: string
  compatKey: string | null
  thumbKey: string | null
  mime: string
  sizeBytes: number
  sha256: string
  compatSha256: string | null
  sha256Key: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  fps: number | null
  quality: { schemaVersion: number; hard: unknown[]; soft: unknown[]; metrics: Record<string, unknown> } | null
  tags: string[]
  reviewDecision: string | null
  reviewReason: string | null
  reviewIssueCodes: string[]
  reviewedBy: string | null
  reviewedAt: string | null
  error: string | null
  sort: number
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
  deletedAt: string | null
  deletedBy: string | null
  /** 处理进度（上传即时反馈） */
  processing: boolean
}

export function mapAssetRow(r: Record<string, any>): PersonaAsset {
  return {
    id: r.id,
    personaId: r.persona_id,
    kind: r.kind,
    name: r.name,
    backgroundLabel: r.background_label ?? null,
    status: r.status,
    storageKey: r.storage_key,
    compatKey: r.compat_key ?? null,
    thumbKey: r.thumb_key ?? null,
    mime: r.mime,
    sizeBytes: Number(r.size_bytes ?? 0),
    sha256: r.sha256,
    compatSha256: r.compat_sha256 ?? null,
    sha256Key: r.sha256_key ?? null,
    width: r.width === null || r.width === undefined ? null : Number(r.width),
    height: r.height === null || r.height === undefined ? null : Number(r.height),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    fps: r.fps === null || r.fps === undefined ? null : Number(r.fps),
    quality: jdec(r.quality, null),
    tags: jdec<string[]>(r.tags, []),
    reviewDecision: r.review_decision ?? null,
    reviewReason: r.review_reason ?? null,
    reviewIssueCodes: jdec<string[]>(r.review_issue_codes, []),
    reviewedBy: r.reviewed_by ?? null,
    reviewedAt: fromDb(r.reviewed_at),
    error: r.error ?? null,
    sort: Number(r.sort ?? 0),
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
    deletedAt: fromDb(r.deleted_at),
    deletedBy: r.deleted_by ?? null,
    processing: r.status === 'uploaded' || r.status === 'processing',
  }
}

/* ── 上传 ───────────────────────────────────────────────────────── */

export interface UploadAssetInput {
  personaId: string
  kind: AssetKind
  name?: string
  backgroundLabel?: string
  tags?: string[]
  /** 文件内容（路由层已落临时文件或读入缓冲） */
  filePath: string
  filename: string
  size: number
  head: Buffer
  operator: string
}

function storagePrefix(personaId: string, kind: AssetKind): string {
  return `persona/${personaId}/${kind}`
}

/** 上传素材：三重校验 → 去重 → 私有存储 → 入队处理 */
export async function uploadAsset(input: UploadAssetInput): Promise<{ asset: PersonaAsset; deduplicated: boolean }> {
  const db = getDb()
  const persona = await getPersonaById(input.personaId, true)
  if (!persona) throw err.personaNotFound()
  if (persona.archivedAt) throw err.personaArchived()
  const rule = LINE_RULES[persona.line]

  // 线规则：分身素材仅经理 / KOS（FR-A2）
  if (input.kind === 'avatar_source' && !rule.avatarAllowed) {
    throw err.lineNotAllowed('素人矩阵不提供数字人口播，不能上传分身素材')
  }

  const limits = UPLOAD_LIMITS[input.kind]
  const meta = validateUploadFile(input.filename, input.size, input.head.subarray(0, MAGIC_HEAD_BYTES), {
    allowedExts: [...limits.exts],
    maxBytes: limits.maxBytes,
  })

  // 结构校验（图片，R27）
  if (input.kind === 'photo' || input.kind === 'background_image') {
    const buf = await fsp.readFile(input.filePath)
    const issue = checkImageStructure(meta.ext, buf)
    if (issue) {
      throw err.assetUnsupported(issue.message, { code: issue.code })
    }
  }

  // 数量上限（不含软删）
  const liveCount =
    (await db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM `persona_asset` WHERE `persona_id` = ? AND `kind` = ? AND `deleted_at` IS NULL',
      [input.personaId, input.kind],
    ))?.c ?? 0
  if (liveCount >= ASSET_LIMITS[input.kind]) {
    throw err.assetLimit(`${ASSET_KIND_LABELS[input.kind]}数量已达上限 ${ASSET_LIMITS[input.kind]} 个`, {
      kind: input.kind,
      max: ASSET_LIMITS[input.kind],
    })
  }

  // SHA-256 去重
  const fileBuf = await fsp.readFile(input.filePath)
  const sha256 = crypto.createHash('sha256').update(fileBuf).digest('hex')
  const existing = await db.get<Record<string, any>>(
    'SELECT * FROM `persona_asset` WHERE `persona_id` = ? AND `kind` = ? AND `sha256_key` = ? AND `deleted_at` IS NULL',
    [input.personaId, input.kind, sha256],
  )
  if (existing) {
    return { asset: mapAssetRow(existing), deduplicated: true }
  }

  const id = newId('pa')
  const storageKey = `${storagePrefix(input.personaId, input.kind)}/${id}${meta.ext}`
  const name = String(input.name ?? '').trim() || path.parse(input.filename).name || ASSET_KIND_LABELS[input.kind]
  const backgroundLabel =
    input.kind === 'avatar_source' ? String(input.backgroundLabel ?? '').trim().slice(0, 20) || null : null
  const tags = input.kind === 'background_image' || input.kind === 'background_video' || input.kind === 'broll_video'
    ? uniq((input.tags ?? []).map(String)).slice(0, 10).map((t) => t.trim().slice(0, 20)).filter(Boolean)
    : []

  const now = toDb(utcNow())
  try {
    await db.run(
      `INSERT INTO \`persona_asset\`
        (\`id\`, \`persona_id\`, \`kind\`, \`name\`, \`background_label\`, \`status\`, \`storage_key\`, \`mime\`, \`size_bytes\`,
         \`sha256\`, \`sha256_key\`, \`tags\`, \`sort\`, \`created_by\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, ?, ?, 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.personaId,
        input.kind,
        name.slice(0, 60),
        backgroundLabel,
        storageKey,
        meta.mime,
        input.size,
        sha256,
        sha256,
        jenc(tags),
        liveCount,
        input.operator,
        now,
        now,
      ],
    )
  } catch (e) {
    if (isDuplicateKey(e)) {
      // 并发同哈希：回查先写者
      const dup = await db.get<Record<string, any>>(
        'SELECT * FROM `persona_asset` WHERE `persona_id` = ? AND `kind` = ? AND `sha256_key` = ? AND `deleted_at` IS NULL',
        [input.personaId, input.kind, sha256],
      )
      if (dup) return { asset: mapAssetRow(dup), deduplicated: true }
    }
    throw e
  }

  // 私有存储（OSS 或本地兜底）
  await putObjectFromFile(input.filePath, storageKey, '')
  await db.run('UPDATE `persona_asset` SET `status` = ?, `updated_at` = ? WHERE `id` = ?', ['processing', now, id])

  // 异步处理（FR-A2/§2.3）
  await enqueue(QUEUE_NAMES.personaAssetProcess, 'process', { assetId: id }, dedupOpts(`asset-${id}`)).catch((e) => {
    // 入队失败不阻塞上传记录；处理任务重启后可补跑
    logger.error({ assetId: id, err: (e as Error).message }, 'persona.asset.enqueue_failed')
  })

  const asset = (await getAssetById(id))!
  return { asset, deduplicated: false }
}

/* ── 查询 / 维护 ────────────────────────────────────────────────── */

export async function getAssetById(id: string, db: Db = getDb()): Promise<PersonaAsset | null> {
  const r = await db.get<Record<string, any>>('SELECT * FROM `persona_asset` WHERE `id` = ?', [id])
  return r ? mapAssetRow(r) : null
}

export async function listAssets(
  personaId: string,
  f: { kind?: AssetKind; status?: AssetStatus; includeDeleted?: boolean } = {},
  db: Db = getDb(),
): Promise<PersonaAsset[]> {
  const where = ['`persona_id` = ?']
  const params: unknown[] = [personaId]
  if (!f.includeDeleted) where.push('`deleted_at` IS NULL')
  if (f.kind) {
    where.push('`kind` = ?')
    params.push(f.kind)
  }
  if (f.status) {
    where.push('`status` = ?')
    params.push(f.status)
  }
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`persona_asset\` WHERE ${where.join(' AND ')} ORDER BY \`sort\` ASC, \`created_at\` DESC`,
    params,
  )
  return rows.map(mapAssetRow)
}

export async function patchAsset(
  id: string,
  patch: { name?: string; backgroundLabel?: string; tags?: string[]; sort?: number },
  operator: string,
): Promise<PersonaAsset> {
  const db = getDb()
  const asset = await getAssetById(id)
  if (!asset) throw err.notFound('素材不存在')
  if (asset.deletedAt) throw err.invalidState('素材已删除')
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    const name = String(patch.name).trim()
    if (!name) throw err.badRequest('名称不能为空')
    sets.push('`name` = ?')
    params.push(name.slice(0, 60))
  }
  if (patch.backgroundLabel !== undefined) {
    if (asset.kind !== 'avatar_source') throw err.badRequest('仅分身素材可登记背景名')
    sets.push('`background_label` = ?')
    params.push(String(patch.backgroundLabel).trim().slice(0, 20) || null)
  }
  if (patch.tags !== undefined) {
    if (!['background_image', 'background_video', 'broll_video'].includes(asset.kind)) {
      throw err.badRequest('仅背景 / 空镜素材可打标签')
    }
    sets.push('`tags` = ?')
    params.push(jenc(uniq(patch.tags.map(String)).slice(0, 10).map((t) => t.trim().slice(0, 20)).filter(Boolean)))
  }
  if (patch.sort !== undefined) {
    sets.push('`sort` = ?')
    params.push(Math.max(0, Math.min(9999, Number(patch.sort) || 0)))
  }
  if (!sets.length) return asset
  sets.push('`updated_at` = ?')
  params.push(toDb(utcNow()), id)
  await db.run(`UPDATE \`persona_asset\` SET ${sets.join(', ')} WHERE \`id\` = ?`, params)
  void operator
  return (await getAssetById(id))!
}

export interface ReviewAssetInput {
  decision: 'approved' | 'rejected'
  reason?: string
  issueCodes?: string[]
  operator: string
}

/** 人工审核（FR-A / L8）：驳回原因必填；issue code 规范校验（R28） */
export async function reviewAsset(id: string, input: ReviewAssetInput): Promise<PersonaAsset> {
  const db = getDb()
  const asset = await getAssetById(id)
  if (!asset) throw err.notFound('素材不存在')
  if (asset.deletedAt) throw err.invalidState('素材已删除')
  if (asset.status !== 'pending_review') {
    throw err.invalidState(`当前状态（${asset.status}）不可审核，仅「待审核」素材可操作`, { status: asset.status })
  }
  // P0-1 四眼原则：上传人不能审核自己上传的素材
  if (asset.createdBy && asset.createdBy === input.operator) {
    throw err.forbidden('素材须由上传人以外的审核员审核')
  }
  const reason = String(input.reason ?? '').trim()
  if (input.decision === 'rejected' && !reason) {
    throw err.badRequest('驳回必须填写原因')
  }
  const issueCodes = uniq((input.issueCodes ?? []).map(String)).filter((c) => /^[A-Z][A-Z0-9_]{1,63}$/.test(c))
  if (input.issueCodes?.length && issueCodes.length !== input.issueCodes.length) {
    throw err.badRequest('issue code 需为大写字母开头、仅含大写字母数字下划线（≤64 字符）', {
      received: input.issueCodes,
    })
  }
  const now = toDb(utcNow())
  await db.run(
    `UPDATE \`persona_asset\`
     SET \`status\` = ?, \`review_decision\` = ?, \`review_reason\` = ?, \`review_issue_codes\` = ?, \`reviewed_by\` = ?, \`reviewed_at\` = ?, \`updated_at\` = ?
     WHERE \`id\` = ? AND \`status\` = 'pending_review'`,
    [input.decision === 'approved' ? 'approved' : 'rejected', input.decision, reason || null, jenc(issueCodes), input.operator, now, now, id],
  )
  return (await getAssetById(id))!
}

/** 设为封面（FR-A1：仅已审核通过的照片） */
export async function setCoverAsset(personaId: string, assetId: string, operator: string): Promise<void> {
  const db = getDb()
  const asset = await getAssetById(assetId)
  if (!asset || asset.personaId !== personaId) throw err.notFound('素材不存在')
  if (asset.kind !== 'photo') throw err.badRequest('仅形象照片可设为封面')
  if (asset.status !== 'approved' || asset.deletedAt) throw err.assetNotApproved('照片尚未审核通过，不能设为封面')
  await db.run('UPDATE `persona` SET `cover_asset_id` = ?, `updated_at` = ?, `updated_by` = ? WHERE `id` = ?', [
    assetId,
    toDb(utcNow()),
    operator,
    personaId,
  ])
}

/** 软删（§2.3：任一态可软删；sha256_key 置 NULL 释放去重位） */
export async function softDeleteAsset(id: string, operator: string): Promise<void> {
  const db = getDb()
  const asset = await getAssetById(id)
  if (!asset) throw err.notFound('素材不存在')
  if (asset.deletedAt) return // 幂等
  const now = toDb(utcNow())
  await db.run(
    'UPDATE `persona_asset` SET `deleted_at` = ?, `deleted_by` = ?, `sha256_key` = NULL, `updated_at` = ? WHERE `id` = ?',
    [now, operator, now, id],
  )
  // 封面引用清理
  const persona = await getPersonaById(asset.personaId, true)
  if (persona?.coverAssetId === id) {
    await db.run('UPDATE `persona` SET `cover_asset_id` = NULL WHERE `id` = ?', [asset.personaId])
  }
}

/** 处理失败时置 failed 并记录原因（worker 用） */
export async function markAssetFailed(id: string, message: string): Promise<void> {
  await getDb().run('UPDATE `persona_asset` SET `status` = ?, `error` = ?, `updated_at` = ? WHERE `id` = ?', [
    'failed',
    message.slice(0, 2000),
    toDb(utcNow()),
    id,
  ])
}

/* ── 文件读取（FR-A4：经后端流式代理 + 敏感访问审计）────────────── */

export interface AssetFileTarget {
  variant: 'thumb' | 'compat' | 'original'
  storageKey: string
  filename: string
}

export function assetFileTarget(asset: PersonaAsset, variant: 'thumb' | 'compat' | 'original'): AssetFileTarget {
  if (variant === 'thumb') {
    if (!asset.thumbKey) throw err.notFound('缩略图尚未生成')
    return { variant, storageKey: asset.thumbKey, filename: `${asset.name || asset.id}.jpg` }
  }
  if (variant === 'compat') {
    if (!asset.compatKey) throw err.notFound('兼容版本尚未生成')
    return { variant, storageKey: asset.compatKey, filename: `${asset.name || asset.id}.mp4` }
  }
  return { variant, storageKey: asset.storageKey, filename: `${asset.name || asset.id}` }
}

/** 读取存储对象（OSS 或本地兜底）；本地兜底可直接拿到绝对路径 */
export async function readAssetStream(
  storageKey: string,
  range?: string,
): Promise<Awaited<ReturnType<typeof getObjectStream>>> {
  return getObjectStream(storageKey, range)
}

/** 本地兜底路径（仅本地存储可用） */
export function localAssetPath(storageKey: string): string | null {
  if (isOssEnabled()) return null
  return path.join(paths.dataDir, 'oss', storageKey)
}
