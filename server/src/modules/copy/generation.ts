import { getDb, isDuplicateKey } from '../../db/index.js'
import { candidateUser } from './candidates.js'
import { config } from '../../config.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { newId, jenc, jdec } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { chat, currentModelLabel } from '../../integrations/copy-llm/index.js'
import { recordOperation } from '../audit/repo.js'
import { enqueue, getQueueBackend, QUEUE_NAMES } from '../../queue/index.js'
import {
  countDrafts,
  getCopy,
  getGeneration,
  getStyle,
  getTemplate,
  insertDraft,
  insertGeneration,
  insertVariant,
  requireCopy,
  touchCopy,
  updateCopy,
  updateGeneration,
  type CopyRow,
} from './repo.js'
import {
  countSectionsWords,
  contentHash,
  scanCompliance,
  toPlainText,
} from './text.js'
import { assemblePrompt, assembleVariantPrompt, parseDraftJson, parseVariantJson } from './prompt.js'
import { listTemplates as listTopicMethods } from '../topics/repo.js'
import { inheritedMethod } from '../topics/methods.js'
import {
  tierOf,
  wordRangeOf,
  type GenerationMode,
  type Section,
} from './constants.js'
import { getPersonaById } from './persona-bridge.js'
import { structureRefFor } from './structure.js'
import { assertApprovedEditConfirmed } from './service.js'
import { insertVersion, listComplianceWords, storedPrompt } from './repo.js'

/**
 * 数据看板偏好注入（FR-M7）：取 active preference_profile 的 basis_text。
 * 看板模块异常或没有 active 档案时一律返回 null —— 生成链路不因数据看板不可用而失败（AC-R1）。
 */
async function injectedInstructions(): Promise<string | null> {
  try {
    const { instructionsFromProfile } = await import('../analytics/features.js')
    return await instructionsFromProfile()
  } catch {
    return null
  }
}

/**
 * 文案引擎（W2 / FR-G1~G7）。
 * 规则要点：
 *  - 生成**永远产出新稿**，不覆盖任何已有稿（W5）；
 *  - 单 copy 稿数上限（默认 10），超出拒绝 COPY_DRAFT_LIMIT；
 *  - `Idempotency-Key` 唯一，同 key 重复请求返回同一 generationId；
 *  - 部分成功：成功的份数建稿，失败的份数记原因，生成记录 status=partial；
 *  - LLM 输出非法 JSON 自动重试 1 次，仍失败则该份记失败，**不落半截稿**（FR-G4）。
 */

export interface GenerateArgs {
  copyId: string
  templateId: string
  styleId: string
  durationTier: string
  durationSeconds?: number | null
  count: number
  instructions?: string | null
  preferences?: unknown
  operator: string
  idempotencyKey?: string | null
}

export interface GenerateAccept {
  generationId: string
  status: string
  reused?: boolean
}

/* ── 参数校验 ─────────────────────────────────────────────────────── */

export function validateDuration(tier: string, durationSeconds: unknown): number | null {
  const def = tierOf(tier)
  if (!def) throw err.badRequest(`不支持的目标时长档：${tier}`, { allowed: ['short', 'medium', 'long', 'custom'] })
  if (def.key !== 'custom') return null

  // AC-G8：custom 必填、10–180 整数
  if (durationSeconds === undefined || durationSeconds === null || durationSeconds === '') {
    throw err.badRequest('选择「自定义」时长时必须填写秒数', { field: 'durationSeconds' })
  }
  const n = Number(durationSeconds)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw err.badRequest('自定义时长必须是整数秒', { value: durationSeconds })
  }
  if (n < def.minSeconds || n > def.maxSeconds) {
    throw err.badRequest(`自定义时长需在 ${def.minSeconds}–${def.maxSeconds} 秒之间`, {
      value: n,
      min: def.minSeconds,
      max: def.maxSeconds,
    })
  }
  return n
}

/* ── 接受生成请求（同步部分：校验 + 落记录 + 入队）──────────────────── */

export async function acceptGeneration(args: GenerateArgs): Promise<GenerateAccept> {
  const db = getDb()

  // 1) 幂等：同 key 直接返回既有记录（AC-G2）
  if (args.idempotencyKey) {
    const existed = await db.get<{ id: string; status: string }>(
      'SELECT `id`, `status` FROM `copy_generation` WHERE `idempotency_key` = ?',
      [args.idempotencyKey],
    )
    if (existed) return { generationId: existed.id, status: existed.status, reused: true }
  }

  const copy = await requireCopy(args.copyId, db)
  if (copy.status === 'archived') throw err.invalidState('该文案已归档，不可生成')
  if (copy.status === 'in_review') throw err.copyLocked()

  // 2) 稿数上限（AC-G2）
  const current = await countDrafts(copy.id, db)
  const count = Math.max(1, Math.min(config.copy.maxBatchCount, Number(args.count) || 1))
  if (current + count > config.copy.maxDrafts) {
    throw err.draftLimit(
      `该文案已有 ${current} 份稿，本次生成 ${count} 份将超过上限 ${config.copy.maxDrafts}；请先删除旧稿或减少生成数量`,
      { current, requested: count, max: config.copy.maxDrafts },
    )
  }

  // 3) 模板 / 风格 / 时长
  const template = await getTemplate(args.templateId, db)
  if (!template || !template.enabled) throw err.badRequest('模板不存在或已停用，请重新选择')
  const style = await getStyle(args.styleId, db)
  if (!style || !style.enabled) throw err.badRequest('风格不存在或已停用，请重新选择')

  const persona = copy.personaId ? await getPersonaById(copy.personaId, true) : null
  if (!persona) throw err.badRequest('文案未绑定有效人物，无法生成')
  // Q4：风格严格按线过滤
  if (style.line !== persona.line) {
    throw err.badRequest(`风格「${style.name}」不适用于 ${persona.line} 生产线`, {
      styleLine: style.line,
      personaLine: persona.line,
    })
  }

  const durationSeconds = validateDuration(args.durationTier, args.durationSeconds)
  // 用户显式填写优先；未填时注入数据看板已确认的爆款特征偏好（FR-M7 / §3.3）。
  // 无 active 档案时 instructions 为 null，行为与接入前完全一致（AC-R1）。
  // 注意：注入值只进本次生成记录与提示词，不回写 copy.settings——否则偏好更新后
  // 前端会一直回填旧文案，被误判成「用户显式要求」。
  const explicitInstructions = args.instructions ? String(args.instructions).trim().slice(0, config.copy.maxInstructions) : null
  const instructions = explicitInstructions ?? (await injectedInstructions())

  // 4) 组装提示词与快照
  const ip = persona.ipProfile
  const assembled = await assembleForCopy(copy, persona, template, style, {
    durationTier: args.durationTier,
    durationSeconds,
    instructions,
  })

  const personaSnapshot = {
    id: persona.id,
    name: persona.name,
    line: persona.line,
    ipProfile: ip,
    // FR-X3：生成时的人物版本（供详情回显版本号）
    versionId: persona.currentVersionId ?? null,
    capturedAt: toDb(utcNow()),
  }

  const generationId = newId('gen')
  try {
    await insertGeneration(
      {
        id: generationId,
        copy_id: copy.id,
        draft_id: null,
        kind: 'generate',
        mode: copy.source,
        template_id: template.id,
        template_rev: template.revision,
        style_id: style.id,
        style_rev: style.revision,
        duration_tier: args.durationTier,
        duration_seconds: durationSeconds,
        count,
        instructions,
        target_section: null,
        persona_snapshot: personaSnapshot,
        persona_version_id: persona.currentVersionId ?? null,
        prompt_text: assembled.promptText,
        prompt_system: assembled.system,
        prompt_hash: assembled.promptHash,
        model: currentModelLabel(),
        status: 'pending',
        idempotency_key: args.idempotencyKey ?? null,
        created_by: args.operator,
      },
      db,
    )
  } catch (e) {
    // 幂等兜底：并发同 key 时，上面的「先查后插」会双写，唯一索引在此拦下后写者。
    // 此时把先写者的记录返回给调用方，保持「同 key 只有一个生成记录」的语义（AC-G2）。
    if (args.idempotencyKey && isDuplicateKey(e)) {
      const existed = await db.get<{ id: string; status: string }>(
        'SELECT `id`, `status` FROM `copy_generation` WHERE `idempotency_key` = ?',
        [args.idempotencyKey],
      )
      if (existed) return { generationId: existed.id, status: existed.status, reused: true }
    }
    throw e
  }

  // 5) 记住创作设置（下次打开回填，FR-G1）
  const settings = {
    ...(copy.settings ?? {}),
    templateId: template.id,
    styleId: style.id,
    durationTier: args.durationTier,
    durationSeconds,
    count,
    instructions: explicitInstructions,
  }
  await db.tx(async tx => {
    const fresh = await requireCopy(copy.id, tx)
    await updateCopy(copy.id, { settings: jenc({ ...fresh.settings, templateId: settings.templateId, styleId: settings.styleId, durationTier: settings.durationTier, durationSeconds: settings.durationSeconds, count, instructions: explicitInstructions }), updated_at: toDb(utcNow()) }, tx)
  })

  // 6) 入队（jobId 用 generationId，天然去重）
  await enqueueOrFail(generationId, 'generate')

  await recordOperation({
    operator: args.operator,
    action: 'copy.generate',
    targetType: 'copy',
    targetId: copy.id,
    detail: {
      generationId,
      templateId: template.id,
      styleId: style.id,
      durationTier: args.durationTier,
      durationSeconds,
      count,
      wordRange: assembled.wordRange,
      promptHash: assembled.promptHash,
    },
  })

  return { generationId, status: 'pending' }
}

type PersonaRow = NonNullable<Awaited<ReturnType<typeof getPersonaById>>>
type TemplateRow = NonNullable<Awaited<ReturnType<typeof getTemplate>>>
type StyleRow = NonNullable<Awaited<ReturnType<typeof getStyle>>>

/**
 * 某条文案的整稿提示词组装（受理生成、老记录重拼、「查看提示词」预览共用）。
 * 三处必须同源：预览若只拼 copy.sourceText，看到的就不是实际发给模型的提示词。
 */
export async function assembleForCopy(
  copy: CopyRow,
  persona: PersonaRow,
  template: TemplateRow,
  style: StyleRow,
  opts: { durationTier: string; durationSeconds: number | null; instructions: string | null },
): Promise<ReturnType<typeof assemblePrompt>> {
  const ip = persona.ipProfile
  return assemblePrompt({
    mode: copy.source as GenerationMode,
    persona: {
      name: persona.name,
      line: persona.line,
      role: ip.role,
      serviceScope: ip.serviceScope,
      targetAudience: ip.targetAudience,
      expressionStyle: ip.expressionStyle,
      forbiddenClaims: ip.forbiddenClaims,
      audienceNeeds: ip.audienceNeeds,
      factualBackground: ip.factualBackground,
      sampleScript: ip.sampleScript,
    },
    topic: await topicAngle(copy, persona),
    structureRef: await structureRefFor(copy),
    template: { name: template.name, prompt: template.prompt, structureHint: template.structureHint },
    style: { name: style.name, prompt: style.prompt },
    durationTier: opts.durationTier,
    durationSeconds: opts.durationSeconds,
    instructions: opts.instructions,
    source: { ...(await buildSourceBlock(copy)), ...((copy.settings?.sourceReview as any)?.correctedText ? { sourceText: String((copy.settings!.sourceReview as any).correctedText) } : {}) },
  })
}

/**
 * 选题角度：只有资讯 / 对标来源的选题带角度。
 * 手动来源的 topic.hook 存的是运营填写的关键词（见 buildSourceBlock），不能当开场注入。
 */
async function topicAngle(copy: CopyRow, persona: PersonaRow): Promise<Parameters<typeof assemblePrompt>[0]['topic']> {
  if (!copy.topicId || (copy.source !== 'news' && copy.source !== 'benchmark')) return null
  const t = await getDb().get<{ title: string; direction: string | null; hook: string | null; rationale: string | null; method_id: string | null }>(
    'SELECT `title`, `direction`, `hook`, `rationale`, `method_id` FROM `topic` WHERE `id` = ?',
    [copy.topicId],
  )
  if (!t) return null
  // 选题方法该人物没开启（改派场景）时不写方法名，避免把人物不做的方法带进文案
  const inherited = inheritedMethod(t.method_id, { line: persona.line, contentMix: persona.ipProfile.contentMix }, await listTopicMethods())
  const method = inherited.from === 'topic' ? inherited.method?.name ?? null : null
  return { title: copy.title ?? t.title, method, direction: t.direction, hook: t.hook, rationale: t.rationale }
}

/** 按来源组装来源块（FR-G3 四种模式） */
async function buildSourceBlock(copy: CopyRow): Promise<Parameters<typeof assemblePrompt>[0]['source']> {
  const db = getDb()
  const base = {
    mode: copy.source as GenerationMode,
    sourceText: copy.sourceText ?? '',
  }
  if (copy.source === 'news' && copy.sourceRefId) {
    const n = await db.get<{ title: string; summary: string | null; content_url: string | null }>(
      'SELECT `title`, `summary`, `content_url` FROM `news_item` WHERE `id` = ?',
      [copy.sourceRefId],
    )
    return {
      ...base,
      sourceText: [n?.title, n?.summary].filter(Boolean).join('\n') || base.sourceText,
      sourceUrl: n?.content_url ?? null,
    }
  }
  if (copy.source === 'benchmark' && copy.sourceRefId) {
    const v = await db.get<{ title: string | null; author_nickname: string | null }>(
      'SELECT `title`, `author_nickname` FROM `benchmark_video` WHERE `id` = ?',
      [copy.sourceRefId],
    )
    return {
      ...base,
      benchmarkTitle: v?.title ?? null,
      benchmarkAuthor: v?.author_nickname ?? null,
    }
  }
  if (copy.source === 'article') {
    const article = copy.sourceRefId
      ? await db.get<{ outline: string | null; plain_text: string | null }>(
          'SELECT `outline`, `plain_text` FROM `article_source` WHERE `id` = ?',
          [copy.sourceRefId],
        )
      : null
    const outline = jdec<Array<{ index: number; level: number; title: string }>>(article?.outline, [])
    return {
      ...base,
      sourceText: article?.plain_text ?? base.sourceText,
      outline,
    }
  }
  // manual
  const topic = copy.topicId
    ? await db.get<{ title: string; hook: string | null }>('SELECT `title`, `hook` FROM `topic` WHERE `id` = ?', [
        copy.topicId,
      ])
    : null
  return {
    ...base,
    manualTitle: copy.title ?? topic?.title ?? null,
    manualKeywords: topic?.hook ?? null,
  }
}

/**
 * 入队失败（Redis 不可用等）时把生成记录标为失败并报错。
 * 之前只打日志、接口照常返回 pending，记录会永远停在「排队中」。
 */
async function enqueueOrFail(generationId: string, jobName: 'generate' | 'variant'): Promise<void> {
  try {
    await enqueue(QUEUE_NAMES.copyGenerate, jobName, { generationId }, { jobId: generationId, attempts: 1 })
  } catch (e) {
    logger.error({ err: (e as Error).message, generationId, jobName }, 'copy.generate.enqueue_failed')
    await updateGeneration(generationId, {
      status: 'failed',
      error: '任务排队失败，请稍后重试',
      finished_at: toDb(utcNow()),
    })
    throw err.upstream('生成任务排队失败，请稍后重试')
  }
}

/** 审核中 / 已归档的文案不再写入任何稿（§3.1：in_review 下写操作一律拒绝） */
function isLocked(copy: CopyRow | null): boolean {
  return !copy || copy.status === 'in_review' || copy.status === 'archived'
}

const LOCKED_REASON = '文案已提交审核或已归档，本次生成未写入'

/**
 * 启动时补扫中断的生成：内存队列重启后任务全部丢失；Redis 队列里卡住超过 30 分钟的也视为中断。
 * 标为失败后前端轮询即可结束，运营可重新生成；worker 再拿到这些任务时会因终态直接跳过。
 */
export async function failInterruptedGenerations(): Promise<number> {
  const db = getDb()
  const memory = getQueueBackend() === 'memory'
  const cutoff = toDb(new Date(Date.now() - 30 * 60_000))
  const rows = await db.all<{ id: string }>(
    memory
      ? "SELECT `id` FROM `copy_generation` WHERE `status` IN ('pending', 'running')"
      : "SELECT `id` FROM `copy_generation` WHERE `status` IN ('pending', 'running') AND `created_at` < ?",
    memory ? [] : [cutoff],
  )
  for (const r of rows) {
    await updateGeneration(r.id, { status: 'failed', error: '任务已中断（服务重启或排队超时），请重新生成', finished_at: toDb(utcNow()) }, db)
  }
  if (rows.length) logger.warn({ count: rows.length, memory }, 'copy.generate.interrupted_failed')
  return rows.length
}

/* ── 异步执行（BullMQ worker 调用）────────────────────────────────── */

export async function runGeneration(generationId: string): Promise<void> {
  const db = getDb()
  const gen = await getGeneration(generationId, db)
  if (!gen) {
    logger.warn({ generationId }, 'copy.generate.missing')
    return
  }
  if (gen.status === 'done' || gen.status === 'partial' || gen.status === 'failed') return

  await updateGeneration(generationId, { status: 'running' }, db)
  const copy = await getCopy(gen.copyId, db)
  if (!copy) {
    await updateGeneration(
      generationId,
      { status: 'failed', error: '文案已不存在', finished_at: toDb(utcNow()) },
      db,
    )
    return
  }
  if (isLocked(copy)) {
    await updateGeneration(generationId, { status: 'failed', error: LOCKED_REASON, finished_at: toDb(utcNow()) }, db)
    return
  }

  // P2-15：优先用受理时落库的提示词快照，保证「记录的提示词 = 实际发给模型的提示词」；
  // 老记录没有 prompt_system 时才按当前人物 / 模板 / 风格重拼（并回写快照）
  const persona = copy.personaId ? await getPersonaById(copy.personaId, true) : null
  const stored = storedPrompt(gen)
  const style = !stored && gen.styleId ? await getStyle(gen.styleId, db) : null
  const template = !stored && gen.templateId ? await getTemplate(gen.templateId, db) : null
  if (!persona || (!stored && (!style || !template))) {
    await updateGeneration(
      generationId,
      { status: 'failed', error: '人物、模板或风格已失效，请重新生成', finished_at: toDb(utcNow()) },
      db,
    )
    return
  }

  const assembled = stored
    ? null
    : await assembleForCopy(copy, persona, template!, style!, {
        durationTier: gen.durationTier,
        durationSeconds: gen.durationSeconds,
        instructions: gen.instructions,
      })
  const prompt = stored ?? { system: assembled!.system, user: assembled!.user }

  const words = await listComplianceWords({ enabledOnly: true }, db)
  const range = wordRangeOf(gen.durationTier, gen.durationSeconds)

  let succeeded = 0
  let failed = 0
  let totalCost = 0
  const failures: string[] = []
  const draftIds: string[] = []
  const warnings: string[] = []

  /**
   * 单份生成的完整处理（LLM → 解析 → 校验 → 落稿 + 落版本）。
   * 抽成函数是为了支持批内并发：真实模型单份耗时约 40–60 秒，串行跑 3 份会超过 2 分钟，
   * 前端轮询早已超时（本地 mock 瞬时返回，掩盖了这个问题）。
   * 稿号由 insertDraft 按 copy 串行分配，并发落稿不会撞号。
   */
  const runOne = async (i: number): Promise<{ ok: boolean; draftId?: string; cost: number }> => {
    try {
      // FR-G4：非法输出（非 JSON / 段落为空 / 超过 8 段）自动重试 1 次，仍失败才记该份失败
      let cost = 0
      let parsed: ReturnType<typeof parseDraftJson> = null
      for (let attempt = 0; attempt <= 1 && !parsed; attempt++) {
        const candidate = candidateUser(prompt.user, i, gen.count)
        const r = await callLlmWithRetry(prompt.system, candidate.user, generationId)
        cost += r.cost
        parsed = parseDraftJson(r.content)
      }
      if (!parsed || !parsed.sections.length) {
        failed += 1
        failures.push(`第 ${i} 份：模型返回内容不是合法 JSON，或段落为空 / 超过 8 段`)
        return { ok: false, cost }
      }

      // 字数偏离只提示不失败（FR-G4 / FR-E5）
      const wc = countSectionsWords(parsed.title, parsed.sections)
      if (wc < range.min || wc > range.max) warnings.push(`第 ${i} 份字数 ${wc} 字，超出 ${range.min}–${range.max} 字区间`)

      // article 模式：sourceRefs 非递减校验（AC-G3）
      if (copy.source === 'article') {
        const refs = parsed.sections.flatMap((s) => s.sourceRefs ?? [])
        const sorted = [...refs].sort((a, b) => a - b)
        if (refs.join(',') !== sorted.join(',')) {
          warnings.push(`第 ${i} 份 sourceRefs 非非递减，已按原文顺序重排`)
          let last = 0
          for (const s of parsed.sections) {
            if (s.sourceRefs?.length) {
              s.sourceRefs = s.sourceRefs.map((x) => Math.max(x, last)).sort((a, b) => a - b)
              last = s.sourceRefs[s.sourceRefs.length - 1] ?? last
            }
          }
        }
      }

      // P1-14①：标题也纳入扫描
      const hits = scanCompliance(parsed.sections, words, persona.ipProfile.forbiddenClaims, parsed.title)
      // 模型调用耗时数十秒，期间文案可能已提交审核或归档：落稿前再查一次
      if (isLocked(await getCopy(copy.id, db))) throw new Error(LOCKED_REASON)
      // 稿号由 insertDraft 在同一临界区内取号并插入（批内并发不会撞 UNIQUE(copy_id, draft_no)）
      const { id: draftId } = await insertDraft(
        {
          copyId: copy.id,
          title: parsed.title || copy.title,
          sections: parsed.sections,
          plainText: toPlainText(parsed.title, parsed.sections),
          wordCount: wc,
          origin: 'ai',
          name: gen.count > 1 ? candidateUser(prompt.user, i, gen.count).direction : '自由创作',
          generationId,
          createdBy: gen.createdBy ?? 'system',
          // 受理时只按当时稿数校验；执行期间可能有别的生成或新建稿落地，这里再卡一次
          maxDrafts: config.copy.maxDrafts,
        },
        db,
      )
      const version = await insertVersion(
        {
          copyId: copy.id,
          draftId,
          title: parsed.title || copy.title,
          sections: parsed.sections,
          plainText: toPlainText(parsed.title, parsed.sections),
          wordCount: wc,
          contentHash: contentHash(parsed.title, parsed.sections),
          origin: 'ai_generate',
          complianceHits: hits,
          createdBy: gen.createdBy ?? 'system',
        },
        db,
      )
      // 批内并发时 copy 级 MAX(version_no) 可能是别的稿的号，必须用本稿刚插入的版本号
      await db.run('UPDATE `copy_draft` SET `latest_version_no` = ? WHERE `id` = ?', [version.versionNo, draftId])
      draftIds.push(draftId)
      succeeded += 1
      return { ok: true, draftId, cost }
    } catch (e) {
      failed += 1
      failures.push(`第 ${i} 份：${(e as Error).message}`)
      logger.warn({ generationId, index: i, err: (e as Error).message }, 'copy.generate.item_failed')
      return { ok: false, cost: 0 }
    }
  }

  // 批内并发：默认 3，上限不超过份数。并发过高会被上游限流，3 是「时长/成功率」的折中。
  const batchConcurrency = Math.max(1, Math.min(config.copy.generateItemConcurrency, gen.count))
  const indexes = Array.from({ length: gen.count }, (_, k) => k + 1)
  const results: Array<{ ok: boolean; cost: number }> = []
  for (let c = 0; c < indexes.length; c += batchConcurrency) {
    const slice = indexes.slice(c, c + batchConcurrency)
    results.push(...(await Promise.all(slice.map((i) => runOne(i)))))
  }
  totalCost = results.reduce((s, r) => s + (r.cost ?? 0), 0)
  // draftIds 的顺序受并发影响，按 draftNo 重排，保证「current_draft_id 取第一份生成稿」语义稳定
  if (draftIds.length > 1) {
    const nos = await db.all<{ id: string; draft_no: number }>(
      `SELECT \`id\`, \`draft_no\` FROM \`copy_draft\` WHERE \`id\` IN (${draftIds.map(() => '?').join(',')})`,
      draftIds,
    )
    const order = new Map(nos.map((r) => [r.id, Number(r.draft_no)]))
    draftIds.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  }

  const status = failed === 0 ? 'done' : succeeded === 0 ? 'failed' : 'partial'
  await updateGeneration(
    generationId,
    {
      status,
      succeeded,
      failed,
      cost: totalCost,
      error: failures.length ? failures.join('；').slice(0, 2000) : null,
      finished_at: toDb(utcNow()),
      // 只有老记录（无快照、刚重拼）才回写；有快照时保持受理时的原文
      ...(assembled
        ? { prompt_hash: assembled.promptHash, prompt_text: assembled.promptText, prompt_system: assembled.system }
        : {}),
    },
    db,
  )

  // 当前稿切到本次生成的第一份（AI 产出物，不覆盖已有稿内容 W5）
  if (draftIds.length) {
    await db.run(
      "UPDATE `copy` SET `current_draft_id` = ?, `updated_at` = ? WHERE `id` = ? AND `status` NOT IN ('in_review', 'archived')",
      [draftIds[0], toDb(utcNow()), copy.id],
    )
    await dropUntouchedBlankDrafts(copy.id, draftIds)
  }
  if (warnings.length) {
    logger.info({ generationId, warnings }, 'copy.generate.warnings')
  }
  logger.info({ generationId, succeeded, failed, cost: totalCost, status }, 'copy.generate.finished')
}

/**
 * 新建文案时会先放一份空白稿，生成出结果后它只会以「0 字候选」的形式留在候选里。
 * 只删从未保存过（rev = 0）、从未提交、手动新建且内容为空的稿；运营动过的稿一律保留。
 */
async function dropUntouchedBlankDrafts(copyId: string, keep: string[]): Promise<void> {
  const db = getDb()
  const rows = await db.all<{ id: string; title: string | null; sections: string | null }>(
    "SELECT `id`, `title`, `sections` FROM `copy_draft` WHERE `copy_id` = ? AND `deleted_at` IS NULL AND `origin` = 'manual' AND `rev` = 0 AND `has_submitted` = 0",
    [copyId],
  )
  const now = toDb(utcNow())
  for (const r of rows) {
    if (keep.includes(r.id)) continue
    const sections = jdec<Section[]>(r.sections, [])
    if (sections.some((x) => String(x.text ?? '').trim())) continue
    await db.run('UPDATE `copy_draft` SET `deleted_at` = ? WHERE `id` = ? AND `rev` = 0', [now, r.id])
  }
}

/** 调 LLM；非法 JSON 重试 1 次（FR-G4） */
/**
 * P1-13：记账只在接入层 `chat()` 里写一次（通过 ref 归集到本 generationId），
 * 这里负责重试控制与文案工坊侧的 provider/endpoint 语义，不再重复写 api_call_log，
 * 否则 /api-calls/summary 的当日费用会翻倍。
 */
async function callLlmWithRetry(
  system: string,
  user: string,
  generationId: string,
): Promise<{ content: string; cost: number }> {
  const retries = Math.max(0, config.copy.llmRetry)
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { temperature: 0.8, maxTokens: 4000 },
        { type: 'copy_generation', id: generationId },
      )
      return { content: res.content, cost: res.cost }
    } catch (e) {
      lastErr = e as Error
      if (attempt >= retries) break
    }
  }
  throw lastErr ?? new Error('LLM 调用失败')
}

/* ── AI 变体（FR-G5 / AC-V1~V3）───────────────────────────────────── */

export interface VariantArgs {
  copyId: string
  draftId: string
  sectionIndex: number
  kinds?: string[]
  operator: string
}

export async function acceptVariant(args: VariantArgs): Promise<{ generationId: string }> {
  const db = getDb()
  const copy = await requireCopy(args.copyId, db)
  if (copy.status === 'archived') throw err.invalidState('该文案已归档，不可操作')
  if (copy.status === 'in_review') throw err.copyLocked()

  const draft = await db.get<Record<string, any>>(
    'SELECT * FROM `copy_draft` WHERE `id` = ? AND `copy_id` = ? AND `deleted_at` IS NULL',
    [args.draftId, args.copyId],
  )
  if (!draft) throw err.notFound('稿不存在')
  const sections = jdec<Section[]>(draft.sections, [])
  const idx = Number(args.sectionIndex ?? 0)
  if (!Number.isInteger(idx) || idx < 0 || idx >= sections.length) {
    throw err.badRequest('段落序号超出范围', { sectionIndex: idx, total: sections.length })
  }
  const kinds = (args.kinds?.length ? args.kinds : ['口语化', '专业型']).map((k) => String(k).slice(0, 32)).slice(0, 3)

  const persona = copy.personaId ? await getPersonaById(copy.personaId, true) : null
  if (!persona) throw err.badRequest('文案未绑定有效人物')

  const target = sections[idx]!
  const context = [
    draft.title ? `标题：${draft.title}` : '',
    ...sections.map((s, i) => (i === idx ? '' : `${s.label}：${s.text.slice(0, 60)}`)),
  ]
    .filter(Boolean)
    .join('\n')

  const styleId = (copy.settings as Record<string, string> | null)?.styleId
  const style = styleId ? await getStyle(styleId, db) : null
  const ip = persona.ipProfile
  const assembled = assembleVariantPrompt({
    persona: {
      name: persona.name,
      line: persona.line,
      role: ip.role,
      serviceScope: ip.serviceScope,
      targetAudience: ip.targetAudience,
      expressionStyle: ip.expressionStyle,
      forbiddenClaims: ip.forbiddenClaims,
      audienceNeeds: ip.audienceNeeds,
      factualBackground: ip.factualBackground,
      sampleScript: ip.sampleScript,
    },
    style: style?.enabled ? { name: style.name, prompt: style.prompt } : null,
    sectionLabel: target.label,
    sectionText: target.text,
    kinds,
    context,
    // 与整稿生成同口径：未显式填写时注入已确认的爆款特征偏好（无档案时为空串，行为不变）
    instructions: await injectedInstructions(),
  })

  const generationId = newId('gen')
  await insertGeneration(
    {
      id: generationId,
      copy_id: copy.id,
      draft_id: args.draftId,
      kind: 'variant',
      mode: copy.source,
      duration_tier: (copy.settings as Record<string, string> | null)?.durationTier ?? 'medium',
      count: kinds.length,
      target_section: idx,
      target_section_text: (target.label ?? '').slice(0, 60),
      persona_snapshot: {
        id: persona.id,
        name: persona.name,
        line: persona.line,
        ipProfile: persona.ipProfile,
        versionId: persona.currentVersionId ?? null,
      },
      persona_version_id: persona.currentVersionId ?? null,
      prompt_text: assembled.promptText,
      prompt_system: assembled.system,
      prompt_hash: assembled.promptHash,
      model: currentModelLabel(),
      status: 'pending',
      created_by: args.operator,
    },
    db,
  )

  await enqueueOrFail(generationId, 'variant')
  return { generationId }
}

export async function runVariant(generationId: string): Promise<void> {
  const db = getDb()
  const gen = await getGeneration(generationId, db)
  if (!gen || gen.status === 'done' || gen.status === 'failed') return
  await updateGeneration(generationId, { status: 'running' }, db)

  const copy = await getCopy(gen.copyId, db)
  if (!copy || !gen.draftId) {
    await updateGeneration(generationId, { status: 'failed', error: '目标稿已不存在', finished_at: toDb(utcNow()) }, db)
    return
  }
  const draft = await db.get<Record<string, any>>(
    'SELECT * FROM `copy_draft` WHERE `id` = ? AND `deleted_at` IS NULL',
    [gen.draftId],
  )
  if (!draft) {
    await updateGeneration(generationId, { status: 'failed', error: '目标稿已删除', finished_at: toDb(utcNow()) }, db)
    return
  }

  const sections = jdec<Section[]>(draft.sections, [])
  const idx = gen.targetSection ?? 0
  const target = sections[idx]
  const persona = copy.personaId ? await getPersonaById(copy.personaId, true) : null
  if (!target || !persona) {
    await updateGeneration(generationId, { status: 'failed', error: '段落或人物已失效', finished_at: toDb(utcNow()) }, db)
    return
  }
  const kindsLine = /【需要的变体类型】(.+)/.exec(gen.promptText ?? '')?.[1] ?? '1) 口语化  2) 专业型'
  const kinds = kindsLine
    .split(/\d\)\s*/)
    .map((s) => s.trim())
    .filter(Boolean)

  const textAtAccept =
    /--- 原始段落开始 ---\n([\s\S]*?)\n--- 原始段落结束 ---/.exec(gen.promptText ?? '')?.[1] ?? target.text

  let created = 0
  let cost = 0
  try {
    // P2-16：用受理时落库的 system / user 快照。老记录没有 prompt_system 时按旧方式拆分兜底
    const prompt = storedPrompt(gen) ?? {
      system: gen.promptText?.split('\n\n【本次任务】')[0] ?? '',
      user: gen.promptText?.split('【本次任务】')[1] ?? '',
    }
    const res = await callLlmWithRetry(prompt.system, prompt.user, generationId)
    cost += res.cost
    const variants = parseVariantJson(res.content) ?? []
    for (const v of variants) {
      await insertVariant(
        {
          copyId: copy.id,
          draftId: gen.draftId,
          generationId,
          sectionIndex: idx,
          // AC-V3 的比对基准是「受理时」的段落原文（即提示词里给模型看的那段），
          // 而不是执行时的文本，否则排队期间用户改了这段也比对不出来
          sectionTextAtGen: textAtAccept,
          kind: v.kind,
          text: v.text,
        },
        db,
      )
      created += 1
    }
    await updateGeneration(
      generationId,
      {
        status: created ? 'done' : 'failed',
        succeeded: created,
        failed: created ? 0 : kinds.length,
        cost,
        error: created ? null : '模型未返回可用变体',
        finished_at: toDb(utcNow()),
      },
      db,
    )
  } catch (e) {
    await updateGeneration(
      generationId,
      { status: 'failed', error: (e as Error).message, cost, finished_at: toDb(utcNow()) },
      db,
    )
  }
  // 变体生成**不改动稿内容**（AC-V1）
  await touchCopy(copy.id, db)
}

/* ── 应用变体（W5 / AC-V2 / AC-V3）────────────────────────────────── */

export async function applyVariant(
  variantId: string,
  mode: 'replace' | 'new_draft',
  confirmChanged: boolean,
  operator: string,
  confirmReedit = false,
): Promise<{ draftId: string; versionId: string; changed: boolean }> {
  const db = getDb()
  const { getVariant } = await import('./repo.js')
  const v = await getVariant(variantId, db)
  if (!v) throw err.notFound('变体不存在')
  if (v.appliedAt) throw err.invalidState('该变体已应用过')

  const copy = await requireCopy(v.copyId, db)
  if (copy.status === 'archived') throw err.invalidState('该文案已归档，不可操作')
  if (copy.status === 'in_review') throw err.copyLocked()
  // 替换会改动已通过文案的稿内容并降回草稿，与普通编辑一样须先确认（FR-R6）；另存新稿不改原稿，无需确认
  if (mode === 'replace') assertApprovedEditConfirmed(copy, confirmReedit)

  const draftRow = await db.get<Record<string, any>>(
    'SELECT * FROM `copy_draft` WHERE `id` = ? AND `deleted_at` IS NULL',
    [v.draftId],
  )
  if (!draftRow) throw err.notFound('目标稿已删除')
  const sections = jdec<Section[]>(draftRow.sections, [])
  const idx = v.sectionIndex
  if (!sections[idx]) throw err.invalidState('目标段落已不存在（稿结构已变化），请重新生成变体')

  // AC-V3：生成期间目标段被改过 → 需确认
  const changed = (sections[idx]!.text ?? '') !== (v.sectionTextAtGen ?? '')
  if (changed && !confirmChanged) {
    return { draftId: v.draftId, versionId: '', changed: true }
  }

  if (mode === 'new_draft') {
    const newSections = sections.map((s) => ({ ...s }))
    newSections[idx] = { ...newSections[idx]!, text: v.text }
    const wc = countSectionsWords(draftRow.title ?? null, newSections)
    const { id: newDraftId } = await insertDraft(
      {
        copyId: copy.id,
        title: draftRow.title ?? null,
        sections: newSections,
        plainText: toPlainText(draftRow.title ?? null, newSections),
        wordCount: wc,
        origin: 'variant',
        generationId: v.generationId,
        createdBy: operator,
        maxDrafts: config.copy.maxDrafts,
      },
      db,
    )
    const version = await insertVersion(
      {
        copyId: copy.id,
        draftId: newDraftId,
        title: draftRow.title ?? null,
        sections: newSections,
        plainText: toPlainText(draftRow.title ?? null, newSections),
        wordCount: wc,
        contentHash: contentHash(draftRow.title ?? null, newSections),
        origin: 'variant',
        createdBy: operator,
      },
      db,
    )
    await db.run('UPDATE `copy_draft` SET `latest_version_no` = ? WHERE `id` = ?', [version.versionNo, newDraftId])
    await db.run('UPDATE `copy_variant` SET `applied_at` = ?, `applied_version_id` = ? WHERE `id` = ?', [
      toDb(utcNow()),
      version.id,
      variantId,
    ])
    await updateCopy(copy.id, { current_draft_id: newDraftId, updated_at: toDb(utcNow()) }, db)
    await recordOperation({
      operator,
      action: 'copy.variant_apply',
      targetType: 'copy',
      targetId: copy.id,
      detail: { variantId, mode, newDraftId, versionNo: version.versionNo },
    })
    return { draftId: newDraftId, versionId: version.id, changed: false }
  }

  // replace：替换目标段并产生新版本
  const nextSections = sections.map((s, i) => (i === idx ? { ...s, text: v.text } : { ...s }))
  const rev = Number(draftRow.rev ?? 0)
  const wc = countSectionsWords(draftRow.title ?? null, nextSections)
  // P1-12：必须检查乐观锁结果。之前 affectedRows=0（期间自动保存把 rev 改了）也照样往下走，
  // 结果写入了变体版本并把变体标为已应用，但稿内容没变，版本内容与稿内容不一致。
  const w = await db.run(
    `UPDATE \`copy_draft\` SET \`sections\` = ?, \`plain_text\` = ?, \`word_count\` = ?, \`rev\` = \`rev\` + 1, \`updated_at\` = ?
     WHERE \`id\` = ? AND \`rev\` = ?`,
    [
      jenc(nextSections),
      toPlainText(draftRow.title ?? null, nextSections),
      wc,
      toDb(utcNow()),
      v.draftId,
      rev,
    ],
  )
  if (!w.affectedRows) {
    throw err.conflict('稿件已被修改（rev 已变化），请刷新后重新应用该变体', {
      draftId: v.draftId,
      expectedRev: rev,
    })
  }
  const version = await insertVersion(
    {
      copyId: copy.id,
      draftId: v.draftId,
      title: draftRow.title ?? null,
      sections: nextSections,
      plainText: toPlainText(draftRow.title ?? null, nextSections),
      wordCount: wc,
      contentHash: contentHash(draftRow.title ?? null, nextSections),
      origin: 'variant',
      createdBy: operator,
    },
    db,
  )
  await db.run('UPDATE `copy_draft` SET `latest_version_no` = ? WHERE `id` = ?', [version.versionNo, v.draftId])
  await db.run('UPDATE `copy_variant` SET `applied_at` = ?, `applied_version_id` = ? WHERE `id` = ?', [
    toDb(utcNow()),
    version.id,
    variantId,
  ])
  if (copy.status === 'approved') {
    const { downgradeApprovedToDraft } = await import('./service.js')
    await downgradeApprovedToDraft(copy, operator, db)
  }
  await touchCopy(copy.id, db)
  await recordOperation({
    operator,
    action: 'copy.variant_apply',
    targetType: 'copy',
    targetId: copy.id,
    detail: { variantId, mode, draftId: v.draftId, versionNo: version.versionNo },
  })
  return { draftId: v.draftId, versionId: version.id, changed: false }
}
