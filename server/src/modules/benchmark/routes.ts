import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { getDb } from '../../db/index.js'
import { recordOperation } from '../audit/repo.js'
import { createDraftsFromTopics, createInitialDrafts } from '../copy-contract/service.js'
import { createTopic } from '../topics/repo.js'
import {
  addAccount,
  dailyQuota,
  listAccounts,
  previewAccount,
  removeAccount,
  updateAccount,
  findAccountBySecUid,
} from './accounts.js'
import { listAlerts, markAllRead, markRead, unreadCount } from './alerts.js'
import {
  getCacheByVideo,
  getScriptByVideo,
  getStatusByVideo,
  requestExtract,
} from './extract.js'
import { parseUserOrVideoLink } from './link.js'
import { enqueueFetch } from './sweep.js'
import { getVideoById, listVideos, upsertVideoFromPost } from './videos.js'
import { fetchVideoDetail, parseShareLink } from '../../integrations/tikhub/client.js'
import { logger } from '../../log.js'
import { utcNow } from '../../lib/time.js'

export function registerBenchmarkRoutes(app: FastifyInstance): void {
  /* ── 账号（FR-B1/B2） ─────────────────────────────────────────── */
  app.post('/benchmark/accounts/preview', async (req) => {
    const body = (req.body ?? {}) as { url?: string }
    if (!body.url) throw err.badRequest('请粘贴抖音主页链接或分享链接')
    return ok(await previewAccount(body.url))
  })

  app.post('/benchmark/accounts', async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string; intervalHours?: number }
    if (!body.url) throw err.badRequest('请粘贴抖音主页链接或分享链接')
    const { account } = await addAccount({
      url: body.url,
      intervalHours: body.intervalHours ?? 24,
      operator: req.operator,
    })
    // 添加成功自动回填最近一页视频（回填期不产生任何告警）
    await enqueueFetch(account.id, 'add', { backfill: true, advanceSchedule: false })
    return reply.status(201).send(ok({ ...account, backfillStarted: true }))
  })

  app.get('/benchmark/accounts', async (req) => {
    const q = (req.query ?? {}) as { includeRemoved?: string }
    return ok(await listAccounts(q.includeRemoved === '1'))
  })

  app.get('/benchmark/accounts/daily-quota', async () => ok(await dailyQuota()))

  app.patch('/benchmark/accounts/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { intervalHours?: number; monitorStatus?: 'on' | 'paused' }
    return ok(await updateAccount(id, body, req.operator))
  })

  app.delete('/benchmark/accounts/:id', async (req) => {
    const { id } = req.params as { id: string }
    await removeAccount(id, req.operator)
    return ok({ ok: true })
  })

  /** §2.4 任务可观测：手动触发一次抓取 */
  app.post('/benchmark/accounts/:id/fetch-now', async (req) => {
    const { id } = req.params as { id: string }
    await enqueueFetch(id, 'manual')
    await recordOperation({
      operator: req.operator,
      action: 'account.fetch',
      targetType: 'account',
      targetId: id,
    })
    return ok({ queued: true })
  })

  /* ── 视频（FR-B5/B6/B7/B8） ──────────────────────────────────── */
  app.get('/benchmark/videos', async (req) => ok(await listVideos((req.query ?? {}) as Record<string, unknown>)))

  app.post('/benchmark/videos/:id/extract', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { confirm?: boolean }
    const res = await requestExtract(id, { confirm: body.confirm === true })
    await recordOperation({
      operator: req.operator,
      action: 'video.extract',
      targetType: 'benchmark_video',
      targetId: id,
      detail: res,
    })
    return ok(res)
  })

  /** 提取状态轮询（供前端展示流转） */
  app.get('/benchmark/videos/:id/extract-status', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await getStatusByVideo(id))
  })

  app.get('/benchmark/videos/:id/script', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await getScriptByVideo(id))
  })

  /** FR-B7 送文案工坊：单事务原子创建 topic(sent) + copy 草稿 */
  app.post('/benchmark/videos/:id/send-to-copy', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { personaIds?: string[] }
    const personaIds = Array.isArray(body.personaIds) ? body.personaIds : []
    if (!personaIds.length) throw err.badRequest('请至少选择 1 个人物')

    const video = await getVideoById(id)
    if (!video) throw err.notFound('视频不存在')
    const cache = await getCacheByVideo(video.platform, video.videoId)
    if (!cache || cache.status !== 'done') {
      throw err.invalidState('请先完成文案提取（状态需为 done）')
    }

    const db = getDb()
    const result = await db.tx(async (t) => {
      const topic = await createTopic(
        {
          source: 'benchmark',
          sourceId: video.id,
          title: video.title ?? '（无标题视频）',
          personaIds,
          status: 'sent', // FR-C1 ②：benchmark 由送入接口原子创建即为 sent
          createdBy: req.operator,
        },
        t,
      )
      const drafts = await createDraftsFromTopics({
        topicIds: [topic.id],
        personaIds,
        operator: req.operator,
        db: t,
        alreadySent: true, // topic 已按 FR-C1② 建为 sent，仍需展开草稿
      })
      return { topicId: topic.id, copyIds: drafts.copyIds }
    })

    await recordOperation({
      operator: req.operator,
      action: 'video.send_copy',
      targetType: 'benchmark_video',
      targetId: id,
      detail: result,
    })
    // P1-10：初始空白稿必须在事务提交后创建（见 createInitialDrafts 注释）
    await createInitialDrafts(result.copyIds, req.operator)
    return ok(result)
  })

  /** FR-B8 直接提取改写：粘贴分享链接（过白名单），无需监控关系 */
  app.post('/benchmark/parse-link', async (req, reply) => {
    const body = (req.body ?? {}) as { shareUrl?: string }
    if (!body.shareUrl) throw err.badRequest('请粘贴视频分享链接')

    const parsed = await parseUserOrVideoLink(body.shareUrl)
    let videoId = parsed.videoId
    let authorSecUid = parsed.secUid
    if (!videoId) {
      const info = await parseShareLink(body.shareUrl)
      videoId = info.videoId
      authorSecUid = info.authorSecUid ?? authorSecUid
    }
    if (!videoId) throw err.badRequest('未能从链接中解析出视频，请检查链接是否为抖音视频分享链接')

    const detail = await fetchVideoDetail(videoId)
    const account = authorSecUid ? await findAccountBySecUid(authorSecUid) : null
    const isMonitor = !!account && !account.removedAt

    const { video, isNew } = await upsertVideoFromPost({
      accountId: isMonitor ? account!.id : null,
      origin: isMonitor ? 'monitor' : 'adhoc',
      platform: 'douyin',
      post: {
        videoId,
        title: detail.title || parsed.finalUrl,
        coverUrl: detail.coverUrl,
        duration: detail.duration,
        playCount: detail.playCount,
        diggCount: detail.diggCount,
        commentCount: detail.commentCount,
        shareCount: detail.shareCount,
        isTop: false,
        publishedAt: detail.publishedAt ?? utcNow(),
        shareUrl: body.shareUrl,
      },
      authorNickname: detail.authorNickname,
      authorSecUid: detail.authorSecUid ?? authorSecUid ?? null,
      allowAlert: false, // adhoc 视频不产生告警
    })

    // P2-6：刚取到的详情随任务带上，提取时不再重复调 TikHub 详情
    const extract = await requestExtract(video.id, {
      prefetched: { playUrl: detail.playUrl, duration: detail.duration, fetchedAt: Date.now() },
    })
    await recordOperation({
      operator: req.operator,
      action: 'link.parse',
      targetType: 'benchmark_video',
      targetId: video.id,
      detail: { shareUrl: body.shareUrl, isNew },
    })
    logger.info({ videoId: video.id, isNew, origin: video.origin }, 'benchmark.parse_link')
    return reply.status(isNew ? 201 : 200).send(ok({ video, extractStatus: extract.status }))
  })

  /* ── 告警（FR-B9） ───────────────────────────────────────────── */
  app.get('/benchmark/alerts', async (req) => ok(await listAlerts((req.query ?? {}) as Record<string, unknown>)))
  app.get('/benchmark/alerts/unread-count', async () => ok({ count: await unreadCount() }))
  app.patch('/benchmark/alerts/:id/read', async (req) => {
    const { id } = req.params as { id: string }
    await markRead(id)
    await recordOperation({ operator: req.operator, action: 'alert.read', targetType: 'alert', targetId: id })
    return ok({ ok: true })
  })
  app.post('/benchmark/alerts/read-all', async (req) => {
    const n = await markAllRead()
    await recordOperation({ operator: req.operator, action: 'alert.read', targetType: 'alert', detail: { all: n } })
    return ok({ updated: n })
  })
}
