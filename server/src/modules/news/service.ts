import { enabledProviders } from './providers.js'
import { classify } from './classify.js'
import { insertNews } from './repo.js'
import { logApiCall } from '../metrics/call-log.js'
import { Mutex } from '../../lib/util.js'
import { logger } from '../../log.js'

export interface SourceResult {
  source: string
  ok: boolean
  count: number
  error?: string
}
export interface FetchOutcome {
  fetched: number
  inserted: number
  bySource: SourceResult[]
}

const mutex = new Mutex('news-fetch')

/** 单源失败不影响其他源（FR-N1） */
export async function fetchAndStore(): Promise<FetchOutcome> {
  const list = enabledProviders()
  const bySource: SourceResult[] = []
  let fetched = 0
  let inserted = 0

  await Promise.all(
    list.map(async (p) => {
      const started = Date.now()
      try {
        const items = await p.fetchLatest()
        let count = 0
        for (const dto of items) {
          if (!dto?.title || !dto?.externalId) continue
          const category = await classify(dto.title, dto.summary)
          const okInsert = await insertNews(dto, category)
          if (okInsert) count++
        }
        fetched += items.length
        inserted += count
        bySource.push({ source: p.label, ok: true, count })
        await logApiCall({
          provider: 'news',
          endpoint: p.name,
          ok: true,
          durationMs: Date.now() - started,
          cost: 0,
        })
        logger.info({ provider: p.name, got: items.length, inserted: count }, 'news.fetch')
      } catch (e) {
        const msg = (e as Error).message || '采集失败'
        bySource.push({ source: p.label, ok: false, count: 0, error: msg })
        await logApiCall({
          provider: 'news',
          endpoint: p.name,
          ok: false,
          durationMs: Date.now() - started,
          error: msg,
          cost: 0,
        })
        logger.error({ provider: p.name, err: msg }, 'news.fetch_failed')
      }
    }),
  )
  return { fetched, inserted, bySource }
}

/** 带互斥：手动刷新与 15min 定时任务不并发（P2-8）。返回 null 表示已有任务在执行 */
export async function runFetchExclusive(): Promise<FetchOutcome | null> {
  return mutex.run('fetch', fetchAndStore, () => null)
}

/**
 * 排队版：手动刷新用。
 * 若定时任务正在采集，本次请求排队等待（最多 waitMs），拿到锁后立即执行一次采集。
 * 与 runFetchExclusive 的区别只在「忙时行为」：前者立刻返回 null，这里会等。
 */
export async function runFetchQueued(waitMs = 180_000): Promise<FetchOutcome | null> {
  return mutex.runQueued('fetch', fetchAndStore, waitMs, () => null)
}
