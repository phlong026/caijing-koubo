import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { getNewsById, listNews, newsCategories } from './repo.js'
import { runFetchExclusive, runFetchQueued } from './service.js'
import { nextFetchAt } from './jobs.js'
import { recordOperation } from '../audit/repo.js'
import { getDb } from '../../db/index.js'
import { newId } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { invalidateRules, loadRules } from './classify.js'
import { err } from '../../errors.js'
import { sleep } from '../../lib/util.js'

const MANUAL_TIMEOUT_MS = 12_000
/**
 * 手动刷新最长排队时间。
 * 采集接入 FinStep 后单轮 60~90s（两个源各一次 LLM ReAct），12s 的同步窗口必然超时。
 * 这里允许手动请求**排队**等前一轮跑完再执行，最多等 3 分钟，超时才转异步。
 */
const MANUAL_QUEUE_WAIT_MS = 180_000

export function registerNewsRoutes(app: FastifyInstance): void {
  /** FR-N3 列表检索 */
  app.get('/news', async (req) => ok(await listNews((req.query ?? {}) as Record<string, unknown>)))

  /** FR-N3 分类计数 + 来源清单 */
  app.get('/news/categories', async () => ok(await newsCategories()))

  /**
   * FR-N3 单条资讯详情 —— 前端点击标题打开详情的入口。
   *
   * 路由冲突说明：本路由与 `/news/categories`、`/news/rules` 同为 `/news/*` 前缀。
   * Fastify 底层 find-my-way 的 radix tree 会让**静态段优先于参数段**，
   * 因此 categories / rules 不会被 `:id` 吃掉，注册顺序无关（已实测三者并存正常）。
   * 这里仍紧跟在 categories 之后，是为了让相关路由在手读时聚在一起。
   */
  app.get('/news/:id', async (req) => {
    const { id } = req.params as { id: string }
    const item = await getNewsById(id)
    if (!item) throw err.notFound('资讯不存在或已被清理')
    return ok(item)
  })

  /** FR-N3 手动刷新：立即采集并返回本次增量（超时转异步，P2-8） */
  app.post('/news/refresh', async (req, reply) => {
    const operator = req.operator
    // 用排队语义：若定时任务正在采集，本次请求排队等它结束再跑，而不是立刻返回 busy。
    // 12s 内跑完就同步返回；跑不完返回 202，但后台仍在继续（不取消）。
    const outcome = await Promise.race([
      runFetchQueued(MANUAL_QUEUE_WAIT_MS),
      sleep(MANUAL_TIMEOUT_MS).then(() => 'timeout' as const),
    ])
    const nextAt = await nextFetchAt().catch(() => null)
    await recordOperation({ operator, action: 'news.refresh', targetType: 'news' })

    if (outcome === 'timeout') {
      return reply.status(202).send(
        ok({
          status: 'running',
          fetched: 0,
          inserted: 0,
          bySource: [],
          nextRunAt: nextAt ? new Date(nextAt).toISOString() : null,
          message: '采集耗时较长，已在后台继续，稍后刷新列表',
        }),
      )
    }
    if (outcome === null) {
      return reply.status(202).send(
        ok({
          status: 'busy',
          fetched: 0,
          inserted: 0,
          bySource: [],
          nextRunAt: nextAt ? new Date(nextAt).toISOString() : null,
          message: '采集队列繁忙，请稍后重试',
        }),
      )
    }
    return reply.send(ok({ status: 'done', ...outcome, nextRunAt: nextAt ? new Date(nextAt).toISOString() : null }))
  })

  /** FR-N2 分类规则维护（配置表） */
  app.get('/news/rules', async () => ok(await loadRules(true)))

  app.post('/news/rules', async (req, reply) => {
    const body = (req.body ?? {}) as { category?: string; keyword?: string; priority?: number }
    if (!body.category || !body.keyword) throw err.badRequest('category 与 keyword 必填')
    const db = getDb()
    await db.run(
      'INSERT INTO `news_category_rule` (`id`, `category`, `keyword`, `priority`, `enabled`, `created_at`) VALUES (?, ?, ?, ?, 1, ?)',
      [newId('rule'), String(body.category), String(body.keyword), Number(body.priority ?? 10), toDb(utcNow())],
    )
    invalidateRules()
    await recordOperation({
      operator: req.operator,
      action: 'news.rule.add',
      targetType: 'news_rule',
      detail: body,
    })
    return reply.status(201).send(ok(await loadRules(true)))
  })

  app.delete('/news/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const db = getDb()
    await db.run('DELETE FROM `news_category_rule` WHERE `id` = ?', [id])
    invalidateRules()
    await recordOperation({ operator: req.operator, action: 'news.rule.delete', targetType: 'news_rule', targetId: id })
    return reply.send(ok({ ok: true }))
  })
}
