import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ok } from '../../app.js'
import { registerCopyWorkspaceRoutes } from './workspace.js'
import { err } from '../../errors.js'
import { config } from '../../config.js'
import { chat, resolveLlm } from '../../integrations/copy-llm/index.js'
import { parsePaging, pageResult, toInt, jdec } from '../../lib/util.js'
import { recordOperation } from '../audit/repo.js'
import {
  DURATION_TIERS,
  DERIVED_STATUS_LABELS,
  GATE_LABELS,
  LINE_LABELS,
  SOURCE_LABELS,
  WITHDRAWABLE_STATUSES,
  wordRangeOf,
} from './constants.js'
import {
  derivedStatusOf,
  getCopy,
  getDraft,
  getStyle,
  getTemplate,
  listComplianceWords,
  listCopies,
  listDrafts,
  listStyles,
  listTemplates,
  listVariantsByDraft,
  requireCopy,
  updateCopy,
} from './repo.js'
import {
  createCopyFromArticleOrManual,
  createDraft,
  deleteDraft,
  diffSections,
  getCopyDetail,
  listGenerations,
  precheck,
  renameDraft,
  restoreVersion,
  saveDraftContent,
  saveDraftVersion,
  switchCurrentDraft,
} from './service.js'
import { acceptGeneration, acceptVariant, applyVariant, assembleForCopy, validateDuration } from './generation.js'
import { listTemplates as listTopicMethods } from '../topics/repo.js'
import { copyTemplateFor, personaMethods } from '../topics/methods.js'
import {
  assertReviewStubEnabled,
  getApprovedCopy,
  getSubmissionProgress,
  listReviewQueue,
  manualDecision,
  onReviewProgress,
  onReviewResult,
  submitForReview,
  withdrawReview,
} from './review.js'
import { listPersonasForCopy } from './persona-bridge.js'
import { getVersion, listVersions, getSubmission, getGeneration, listVariantsByGeneration } from './repo.js'
import { parseArticleBuffer, parsePastedText, saveArticle, validateFileMeta, writeTempFile } from './article.js'
import { getArticle } from './repo.js'
import { scanCompliance } from './text.js'
import { getPersonaById } from './persona-bridge.js'
import { toDb, utcNow } from '../../lib/time.js'
import { newId } from '../../lib/util.js'

/**
 * 文案工坊路由（任务书 §5.1，前缀 /api）。
 * 统一信封 { ok, data }，写操作取登录账号（req.operator）并落 operation_log。
 * `/copy/from-topic` 仍由 copy-contract 提供（D12 冻结契约）；此处接管 `GET /copy` 并扩展筛选。
 */
/** 文案引擎运行时信息：当前生效的模型接入（不泄漏 key） */
export function registerCopyLlmRoutes(app: FastifyInstance): void {
  app.get('/copy/llm/status', async () => {
    const r = resolveLlm()
    return ok({
      configured: !!r,
      provider: r?.provider ?? 'mock',
      model: r?.model ?? null,
      protocol: r?.protocol ?? null,
      baseUrlHost: r ? safeHost(r.baseUrl) : null,
      mock: !r,
      mockFallback: config.mockFallback,
      hint: r ? '使用文案二创专用模型（COPY_LLM_*）' : '未配置 COPY_LLM_API_KEY，当前走 mock 兜底输出',
    })
  })

  /** 连通性自测：真打一次最小对话，验证 baseurl / key / 模型是否可用 */
  app.post('/copy/llm/ping', async () => {
    const r = resolveLlm()
    if (!r) return ok({ ok: false, message: '未配置模型，无法自测（会走 mock）', provider: 'mock' })
    const started = Date.now()
    try {
      const res = await chat(
        [
          { role: 'system', content: '你是一个连通性测试助手。' },
          { role: 'user', content: '只回复两个字：可用' },
        ],
        { temperature: 0, maxTokens: 32 },
      )
      return ok({
        ok: !res.mock,
        provider: res.provider ?? r.provider,
        model: res.model ?? r.model,
        protocol: res.protocol ?? r.protocol,
        reply: res.content.slice(0, 200),
        durationMs: Date.now() - started,
      })
    } catch (e) {
      return ok({
        ok: false,
        provider: r.provider,
        model: r.model,
        protocol: r.protocol,
        durationMs: Date.now() - started,
        message: (e as Error).message,
      })
    }
  })
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.replace(/\/\/[^/]*@/, '//')
  }
}

export function registerCopyWorkshopRoutes(app: FastifyInstance): void {
  registerCopyWorkspaceRoutes(app)
  /* ── 配置 / 选项（W0 AC-0.4）────────────────────────────────────── */

  app.get('/copy/options', async (req) => {
    const q = (req.query ?? {}) as { personaId?: string; line?: string }
    const personas = await listPersonasForCopy()
    const persona = q.personaId ? personas.find((p) => p.id === q.personaId) : null
    const line = q.line ?? persona?.line ?? null

    const templates = await listTemplates(true)
    const styles = await listStyles(line, true)
    // 该人物开启的选题方法对应的模板：前端下拉只列这些，减少无关选项
    // 只保留已启用的模板；交集为空时返回 null，前端回落全部模板
    const enabledIds = new Set(templates.map((t) => t.id))
    const matched = persona
      ? [...new Set(personaMethods({ line: persona.line, contentMix: persona.ipProfile.contentMix }, await listTopicMethods()).items.map((x) => copyTemplateFor(x.method)))].filter((id) => enabledIds.has(id))
      : []
    const methodTemplateIds = matched.length ? matched : null

    return ok({
      methodTemplateIds,
      durationTiers: DURATION_TIERS.map((t) => ({
        key: t.key,
        name: t.name,
        minSeconds: t.minSeconds,
        maxSeconds: t.maxSeconds,
        minWords: t.minWords,
        maxWords: t.maxWords,
        custom: !!t.custom,
        // custom 的实时换算规则：N×3 – N×4
        wordsPerSecond: t.custom ? { min: 3, max: 4 } : null,
      })),
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        structureHint: t.structureHint,
        riskHint: t.riskHint,
        isBuiltin: t.isBuiltin,
        revision: t.revision,
        prompt: t.prompt,
        sort: t.sort,
      })),
      styles: styles.map((s) => ({
        id: s.id,
        name: s.name,
        line: s.line,
        prompt: s.prompt,
        isBuiltin: s.isBuiltin,
        revision: s.revision,
        sort: s.sort,
      })),
      limits: {
        maxDrafts: config.copy.maxDrafts,
        maxBatchCount: config.copy.maxBatchCount,
        maxInstructions: config.copy.maxInstructions,
        maxTitle: config.copy.maxTitle,
        maxManualSource: config.copy.maxManualSource,
        charsPerSec: config.copy.charsPerSec,
        similarityThreshold: config.copy.similarityThreshold,
        customDurationMin: config.copy.customDurationMin,
        customDurationMax: config.copy.customDurationMax,
        articleMaxBytes: config.copy.articleMaxBytes,
        articleMaxChars: config.copy.articleMaxChars,
      },
      labels: {
        sources: SOURCE_LABELS,
        lines: LINE_LABELS,
        derivedStatus: DERIVED_STATUS_LABELS,
        gates: GATE_LABELS,
      },
      // usable：派生状态可用（启用 + 授权有效）；新建文案只能选可用人物，否则创建时会被 409 拒绝
      personas: personas.map((p) => ({
        id: p.id,
        name: p.name,
        line: p.line,
        lineLabel: p.lineLabel,
        enabled: p.enabled,
        usable: p.usable,
        statusLabel: p.statusLabel,
      })),
      activeLine: line,
    })
  })

  /* ── 文案列表（FR-M1 / AC-M1）────────────────────────────────────── */

  app.get('/copy', async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    const p = parsePaging(q, 20, 100)
    const ids = q.ids
      ? String(q.ids)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined

    const { rows, total } = await listCopies({
      status: q.status ? String(q.status) : undefined,
      derivedStatus: q.derivedStatus ? String(q.derivedStatus) : undefined,
      personaId: q.personaId ? String(q.personaId) : undefined,
      line: q.line ? String(q.line) : undefined,
      source: q.source ? String(q.source) : undefined,
      keyword: q.keyword ? String(q.keyword) : undefined,
      topicId: q.topicId ? String(q.topicId) : undefined,
      includeArchived: q.includeArchived === '1' || q.includeArchived === 'true',
      ids,
      limit: p.limit,
      offset: p.offset,
    })

    // 人物名（列表展示「人物 · 线」）
    const personas = await listPersonasForCopy()
    const pmap = new Map(personas.map((x) => [x.id, x]))

    const items = rows.map((c) => {
      const persona = c.personaId ? pmap.get(c.personaId) : null
      const derived = derivedStatusOf(c, c.draftCount)
      // line 以 copy 自身为准；历史数据（copy-contract 建单未写 line）回退到人物所属线，
      // 保证风格按线过滤、列表筛选在任何来源下都可用。
      const line = c.line ?? persona?.line ?? null
      return {
        id: c.id,
        title: c.title,
        source: c.source,
        sourceLabel: SOURCE_LABELS[c.source] ?? c.source,
        status: c.status,
        derivedStatus: derived,
        derivedStatusLabel: DERIVED_STATUS_LABELS[derived as keyof typeof DERIVED_STATUS_LABELS] ?? derived,
        persona: persona ? { id: persona.id, name: persona.name, line: persona.line } : null,
        line,
        lineLabel: line ? LINE_LABELS[line] ?? line : null,
        draftCount: c.draftCount,
        submittedVersionId: c.submittedVersionId,
        approvedVersionId: c.approvedVersionId,
        reviewGate: c.reviewGate,
        everSubmitted: c.everSubmitted,
        createdBy: c.createdBy,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        topicId: c.topicId,
        // 下划线别名：D12 既有验收口径（smoke 场景 3）依赖 topic_id，不能改
        topic_id: c.topicId,
        // D12 冻结字段：送工坊契约的验收依赖它们（source_ref_type / extract_cache_id / source_text）
        // 同时输出驼峰与下划线两种命名：驼峰给前端，下划线是 D12 既有的验收口径，不能改。
        sourceRefType: c.sourceRefType,
        sourceRefId: c.sourceRefId,
        extractCacheId: c.extractCacheId,
        sourceText: c.sourceText,
        source_ref_type: c.sourceRefType,
        source_ref_id: c.sourceRefId,
        extract_cache_id: c.extractCacheId,
        source_text: c.sourceText,
      }
    })
    return ok(pageResult(items, total, p))
  })

  /* ── 文案详情 / 创建 / 更新 / 归档 ──────────────────────────────── */

  app.get('/copy/:id', async (req) => {
    const { id } = req.params as { id: string }
    const detail = await getCopyDetail(id)
    const generations = await listGenerations(id, 10)
    const variants = detail.currentDraft ? await listVariantsByDraft(detail.currentDraft.id) : []
    const { getArticle } = await import('./repo.js')
    const article =
      detail.copy.source === 'article' && detail.copy.sourceRefId
        ? await getArticle(detail.copy.sourceRefId)
        : null
    // FR-X3：视频创作只读冗余（文案步骤条第 4 步点亮与「去视频创作」入口用）
    const { getLatestVideoJobBrief } = await import('../video/service.js')
    const latestVideoJob = await getLatestVideoJobBrief(id).catch(() => null)
    return ok({ ...detail, generations, variants, article, latestVideoJob })
  })

  app.post('/copy', async (req) => {
    const body = (req.body ?? {}) as {
      source?: string
      personaIds?: string[]
      title?: string
      articleId?: string
      sourceText?: string
      keywords?: string
    }
    const source = body.source === 'article' || body.source === 'manual' ? body.source : null
    if (!source) throw err.badRequest('source 只能是 article 或 manual')
    if (!body.title || !String(body.title).trim()) throw err.badRequest('标题必填')

    const r = await createCopyFromArticleOrManual({
      source,
      personaIds: Array.isArray(body.personaIds) ? body.personaIds : [],
      title: String(body.title),
      articleId: body.articleId ?? null,
      sourceText: body.sourceText ?? null,
      keywords: body.keywords ?? null,
      operator: req.operator,
    })
    return ok(r)
  })

  app.patch('/copy/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { title?: string; settings?: Record<string, unknown> }
    const copy = await requireCopy(id)
    if (copy.status === 'archived') throw err.invalidState('该文案已归档，不可修改')

    const patch: Record<string, unknown> = { updated_at: toDb(utcNow()) }
    if (body.title !== undefined) {
      const t = String(body.title).trim()
      if (!t) throw err.badRequest('标题不能为空')
      if (t.length > config.copy.maxTitle) throw err.badRequest(`标题不能超过 ${config.copy.maxTitle} 字`)
      patch.title = t
    }
    if (body.settings !== undefined) {
      patch.settings = JSON.stringify({ ...(copy.settings ?? {}), ...(body.settings ?? {}) })
    }
    await updateCopy(id, patch)
    await recordOperation({
      operator: req.operator,
      action: 'copy.update',
      targetType: 'copy',
      targetId: id,
      detail: { fields: Object.keys(patch).filter((k) => k !== 'updated_at') },
    })
    return ok(await getCopy(id))
  })

  app.post('/copy/:id/archive', async (req) => {
    const { id } = req.params as { id: string }
    const copy = await requireCopy(id)
    if (copy.everSubmitted || copy.status === 'approved' || copy.status === 'in_review') {
      throw err.invalidState('该文案有过提交记录，不可归档', { everSubmitted: copy.everSubmitted })
    }
    if (copy.status === 'archived') return ok({ id, status: 'archived', already: true })
    const now = toDb(utcNow())
    await updateCopy(id, { status: 'archived', archived_at: now, updated_at: now })
    await recordOperation({
      operator: req.operator,
      action: 'copy.archive',
      targetType: 'copy',
      targetId: id,
    })
    return ok({ id, status: 'archived' })
  })

  /** 来源全文：news 摘要+外链 / benchmark 提取全文+句级时间戳 / article 大纲+全文 / manual 资料 */
  app.get('/copy/:id/source', async (req) => {
    const { id } = req.params as { id: string }
    const copy = await requireCopy(id)
    const db = (await import('../../db/index.js')).getDb()

    if (copy.sourceRefType === 'news_item' && copy.sourceRefId) {
      const n = await db.get<Record<string, any>>('SELECT * FROM `news_item` WHERE `id` = ?', [copy.sourceRefId])
      return ok({
        type: 'news',
        title: n?.title ?? copy.title,
        summary: n?.summary ?? null,
        contentUrl: n?.content_url ?? null,
        source: n?.source ?? null,
        publishedAt: n?.published_at ?? null,
        text: copy.sourceText,
      })
    }
    if (copy.sourceRefType === 'benchmark_video' && copy.sourceRefId) {
      const v = await db.get<Record<string, any>>('SELECT * FROM `benchmark_video` WHERE `id` = ?', [copy.sourceRefId])
      const cache = copy.extractCacheId
        ? await db.get<Record<string, any>>('SELECT * FROM `script_extract_cache` WHERE `id` = ?', [
            copy.extractCacheId,
          ])
        : null
      const sentences: unknown = jdec<unknown>(cache?.sentences, null)
      return ok({
        type: 'benchmark',
        videoId: copy.sourceRefId,
        coverUrl: v?.cover_url ?? null,
        publishedAt: v?.published_at ?? null,
        title: v?.title ?? copy.title,
        author: v?.author_nickname ?? null,
        shareUrl: v?.share_url ?? null,
        duration: v?.duration ?? null,
        text: cache?.text ?? copy.sourceText,
        sentences: Array.isArray(sentences) ? sentences.map((s: any) => ({ text: String(s.text ?? ''), startTime: Number(s.startTime ?? s.beginTime ?? 0), endTime: Number(s.endTime ?? 0) })) : [],
      })
    }
    if (copy.sourceRefType === 'article_source' && copy.sourceRefId) {
      const a = await getArticle(copy.sourceRefId)
      return ok({
        type: 'article',
        filename: a?.filename ?? null,
        outline: a?.outline ?? null,
        wordCount: a?.wordCount ?? 0,
        text: a?.plainText ?? copy.sourceText,
        expired: !a,
      })
    }
    return ok({
      type: 'manual',
      title: copy.title,
      text: copy.sourceText,
    })
  })

  /* ── 稿 ──────────────────────────────────────────────────────────── */

  app.get('/copy/:id/drafts/:draftId', async (req) => {
    const { id, draftId } = req.params as { id: string; draftId: string }
    const draft = await getDraft(id, draftId)
    if (!draft) throw err.notFound('稿不存在')
    return ok(draft)
  })

  app.post('/copy/:id/drafts', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { from?: string }
    return ok(await createDraft(id, body.from ?? null, req.operator))
  })

  app.put('/copy/:id/drafts/:draftId', async (req) => {
    const { id, draftId } = req.params as { id: string; draftId: string }
    const body = (req.body ?? {}) as {
      title?: string | null
      sections?: unknown
      rev: number
      confirmReedit?: boolean
    }
    const r = await saveDraftContent(
      id,
      draftId,
      { title: body.title, sections: body.sections as never, rev: toInt(body.rev, -1) },
      req.operator,
      { allowApprovedEdit: !!body.confirmReedit },
    )
    return ok(r)
  })

  app.patch('/copy/:id/drafts/:draftId', async (req) => {
    const { id, draftId } = req.params as { id: string; draftId: string }
    const body = (req.body ?? {}) as { name?: string; current?: boolean }
    if (body.current) {
      await switchCurrentDraft(id, draftId)
      return ok(await getDraft(id, draftId))
    }
    return ok(await renameDraft(id, draftId, String(body.name ?? '')))
  })

  app.delete('/copy/:id/drafts/:draftId', async (req) => {
    const { id, draftId } = req.params as { id: string; draftId: string }
    await deleteDraft(id, draftId, req.operator)
    return ok({ ok: true })
  })

  /* ── 版本 ────────────────────────────────────────────────────────── */

  app.post('/copy/:id/drafts/:draftId/versions', async (req) => {
    const { id, draftId } = req.params as { id: string; draftId: string }
    const r = await saveDraftVersion(id, draftId, req.operator)
    return ok({ versionId: r.version.id, versionNo: r.version.versionNo, created: r.created })
  })

  app.get('/copy/:id/versions', async (req) => {
    const { id } = req.params as { id: string }
    const q = (req.query ?? {}) as { draftId?: string }
    await requireCopy(id)
    const versions = await listVersions(id, q.draftId)
    // 附带所属稿名与是否提交过、审核结论（FR-E3 历史版本抽屉列）
    const drafts = await listDrafts(id)
    const dmap = new Map(drafts.map((d) => [d.id, d]))
    const items = []
    for (const v of versions) {
      const sub = await getSubmissionByVersionSafe(v.id)
      items.push({
        id: v.id,
        versionNo: v.versionNo,
        draftId: v.draftId,
        draftName: dmap.get(v.draftId)?.name ?? `稿`,
        draftNo: dmap.get(v.draftId)?.draftNo ?? null,
        origin: v.origin,
        title: v.title,
        wordCount: v.wordCount,
        locked: v.locked,
        similarity: v.similarity,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
        submitted: !!sub,
        submissionStatus: sub?.status ?? null,
      })
    }
    return ok(items)
  })

  app.get('/copy/versions/:versionId', async (req) => {
    const { versionId } = req.params as { versionId: string }
    const v = await getVersion(versionId)
    if (!v) throw err.notFound('版本不存在')
    return ok(v)
  })

  /** 段落级对比：?with=versionId（基准为当前稿）或 ?a=x&b=y（两个版本互比） */
  app.get('/copy/versions/:versionId/diff', async (req) => {
    const { versionId } = req.params as { versionId: string }
    const q = (req.query ?? {}) as { with?: string; a?: string; b?: string }
    const left = await getVersion(versionId)
    if (!left) throw err.notFound('版本不存在')
    const right = q.with ? await getVersion(q.with) : null
    const before = right ?? left
    const after = right ? left : null
    if (!after) {
      // 与当前稿对比
      const drafts = await listDrafts(left.copyId)
      const d = drafts.find((x) => x.id === left.draftId) ?? drafts[0]
      if (!d) throw err.notFound('当前稿不存在')
      return ok({ beforeVersionId: left.id, afterDraftId: d.id, diff: diffSections(left.sections, d.sections) })
    }
    return ok({ beforeVersionId: before.id, afterVersionId: after.id, diff: diffSections(before.sections, after.sections) })
  })

  app.post('/copy/versions/:versionId/restore', async (req) => {
    const { versionId } = req.params as { versionId: string }
    const q = (req.query ?? {}) as { copyId?: string }
    const v = await getVersion(versionId)
    if (!v) throw err.notFound('版本不存在')
    const copyId = q.copyId ?? v.copyId
    const r = await restoreVersion(copyId, versionId, req.operator)
    return ok({ versionId: r.version.id, versionNo: r.version.versionNo, draft: r.draft })
  })

  /* ── 生成与变体 ─────────────────────────────────────────────────── */

  app.post('/copy/:id/generate', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as {
      templateId?: string
      styleId?: string
      durationTier?: string
      durationSeconds?: number
      count?: number
      instructions?: string
      preferences?: unknown
    }
    if (!body.templateId) throw err.badRequest('请选择模板')
    if (!body.styleId) throw err.badRequest('请选择风格')

    const headerKey = req.headers['idempotency-key']
    const idempotencyKey = (Array.isArray(headerKey) ? headerKey[0] : headerKey)?.toString().slice(0, 64) || null

    const r = await acceptGeneration({
      copyId: id,
      templateId: body.templateId,
      styleId: body.styleId,
      durationTier: body.durationTier ?? 'medium',
      durationSeconds: body.durationSeconds ?? null,
      count: toInt(body.count, 1),
      instructions: body.instructions ?? null,
      preferences: body.preferences,
      operator: req.operator,
      idempotencyKey,
    })
    return ok(r)
  })

  app.post('/copy/:id/drafts/:draftId/variants', async (req) => {
    const { id, draftId } = req.params as { id: string; draftId: string }
    const body = (req.body ?? {}) as { sectionIndex?: number; kinds?: string[] }
    const r = await acceptVariant({
      copyId: id,
      draftId,
      sectionIndex: toInt(body.sectionIndex, 0),
      kinds: body.kinds,
      operator: req.operator,
    })
    return ok(r)
  })

  app.get('/copy/generations/:generationId', async (req) => {
    const { generationId } = req.params as { generationId: string }
    const g = await getGeneration(generationId)
    if (!g) throw err.notFound('生成记录不存在')
    const variants = g.kind === 'variant' ? await listVariantsByGeneration(generationId) : []
    // 该批次产出的稿
    const db = (await import('../../db/index.js')).getDb()
    const drafts = await db.all<Record<string, any>>(
      'SELECT `id`, `draft_no`, `name`, `title`, `word_count` FROM `copy_draft` WHERE `generation_id` = ? AND `deleted_at` IS NULL ORDER BY `draft_no`',
      [generationId],
    )
    // FR-X3：回显人物版本号（版本不可变，可追溯当次生成所用的人物配置）
    const personaVersion = g.personaVersionId
      ? await db.get<{ version_no: number }>('SELECT `version_no` FROM `persona_version` WHERE `id` = ?', [g.personaVersionId])
      : null
    return ok({
      id: g.id,
      copyId: g.copyId,
      draftId: g.draftId,
      kind: g.kind,
      mode: g.mode,
      status: g.status,
      succeeded: g.succeeded,
      failed: g.failed,
      error: g.error,
      cost: g.cost,
      count: g.count,
      durationTier: g.durationTier,
      durationSeconds: g.durationSeconds,
      wordRange: wordRangeOf(g.durationTier, g.durationSeconds),
      templateId: g.templateId,
      templateRev: g.templateRev,
      styleId: g.styleId,
      styleRev: g.styleRev,
      model: g.model,
      prompt: g.promptText,
      promptHash: g.promptHash,
      personaSnapshot: g.personaSnapshot,
      personaVersionId: g.personaVersionId,
      personaVersionNo: personaVersion ? Number(personaVersion.version_no) : null,
      createdAt: g.createdAt,
      finishedAt: g.finishedAt,
      drafts: drafts.map((d) => ({ id: d.id, draftNo: Number(d.draft_no), name: d.name, title: d.title, wordCount: Number(d.word_count) })),
      variants,
    })
  })

  app.post('/copy/variants/:variantId/apply', async (req) => {
    const { variantId } = req.params as { variantId: string }
    const body = (req.body ?? {}) as { mode?: string; confirmChanged?: boolean }
    const mode = body.mode === 'new_draft' ? 'new_draft' : 'replace'
    const r = await applyVariant(variantId, mode, !!body.confirmChanged, req.operator)
    if (r.changed) {
      // 需要确认：返回 200 + requiresConfirm，由前端弹对比
      return ok({ requiresConfirm: true, draftId: r.draftId })
    }
    return ok({ requiresConfirm: false, draftId: r.draftId, versionId: r.versionId })
  })

  /* ── 预检与提交 ─────────────────────────────────────────────────── */

  app.post('/copy/:id/precheck', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { draftId?: string }
    if (!body.draftId) throw err.badRequest('draftId 必填')
    return ok(await precheck(id, body.draftId))
  })

  app.post('/copy/:id/submit', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { draftId?: string; rev?: number }
    if (!body.draftId) throw err.badRequest('draftId 必填')
    const r = await submitForReview(id, body.draftId, body.rev === undefined ? null : toInt(body.rev), req.operator)
    return ok(r)
  })

  app.post('/copy/:id/withdraw', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await withdrawReview(id, req.operator))
  })

  app.get('/copy/:id/approved', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await getApprovedCopy(id))
  })

  /* ── 文章 ────────────────────────────────────────────────────────── */

  app.post('/articles', async (req, reply) => {
    const contentType = String(req.headers['content-type'] ?? '')
    if (contentType.includes('multipart/form-data')) {
      // P0-3：@fastify/multipart 已在 app.ts 注册（limits.fileSize = articleMaxBytes）
      const file = await (req as FastifyRequest & {
        file: () => Promise<
          | { filename: string; mimetype: string; file: AsyncIterable<Buffer> & { truncated?: boolean; destroy?: () => void } }
          | undefined
        >
      }).file()
      if (!file) throw err.badRequest('请上传文件（字段名 file）')
      // P2-2：全局 multipart 上限是人物素材的 200MB，这里按文章上限边读边判，超限立即中断，
      // 不再先 toBuffer() 把整份读进内存再判断
      const tooLarge = () =>
        err.articleTooLarge(`文件超过 ${Math.round(config.copy.articleMaxBytes / 1024 / 1024)}MB，请压缩后上传`, {
          max: config.copy.articleMaxBytes,
        })
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of file.file) {
        total += chunk.length
        if (total > config.copy.articleMaxBytes) {
          file.file.destroy?.()
          throw tooLarge()
        }
        chunks.push(chunk)
      }
      // 超过 limits.fileSize 时 multipart 会把流截断，必须显式判失败，否则会把半个文件当完整解析
      if (file.file.truncated) throw tooLarge()
      const buf = Buffer.concat(chunks)
      const head = buf.subarray(0, 16)
      const ext = validateFileMeta(file.filename, buf.length, head)
      const parsed = await parseArticleBuffer(ext, buf)
      const storagePath = writeTempFile(file.filename, buf)
      const r = await saveArticle({
        filename: file.filename,
        mime: file.mimetype,
        size: buf.length,
        storagePath,
        parsed,
        operator: req.operator,
      })
      await recordOperation({
        operator: req.operator,
        action: 'copy.article_upload',
        targetType: 'article',
        targetId: r.articleId,
        detail: { filename: file.filename, size: buf.length, wordCount: r.wordCount, outline: r.outline.length },
      })
      return ok(r)
    }

    const body = (req.body ?? {}) as { text?: string; filename?: string }
    if (!body.text || !String(body.text).trim()) throw err.badRequest('请粘贴文章正文')
    const parsed = parsePastedText(String(body.text))
    const r = await saveArticle({
      filename: body.filename ?? '粘贴文本.txt',
      mime: 'text/plain',
      size: Buffer.byteLength(String(body.text), 'utf8'),
      storagePath: null,
      parsed,
      operator: req.operator,
    })
    void reply
    return ok(r)
  })

  app.get('/articles/:id', async (req) => {
    const { id } = req.params as { id: string }
    const a = await getArticle(id)
    if (!a) throw err.notFound('文章不存在或已过期（临时文件保留 30 天）')
    return ok(a)
  })

  /* ── 模板 / 风格 / 合规词库 CRUD ────────────────────────────────── */

  app.get('/copy-templates', async (req) => {
    const q = (req.query ?? {}) as { enabled?: string }
    return ok(await listTemplates(q.enabled === '1'))
  })

  app.post('/copy-templates', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = String(body.name ?? '').trim()
    if (!name) throw err.badRequest('模板名称必填')
    const db = (await import('../../db/index.js')).getDb()
    const id = newId('ctpl')
    const now = toDb(utcNow())
    await db.run(
      `INSERT INTO \`copy_template\` (\`id\`, \`name\`, \`description\`, \`prompt\`, \`structure_hint\`, \`risk_hint\`, \`is_builtin\`, \`enabled\`, \`sort\`, \`revision\`, \`updated_by\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        name,
        body.description ? String(body.description).slice(0, 512) : null,
        String(body.prompt ?? ''),
        body.structureHint ? String(body.structureHint) : null,
        body.riskHint ? String(body.riskHint) : null,
        body.enabled === false ? 0 : 1,
        toInt(body.sort, 100),
        req.operator,
        now,
        now,
      ],
    )
    await recordoperationSafe(req.operator, 'template.save', 'copy_template', id, { created: true })
    return ok(await getTemplate(id))
  })

  app.put('/copy-templates/:id', async (req) => {
    const { id } = req.params as { id: string }
    const t = await getTemplate(id)
    if (!t) throw err.notFound('模板不存在')
    const body = (req.body ?? {}) as Record<string, unknown>
    const db = (await import('../../db/index.js')).getDb()
    // 每次保存 revision + 1，生成快照引用 id + revision（AC-M2 / AC-G6）
    await db.run(
      `UPDATE \`copy_template\` SET \`name\` = ?, \`description\` = ?, \`prompt\` = ?, \`structure_hint\` = ?,
        \`risk_hint\` = ?, \`enabled\` = ?, \`sort\` = ?, \`revision\` = \`revision\` + 1, \`updated_by\` = ?, \`updated_at\` = ?
       WHERE \`id\` = ?`,
      [
        body.name === undefined ? t.name : String(body.name).slice(0, 128),
        body.description === undefined ? t.description : String(body.description ?? '').slice(0, 512) || null,
        body.prompt === undefined ? t.prompt : String(body.prompt),
        body.structureHint === undefined ? t.structureHint : String(body.structureHint ?? '') || null,
        body.riskHint === undefined ? t.riskHint : String(body.riskHint ?? '') || null,
        body.enabled === undefined ? (t.enabled ? 1 : 0) : body.enabled ? 1 : 0,
        body.sort === undefined ? t.sort : toInt(body.sort, t.sort),
        req.operator,
        toDb(utcNow()),
        id,
      ],
    )
    await recordoperationSafe(req.operator, 'template.save', 'copy_template', id, {
      revision: t.revision + 1,
    })
    return ok(await getTemplate(id))
  })

  app.delete('/copy-templates/:id', async (req) => {
    const { id } = req.params as { id: string }
    const t = await getTemplate(id)
    if (!t) throw err.notFound('模板不存在')
    if (t.isBuiltin) throw err.invalidState('内置模板不可删除（可停用或修改提示词）', { isBuiltin: true })
    const db = (await import('../../db/index.js')).getDb()
    await db.run('DELETE FROM `copy_template` WHERE `id` = ?', [id])
    await recordoperationSafe(req.operator, 'template.delete', 'copy_template', id, null)
    return ok({ ok: true })
  })

  app.get('/copy-styles', async (req) => {
    const q = (req.query ?? {}) as { line?: string; enabled?: string }
    return ok(await listStyles(q.line ?? null, q.enabled === '1'))
  })

  app.post('/copy-styles', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = String(body.name ?? '').trim()
    const line = String(body.line ?? '')
    if (!name) throw err.badRequest('风格名称必填')
    if (!['manager', 'kos', 'persona'].includes(line)) throw err.badRequest('line 必须是 manager / kos / persona')
    const db = (await import('../../db/index.js')).getDb()
    const id = newId('csty')
    const now = toDb(utcNow())
    await db.run(
      `INSERT INTO \`copy_style\` (\`id\`, \`name\`, \`line\`, \`prompt\`, \`is_builtin\`, \`enabled\`, \`sort\`, \`revision\`, \`updated_by\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`,
      [id, name, line, String(body.prompt ?? ''), body.enabled === false ? 0 : 1, toInt(body.sort, 100), req.operator, now, now],
    )
    await recordoperationSafe(req.operator, 'style.save', 'copy_style', id, { created: true })
    return ok(await getStyle(id))
  })

  app.put('/copy-styles/:id', async (req) => {
    const { id } = req.params as { id: string }
    const s = await getStyle(id)
    if (!s) throw err.notFound('风格不存在')
    const body = (req.body ?? {}) as Record<string, unknown>
    const db = (await import('../../db/index.js')).getDb()
    const line = body.line === undefined ? s.line : String(body.line)
    if (!['manager', 'kos', 'persona'].includes(line)) throw err.badRequest('line 必须是 manager / kos / persona')
    await db.run(
      `UPDATE \`copy_style\` SET \`name\` = ?, \`line\` = ?, \`prompt\` = ?, \`enabled\` = ?, \`sort\` = ?,
        \`revision\` = \`revision\` + 1, \`updated_by\` = ?, \`updated_at\` = ? WHERE \`id\` = ?`,
      [
        body.name === undefined ? s.name : String(body.name).slice(0, 128),
        line,
        body.prompt === undefined ? s.prompt : String(body.prompt),
        body.enabled === undefined ? (s.enabled ? 1 : 0) : body.enabled ? 1 : 0,
        body.sort === undefined ? s.sort : toInt(body.sort, s.sort),
        req.operator,
        toDb(utcNow()),
        id,
      ],
    )
    await recordoperationSafe(req.operator, 'style.save', 'copy_style', id, { revision: s.revision + 1 })
    return ok(await getStyle(id))
  })

  app.delete('/copy-styles/:id', async (req) => {
    const { id } = req.params as { id: string }
    const s = await getStyle(id)
    if (!s) throw err.notFound('风格不存在')
    if (s.isBuiltin) throw err.invalidState('内置风格不可删除（可停用或修改提示词）', { isBuiltin: true })
    const db = (await import('../../db/index.js')).getDb()
    await db.run('DELETE FROM `copy_style` WHERE `id` = ?', [id])
    await recordoperationSafe(req.operator, 'style.delete', 'copy_style', id, null)
    return ok({ ok: true })
  })

  app.get('/compliance-words', async (req) => {
    const q = (req.query ?? {}) as { level?: string; enabled?: string }
    return ok(await listComplianceWords({ level: q.level, enabledOnly: q.enabled === '1' }))
  })

  app.post('/compliance-words', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const word = String(body.word ?? '').trim()
    if (!word) throw err.badRequest('词不能为空')
    if (word.length > 128) throw err.badRequest('词过长（≤128 字符）')
    const level = body.level === 'hard' ? 'hard' : 'soft'
    const db = (await import('../../db/index.js')).getDb()
    const dup = await db.get<{ id: string }>('SELECT `id` FROM `compliance_word` WHERE `word` = ?', [word])
    if (dup) throw err.conflict(`「${word}」已存在词库中`)
    const id = newId('cw')
    const now = toDb(utcNow())
    await db.run(
      `INSERT INTO \`compliance_word\` (\`id\`, \`word\`, \`level\`, \`category\`, \`enabled\`, \`updated_by\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, word, level, body.category ? String(body.category).slice(0, 32) : null, body.enabled === false ? 0 : 1, req.operator, now, now],
    )
    await recordoperationSafe(req.operator, 'compliance.save', 'compliance_word', id, { word, level, created: true })
    const r = await getComplianceWordSafe(id)
    return ok(r)
  })

  app.put('/compliance-words/:id', async (req) => {
    const { id } = req.params as { id: string }
    const existing = await getComplianceWordSafe(id)
    if (!existing) throw err.notFound('词不存在')
    const body = (req.body ?? {}) as Record<string, unknown>
    const db = (await import('../../db/index.js')).getDb()
    await db.run(
      'UPDATE `compliance_word` SET `word` = ?, `level` = ?, `category` = ?, `enabled` = ?, `updated_by` = ?, `updated_at` = ? WHERE `id` = ?',
      [
        body.word === undefined ? existing.word : String(body.word).trim(),
        body.level === undefined ? existing.level : body.level === 'hard' ? 'hard' : 'soft',
        body.category === undefined ? existing.category : String(body.category ?? '') || null,
        body.enabled === undefined ? (existing.enabled ? 1 : 0) : body.enabled ? 1 : 0,
        req.operator,
        toDb(utcNow()),
        id,
      ],
    )
    await recordoperationSafe(req.operator, 'compliance.save', 'compliance_word', id, { updated: true })
    return ok(await getComplianceWordSafe(id))
  })

  app.delete('/compliance-words/:id', async (req) => {
    const { id } = req.params as { id: string }
    const existing = await getComplianceWordSafe(id)
    if (!existing) throw err.notFound('词不存在')
    const db = (await import('../../db/index.js')).getDb()
    await db.run('DELETE FROM `compliance_word` WHERE `id` = ?', [id])
    await recordoperationSafe(req.operator, 'compliance.save', 'compliance_word', id, { deleted: true })
    return ok({ ok: true })
  })

  /* ── 审核契约（§5.3；审核模块就绪后由外部实现接管）─────────────── */

  app.post('/review/submissions', async (req) => {
    const body = (req.body ?? {}) as { copyId?: string; copyVersionId?: string; draftId?: string }
    if (!body.copyId) throw err.badRequest('copyId 必填')
    let draftId = body.draftId
    if (!draftId) {
      const drafts = await listDrafts(body.copyId)
      draftId = drafts[0]?.id
    }
    if (!draftId) throw err.badRequest('该文案还没有稿')
    const r = await submitForReview(body.copyId, draftId, null, req.operator)
    return ok({
      submissionId: r.submissionId,
      versionId: r.versionId,
      versionNo: r.versionNo,
      reused: r.reused,
    })
  })

  app.get('/review/submissions/:id', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await getSubmissionProgress(id))
  })

  app.post('/review/submissions/:id/withdraw', async (req) => {
    const { id } = req.params as { id: string }
    const sub = await getSubmission(id)
    if (!sub) throw err.notFound('审核单不存在')
    if (!WITHDRAWABLE_STATUSES.includes(sub.status as never)) {
      throw err.withdrawNotAllowed('已进入人工复核或已结束，不可撤回', { status: sub.status })
    }
    return ok(await withdrawReview(sub.copyId, req.operator))
  })

  /** 审核桩裁决（审核模块就绪后下线） */
  app.post('/review/submissions/:id/decision', async (req) => {
    // 桩关闭（生产默认）时拒绝；开启时也只允许裁决桩审核单，真实审核单由审核模块回写
    assertReviewStubEnabled()
    const { id } = req.params as { id: string }
    const stubSub = await getSubmission(id)
    if (!stubSub) throw err.notFound('审核单不存在')
    if (!stubSub.isStub) throw err.forbidden('该审核单由真实审核模块处理，不能用审核桩裁决')
    const body = (req.body ?? {}) as {
      result?: string
      reason?: string
      rejectedGate?: string
      riskPoints?: string[]
    }
    if (body.result !== 'approved' && body.result !== 'rejected') {
      throw err.badRequest('result 必须是 approved 或 rejected')
    }
    return ok(
      await onReviewResult({
        submissionId: id,
        result: body.result,
        reason: body.reason ?? null,
        rejectedGate: body.rejectedGate ?? null,
        riskPoints: body.riskPoints ?? null,
        operator: req.operator,
      }),
    )
  })

  /* ── 人工复核（P1-7；角色限定见 auth/guard.ROLE_RULES）──────────── */

  app.get('/review/queue', async (req) => {
    const q = (req.query ?? {}) as { scope?: string; line?: string }
    const scope = q.scope === 'decided' ? 'decided' : 'pending'
    const line = q.line && ['manager', 'kos', 'persona'].includes(q.line) ? q.line : undefined
    return ok({ items: await listReviewQueue({ scope, line }), stubEnabled: config.copy.reviewStubEnabled })
  })

  app.post('/review/submissions/:id/manual-decision', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { result?: string; reason?: string; riskPoints?: string[]; appendedRiskText?: string }
    if (body.result !== 'approved' && body.result !== 'rejected') throw err.badRequest('result 必须是 approved 或 rejected')
    return ok(
      await manualDecision({
        submissionId: id,
        result: body.result,
        reason: body.reason ?? null,
        riskPoints: Array.isArray(body.riskPoints) ? body.riskPoints.map(String).filter(Boolean).slice(0, 20) : null,
        appendedRiskText: body.appendedRiskText ? String(body.appendedRiskText).slice(0, 2000) : null,
        operator: req.operator,
      }),
    )
  })

  /** 关卡推进联调接口（桩专用）；真实审核模块走服务调用 onReviewProgress */
  app.post('/review/submissions/:id/progress', async (req) => {
    assertReviewStubEnabled()
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { gate?: string; result?: string }
    if (!body.gate) throw err.badRequest('gate 必填')
    await onReviewProgress(id, String(body.gate), body.result === 'fail' ? 'fail' : 'pass')
    return ok({ ok: true })
  })

  /* ── 工具：合规扫描试算（前端实时扫描用）────────────────────────── */

  app.post('/copy/compliance/scan', async (req) => {
    // P1-22：前端编辑时实时调用的接口，支持传 title 一起扫（FR-R1 要求标题也纳入）
    const body = (req.body ?? {}) as { sections?: unknown; title?: string; copyId?: string }
    const sections = Array.isArray(body.sections) ? (body.sections as never) : []
    const words = await listComplianceWords({ enabledOnly: true })
    let claims: string[] = []
    if (body.copyId) {
      const c = await getCopy(String(body.copyId))
      if (c?.personaId) {
        const p = await getPersonaById(c.personaId, true)
        claims = p?.ipProfile?.forbiddenClaims ?? []
      }
    }
    return ok({ hits: scanCompliance(sections, words, claims, body.title ?? null) })
  })

  /* ── 提示词预览（编辑器「查看提示词」，仅预览不落库）───────────── */

  app.post('/copy/:id/prompt-preview', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { templateId?: string; styleId?: string; durationTier?: string; durationSeconds?: number; instructions?: string }
    const copy = await requireCopy(id)
    const template = body.templateId ? await getTemplate(body.templateId) : null
    const style = body.styleId ? await getStyle(body.styleId) : null
    const persona = copy.personaId ? await getPersonaById(copy.personaId, true) : null
    if (!template || !style || !persona) throw err.badRequest('模板 / 风格 / 人物不完整')
    // 与真实生成同一套组装（含资讯 / 对标 / 文章大纲等完整来源块），预览即实际发给模型的提示词
    const durationTier = body.durationTier ?? 'medium'
    const a = await assembleForCopy(copy, persona, template, style, {
      durationTier,
      durationSeconds: validateDuration(durationTier, body.durationSeconds),
      instructions: body.instructions ? String(body.instructions).trim().slice(0, config.copy.maxInstructions) : null,
    })
    const count = Math.max(1, Math.min(config.copy.maxBatchCount, Number((req.body as any)?.count) || 1))
    const { candidateUser } = await import('./candidates.js')
    const candidates = Array.from({ length: count }, (_, i) => ({ direction: candidateUser(a.user, i + 1, count).direction, user: candidateUser(a.user, i + 1, count).user }))
    return ok({ system: a.system, user: candidates[0]!.user, candidates, prompt: a.promptText, promptHash: a.promptHash, wordRange: a.wordRange })
  })

  void withReply
}

/** 兼容未使用的 reply 形参（Fastify 会传入，仅部分分支需要） */
function withReply(_reply: FastifyReply): void {}

async function getSubmissionByVersionSafe(versionId: string) {
  const { getSubmissionByVersion } = await import('./repo.js')
  return getSubmissionByVersion(versionId)
}

async function getComplianceWordSafe(id: string) {
  const { getComplianceWord } = await import('./repo.js')
  return getComplianceWord(id)
}

async function recordoperationSafe(
  operator: string,
  action: string,
  targetType: string,
  targetId: string,
  detail: unknown,
): Promise<void> {
  await recordOperation({ operator, action, targetType, targetId, detail })
}
