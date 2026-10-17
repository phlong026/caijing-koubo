import { getDb, type Db, type Row } from '../../db/index.js'
import { jdec, jenc } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'
import type { Section } from './constants.js'

/**
 * 文案工坊数据访问层。
 * 约定：库内存 snake_case，对外统一 camelCase；时间列一律 UTC，出口转 ISO8601。
 */

/* ── copy ─────────────────────────────────────────────────────────── */

export interface CopyRow {
  id: string
  topicId: string | null
  personaId: string | null
  source: string
  status: string
  title: string | null
  sourceText: string | null
  sourceRefType: string | null
  sourceRefId: string | null
  extractCacheId: string | null
  body: string | null
  createdBy: string | null
  createdAt: string | null
  line: string | null
  currentDraftId: string | null
  submittedVersionId: string | null
  approvedVersionId: string | null
  reviewSubmissionId: string | null
  reviewGate: string | null
  rejectReason: string | null
  settings: Record<string, unknown> | null
  everSubmitted: boolean
  updatedAt: string | null
  archivedAt: string | null
}

export function mapCopy(r: Row): CopyRow {
  return {
    id: r.id,
    topicId: r.topic_id ?? null,
    personaId: r.persona_id ?? null,
    source: r.source,
    status: r.status,
    title: r.title ?? null,
    sourceText: r.source_text ?? null,
    sourceRefType: r.source_ref_type ?? null,
    sourceRefId: r.source_ref_id ?? null,
    extractCacheId: r.extract_cache_id ?? null,
    body: r.body ?? null,
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    line: r.line ?? null,
    currentDraftId: r.current_draft_id ?? null,
    submittedVersionId: r.submitted_version_id ?? null,
    approvedVersionId: r.approved_version_id ?? null,
    reviewSubmissionId: r.review_submission_id ?? null,
    reviewGate: r.review_gate ?? null,
    rejectReason: r.reject_reason ?? null,
    settings: jdec<Record<string, unknown> | null>(r.settings, null),
    everSubmitted: !!r.ever_submitted,
    updatedAt: fromDb(r.updated_at ?? r.created_at),
    archivedAt: fromDb(r.archived_at),
  }
}

export async function getCopy(id: string, db: Db = getDb()): Promise<CopyRow | null> {
  const r = await db.get<Row>('SELECT * FROM `copy` WHERE `id` = ?', [id])
  return r ? mapCopy(r) : null
}

export async function requireCopy(id: string, db: Db = getDb()): Promise<CopyRow> {
  const c = await getCopy(id, db)
  if (!c) {
    const { err } = await import('../../errors.js')
    throw err.notFound(`文案不存在：${id}`)
  }
  return c
}

export interface CopyListFilter {
  status?: string
  derivedStatus?: string
  personaId?: string
  line?: string
  source?: string
  keyword?: string
  ids?: string[]
  topicId?: string
  includeArchived?: boolean
  /** 更新时间倒序（默认） */
  limit: number
  offset: number
}

/** 列表查询（FR-M1 / AC-M1）：状态含派生状态，支持 ids 过滤 */
export async function listCopies(
  f: CopyListFilter,
  db: Db = getDb(),
): Promise<{ rows: Array<CopyRow & { draftCount: number }>; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (!f.includeArchived) where.push("`status` <> 'archived'")
  if (f.status) {
    where.push('`status` = ?')
    params.push(f.status)
  }
  if (f.derivedStatus) {
    // 派生状态：pending_write = draft 且无稿；revising = draft 且有通过版本；writing = draft 且其余
    const hasDraft = 'EXISTS (SELECT 1 FROM `copy_draft` d WHERE d.`copy_id` = `copy`.`id` AND d.`deleted_at` IS NULL)'
    if (f.derivedStatus === 'pending_write') {
      where.push("`status` = 'draft'")
      where.push(`NOT ${hasDraft}`)
    } else if (f.derivedStatus === 'revising') {
      where.push("`status` = 'draft'")
      where.push('`approved_version_id` IS NOT NULL')
    } else if (f.derivedStatus === 'writing') {
      where.push("`status` = 'draft'")
      where.push('`approved_version_id` IS NULL')
      where.push(hasDraft)
    } else {
      where.push('`status` = ?')
      params.push(f.derivedStatus)
    }
  }
  if (f.personaId) {
    where.push('`persona_id` = ?')
    params.push(f.personaId)
  }
  if (f.line) {
    where.push('`line` = ?')
    params.push(f.line)
  }
  if (f.source) {
    where.push('`source` = ?')
    params.push(f.source)
  }
  if (f.topicId) {
    where.push('`topic_id` = ?')
    params.push(f.topicId)
  }
  if (f.keyword) {
    where.push('`title` LIKE ?')
    params.push(`%${f.keyword}%`)
  }
  if (f.ids?.length) {
    where.push(`\`id\` IN (${f.ids.map(() => '?').join(', ')})`)
    params.push(...f.ids)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total =
    (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM \`copy\` ${whereSql}`, params))?.c ?? 0
  const rows = await db.all<Row>(
    `SELECT * FROM \`copy\` ${whereSql}
     ORDER BY COALESCE(\`updated_at\`, \`created_at\`) DESC, \`created_at\` DESC
     LIMIT ? OFFSET ?`,
    [...params, f.limit, f.offset],
  )
  const copies = rows.map(mapCopy)

  // 稿数（列表展示「N 稿」）
  const counts = new Map<string, number>()
  if (copies.length) {
    const ids = copies.map((c) => c.id)
    const cs = await db.all<{ copy_id: string; c: number }>(
      `SELECT \`copy_id\`, COUNT(*) AS c FROM \`copy_draft\`
       WHERE \`deleted_at\` IS NULL AND \`copy_id\` IN (${ids.map(() => '?').join(', ')})
       GROUP BY \`copy_id\``,
      ids,
    )
    for (const r of cs) counts.set(r.copy_id, Number(r.c))
  }
  return {
    rows: copies.map((c) => ({ ...c, draftCount: counts.get(c.id) ?? 0 })),
    total,
  }
}

/** 派生状态（§3.1，不入库） */
export function derivedStatusOf(copy: CopyRow, draftCount: number): string {
  if (copy.status !== 'draft') return copy.status
  if (copy.approvedVersionId) return 'revising'
  return draftCount > 0 ? 'writing' : 'pending_write'
}

/** 更新 copy 若干列（内部用，调用方负责状态校验） */
export async function updateCopy(id: string, patch: Record<string, unknown>, db: Db = getDb()): Promise<void> {
  const keys = Object.keys(patch)
  if (!keys.length) return
  const sets = keys.map((k) => `\`${k}\` = ?`).join(', ')
  await db.run(`UPDATE \`copy\` SET ${sets} WHERE \`id\` = ?`, [...keys.map((k) => patch[k]), id])
}

/** touch 更新时间（列表排序依赖） */
export async function touchCopy(id: string, db: Db = getDb()): Promise<void> {
  await db.run('UPDATE `copy` SET `updated_at` = ? WHERE `id` = ?', [toDb(utcNow()), id])
}

/* ── copy_draft ───────────────────────────────────────────────────── */

export interface DraftRow {
  id: string
  copyId: string
  draftNo: number
  name: string
  title: string | null
  sections: Section[]
  plainText: string
  wordCount: number
  rev: number
  latestVersionNo: number
  hasSubmitted: boolean
  origin: string
  generationId: string | null
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
}

export function mapDraft(r: Row): DraftRow {
  return {
    id: r.id,
    copyId: r.copy_id,
    draftNo: Number(r.draft_no ?? 1),
    name: r.name ?? `稿 ${r.draft_no ?? 1}`,
    title: r.title ?? null,
    sections: jdec<Section[]>(r.sections, []),
    plainText: r.plain_text ?? '',
    wordCount: Number(r.word_count ?? 0),
    rev: Number(r.rev ?? 0),
    latestVersionNo: Number(r.latest_version_no ?? 0),
    hasSubmitted: !!r.has_submitted,
    origin: r.origin ?? 'manual',
    generationId: r.generation_id ?? null,
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}

export async function listDrafts(copyId: string, db: Db = getDb()): Promise<DraftRow[]> {
  const rows = await db.all<Row>(
    'SELECT * FROM `copy_draft` WHERE `copy_id` = ? AND `deleted_at` IS NULL ORDER BY `draft_no`',
    [copyId],
  )
  return rows.map(mapDraft)
}

export async function getDraft(copyId: string, draftId: string, db: Db = getDb()): Promise<DraftRow | null> {
  const r = await db.get<Row>(
    'SELECT * FROM `copy_draft` WHERE `id` = ? AND `copy_id` = ? AND `deleted_at` IS NULL',
    [draftId, copyId],
  )
  return r ? mapDraft(r) : null
}

export async function getDraftById(draftId: string, db: Db = getDb()): Promise<DraftRow | null> {
  const r = await db.get<Row>('SELECT * FROM `copy_draft` WHERE `id` = ? AND `deleted_at` IS NULL', [draftId])
  return r ? mapDraft(r) : null
}

/** 下一个稿序号（删除后不复用，避免稿号跳变引起误解） */
export async function nextDraftNo(copyId: string, db: Db = getDb()): Promise<number> {
  const r = await db.get<{ n: number | null }>(
    'SELECT MAX(`draft_no`) AS n FROM `copy_draft` WHERE `copy_id` = ?',
    [copyId],
  )
  return Number(r?.n ?? 0) + 1
}

export async function countDrafts(copyId: string, db: Db = getDb()): Promise<number> {
  const r = await db.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM `copy_draft` WHERE `copy_id` = ? AND `deleted_at` IS NULL',
    [copyId],
  )
  return Number(r?.c ?? 0)
}

export interface InsertDraftInput {
  copyId: string
  draftNo: number
  name: string
  title: string | null
  sections: Section[]
  plainText: string
  wordCount: number
  origin: string
  generationId?: string | null
  createdBy: string
}

export async function insertDraft(input: InsertDraftInput, db: Db = getDb()): Promise<string> {
  const { newId } = await import('../../lib/util.js')
  const id = newId('draft')
  const now = toDb(utcNow())
  await db.run(
    `INSERT INTO \`copy_draft\`
      (\`id\`, \`copy_id\`, \`draft_no\`, \`name\`, \`title\`, \`sections\`, \`plain_text\`, \`word_count\`,
       \`rev\`, \`latest_version_no\`, \`has_submitted\`, \`origin\`, \`generation_id\`, \`created_by\`, \`created_at\`, \`updated_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
    [
      id,
      input.copyId,
      input.draftNo,
      input.name,
      input.title,
      jenc(input.sections),
      input.plainText,
      input.wordCount,
      input.origin,
      input.generationId ?? null,
      input.createdBy,
      now,
      now,
    ],
  )
  return id
}

/* ── copy_version ─────────────────────────────────────────────────── */

export interface VersionRow {
  id: string
  copyId: string
  draftId: string
  versionNo: number
  title: string | null
  sections: Section[]
  plainText: string
  wordCount: number
  contentHash: string | null
  origin: string
  locked: boolean
  complianceHits: unknown[] | null
  similarity: number | null
  createdBy: string | null
  createdAt: string | null
}

export function mapVersion(r: Row): VersionRow {
  return {
    id: r.id,
    copyId: r.copy_id,
    draftId: r.draft_id,
    versionNo: Number(r.version_no ?? 0),
    title: r.title ?? null,
    sections: jdec<Section[]>(r.sections, []),
    plainText: r.plain_text ?? '',
    wordCount: Number(r.word_count ?? 0),
    contentHash: r.content_hash ?? null,
    origin: r.origin,
    locked: !!r.locked,
    complianceHits: jdec<unknown[] | null>(r.compliance_hits, null),
    similarity: r.similarity === null || r.similarity === undefined ? null : Number(r.similarity),
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
  }
}

export async function latestVersion(copyId: string, db: Db = getDb()): Promise<VersionRow | null> {
  const r = await db.get<Row>(
    'SELECT * FROM `copy_version` WHERE `copy_id` = ? ORDER BY `version_no` DESC LIMIT 1',
    [copyId],
  )
  return r ? mapVersion(r) : null
}

export async function getVersion(versionId: string, db: Db = getDb()): Promise<VersionRow | null> {
  const r = await db.get<Row>('SELECT * FROM `copy_version` WHERE `id` = ?', [versionId])
  return r ? mapVersion(r) : null
}

export async function listVersions(copyId: string, draftId?: string, db: Db = getDb()): Promise<VersionRow[]> {
  const where = draftId ? '`copy_id` = ? AND `draft_id` = ?' : '`copy_id` = ?'
  const params = draftId ? [copyId, draftId] : [copyId]
  const rows = await db.all<Row>(
    `SELECT * FROM \`copy_version\` WHERE ${where} ORDER BY \`version_no\` DESC`,
    params,
  )
  return rows.map(mapVersion)
}

export interface InsertVersionInput {
  copyId: string
  draftId: string
  title: string | null
  sections: Section[]
  plainText: string
  wordCount: number
  contentHash: string
  origin: string
  locked?: boolean
  complianceHits?: unknown
  similarity?: number | null
  createdBy: string
}

/**
 * 插入版本：`version_no` 在 copy 内单调递增（W3 / §3.2）。
 * 递增在 SQL 内完成，避免并发读-改-写重号；`UNIQUE(copy_id, version_no)` 兜底。
 */
export async function insertVersion(input: InsertVersionInput, db: Db = getDb()): Promise<VersionRow> {
  const { newId } = await import('../../lib/util.js')
  const id = newId('ver')
  const now = toDb(utcNow())
  const next =
    (await db.get<{ n: number | null }>('SELECT MAX(`version_no`) AS n FROM `copy_version` WHERE `copy_id` = ?', [
      input.copyId,
    ]))?.n ?? 0
  const versionNo = Number(next) + 1
  await db.run(
    `INSERT INTO \`copy_version\`
      (\`id\`, \`copy_id\`, \`draft_id\`, \`version_no\`, \`title\`, \`sections\`, \`plain_text\`, \`word_count\`,
       \`content_hash\`, \`origin\`, \`locked\`, \`compliance_hits\`, \`similarity\`, \`created_by\`, \`created_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.copyId,
      input.draftId,
      versionNo,
      input.title,
      jenc(input.sections),
      input.plainText,
      input.wordCount,
      input.contentHash,
      input.origin,
      input.locked ? 1 : 0,
      input.complianceHits === undefined ? null : jenc(input.complianceHits),
      input.similarity ?? null,
      input.createdBy,
      now,
    ],
  )
  return {
    id,
    copyId: input.copyId,
    draftId: input.draftId,
    versionNo,
    title: input.title,
    sections: input.sections,
    plainText: input.plainText,
    wordCount: input.wordCount,
    contentHash: input.contentHash,
    origin: input.origin,
    locked: !!input.locked,
    complianceHits: (input.complianceHits as unknown[]) ?? null,
    similarity: input.similarity ?? null,
    createdBy: input.createdBy,
    createdAt: fromDb(now),
  }
}

/** 稿的最新版本（用于「保存草稿」hash 去重） */
export async function latestVersionOfDraft(draftId: string, db: Db = getDb()): Promise<VersionRow | null> {
  const r = await db.get<Row>(
    'SELECT * FROM `copy_version` WHERE `draft_id` = ? ORDER BY `version_no` DESC LIMIT 1',
    [draftId],
  )
  return r ? mapVersion(r) : null
}

/* ── copy_generation ──────────────────────────────────────────────── */

export interface GenerationRow {
  id: string
  copyId: string
  draftId: string | null
  kind: string
  mode: string
  templateId: string | null
  templateRev: number
  styleId: string | null
  styleRev: number
  durationTier: string
  durationSeconds: number | null
  count: number
  instructions: string | null
  targetSection: number | null
  personaSnapshot: Record<string, unknown> | null
  promptText: string | null
  promptHash: string | null
  model: string | null
  status: string
  succeeded: number
  failed: number
  error: string | null
  cost: number
  idempotencyKey: string | null
  createdBy: string | null
  createdAt: string | null
  finishedAt: string | null
}

export function mapGeneration(r: Row): GenerationRow {
  return {
    id: r.id,
    copyId: r.copy_id,
    draftId: r.draft_id ?? null,
    kind: r.kind ?? 'generate',
    mode: r.mode,
    templateId: r.template_id ?? null,
    templateRev: Number(r.template_rev ?? 0),
    styleId: r.style_id ?? null,
    styleRev: Number(r.style_rev ?? 0),
    durationTier: r.duration_tier ?? 'medium',
    durationSeconds: r.duration_seconds === null || r.duration_seconds === undefined ? null : Number(r.duration_seconds),
    count: Number(r.count ?? 1),
    instructions: r.instructions ?? null,
    targetSection: r.target_section === null || r.target_section === undefined ? null : Number(r.target_section),
    personaSnapshot: jdec<Record<string, unknown> | null>(r.persona_snapshot, null),
    promptText: r.prompt_text ?? null,
    promptHash: r.prompt_hash ?? null,
    model: r.model ?? null,
    status: r.status,
    succeeded: Number(r.succeeded ?? 0),
    failed: Number(r.failed ?? 0),
    error: r.error ?? null,
    cost: Number(r.cost ?? 0),
    idempotencyKey: r.idempotency_key ?? null,
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    finishedAt: fromDb(r.finished_at),
  }
}

export async function getGeneration(id: string, db: Db = getDb()): Promise<GenerationRow | null> {
  const r = await db.get<Row>('SELECT * FROM `copy_generation` WHERE `id` = ?', [id])
  return r ? mapGeneration(r) : null
}

export async function findGenerationByKey(key: string, db: Db = getDb()): Promise<GenerationRow | null> {
  const r = await db.get<Row>('SELECT * FROM `copy_generation` WHERE `idempotency_key` = ?', [key])
  return r ? mapGeneration(r) : null
}

/** 进行中的生成（同 copy 同稿同 kind 未完成则复用，避免双击重复入队） */
export async function runningGeneration(
  copyId: string,
  kind: string,
  db: Db = getDb(),
): Promise<GenerationRow | null> {
  const r = await db.get<Row>(
    `SELECT * FROM \`copy_generation\`
     WHERE \`copy_id\` = ? AND \`kind\` = ? AND \`status\` IN ('pending','running')
     ORDER BY \`created_at\` DESC LIMIT 1`,
    [copyId, kind],
  )
  return r ? mapGeneration(r) : null
}

export async function insertGeneration(
  row: Record<string, unknown>,
  db: Db = getDb(),
): Promise<string> {
  const { newId } = await import('../../lib/util.js')
  const id = (row.id as string) ?? newId('gen')
  const now = toDb(utcNow())
  await db.run(
    `INSERT INTO \`copy_generation\`
      (\`id\`, \`copy_id\`, \`draft_id\`, \`kind\`, \`mode\`, \`template_id\`, \`template_rev\`, \`style_id\`, \`style_rev\`,
       \`duration_tier\`, \`duration_seconds\`, \`count\`, \`instructions\`, \`target_section\`, \`target_section_text\`,
       \`persona_snapshot\`, \`prompt_text\`, \`prompt_hash\`, \`model\`, \`status\`, \`succeeded\`, \`failed\`, \`error\`, \`cost\`,
       \`idempotency_key\`, \`created_by\`, \`created_at\`, \`finished_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      row.copy_id,
      row.draft_id ?? null,
      row.kind ?? 'generate',
      row.mode,
      row.template_id ?? null,
      row.template_rev ?? 0,
      row.style_id ?? null,
      row.style_rev ?? 0,
      row.duration_tier ?? 'medium',
      row.duration_seconds ?? null,
      row.count ?? 1,
      row.instructions ?? null,
      row.target_section ?? null,
      row.target_section_text ?? null,
      jenc(row.persona_snapshot ?? null),
      row.prompt_text ?? null,
      row.prompt_hash ?? null,
      row.model ?? null,
      row.status ?? 'pending',
      row.succeeded ?? 0,
      row.failed ?? 0,
      row.error ?? null,
      row.cost ?? 0,
      row.idempotency_key ?? null,
      row.created_by ?? null,
      now,
      null,
    ],
  )
  return id
}

export async function updateGeneration(id: string, patch: Record<string, unknown>, db: Db = getDb()): Promise<void> {
  const keys = Object.keys(patch)
  if (!keys.length) return
  await db.run(
    `UPDATE \`copy_generation\` SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE \`id\` = ?`,
    [...keys.map((k) => patch[k]), id],
  )
}

/* ── copy_variant ─────────────────────────────────────────────────── */

export interface VariantRow {
  id: string
  copyId: string
  draftId: string
  generationId: string | null
  sectionIndex: number
  sectionTextAtGen: string | null
  kind: string
  text: string
  appliedAt: string | null
  appliedVersionId: string | null
  createdAt: string | null
}

export function mapVariant(r: Row): VariantRow {
  return {
    id: r.id,
    copyId: r.copy_id,
    draftId: r.draft_id,
    generationId: r.generation_id ?? null,
    sectionIndex: Number(r.section_index ?? 0),
    sectionTextAtGen: r.section_text_at_gen ?? null,
    kind: r.kind ?? '变体',
    text: r.text ?? '',
    appliedAt: fromDb(r.applied_at),
    appliedVersionId: r.applied_version_id ?? null,
    createdAt: fromDb(r.created_at),
  }
}

export async function insertVariant(
  v: {
    copyId: string
    draftId: string
    generationId: string
    sectionIndex: number
    sectionTextAtGen: string
    kind: string
    text: string
  },
  db: Db = getDb(),
): Promise<string> {
  const { newId } = await import('../../lib/util.js')
  const id = newId('var')
  await db.run(
    `INSERT INTO \`copy_variant\`
      (\`id\`, \`copy_id\`, \`draft_id\`, \`generation_id\`, \`section_index\`, \`section_text_at_gen\`, \`kind\`, \`text\`, \`created_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, v.copyId, v.draftId, v.generationId, v.sectionIndex, v.sectionTextAtGen, v.kind, v.text, toDb(utcNow())],
  )
  return id
}

export async function getVariant(id: string, db: Db = getDb()): Promise<VariantRow | null> {
  const r = await db.get<Row>('SELECT * FROM `copy_variant` WHERE `id` = ?', [id])
  return r ? mapVariant(r) : null
}

export async function listVariantsByGeneration(generationId: string, db: Db = getDb()): Promise<VariantRow[]> {
  const rows = await db.all<Row>(
    'SELECT * FROM `copy_variant` WHERE `generation_id` = ? ORDER BY `section_index`, `created_at`',
    [generationId],
  )
  return rows.map(mapVariant)
}

export async function listVariantsByDraft(draftId: string, db: Db = getDb()): Promise<VariantRow[]> {
  const rows = await db.all<Row>(
    'SELECT * FROM `copy_variant` WHERE `draft_id` = ? ORDER BY `created_at` DESC LIMIT 20',
    [draftId],
  )
  return rows.map(mapVariant)
}

/* ── copy_template / copy_style ───────────────────────────────────── */

export interface TemplateRow {
  id: string
  name: string
  description: string | null
  prompt: string
  structureHint: string | null
  riskHint: string | null
  isBuiltin: boolean
  enabled: boolean
  sort: number
  revision: number
  updatedBy: string | null
  updatedAt: string | null
}

export function mapTemplate(r: Row): TemplateRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    prompt: r.prompt ?? '',
    structureHint: r.structure_hint ?? null,
    riskHint: r.risk_hint ?? null,
    isBuiltin: !!r.is_builtin,
    enabled: !!r.enabled,
    sort: Number(r.sort ?? 0),
    revision: Number(r.revision ?? 1),
    updatedBy: r.updated_by ?? null,
    updatedAt: fromDb(r.updated_at),
  }
}

export async function listTemplates(enabledOnly = false, db: Db = getDb()): Promise<TemplateRow[]> {
  const rows = await db.all<Row>(
    `SELECT * FROM \`copy_template\` ${enabledOnly ? 'WHERE `enabled` = 1' : ''} ORDER BY \`sort\`, \`name\``,
  )
  return rows.map(mapTemplate)
}

export async function getTemplate(id: string, db: Db = getDb()): Promise<TemplateRow | null> {
  const r = await db.get<Row>('SELECT * FROM `copy_template` WHERE `id` = ?', [id])
  return r ? mapTemplate(r) : null
}

export interface StyleRow {
  id: string
  name: string
  line: string
  prompt: string
  isBuiltin: boolean
  enabled: boolean
  sort: number
  revision: number
  updatedBy: string | null
  updatedAt: string | null
}

export function mapStyle(r: Row): StyleRow {
  return {
    id: r.id,
    name: r.name,
    line: r.line,
    prompt: r.prompt ?? '',
    isBuiltin: !!r.is_builtin,
    enabled: !!r.enabled,
    sort: Number(r.sort ?? 0),
    revision: Number(r.revision ?? 1),
    updatedBy: r.updated_by ?? null,
    updatedAt: fromDb(r.updated_at),
  }
}

export async function listStyles(line?: string | null, enabledOnly = false, db: Db = getDb()): Promise<StyleRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (enabledOnly) where.push('`enabled` = 1')
  if (line) {
    where.push('`line` = ?')
    params.push(line)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = await db.all<Row>(`SELECT * FROM \`copy_style\` ${whereSql} ORDER BY \`line\`, \`sort\`, \`name\``, params)
  return rows.map(mapStyle)
}

export async function getStyle(id: string, db: Db = getDb()): Promise<StyleRow | null> {
  const r = await db.get<Row>('SELECT * FROM `copy_style` WHERE `id` = ?', [id])
  return r ? mapStyle(r) : null
}

/* ── compliance_word ──────────────────────────────────────────────── */

export interface ComplianceWordRecord {
  id: string
  word: string
  level: 'hard' | 'soft'
  category: string | null
  enabled: boolean
  updatedBy: string | null
  updatedAt: string | null
}

export function mapComplianceWord(r: Row): ComplianceWordRecord {
  return {
    id: r.id,
    word: r.word,
    level: (r.level === 'hard' ? 'hard' : 'soft') as 'hard' | 'soft',
    category: r.category ?? null,
    enabled: !!r.enabled,
    updatedBy: r.updated_by ?? null,
    updatedAt: fromDb(r.updated_at),
  }
}

export async function listComplianceWords(
  opts: { enabledOnly?: boolean; level?: string } = {},
  db: Db = getDb(),
): Promise<ComplianceWordRecord[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.enabledOnly) where.push('`enabled` = 1')
  if (opts.level) {
    where.push('`level` = ?')
    params.push(opts.level)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = await db.all<Row>(
    `SELECT * FROM \`compliance_word\` ${whereSql} ORDER BY \`level\`, \`word\``,
    params,
  )
  return rows.map(mapComplianceWord)
}

export async function getComplianceWord(id: string, db: Db = getDb()): Promise<ComplianceWordRecord | null> {
  const r = await db.get<Row>('SELECT * FROM `compliance_word` WHERE `id` = ?', [id])
  return r ? mapComplianceWord(r) : null
}

/* ── review_submission ────────────────────────────────────────────── */

export interface GateResult {
  gate: string
  result: 'pass' | 'fail'
  reason?: string | null
  riskPoints?: string[] | null
  confidence?: number | null
  at: string
}

export interface SubmissionRow {
  id: string
  copyId: string
  copyVersionId: string
  status: string
  gateResults: GateResult[]
  appendedRiskText: string | null
  rejectedGate: string | null
  reason: string | null
  decidedBy: string | null
  isStub: boolean
  createdAt: string | null
  updatedAt: string | null
}

export function mapSubmission(r: Row): SubmissionRow {
  return {
    id: r.id,
    copyId: r.copy_id,
    copyVersionId: r.copy_version_id,
    status: r.status,
    gateResults: jdec<GateResult[]>(r.gate_results, []),
    appendedRiskText: r.appended_risk_text ?? null,
    rejectedGate: r.rejected_gate ?? null,
    reason: r.reason ?? null,
    decidedBy: r.decided_by ?? null,
    isStub: !!r.is_stub,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}

export async function getSubmission(id: string, db: Db = getDb()): Promise<SubmissionRow | null> {
  const r = await db.get<Row>('SELECT * FROM `review_submission` WHERE `id` = ?', [id])
  return r ? mapSubmission(r) : null
}

export async function getSubmissionByVersion(versionId: string, db: Db = getDb()): Promise<SubmissionRow | null> {
  const r = await db.get<Row>('SELECT * FROM `review_submission` WHERE `copy_version_id` = ?', [versionId])
  return r ? mapSubmission(r) : null
}

export async function listSubmissionsByCopy(copyId: string, db: Db = getDb()): Promise<SubmissionRow[]> {
  const rows = await db.all<Row>(
    'SELECT * FROM `review_submission` WHERE `copy_id` = ? ORDER BY `created_at` DESC',
    [copyId],
  )
  return rows.map(mapSubmission)
}

/* ── article_source ───────────────────────────────────────────────── */

export interface ArticleRow {
  id: string
  filename: string | null
  mime: string | null
  size: number
  storagePath: string | null
  outline: OutlineNode[] | null
  plainText: string
  wordCount: number
  status: string
  error: string | null
  createdBy: string | null
  createdAt: string | null
}

export interface OutlineNode {
  /** 从 0 开始的节点序号（article 模式 sourceRefs 用它） */
  index: number
  /** 1–3 标题层级；0 = 无层级（txt/pdf 按空行切段的顶层节点） */
  level: number
  title: string
  paragraphs: number
  chars: number
}

export function mapArticle(r: Row): ArticleRow {
  return {
    id: r.id,
    filename: r.filename ?? null,
    mime: r.mime ?? null,
    size: Number(r.size ?? 0),
    storagePath: r.storage_path ?? null,
    outline: jdec<OutlineNode[] | null>(r.outline, null),
    plainText: r.plain_text ?? '',
    wordCount: Number(r.word_count ?? 0),
    status: r.status,
    error: r.error ?? null,
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
  }
}

export async function getArticle(id: string, db: Db = getDb()): Promise<ArticleRow | null> {
  const r = await db.get<Row>('SELECT * FROM `article_source` WHERE `id` = ?', [id])
  return r ? mapArticle(r) : null
}
