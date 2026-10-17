import { getDb, upsert } from '../../db/index.js'
import { jdec, jenc, newId, parsePaging, pageResult, type PageResult } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'

export type TopicSource = 'news' | 'benchmark' | 'manual' | 'article' | 'feedback'
export type TopicStatus = 'candidate' | 'assigned' | 'sent' | 'archived'

export interface TopicRow {
  id: string
  source: TopicSource
  sourceId: string | null
  title: string
  direction: string | null
  hook: string | null
  rationale: string | null
  personaIds: string[]
  status: TopicStatus
  batchId: string | null
  newsTitle: string | null
  sentAt: string | null
  createdBy: string | null
  createdAt: string | null
}

function mapTopic(r: Record<string, any>): TopicRow {
  return {
    id: r.id,
    source: r.source,
    sourceId: r.source_id ?? null,
    title: r.title,
    direction: r.direction ?? null,
    hook: r.hook ?? null,
    rationale: r.rationale ?? null,
    personaIds: jdec<string[]>(r.persona_ids, []),
    status: r.status,
    batchId: r.batch_id ?? null,
    newsTitle: r.news_title ?? null,
    sentAt: fromDb(r.sent_at),
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
  }
}

/* ── FR-C1 状态机 ─────────────────────────────────────────────────── */
const ALLOWED: Record<TopicStatus, TopicStatus[]> = {
  candidate: ['assigned', 'archived'],
  assigned: ['sent', 'archived'],
  sent: ['archived'],
  archived: [],
}

/**
 * 分来源规则：
 * ① news/manual/article 必须经 assigned 才能 sent；
 * ② benchmark 由 FR-B7 原子创建即为 sent（不经 candidate/assigned），不算非法跳变。
 */
export function assertTransition(current: TopicStatus, next: TopicStatus, source: TopicSource): void {
  if (current === next) return
  if (source === 'benchmark' && current === 'sent') {
    throw err.invalidState('benchmark 来源选题已送入文案工坊，不可变更')
  }
  if (!ALLOWED[current]?.includes(next)) {
    throw err.invalidState(`非法状态跳变：${current} → ${next}（来源 ${source}）`)
  }
}

export async function getTopic(id: string, db = getDb()): Promise<TopicRow | null> {
  const r = await db.get<Record<string, any>>(
    `SELECT t.*, n.\`title\` AS news_title
     FROM \`topic\` t LEFT JOIN \`news_item\` n ON n.\`id\` = t.\`source_id\`
     WHERE t.\`id\` = ?`,
    [id],
  )
  return r ? mapTopic(r) : null
}

export async function getTopicsByIds(ids: string[], db = getDb()): Promise<TopicRow[]> {
  if (!ids.length) return []
  const ph = ids.map(() => '?').join(', ')
  const rows = await db.all<Record<string, any>>(
    `SELECT t.*, n.\`title\` AS news_title
     FROM \`topic\` t LEFT JOIN \`news_item\` n ON n.\`id\` = t.\`source_id\`
     WHERE t.\`id\` IN (${ph})`,
    ids,
  )
  return rows.map(mapTopic)
}

export async function listTopics(q: Record<string, unknown>): Promise<PageResult<TopicRow>> {
  const db = getDb()
  const p = parsePaging(q, 20, 100)
  const where: string[] = []
  const params: unknown[] = []
  if (q.status) {
    where.push('t.`status` = ?')
    params.push(String(q.status))
  }
  if (q.source) {
    where.push('t.`source` = ?')
    params.push(String(q.source))
  }
  if (q.batchId) {
    where.push('t.`batch_id` = ?')
    params.push(String(q.batchId))
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total =
    (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM \`topic\` t ${whereSql}`, params))?.c ?? 0
  const rows = await db.all<Record<string, any>>(
    `SELECT t.*, n.\`title\` AS news_title
     FROM \`topic\` t LEFT JOIN \`news_item\` n ON n.\`id\` = t.\`source_id\`
     ${whereSql} ORDER BY t.\`created_at\` DESC LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  )
  return pageResult(rows.map(mapTopic), total, p)
}

export interface CreateTopicInput {
  source: TopicSource
  sourceId?: string | null
  title: string
  direction?: string | null
  hook?: string | null
  rationale?: string | null
  personaIds?: string[]
  status?: TopicStatus
  batchId?: string | null
  createdBy?: string | null
}

export async function createTopic(input: CreateTopicInput, db = getDb()): Promise<TopicRow> {
  const id = newId('topic')
  const status = input.status ?? 'candidate'
  if (input.source === 'benchmark' && status !== 'sent') {
    throw err.invalidState('benchmark 来源选题只能由送入接口原子创建为 sent')
  }
  if (input.source !== 'benchmark' && status === 'sent') {
    throw err.invalidState('非 benchmark 来源选题必须经 assigned 后由送入接口置为 sent')
  }
  await db.run(
    `INSERT INTO \`topic\` (\`id\`, \`source\`, \`source_id\`, \`title\`, \`direction\`, \`hook\`, \`rationale\`, \`persona_ids\`, \`status\`, \`batch_id\`, \`created_by\`, \`created_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.source,
      input.sourceId ?? null,
      String(input.title).slice(0, 500),
      input.direction ?? null,
      input.hook ?? null,
      input.rationale ?? null,
      jenc(input.personaIds ?? []),
      status,
      input.batchId ?? null,
      input.createdBy ?? null,
      toDb(utcNow()),
    ],
  )
  return (await getTopic(id, db))!
}

export async function setTopicStatus(id: string, next: TopicStatus, db = getDb()): Promise<TopicRow> {
  const t = await getTopic(id, db)
  if (!t) throw err.notFound('选题不存在')
  assertTransition(t.status, next, t.source)
  // 条件更新：读到的状态在写入前被并发送入 / 归档改掉时，不覆盖对方的结果
  const r = await db.run('UPDATE `topic` SET `status` = ? WHERE `id` = ? AND `status` = ?', [next, id, t.status])
  if (!r.affectedRows) throw err.invalidState('选题状态已变化，请刷新后重试', { topicId: id })
  const fresh = await getTopic(id, db)
  return fresh!
}

/** 分配人物：sent 后不可再改分配（FR-C1） */
export async function assignPersonas(id: string, personaIds: string[], db = getDb()): Promise<TopicRow> {
  const t = await getTopic(id, db)
  if (!t) throw err.notFound('选题不存在')
  if (t.status === 'sent') throw err.invalidState('选题已送入文案工坊，不可再改分配')
  if (t.status === 'archived') throw err.invalidState('已归档选题不可再改分配')
  // 条件更新：与「送入 / 归档」并发时，只有仍处于 candidate/assigned 才写入
  const r = await db.run(
    "UPDATE `topic` SET `persona_ids` = ?, `status` = ? WHERE `id` = ? AND `status` IN ('candidate', 'assigned')",
    [jenc(personaIds), personaIds.length ? 'assigned' : 'candidate', id],
  )
  if (!r.affectedRows) throw err.invalidState('选题已送入或归档，不可再改分配', { topicId: id })
  return (await getTopic(id, db))!
}

export async function markSent(id: string, db = getDb()): Promise<void> {
  await db.run('UPDATE `topic` SET `status` = ?, `sent_at` = ? WHERE `id` = ?', ['sent', toDb(utcNow()), id])
}

export async function archiveTopic(id: string, db = getDb()): Promise<TopicRow> {
  return setTopicStatus(id, 'archived', db)
}

/* ── 批次 ─────────────────────────────────────────────────────────── */
export interface BatchRow {
  id: string
  newsIds: string[]
  personaIds: string[]
  countPer: number
  templateId: string | null
  status: 'running' | 'done' | 'failed'
  llmCost: number
  expected: number
  produced: number
  error: string | null
  createdBy: string | null
  createdAt: string | null
  finishedAt: string | null
}

export async function createBatch(input: {
  newsIds: string[]
  personaIds: string[]
  countPer: number
  templateId?: string | null
  createdBy?: string | null
}, db = getDb()): Promise<BatchRow> {
  const id = newId('batch')
  const expected = input.newsIds.length * input.personaIds.length * input.countPer
  await db.run(
    `INSERT INTO \`topic_generation_batch\` (\`id\`, \`news_ids\`, \`persona_ids\`, \`count_per\`, \`template_id\`, \`status\`, \`expected\`, \`produced\`, \`created_by\`, \`created_at\`)
     VALUES (?, ?, ?, ?, ?, 'running', ?, 0, ?, ?)`,
    [
      id,
      jenc(input.newsIds),
      jenc(input.personaIds),
      input.countPer,
      input.templateId ?? null,
      expected,
      input.createdBy ?? null,
      toDb(utcNow()),
    ],
  )
  return (await getBatch(id, db))!
}

export async function getBatch(id: string, db = getDb()): Promise<BatchRow | null> {
  const r = await db.get<Record<string, any>>('SELECT * FROM `topic_generation_batch` WHERE `id` = ?', [id])
  if (!r) return null
  return {
    id: r.id,
    newsIds: jdec<string[]>(r.news_ids, []),
    personaIds: jdec<string[]>(r.persona_ids, []),
    countPer: Number(r.count_per ?? 0),
    templateId: r.template_id ?? null,
    status: r.status,
    llmCost: Number(r.llm_cost ?? 0),
    expected: Number(r.expected ?? 0),
    produced: Number(r.produced ?? 0),
    error: r.error ?? null,
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    finishedAt: fromDb(r.finished_at),
  }
}

export async function addBatchCost(id: string, cost: number, db = getDb()): Promise<void> {
  await db.run('UPDATE `topic_generation_batch` SET `llm_cost` = `llm_cost` + ? WHERE `id` = ?', [cost, id])
}

export async function bumpBatchProduced(id: string, n: number, db = getDb()): Promise<void> {
  await db.run('UPDATE `topic_generation_batch` SET `produced` = `produced` + ? WHERE `id` = ?', [n, id])
}

export async function finishBatch(
  id: string,
  status: 'done' | 'failed',
  error?: string | null,
  db = getDb(),
): Promise<void> {
  await db.run('UPDATE `topic_generation_batch` SET `status` = ?, `error` = ?, `finished_at` = ? WHERE `id` = ?', [
    status,
    error ?? null,
    toDb(utcNow()),
    id,
  ])
}

/* ── 提示词模板（FR-C2） ──────────────────────────────────────────── */
export interface TemplateRow {
  id: string
  name: string
  content: string
  isDefault: boolean
  builtin: string | null
  createdBy: string | null
  updatedAt: string | null
}

function mapTemplate(r: Record<string, any>): TemplateRow {
  return {
    id: r.id,
    name: r.name,
    content: r.content,
    isDefault: !!r.is_default,
    builtin: r.builtin ?? null,
    createdBy: r.created_by ?? null,
    updatedAt: fromDb(r.updated_at),
  }
}

export async function listTemplates(): Promise<TemplateRow[]> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT * FROM `topic_prompt_template` ORDER BY `is_default` DESC, `name`',
  )
  return rows.map(mapTemplate)
}

export async function getTemplate(id: string): Promise<TemplateRow | null> {
  const db = getDb()
  const r = await db.get<Record<string, any>>('SELECT * FROM `topic_prompt_template` WHERE `id` = ?', [id])
  return r ? mapTemplate(r) : null
}

export async function getDefaultTemplate(): Promise<TemplateRow | null> {
  const db = getDb()
  const r = await db.get<Record<string, any>>(
    'SELECT * FROM `topic_prompt_template` WHERE `is_default` = 1 ORDER BY `updated_at` DESC LIMIT 1',
  )
  return r ? mapTemplate(r) : null
}

/** 默认模板全局唯一 */
async function clearDefaultExcept(id: string | null, db = getDb()): Promise<void> {
  if (id) await db.run('UPDATE `topic_prompt_template` SET `is_default` = 0 WHERE `id` <> ?', [id])
  else await db.run('UPDATE `topic_prompt_template` SET `is_default` = 0')
}

export async function createTemplate(input: {
  name: string
  content: string
  isDefault?: boolean
  createdBy?: string | null
}, db = getDb()): Promise<TemplateRow> {
  const id = newId('tpl')
  await db.run(
    `INSERT INTO \`topic_prompt_template\` (\`id\`, \`name\`, \`content\`, \`is_default\`, \`created_by\`, \`created_at\`, \`updated_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      String(input.name).slice(0, 128),
      input.content,
      input.isDefault ? 1 : 0,
      input.createdBy ?? null,
      toDb(utcNow()),
      toDb(utcNow()),
    ],
  )
  if (input.isDefault) await clearDefaultExcept(id, db)
  return (await getTemplate(id))!
}

export async function updateTemplate(
  id: string,
  patch: { name?: string; content?: string; isDefault?: boolean },
  db = getDb(),
): Promise<TemplateRow> {
  const t = await getTemplate(id)
  if (!t) throw err.notFound('模板不存在')
  await db.run(
    'UPDATE `topic_prompt_template` SET `name` = ?, `content` = ?, `is_default` = ?, `updated_at` = ? WHERE `id` = ?',
    [
      patch.name ?? t.name,
      patch.content ?? t.content,
      patch.isDefault === undefined ? (t.isDefault ? 1 : 0) : patch.isDefault ? 1 : 0,
      toDb(utcNow()),
      id,
    ],
  )
  if (patch.isDefault) await clearDefaultExcept(id, db)
  return (await getTemplate(id))!
}

/**
 * P1-6③：删除保护。
 * 删掉内置模板或默认模板后，批次会退回到兜底提示词（历史上那句不含合规约束的话），
 * 相当于悄悄降低了合规底线。内置模板与默认模板一律禁止删除。
 */
export async function deleteTemplate(id: string, db = getDb()): Promise<void> {
  const t = await db.get<Record<string, any>>('SELECT * FROM `topic_prompt_template` WHERE `id` = ?', [id])
  if (!t) throw err.notFound('模板不存在')
  if (t.builtin) throw err.invalidState('内置模板不可删除，可复制一份后再修改', { id, builtin: t.builtin })
  if (Number(t.is_default ?? 0) === 1) {
    throw err.invalidState('默认模板不可删除，请先把其他模板设为默认', { id })
  }
  await db.run('DELETE FROM `topic_prompt_template` WHERE `id` = ?', [id])
}
