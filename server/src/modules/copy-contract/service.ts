import { getDb, type Db } from '../../db/index.js'
import { newId, jdec } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { getTopicsByIds, markSent, type TopicRow } from '../topics/repo.js'
import { logger } from '../../log.js'
import { assertPersonasUsable } from '../personas/repo.js'

export interface CreateDraftsArgs {
  topicIds: string[]
  personaIds?: string[]
  operator?: string
  /** 传入即在同一事务内执行（FR-B7 原子创建） */
  db?: Db
  /**
   * FR-B7 专用：调用方已在同事务内把 topic 建为 sent（FR-C1②），
   * 此处仍需按 topic × persona 展开草稿，不能走「已送过」的短路分支。
   */
  alreadySent?: boolean
}

export interface CreateDraftsResult {
  created: number
  copyIds: string[]
  skipped: string[]
}

/**
 * FR-C3 文案工坊契约（服务端唯一出口实现）。
 * 规则：
 *  - 按 topic × persona 展开创建 copy 草稿；
 *  - personaIds 不传则用 topic 已分配人物，无人物则拒绝；
 *  - copy.source = topic.source，copy.topic_id 回链，写入 source_text / source_ref_* / extract_cache_id；
 *  - topic 状态 → sent。
 */
export async function createDraftsFromTopics(args: CreateDraftsArgs): Promise<CreateDraftsResult> {
  const db = args.db ?? getDb()
  const topics = await getTopicsByIds(args.topicIds, db)
  if (!topics.length) throw err.notFound('未找到任何选题')

  const now = toDb(utcNow())

  // P1-4①：先整体校验所有选题，避免「第 1 条已建 copy、第 2 条抛 409」的部分送入。
  for (const topic of topics) {
    if (topic.status === 'sent' && !args.alreadySent) continue
    if (topic.status === 'candidate') {
      throw err.invalidState(`选题「${topic.title}」尚未分配人物，不能送入文案工坊`, { topicId: topic.id })
    }
    if (topic.status === 'archived') {
      throw err.invalidState(`选题「${topic.title}」已归档，不能送入文案工坊`, { topicId: topic.id })
    }
    const pids = args.personaIds?.length ? args.personaIds : topic.personaIds
    if (!pids?.length) {
      throw err.badRequest(`选题「${topic.title}」没有分配人物，请先分配后再送入`, { topicId: topic.id })
    }
    await assertPersonasUsable(pids)
  }

  const copyIds: string[] = []
  const skipped: string[] = []

  for (const topic of topics) {
    if (topic.status === 'sent' && !args.alreadySent) {
      skipped.push(topic.id)
      continue
    }

    const personaIds = args.personaIds?.length ? args.personaIds : topic.personaIds
    if (!personaIds?.length) continue // 已在预校验阶段拦截，这里只为类型收窄

    // P1-4②：并发保护——用条件更新占位，只有真正把 status 改成 sent 的那一个请求才展开 copy。
    // alreadySent 表示调用方已在本事务内建成 sent，此时不需要再更新（也不能命中）。
    if (!args.alreadySent) {
      const claim = await db.run(
        "UPDATE `topic` SET `status` = 'sent', `sent_at` = ? WHERE `id` = ? AND `status` = 'assigned'",
        [now, topic.id],
      )
      if (!claim.affectedRows) {
        // 另一个请求刚刚把它送走了，本次跳过（不重复建 copy）
        skipped.push(topic.id)
        continue
      }
    }

    const { sourceText, refType, refId, extractCacheId } = await resolveSource(topic, db)

    for (const personaId of personaIds) {
      const id = newId('copy')
      // line 由人物所属线派生写入：风格按线过滤（Q4）与列表按线筛选都依赖它。
      // copy-contract 不感知 persona 模块的领域细节，这里只取一个字段，保持契约稳定。
      const line =
        (await db.get<{ line: string | null }>('SELECT `line` FROM `persona` WHERE `id` = ?', [personaId]))?.line ?? null
      await db.run(
        `INSERT INTO \`copy\` (\`id\`, \`topic_id\`, \`persona_id\`, \`source\`, \`status\`, \`title\`, \`source_text\`, \`source_ref_type\`, \`source_ref_id\`, \`extract_cache_id\`, \`line\`, \`created_by\`, \`created_at\`)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          topic.id,
          personaId,
          topic.source,
          topic.title,
          sourceText,
          refType,
          refId,
          extractCacheId,
          line,
          args.operator ?? topic.createdBy ?? null,
          now,
        ],
      )
      copyIds.push(id)
    }
    // alreadySent 时调用方已在本事务内建成 sent；否则上面已用条件更新落库
    if (args.alreadySent) await markSent(topic.id, db)
    logger.info({ topicId: topic.id, personas: personaIds.length, copies: personaIds.length }, 'copy.drafts_created')
  }

  // P1-10：初始空白稿**不在本函数内创建**。
  // 本函数常在调用方的 db.tx 作用域内被调用，而 createDraft 用的是全局 getDb()：
  //  - SQLite 同连接 → 在事务里建出第 1 份稿，调用方提交后又在事务外建第 2 份（实测每条文案 2 份空白稿）；
  //  - MySQL 另一连接 → 看不到未提交的 copy，requireCopy 报 not found 被吞成 warn（对标送入没有初始稿）。
  // 改为只返回 copyIds，由调用方在事务提交后统一调用 createInitialDrafts(copyIds)。
  return { created: copyIds.length, copyIds, skipped }
}

/**
 * 为送入后的 copy 各建一份空白初始稿（FR-E4）。
 * 必须在事务**提交之后**调用，且只调用一次。
 */
export async function createInitialDrafts(copyIds: string[], operator?: string): Promise<void> {
  if (!copyIds.length) return
  // 用动态导入避免 copy-contract → copy 的静态循环依赖。
  const { createDraft } = await import('../copy/service.js')
  for (const id of copyIds) {
    await createDraft(id, null, operator ?? 'system').catch((e) => {
      logger.warn({ copyId: id, err: (e as Error).message }, 'copy.initial_draft_failed')
    })
  }
}

async function resolveSource(
  topic: TopicRow,
  db: Db,
): Promise<{ sourceText: string | null; refType: string | null; refId: string | null; extractCacheId: string | null }> {
  if (topic.source === 'news' && topic.sourceId) {
    const news = await db.get<{ title: string; summary: string | null }>(
      'SELECT `title`, `summary` FROM `news_item` WHERE `id` = ?',
      [topic.sourceId],
    )
    return {
      sourceText: [news?.title, news?.summary].filter(Boolean).join('\n') || null,
      refType: 'news_item',
      refId: topic.sourceId,
      extractCacheId: null,
    }
  }
  if (topic.source === 'benchmark' && topic.sourceId) {
    const v = await db.get<{ platform: string; video_id: string; title: string }>(
      'SELECT `platform`, `video_id`, `title` FROM `benchmark_video` WHERE `id` = ?',
      [topic.sourceId],
    )
    const cache = v
      ? await db.get<{ id: string; text: string | null }>(
          'SELECT `id`, `text` FROM `script_extract_cache` WHERE `platform` = ? AND `video_id` = ?',
          [v.platform, v.video_id],
        )
      : null
    return {
      sourceText: cache?.text ?? v?.title ?? null,
      refType: 'benchmark_video',
      refId: topic.sourceId,
      extractCacheId: cache?.id ?? null,
    }
  }
  return { sourceText: null, refType: null, refId: topic.sourceId ?? null, extractCacheId: null }
}

/** 供列表页展示：某 topic 已生成多少 copy */
export async function countCopiesByTopic(topicIds: string[]): Promise<Record<string, number>> {
  if (!topicIds.length) return {}
  const db = getDb()
  const ph = topicIds.map(() => '?').join(', ')
  const rows = await db.all<{ topic_id: string; c: number }>(
    `SELECT \`topic_id\`, COUNT(*) AS c FROM \`copy\` WHERE \`topic_id\` IN (${ph}) GROUP BY \`topic_id\``,
    topicIds,
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.topic_id] = Number(r.c)
  return out
}
