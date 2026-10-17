import { getDb, insertIgnore } from '../../db/index.js'
import { newId, parsePaging, pageResult, type PageResult } from '../../lib/util.js'
import { toDb, utcNow, fromDb } from '../../lib/time.js'
import { CATEGORIES, type Category } from './classify.js'
import type { NewsDTO } from './providers.js'
import { hashUrl } from './providers.js'

export interface NewsItemOut {
  id: string
  externalId: string
  source: string
  category: Category
  title: string
  summary: string | null
  contentUrl: string | null
  imageUrl: string | null
  publishedAt: string | null
  fetchedAt: string | null
}

function map(r: Record<string, any>): NewsItemOut {
  return {
    id: r.id,
    externalId: r.external_id,
    source: r.source,
    category: (r.category ?? '其他') as Category,
    title: r.title,
    summary: r.summary ?? null,
    contentUrl: r.content_url ?? null,
    imageUrl: r.image_url ?? null,
    publishedAt: fromDb(r.published_at),
    fetchedAt: fromDb(r.fetched_at),
  }
}

/** FR-N2 去重：UNIQUE(source, external_id) 优先 + url_hash 兜底，重复采集零增量 */
export async function insertNews(dto: NewsDTO, category: Category): Promise<boolean> {
  const db = getDb()
  const published = dto.publishedAt ? new Date(dto.publishedAt as any) : utcNow()
  const safePublished = Number.isNaN(published.getTime()) ? utcNow() : published
  const urlHash = hashUrl(dto.source, dto.contentUrl ?? null, dto.title, safePublished)
  return insertIgnore(db, 'news_item', {
    id: newId('news'),
    external_id: String(dto.externalId),
    source: dto.source,
    category,
    title: String(dto.title).slice(0, 500),
    summary: dto.summary ?? null,
    content_url: dto.contentUrl ?? null,
    image_url: dto.imageUrl ?? null,
    published_at: toDb(safePublished),
    fetched_at: toDb(utcNow()),
    url_hash: urlHash,
  })
}

export async function listNews(q: Record<string, unknown>): Promise<PageResult<NewsItemOut>> {
  const db = getDb()
  const p = parsePaging(q, 20, 100)
  const where: string[] = []
  const params: unknown[] = []
  if (q.category && q.category !== 'all') {
    where.push('`category` = ?')
    params.push(String(q.category))
  }
  if (q.source) {
    where.push('`source` = ?')
    params.push(String(q.source))
  }
  if (q.keyword) {
    const kw = `%${String(q.keyword)}%`
    where.push('(`title` LIKE ? OR `summary` LIKE ?)')
    params.push(kw, kw)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM \`news_item\` ${whereSql}`, params))?.c ?? 0
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`news_item\` ${whereSql} ORDER BY \`published_at\` DESC LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  )
  return pageResult(rows.map(map), total, p)
}

/** FR-N3 分类计数 + 来源清单 */
export async function newsCategories(): Promise<{
  all: number
  items: Array<{ key: string; count: number }>
  sources: string[]
}> {
  const db = getDb()
  const total = (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM `news_item`'))?.c ?? 0
  const rows = await db.all<{ category: string; c: number }>(
    'SELECT `category`, COUNT(*) AS c FROM `news_item` GROUP BY `category`',
  )
  const countMap = new Map(rows.map((r) => [r.category, Number(r.c)]))
  const items = [{ key: 'all', count: total }]
  for (const c of CATEGORIES) items.push({ key: c, count: countMap.get(c) ?? 0 })
  const srcRows = await db.all<{ source: string }>('SELECT DISTINCT `source` FROM `news_item` ORDER BY `source`')
  return { all: total, items, sources: srcRows.map((r) => r.source) }
}

export async function getNewsByIds(ids: string[]): Promise<NewsItemOut[]> {
  if (!ids.length) return []
  const db = getDb()
  const ph = ids.map(() => '?').join(', ')
  const rows = await db.all<Record<string, any>>(`SELECT * FROM \`news_item\` WHERE \`id\` IN (${ph})`, ids)
  return rows.map(map)
}
