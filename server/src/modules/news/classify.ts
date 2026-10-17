import { getDb } from '../../db/index.js'
import { logger } from '../../log.js'

export const CATEGORIES = ['市场', '政策', '行业', '基金', '其他'] as const
export type Category = (typeof CATEGORIES)[number]

interface Rule {
  category: Category
  keyword: string
  priority: number
}

let cache: Rule[] | null = null
let cachedAt = 0
const TTL_MS = 60_000

/** 规则来自 news_category_rule 配置表（FR-N2：规则可维护） */
export async function loadRules(force = false): Promise<Rule[]> {
  if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache
  const db = getDb()
  const rows = await db.all<{ category: string; keyword: string; priority: number }>(
    'SELECT `category`, `keyword`, `priority` FROM `news_category_rule` WHERE `enabled` = 1 ORDER BY `priority` DESC',
  )
  cache = rows.map((r) => ({ category: r.category as Category, keyword: r.keyword, priority: r.priority }))
  cachedAt = Date.now()
  return cache
}

export function classifyWith(rules: Rule[], text: string): Category {
  const t = (text || '').toLowerCase()
  for (const r of rules) {
    if (t.includes(r.keyword.toLowerCase())) return r.category
  }
  return '其他'
}

/** 主分类唯一：按规则优先级取首个命中 */
export async function classify(title: string, summary?: string | null): Promise<Category> {
  try {
    const rules = await loadRules()
    return classifyWith(rules, `${title} ${summary ?? ''}`)
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'news.classify_failed')
    return '其他'
  }
}

/** 手动维护规则后调用以刷新缓存 */
export function invalidateRules(): void {
  cache = null
  cachedAt = 0
}
