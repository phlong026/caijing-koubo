import { getDb } from '../../db/index.js'
import { config } from '../../config.js'
import { fetchUserPosts, fetchUserInfo } from '../../integrations/tikhub/client.js'
import { getAccount, markFetchResult, markUserInfoRefreshed, needsUserInfoRefresh } from './accounts.js'
import { evaluateHot, upsertVideoFromPost } from './videos.js'
import { logger } from '../../log.js'
import { toDb, utcNow } from '../../lib/time.js'

export interface FetchOutcome {
  accountId: string
  pages: number
  newCount: number
  refreshedCount: number
  hotMarked: number
  userInfoRefreshed: boolean
}

export interface FetchOptions {
  /** FR-B1 回填期：只入库与判定 is_hot，不产生任何告警 */
  backfill?: boolean
  maxPages?: number
  reason: 'add' | 'schedule' | 'manual'
}

/**
 * FR-B3 抓取规则：
 * - cursor 翻页，至多 maxPages(2) 页
 * - 第 1 页始终完整处理：新视频入库，近 7 天内的已知视频刷新互动并重判爆款
 * - 置顶作品（is_top）不参与"遇到已知视频即停"的判断
 * - 第 1 页非置顶作品全为新视频时才翻第 2 页
 * - 每日首次抓取同时刷新用户信息（粉丝数）
 */
export async function fetchAccountVideos(accountId: string, opts: FetchOptions): Promise<FetchOutcome> {
  const acc = await getAccount(accountId)
  if (!acc || acc.removedAt) throw new Error('账号不存在或已移除')
  if (!acc.secUid) throw new Error('账号缺少 sec_uid')

  const maxPages = opts.backfill ? 1 : Math.max(1, Math.min(2, opts.maxPages ?? config.fetchQueue.maxPages))
  const allowAlert = !opts.backfill
  const outcome: FetchOutcome = {
    accountId,
    pages: 0,
    newCount: 0,
    refreshedCount: 0,
    hotMarked: 0,
    userInfoRefreshed: false,
  }

  let cursor = 0
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchUserPosts(acc.secUid, cursor, 20, { type: 'account', id: acc.id })
    outcome.pages++
    let pageAllNew = true

    for (const post of res.posts) {
      if (!post.videoId) continue
      const { video, isNew } = await upsertVideoFromPost({
        accountId: acc.id,
        origin: 'monitor',
        platform: acc.platform,
        post,
        isBackfill: !!opts.backfill,
        allowAlert,
      })

      if (isNew) {
        outcome.newCount++
        const hot = await evaluateHot(video, { allowAlert })
        if (hot.isHot && hot.reason === 'above_threshold') outcome.hotMarked++
      } else {
        // 近 7 天内的已知视频：刷新互动后重判爆款（FR-B4）
        const published = video.publishedAt ? new Date(video.publishedAt).getTime() : 0
        const withinWindow = published >= Date.now() - config.hot.refreshDays * 86_400_000
        if (withinWindow) {
          const hot = await evaluateHot(video, { allowAlert })
          if (hot.isHot && hot.reason === 'above_threshold') outcome.hotMarked++
        }
        outcome.refreshedCount++
        if (!post.isTop) pageAllNew = false // 置顶作品不作为"已知视频即停"的信号
      }
    }

    if (!res.hasMore || !res.nextCursor) break
    if (page === 0 && !pageAllNew) break
    cursor = res.nextCursor
  }

  // 每日首次抓取刷新用户信息
  if (!opts.backfill && (await needsUserInfoRefresh(acc))) {
    try {
      const user = await fetchUserInfo(acc.secUid)
      await markUserInfoRefreshed(acc.id, user.fansCount)
      outcome.userInfoRefreshed = true
    } catch (e) {
      logger.warn({ accountId, err: (e as Error).message }, 'account.user_info_refresh_failed')
    }
  }

  await markFetchResult(acc.id, { ok: true })
  logger.info({ reason: opts.reason, ...outcome }, 'benchmark.fetched')
  return outcome
}

/** 抓取失败统一走退避计数（FR-B3） */
export async function failFetch(accountId: string, error: unknown): Promise<void> {
  const msg = (error as Error)?.message ?? '抓取失败'
  await markFetchResult(accountId, { ok: false, error: msg })
  logger.error({ accountId, err: msg }, 'benchmark.fetch_failed')
}

/** 启动续跑：进程重启后把 submitting 未拿到 task_id 的记录标记为 uncertain（FR-B6） */
export async function recoverUncertainExtracts(): Promise<number> {
  const db = getDb()
  const res = await db.run(
    "UPDATE `script_extract_cache` SET `status` = 'uncertain', `error` = ?, `updated_at` = ? WHERE `status` = 'submitting'",
    ['进程重启，提交结果未知，请人工确认后重试', toDb(utcNow())],
  )
  if (res.affectedRows) logger.warn({ count: res.affectedRows }, 'extract.recovered_uncertain')
  return res.affectedRows
}
