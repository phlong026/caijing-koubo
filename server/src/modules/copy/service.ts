import { getDb, type Db } from '../../db/index.js'
import { newId, jenc, toInt } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { config, hasJiaoduitai } from '../../config.js'
import { logger } from '../../log.js'
import { createDraftsFromTopics, createInitialDrafts } from '../copy-contract/service.js'
import {
  countDrafts,
  getCopy,
  getDraft,
  insertDraft,
  insertVersion,
  latestVersionOfDraft,
  listDrafts,
  requireCopy,
  touchCopy,
  updateCopy,
  type CopyRow,
  type DraftRow,
  type VersionRow,
} from './repo.js'
import {
  computeSimilarity,
  countBodyWords,
  countSectionsWords,
  contentHash,
  estimateSeconds,
  scanCompliance,
  toPlainText,
  type ComplianceHit,
} from './text.js'
import {
  DERIVED_STATUS_LABELS,
  LINE_LABELS,
  SOURCE_LABELS,
  SUBMISSION_STATUS_LABELS,
  wordRangeOf,
  tierOf,
  type Section,
  WITHDRAWABLE_STATUSES,
} from './constants.js'
import { listComplianceWords } from './repo.js'
import { assertPersonasUsable, derivePersonaStatus, getPersonasByIds } from '../personas/repo.js'
import { getPersonaById } from './persona-bridge.js'

/**
 * 文案工坊领域服务：创作单元（copy）、稿（draft）、版本（version）与状态机。
 * 关键约束：
 *  - `in_review` 下除撤回外的写操作一律 409 COPY_LOCKED；
 *  - `archived` 下任何写操作 409 INVALID_STATE；
 *  - AI 结果永不覆盖已有稿（W5）；
 *  - `db.tx` 不可嵌套，多步原子性统一在最外层一次 tx 内完成。
 */

/* ── 状态机守卫（§3.1）───────────────────────────────────────────── */

export function assertWritable(copy: CopyRow): void {
  if (copy.status === 'archived') {
    throw err.invalidState('该文案已归档，不可再操作', { copyId: copy.id, status: copy.status })
  }
  if (copy.status === 'in_review') {
    throw err.copyLocked('该文案正在审核中，暂不可编辑；如需修改请先撤回提交', {
      copyId: copy.id,
      submissionId: copy.reviewSubmissionId,
      gate: copy.reviewGate,
    })
  }
}

/** 已通过状态下编辑需显式确认（FR-R6 / W11） */
export function assertEditableWithConfirm(copy: CopyRow, confirmReedit?: boolean): void {
  assertWritable(copy)
  if (copy.status === 'approved' && !confirmReedit) {
    throw err.invalidState(
      `该文案已审核通过（v${copy.approvedVersionId ? '已通过版本' : '-'}）。修改后须重新审核，已生成的视频仍绑定原版本。请确认后再编辑。`,
      { requiresConfirm: true, approvedVersionId: copy.approvedVersionId },
    )
  }
}

/** 通过后编辑：状态回 draft，approved_version_id 保留（W11） */
export async function downgradeApprovedToDraft(copy: CopyRow, operator: string, db: Db = getDb()): Promise<void> {
  if (copy.status !== 'approved') return
  await updateCopy(
    copy.id,
    {
      status: 'draft',
      updated_at: toDb(utcNow()),
      reject_reason: null,
      review_gate: null,
    },
    db,
  )
  const { recordOperation } = await import('../audit/repo.js')
  await recordOperation({
    operator,
    action: 'copy.reedit_approved',
    targetType: 'copy',
    targetId: copy.id,
    detail: { approvedVersionId: copy.approvedVersionId },
  })
}

/* ── 创建文案（W6：article / manual 原子创建 topic + copy）─────────── */

export interface CreateCopyInput {
  source: 'article' | 'manual'
  personaIds: string[]
  title: string
  articleId?: string | null
  sourceText?: string | null
  keywords?: string | null
  operator: string
}

export interface CreateCopyResult {
  topicId: string
  copyIds: string[]
}

/**
 * FR-S2 / FR-S4 / W6：
 * 服务端**单事务**原子创建 `topic(source=article|manual, status=sent)` + 每个 persona 一条 copy。
 * topic 直接 sent，不经 candidate/assigned（同 benchmark FR-C1② 规则）。
 */
export async function createCopyFromArticleOrManual(input: CreateCopyInput): Promise<CreateCopyResult> {
  const db = getDb()
  const title = String(input.title ?? '').trim()
  if (!title) throw err.badRequest('标题必填')
  if (title.length > config.copy.maxTitle) {
    throw err.badRequest(`标题不能超过 ${config.copy.maxTitle} 字`, { length: title.length })
  }
  const personaIds = Array.from(new Set((input.personaIds ?? []).filter(Boolean).map(String)))
  if (!personaIds.length) throw err.badRequest('请至少选择一位目标人物')

  // 人物校验（FR-X2：不存在 / 归档 / 停用 / 授权失效分别给出原因）与所属线冗余值
  await assertPersonasUsable(personaIds, db, 'copy')
  const personas = await getPersonasByIds(personaIds)

  let sourceText = String(input.sourceText ?? '').trim()
  let refType: string | null = null
  let refId: string | null = null

  if (input.source === 'article') {
    if (!input.articleId) throw err.badRequest('文章模式下 articleId 必填')
    const article = await db.get<{ id: string; plain_text: string | null; status: string }>(
      'SELECT `id`, `plain_text`, `status` FROM `article_source` WHERE `id` = ?',
      [input.articleId],
    )
    if (!article) throw err.notFound('文章不存在或已过期，请重新上传')
    if (article.status !== 'parsed') throw err.badRequest('文章解析未成功，请重新上传')
    sourceText = article.plain_text ?? ''
    refType = 'article_source'
    refId = article.id
  } else {
    if (sourceText.length > config.copy.maxManualSource) {
      throw err.badRequest(`补充资料不能超过 ${config.copy.maxManualSource} 字`, { length: sourceText.length })
    }
    refType = 'manual'
    refId = null
  }

  const now = toDb(utcNow())
  const topicId = newId('topic')
  const copyIds: string[] = []

  await db.tx(async (t) => {
    // 1) 选题直接建为 sent（W6）
    await t.run(
      `INSERT INTO \`topic\`
        (\`id\`, \`source\`, \`source_id\`, \`title\`, \`direction\`, \`hook\`, \`rationale\`, \`persona_ids\`, \`status\`, \`batch_id\`, \`sent_at\`, \`created_by\`, \`created_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', NULL, ?, ?, ?)`,
      [
        topicId,
        input.source,
        refId,
        title,
        input.source === 'article' ? '文章转口播' : '手动输入',
        input.keywords ? String(input.keywords).trim().slice(0, 200) : null,
        input.source === 'article' ? '由文章上传创建' : '由文案工坊手动创建',
        jenc(personaIds),
        now,
        input.operator,
        now,
      ],
    )

    // 2) 复用 D12 契约按 topic × persona 展开 copy（同事务，alreadySent 跳过短路分支）
    const r = await createDraftsFromTopics({
      topicIds: [topicId],
      personaIds,
      operator: input.operator,
      db: t,
      alreadySent: true,
    })
    copyIds.push(...r.copyIds)

    // 3) 补齐扩展列：line / source_text（manual 的补充资料）/ source_ref_*
    for (let i = 0; i < copyIds.length; i++) {
      const p = personas[i]!
      await t.run(
        `UPDATE \`copy\` SET \`line\` = ?, \`source_text\` = ?, \`source_ref_type\` = ?, \`source_ref_id\` = ?, \`updated_at\` = ? WHERE \`id\` = ?`,
        [p.line, sourceText || null, refType, refId, now, copyIds[i]],
      )
    }
  })

  // 4) 为每条 copy 建一份空白稿并设为当前稿：新建入口直接可编辑（FR-E4 新建空白稿）
  //    P1-10：必须在事务**提交之后**建稿。createDraft 用的是全局连接，
  //    SQLite 下会在事务内建第 1 份、提交后又建第 2 份；MySQL 下则看不到未提交的 copy。
  //    建稿失败不影响已提交的 topic/copy（AC-S5 只要求这两者原子）。
  await createInitialDrafts(copyIds, input.operator)

  const { recordOperation } = await import('../audit/repo.js')
  await recordOperation({
    operator: input.operator,
    action: 'copy.create',
    targetType: 'copy',
    targetId: copyIds[0] ?? topicId,
    detail: { source: input.source, personaIds, topicId, copyIds, articleId: refId },
  })

  return { topicId, copyIds }
}

/* ── 详情 ─────────────────────────────────────────────────────────── */

/** 详情接口的对外契约（与 frontend/src/api/copy.ts 的 CopyDetail 保持一一对应） */
export interface CopyDetailDraft {
  id: string
  copyId: string
  draftNo: number
  name: string
  title: string | null
  sections: Section[]
  wordCount: number
  rev: number
  latestVersionNo: number
  hasSubmitted: boolean
  origin: string
  isFinal?: boolean
  generationId?: string | null
  updatedAt: string | null
}

export interface CopyDetail {
  copy: CopyRow & {
    derivedStatus: string
    derivedStatusLabel: string
    draftCount: number
    /** 与列表接口同构（前端 Copy 类型）：页头、来源卡、按人物加载选项都读这几个字段 */
    sourceLabel: string
    persona: { id: string; name: string; line: string } | null
    line: string | null
    lineLabel: string | null
  }
  drafts: CopyDetailDraft[]
  currentDraft: CopyDetailDraft | null
  review: {
    id: string
    copyId: string
    copyVersionId: string
    isStub: boolean
    channel: 'stub' | 'jiaoduitai' | 'manual'
    externalReviewNo: string | null
    versionNo: number
    status: string
    statusLabel: string
    gates: unknown[]
    riskHint: string | null
    rejectReason: string | null
    rejectedGate: string | null
    submittedBy: string
    submittedAt: string
    decidedAt: string | null
  } | null
  persona: { id: string; name: string; line: string; enabled: boolean; ipProfile: unknown } | null
  topic: { id: string; title: string; source: string } | null
  sourceSummary: { label: string; text: string }
  versions: Array<{
    id: string
    copyId: string
    draftId: string
    versionNo: number
    title: string | null
    wordCount: number
    contentHash: string | null
    origin: string
    isLocked: boolean
    complianceHits: unknown[]
    createdBy: string | null
    createdAt: string | null
  }>
  generations: unknown[]
  variants: unknown[]
  article: unknown
}

export async function getCopyDetail(copyId: string): Promise<CopyDetail> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  let drafts = await listDrafts(copyId, db)

  // 懒修复：历史文案（早于「新建自动建稿」逻辑）可能没有稿，导致打开后无法编辑。
  // 这里补一份空白初始稿，保证「打开即可写」；仅对可写状态生效，审核中/归档不动。
  if (!drafts.length && copy.status !== 'archived' && copy.status !== 'in_review') {
    try {
      await createDraft(copyId, null, copy.createdBy ?? 'system')
      drafts = await listDrafts(copyId, db)
    } catch (e) {
      logger.warn({ copyId, err: (e as Error).message }, 'copy.lazy_initial_draft_failed')
    }
  }

  // 当前稿：优先 current_draft_id，否则第一份
  let current = copy.currentDraftId ? drafts.find((d) => d.id === copy.currentDraftId) ?? null : null
  if (!current) current = drafts[0] ?? null

  const persona = copy.personaId ? await getPersonaById(copy.personaId, true) : null
  const topic = copy.topicId
    ? await db.get<{ id: string; title: string; source: string; status: string; direction: string | null; hook: string | null }>(
        'SELECT `id`, `title`, `source`, `status`, `direction`, `hook` FROM `topic` WHERE `id` = ?',
        [copy.topicId],
      )
    : null

  const { getSubmission, listVersions } = await import('./repo.js')
  const submission = copy.reviewSubmissionId ? await getSubmission(copy.reviewSubmissionId, db) : null
  const versions = await listVersions(copyId, undefined, db)

  const derived = derivedStatusOf(copy, drafts.length)
  const line = copy.line ?? persona?.line ?? null
  return {
    copy: {
      ...copy,
      derivedStatus: derived,
      derivedStatusLabel: DERIVED_STATUS_LABELS[derived as keyof typeof DERIVED_STATUS_LABELS] ?? derived,
      draftCount: drafts.length,
      sourceLabel: SOURCE_LABELS[copy.source] ?? copy.source,
      persona: persona ? { id: persona.id, name: persona.name, line: persona.line } : null,
      line,
      lineLabel: line ? LINE_LABELS[line] ?? line : null,
    },
    // 注意：这里必须带 sections，前端编辑器直接以它初始化本地草稿态
    drafts: drafts.map((d) => ({
      id: d.id,
      copyId: d.copyId,
      draftNo: d.draftNo,
      name: d.name,
      title: d.title,
      sections: d.sections ?? [],
      wordCount: d.wordCount,
      rev: d.rev,
      latestVersionNo: d.latestVersionNo,
      hasSubmitted: d.hasSubmitted,
      origin: d.origin,
      generationId: d.generationId,
      isFinal: (copy.settings?.finalSelection as any)?.draftId === d.id && (copy.settings?.finalSelection as any)?.contentHash === contentHash(d.title, d.sections),
      updatedAt: d.updatedAt,
    })),
    // 当前稿需与列表项同构，前端 switchEditor 读 sections/title/rev
    currentDraft: current
      ? {
          id: current.id,
          copyId: current.copyId,
          draftNo: current.draftNo,
          name: current.name,
          title: current.title,
          sections: current.sections ?? [],
          wordCount: current.wordCount,
          rev: current.rev,
          latestVersionNo: current.latestVersionNo,
          hasSubmitted: current.hasSubmitted,
          origin: current.origin,
          updatedAt: current.updatedAt,
        }
      : null,
    review: submission
      ? {
          id: submission.id,
          copyId: submission.copyId,
          copyVersionId: submission.copyVersionId,
          isStub: submission.isStub,
          // 这张单的审核去向：桩单 / 已送校对台（或校对台已接入、等待补送）/ 人工复核
          channel: submission.isStub
            ? 'stub'
            : submission.externalReviewNo || hasJiaoduitai()
              ? 'jiaoduitai'
              : 'manual',
          externalReviewNo: submission.externalReviewNo,
          versionNo: versions.find((v) => v.id === submission.copyVersionId)?.versionNo ?? 0,
          status: submission.status,
          statusLabel: SUBMISSION_STATUS_LABELS[submission.status] ?? submission.status,
          gates: submission.gateResults ?? [],
          riskHint: submission.appendedRiskText ?? null,
          rejectReason: submission.reason ?? copy.rejectReason ?? null,
          rejectedGate: submission.rejectedGate ?? null,
          // 提交人取提交时锁定版本的 created_by（submit 写入的就是操作人），而不是文案创建人
          submittedBy: versions.find((v) => v.id === submission.copyVersionId)?.createdBy ?? '',
          submittedAt: submission.createdAt ?? '',
          decidedAt: submission.decidedBy ? submission.updatedAt : null,
        }
      : null,
    persona: persona
      ? { id: persona.id, name: persona.name, line: persona.line, enabled: persona.enabled, ipProfile: persona.ipProfile }
      : null,
    topic: topic ? { id: topic.id, title: topic.title, source: topic.source } : null,
    sourceSummary: {
      label: SOURCE_LABEL(copy.source),
      text: copy.sourceText ?? '',
    },
    versions: versions.map((v) => ({
      id: v.id,
      copyId: v.copyId,
      draftId: v.draftId,
      versionNo: v.versionNo,
      title: v.title,
      wordCount: v.wordCount,
      contentHash: v.contentHash,
      origin: v.origin,
      isLocked: v.locked,
      complianceHits: v.complianceHits ?? [],
      createdBy: v.createdBy,
      createdAt: v.createdAt,
    })),
    generations: [],
    variants: [],
    article: null,
  }
}

function SOURCE_LABEL(s: string): string {
  return s === 'news' ? '资讯' : s === 'benchmark' ? '对标视频' : s === 'article' ? '文章' : '手动输入'
}

/** 派生状态（与 repo.listCopies 的 SQL 判定保持一致） */
export function derivedStatusOf(copy: CopyRow, draftCount: number): string {
  if (copy.status !== 'draft') return copy.status
  if (copy.approvedVersionId) return 'revising'
  return draftCount > 0 ? 'writing' : 'pending_write'
}

/* ── 稿 ───────────────────────────────────────────────────────────── */

/** 新建空白稿 / 复制稿（FR-E4） */
export async function createDraft(
  copyId: string,
  from: string | null,
  operator: string,
): Promise<DraftRow> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  assertWritable(copy)

  const max = config.copy.maxDrafts
  const current = await countDrafts(copyId, db)
  if (current >= max) {
    throw err.draftLimit(`该文案已有 ${current} 份稿，达到上限 ${max}；请先删除不需要的稿再新建`, {
      current,
      max,
    })
  }

  let title: string | null = copy.title ?? null
  // 空白稿预置一个开场段：避免新建后编辑器整片空白、无从下手（FR-E4「新建空白稿」）
  let sections: Section[] = [{ label: '开场', text: '' }]
  let origin = 'manual'

  if (from) {
    const src = await getDraft(copyId, from, db)
    if (!src) throw err.notFound('要复制的稿不存在')
    title = src.title
    sections = src.sections
    origin = 'copy'
  }

  const words = countSectionsWords(title, sections)
  const { id } = await insertDraft(
    {
      copyId,
      title,
      sections,
      plainText: toPlainText(title, sections),
      wordCount: words,
      origin,
      createdBy: operator,
    },
    db,
  )
  // 首份稿自动成为当前稿
  const patch: Record<string, unknown> = { updated_at: toDb(utcNow()) }
  if (!copy.currentDraftId || from) patch.current_draft_id = id
  await updateCopy(copyId, patch, db)

  const d = await getDraft(copyId, id, db)
  return d!
}

/** 自动保存（FR-E2）：带 rev 乐观锁；不产生版本 */
export async function saveDraftContent(
  copyId: string,
  draftId: string,
  input: { title?: string | null; sections: Section[]; rev: number },
  operator: string,
  opts: { allowApprovedEdit?: boolean } = {},
): Promise<{ draft: DraftRow; versionCreated: false }> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  assertWritable(copy)
  if (copy.status === 'approved' && !opts.allowApprovedEdit) {
    // 通过后编辑须显式确认（FR-R6）：由路由层在确认后传 allowApprovedEdit 并降级状态
    throw err.invalidState('该文案已审核通过，修改后须重新审核，请确认后再编辑', {
      requiresConfirm: true,
      approvedVersionId: copy.approvedVersionId,
    })
  }

  const draft = await getDraft(copyId, draftId, db)
  if (!draft) throw err.notFound('稿不存在')

  const rev = toInt(input.rev, -1)
  if (rev !== draft.rev) {
    throw err.draftConflict('该稿已在其他页面修改，请载入最新内容或另存为新稿', {
      expectedRev: draft.rev,
      providedRev: rev,
      serverUpdatedAt: draft.updatedAt,
    })
  }

  const sections = normalizeSectionsInput(input.sections)
  const title = input.title === undefined ? draft.title : String(input.title ?? '').trim() || null
  const words = countSectionsWords(title, sections)

  if (copy.status === 'approved') await downgradeApprovedToDraft(copy, operator, db)

  // 乐观锁双保险：上面已比对 rev，这里再用 WHERE rev = ? 兜住「比对后到写入前」的并发修改
  const w = await db.run(
    `UPDATE \`copy_draft\` SET \`title\` = ?, \`sections\` = ?, \`plain_text\` = ?, \`word_count\` = ?, \`rev\` = \`rev\` + 1, \`updated_at\` = ?
     WHERE \`id\` = ? AND \`rev\` = ?`,
    [title, jenc(sections), toPlainText(title, sections), words, toDb(utcNow()), draftId, rev],
  )
  if (!w.affectedRows) {
    throw err.draftConflict('该稿已在其他页面修改，请载入最新内容或另存为新稿', {
      expectedRev: draft.rev,
      providedRev: rev,
    })
  }
  await touchCopy(copyId, db)

  const fresh = await getDraft(copyId, draftId, db)
  return { draft: fresh!, versionCreated: false }
}

/** 段落输入规范化：限制段数与文本长度，去控制字符 */
export function normalizeSectionsInput(raw: unknown): Section[] {
  const arr = Array.isArray(raw) ? raw : []
  const out: Section[] = []
  for (const item of arr) {
    const o = (item ?? {}) as Record<string, unknown>
    // eslint-disable-next-line no-control-regex
    const text = String(o.text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    const label = String(o.label ?? '').trim()
    if (!text.trim() && !label) continue
    const sec: Section = { label: label || `段落 ${out.length + 1}`, text }
    const refs = o.sourceRefs
    if (Array.isArray(refs) && refs.length) {
      sec.sourceRefs = refs.map((x) => toInt(x, 0))
    }
    out.push(sec)
    if (out.length >= 40) break
  }
  return out
}

export async function renameDraft(copyId: string, draftId: string, name: string): Promise<DraftRow> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  assertWritable(copy)
  const draft = await getDraft(copyId, draftId, db)
  if (!draft) throw err.notFound('稿不存在')
  const clean = String(name ?? '').trim().slice(0, 64)
  if (!clean) throw err.badRequest('稿名称不能为空')
  await db.run('UPDATE `copy_draft` SET `name` = ?, `updated_at` = ? WHERE `id` = ?', [clean, toDb(utcNow()), draftId])
  return (await getDraft(copyId, draftId, db))!
}

/** 删除稿：有提交记录的稿拒绝（FR-E4 / AC-E6） */
export async function deleteDraft(copyId: string, draftId: string, operator: string): Promise<void> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  assertWritable(copy)
  const draft = await getDraft(copyId, draftId, db)
  if (!draft) throw err.notFound('稿不存在')
  if (draft.hasSubmitted) {
    throw err.invalidState('该稿有过提交记录，不可删除', { draftId })
  }
  const total = await countDrafts(copyId, db)
  if (total <= 1) throw err.invalidState('至少保留一份稿')

  await db.run('UPDATE `copy_draft` SET `deleted_at` = ? WHERE `id` = ?', [toDb(utcNow()), draftId])
  if (copy.currentDraftId === draftId) {
    const rest = await listDrafts(copyId, db)
    await updateCopy(copyId, { current_draft_id: rest[0]?.id ?? null, updated_at: toDb(utcNow()) }, db)
  }

  const { recordOperation } = await import('../audit/repo.js')
  await recordOperation({
    operator,
    action: 'copy.draft_delete',
    targetType: 'copy',
    targetId: copyId,
    detail: { draftId, draftNo: draft.draftNo },
  })
}

export async function switchCurrentDraft(copyId: string, draftId: string): Promise<void> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  const draft = await getDraft(copyId, draftId, db)
  if (!draft) throw err.notFound('稿不存在')
  await updateCopy(copyId, { current_draft_id: draftId, updated_at: toDb(utcNow()) }, db)
  void copy
}

/* ── 版本（FR-E3 / §3.2）─────────────────────────────────────────── */

/** 保存草稿：内容 hash 未变不产生版本（幂等） */
export async function saveDraftVersion(
  copyId: string,
  draftId: string,
  operator: string,
): Promise<{ version: VersionRow; created: boolean }> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  assertWritable(copy)
  const draft = await getDraft(copyId, draftId, db)
  if (!draft) throw err.notFound('稿不存在')

  const hash = contentHash(draft.title, draft.sections)
  const latest = await latestVersionOfDraft(draftId, db)
  if (latest && latest.contentHash === hash) {
    return { version: latest, created: false }
  }

  const hits = await scanDraftCompliance(draft, copy)
  const version = await insertVersion(
    {
      copyId,
      draftId,
      title: draft.title,
      sections: draft.sections,
      plainText: draft.plainText,
      wordCount: draft.wordCount,
      contentHash: hash,
      origin: 'manual_save',
      complianceHits: hits,
      createdBy: operator,
    },
    db,
  )
  await db.run('UPDATE `copy_draft` SET `latest_version_no` = ? WHERE `id` = ?', [version.versionNo, draftId])
  if (copy.status === 'approved') await downgradeApprovedToDraft(copy, operator, db)

  const { recordOperation } = await import('../audit/repo.js')
  await recordOperation({
    operator,
    action: 'copy.version_save',
    targetType: 'copy',
    targetId: copyId,
    detail: { draftId, versionNo: version.versionNo, versionId: version.id },
  })
  return { version, created: true }
}

/** 恢复历史版本：以该版本内容覆盖当前稿工作内容并产生 origin=restore 新版本 */
export async function restoreVersion(
  copyId: string,
  versionId: string,
  operator: string,
): Promise<{ version: VersionRow; draft: DraftRow }> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  assertWritable(copy)

  const { getVersion } = await import('./repo.js')
  const target = await getVersion(versionId, db)
  if (!target || target.copyId !== copyId) throw err.notFound('版本不存在')
  const draft = await getDraft(copyId, target.draftId, db)
  if (!draft) throw err.notFound('该版本所属的稿已被删除，无法恢复')

  await db.run(
    `UPDATE \`copy_draft\` SET \`title\` = ?, \`sections\` = ?, \`plain_text\` = ?, \`word_count\` = ?, \`rev\` = \`rev\` + 1, \`updated_at\` = ?
     WHERE \`id\` = ?`,
    [
      target.title,
      jenc(target.sections),
      target.plainText,
      target.wordCount,
      toDb(utcNow()),
      draft.id,
    ],
  )

  const version = await insertVersion(
    {
      copyId,
      draftId: draft.id,
      title: target.title,
      sections: target.sections,
      plainText: target.plainText,
      wordCount: target.wordCount,
      contentHash: contentHash(target.title, target.sections),
      origin: 'restore',
      createdBy: operator,
    },
    db,
  )
  await db.run('UPDATE `copy_draft` SET `latest_version_no` = ? WHERE `id` = ?', [version.versionNo, draft.id])
  await updateCopy(copyId, { current_draft_id: draft.id, updated_at: toDb(utcNow()) }, db)
  if (copy.status === 'approved') await downgradeApprovedToDraft(copy, operator, db)

  const { recordOperation } = await import('../audit/repo.js')
  await recordOperation({
    operator,
    action: 'copy.version_restore',
    targetType: 'copy',
    targetId: copyId,
    detail: { fromVersionId: versionId, newVersionNo: version.versionNo },
  })

  const fresh = await getDraft(copyId, draft.id, db)
  return { version, draft: fresh! }
}

/** 段落级对比：以当前稿为基准，逐段标注 added / removed / changed / same */
export interface SectionDiff {
  index: number
  status: 'same' | 'changed' | 'added' | 'removed'
  label: string
  before: string
  after: string
}

export function diffSections(before: Section[], after: Section[]): SectionDiff[] {
  const out: SectionDiff[] = []
  const len = Math.max(before.length, after.length)
  for (let i = 0; i < len; i++) {
    const b = before[i]
    const a = after[i]
    if (b && a) {
      const same = b.label === a.label && b.text === a.text
      out.push({
        index: i,
        status: same ? 'same' : 'changed',
        label: a.label || b.label,
        before: b.text,
        after: a.text,
      })
    } else if (a) {
      out.push({ index: i, status: 'added', label: a.label, before: '', after: a.text })
    } else if (b) {
      out.push({ index: i, status: 'removed', label: b.label, before: b.text, after: '' })
    }
  }
  return out
}

/* ── 合规扫描封装 ─────────────────────────────────────────────────── */

export async function scanDraftCompliance(draft: DraftRow, copy: CopyRow): Promise<ComplianceHit[]> {
  const words = await listComplianceWords({ enabledOnly: true })
  const persona = copy.personaId ? await getPersonaById(copy.personaId, true) : null
  const claims = (persona?.ipProfile as { forbiddenClaims?: string[] } | null)?.forbiddenClaims ?? []
  // P1-14①：标题纳入合规扫描
  return scanCompliance(draft.sections, words, claims, draft.title)
}

/* ── 预检（FR-R3 / AC-R1 / AC-R2）────────────────────────────────── */

export interface PrecheckCheck {
  key: string
  label: string
  level: 'hard' | 'soft'
  pass: boolean
  message: string
}

export interface PrecheckResult {
  draftId: string
  wordCount: number
  bodyWordCount: number
  estSeconds: number
  tier: string
  durationSeconds: number | null
  wordRange: { min: number; max: number }
  tierOk: boolean
  complianceHits: ComplianceHit[]
  similarity: ReturnType<typeof computeSimilarity> | null
  checks: PrecheckCheck[]
  canSubmit: boolean
  durationRange: { min: number; max: number }
  durationOk: boolean
  warnings: number
  riskHintMode: string
}

export async function precheck(copyId: string, draftId: string): Promise<PrecheckResult> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  const draft = await getDraft(copyId, draftId, db)
  if (!draft) throw err.notFound('稿不存在')

  const settings = (copy.settings ?? {}) as { durationTier?: string; durationSeconds?: number | null }
  const tier = settings.durationTier ?? 'medium'
  const range = wordRangeOf(tier, settings.durationSeconds)
  const words = draft.wordCount
  const bodyWords = countBodyWords(draft.sections)
  const estSeconds = estimateSeconds(bodyWords)
  const def = tierOf(tier) ?? tierOf('medium')!
  const durationRange = tier === 'custom' ? { min: Number(settings.durationSeconds), max: Number(settings.durationSeconds) } : { min: def.minSeconds, max: def.maxSeconds }
  const durationOk = estSeconds >= durationRange.min && estSeconds <= durationRange.max

  const hits = await scanDraftCompliance(draft, copy)
  const hardHits = hits.filter((h) => h.level === 'hard')
  const softHits = hits.filter((h) => h.level === 'soft')

  // 查重仅对标来源（FR-R2）
  let similarity: PrecheckResult['similarity'] = null
  if (copy.source === 'benchmark' && copy.sourceText) {
    const rewritten = [draft.title ?? '', ...draft.sections.map((s) => s.text)].join('\n')
    similarity = computeSimilarity(copy.sourceText, rewritten, copy.line)
  }

  const persona = copy.personaId ? await getPersonaById(copy.personaId, true) : null
  // FR-X2：预检 ⑤ 与 assertPersonasUsable 同一判定（授权失效同样不过）
  const personaStatus = persona ? await derivePersonaStatus(persona) : null

  const checks: PrecheckCheck[] = [
    ...((copy.settings?.finalSelection as any)?.draftId ? [{ key: 'finalSelection', label: '提审内容与定稿版本一致', level: 'hard' as const, pass: (copy.settings!.finalSelection as any).draftId === draftId && (copy.settings!.finalSelection as any).contentHash === contentHash(draft.title, draft.sections), message: '如果改过定稿内容或切换了候选稿，请先重新定稿，再提交审核' }] : []),
    { key: 'duration', label: `口播时长目标 ${durationRange.min === durationRange.max ? durationRange.max : `${durationRange.min}–${durationRange.max}`} 秒`, level: 'soft', pass: durationOk, message: durationOk ? `正文预计 ${estSeconds} 秒` : estSeconds > durationRange.max ? `预计超时 ${(estSeconds-durationRange.max).toFixed(1)} 秒；建议压缩正文后复检` : `预计少于目标 ${(durationRange.min-estSeconds).toFixed(1)} 秒；可适当补充解释` },
    { key: 'sourceReview', label: '素材已人工核对', level: 'soft', pass: (copy.settings?.sourceReview as any)?.confirmed === true && (copy.settings?.sourceReview as any)?.originalHash === contentHash(copy.sourceText, []), message: (copy.settings?.sourceReview as any)?.confirmed ? '素材已确认，新稿中的新增事实仍需核对' : '请在「准备素材」中核对名称、数字和引用' },
    {
      key: 'content',
      label: '已填写正文',
      level: 'hard',
      pass: draft.sections.length >= 1 && bodyWords > 0,
      message: draft.sections.length >= 1 && bodyWords > 0 ? `共 ${draft.sections.length} 段` : '正文为空，请先写入内容',
    },
    {
      key: 'title',
      label: '已填写标题',
      level: 'hard',
      pass: !!(draft.title ?? '').trim(),
      message: (draft.title ?? '').trim() ? '' : '请填写口播标题',
    },
    {
      key: 'wordRange',
      label: `建议字数 ${range.min}–${range.max} 字`,
      level: 'soft',
      pass: words >= range.min && words <= range.max,
      message:
        words >= range.min && words <= range.max
          ? `当前 ${words} 字，约 ${estSeconds} 秒`
          : `当前 ${words} 字，超出 ${range.min}–${range.max} 字建议区间（不阻止提交）`,
    },
    {
      key: 'complianceHard',
      label: '未使用禁用词',
      level: 'hard',
      pass: hardHits.length === 0,
      message: hardHits.length === 0 ? '' : `命中 ${hardHits.length} 处：${uniqWords(hardHits).join('、')}`,
    },
    {
      key: 'complianceSoft',
      label: '需留意的用词',
      level: 'soft',
      pass: softHits.length === 0,
      message: softHits.length === 0 ? '' : `提醒 ${softHits.length} 处：${uniqWords(softHits).join('、')}（不阻止提交）`,
    },
    {
      key: 'persona',
      label: '人物处于启用状态',
      level: 'hard',
      pass: !!personaStatus?.usable,
      message: !persona
        ? '文案未绑定人物'
        : personaStatus?.usable
          ? ''
          : `人物当前不可用：${personaStatus!.reasons.map((r) => r.message).join('；')}`,
    },
  ]

  if (similarity) {
    checks.push({
      key: 'similarity',
      label: `查重相似度 ≤ ${(similarity.threshold * 100).toFixed(0)}%`,
      level: copy.line === 'persona' ? 'hard' : 'soft',
      pass: !similarity.blocked,
      message: similarity.blocked
        ? `相似度 ${(similarity.similarity * 100).toFixed(1)}%，超过素人线 ${(similarity.threshold * 100).toFixed(0)}% 阈值，请继续改写`
        : `相似度 ${(similarity.similarity * 100).toFixed(1)}%${
            copy.line === 'persona' ? '' : '（该生产线仅提示）'
          }`,
    })
  }

  const canSubmit = checks.every((c) => c.level !== 'hard' || c.pass)
  return {
    draftId,
    wordCount: words,
    bodyWordCount: bodyWords,
    estSeconds,
    tier,
    durationSeconds: settings.durationSeconds ?? null,
    wordRange: range,
    tierOk: words >= range.min && words <= range.max,
    durationRange, durationOk, warnings: checks.filter(c => !c.pass && c.level === 'soft').length, riskHintMode: '风险提示作为独立字幕；预计口播时长只计算正文，若配音朗读需额外计时',
    complianceHits: hits,
    similarity,
    checks,
    canSubmit,
  }
}

function uniqWords(hits: ComplianceHit[]): string[] {
  return Array.from(new Set(hits.map((h) => h.word)))
}

/** 生成记录与稿的衔接：取某 copy 的生成记录列表（供详情页展示） */
export async function listGenerations(copyId: string, limit = 20) {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT `id`, `kind`, `mode`, `status`, `succeeded`, `failed`, `cost`, `created_at`, `finished_at`, `error` FROM `copy_generation` WHERE `copy_id` = ? ORDER BY `created_at` DESC LIMIT ?',
    [copyId, limit],
  )
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    mode: r.mode,
    status: r.status,
    succeeded: Number(r.succeeded ?? 0),
    failed: Number(r.failed ?? 0),
    cost: Number(r.cost ?? 0),
    error: r.error ?? null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }))
}

/** 撤回前置校验：仅供路由层使用（状态机在 review-actions 内） */
export function canWithdraw(status: string | null | undefined): boolean {
  return !!status && WITHDRAWABLE_STATUSES.includes(status as never)
}

export { latestVersionOfDraft }
export type { DraftRow, VersionRow, CopyRow }
