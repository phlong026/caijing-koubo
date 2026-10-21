import { getDb, insertIgnore, type Db } from '../../db/index.js'
import { config } from '../../config.js'
import { jdec, newId, parsePaging, pageResult, type PageResult } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { createAlert } from './alerts.js'
import type { TikPost } from '../../integrations/tikhub/types.js'

export type VideoOrigin = 'monitor' | 'adhoc'
export type ExtractStatus = 'none' | 'pending' | 'submitting' | 'running' | 'done' | 'failed' | 'uncertain'

export interface VideoRow {
  width: number
  height: number
  id: string
  accountId: string | null
  origin: VideoOrigin
  platform: string
  videoId: string
  title: string | null
  coverUrl: string | null
  duration: number | null
  shareUrl: string | null
  authorNickname: string | null
  authorSecUid: string | null
  isTop: boolean
  playCount: number
  diggCount: number
  commentCount: number
  shareCount: number
  interactTotal: number
  statsUpdatedAt: string | null
  isHot: boolean
  hotBaseline: Record<string, unknown> | null
  hotAlertedAt: string | null
  isBackfill: boolean
  publishedAt: string | null
  fetchedAt: string | null
}

export interface BenchVideoOut extends VideoRow {
  accountNickname: string | null
  extractStatus: ExtractStatus
  extractError: string | null
  sentCopyCount: number
}

function mapVideo(r: Record<string, any>): VideoRow {
  return {
    id: r.id,
    width: Number(r.video_width || 0),
    height: Number(r.video_height || 0),
    accountId: r.account_id ?? null,
    origin: r.origin ?? 'monitor',
    platform: r.platform,
    videoId: r.video_id,
    title: r.title ?? null,
    coverUrl: r.cover_url ?? null,
    duration: r.duration ?? null,
    shareUrl: r.share_url ?? null,
    authorNickname: r.author_nickname ?? null,
    authorSecUid: r.author_sec_uid ?? null,
    isTop: !!r.is_top,
    playCount: Number(r.play_count ?? 0),
    diggCount: Number(r.digg_count ?? 0),
    commentCount: Number(r.comment_count ?? 0),
    shareCount: Number(r.share_count ?? 0),
    interactTotal: Number(r.interact_total ?? 0),
    statsUpdatedAt: fromDb(r.stats_updated_at),
    isHot: !!r.is_hot,
    hotBaseline: jdec<Record<string, unknown> | null>(r.hot_baseline, null),
    hotAlertedAt: fromDb(r.hot_alerted_at),
    isBackfill: !!r.is_backfill,
    publishedAt: fromDb(r.published_at),
    fetchedAt: fromDb(r.fetched_at),
  }
}

export async function getVideoById(id: string, db = getDb()): Promise<VideoRow | null> {
  const r = await db.get<Record<string, any>>('SELECT * FROM `benchmark_video` WHERE `id` = ?', [id])
  return r ? mapVideo(r) : null
}

export async function getVideoByPlatformId(
  platform: string,
  videoId: string,
  db = getDb(),
): Promise<VideoRow | null> {
  const r = await db.get<Record<string, any>>(
    'SELECT * FROM `benchmark_video` WHERE `platform` = ? AND `video_id` = ?',
    [platform, videoId],
  )
  return r ? mapVideo(r) : null
}

export interface UpsertVideoInput {
  accountId: string | null
  origin: VideoOrigin
  platform: string
  post: TikPost
  /** FR-B1 回填期：入库与判爆款，但不产生任何告警 */
  isBackfill?: boolean
  /** 是否允许产生新发布告警 */
  allowAlert?: boolean
  /** adhoc 视频记录作者信息（FR-B8） */
  authorNickname?: string | null
  authorSecUid?: string | null
  db?: Db
}

/**
 * FR-B4 增量入库（唯一键 platform+video_id）：
 * 新视频入库并产生新发布告警（回填期除外）；已知视频刷新互动数据并更新 stats_updated_at。
 */
export async function upsertVideoFromPost(input: UpsertVideoInput): Promise<{ video: VideoRow; isNew: boolean }> {
  const db = input.db ?? getDb()
  const { post } = input
  const interact = post.diggCount + post.commentCount + post.shareCount
  const now = toDb(utcNow())

  const existing = await getVideoByPlatformId(input.platform, post.videoId, db)
  if (existing) {
    if (post.width && post.height) {
      await db.run('UPDATE `benchmark_video` SET `video_width` = ?, `video_height` = ? WHERE `id` = ?', [post.width, post.height, existing.id])
    }
    await db.run(
      `UPDATE \`benchmark_video\` SET
        \`title\` = ?, \`cover_url\` = ?, \`duration\` = ?, \`is_top\` = ?,
        \`play_count\` = ?, \`digg_count\` = ?, \`comment_count\` = ?, \`share_count\` = ?,
        \`interact_total\` = ?, \`stats_updated_at\` = ?
       WHERE \`id\` = ?`,
      [
        post.title.slice(0, 1000),
        post.coverUrl,
        post.duration ?? 0,
        post.isTop ? 1 : 0,
        post.playCount,
        post.diggCount,
        post.commentCount,
        post.shareCount,
        interact,
        now,
        existing.id,
      ],
    )
    if (input.authorNickname || input.authorSecUid) {
      await db.run(
        'UPDATE `benchmark_video` SET `author_nickname` = COALESCE(?, `author_nickname`), `author_sec_uid` = COALESCE(?, `author_sec_uid`) WHERE `id` = ?',
        [input.authorNickname ?? null, input.authorSecUid ?? null, existing.id],
      )
    }
    // 之后该作者被纳入监控时，回写 account_id 并置 origin=monitor（FR-B8）
    if (!existing.accountId && input.accountId) {
      await db.run('UPDATE `benchmark_video` SET `account_id` = ?, `origin` = ? WHERE `id` = ?', [
        input.accountId,
        'monitor',
        existing.id,
      ])
    }
    const fresh = (await getVideoById(existing.id, db))!
    return { video: fresh, isNew: false }
  }

  const id = newId('bvideo')
  const inserted = await insertIgnore(db, 'benchmark_video', {
    id,
    account_id: input.accountId,
    origin: input.origin,
    platform: input.platform,
    video_id: post.videoId,
    title: post.title.slice(0, 1000),
    cover_url: post.coverUrl,
    video_width: post.width || 0,
    video_height: post.height || 0,
    duration: post.duration ?? 0,
    share_url: post.shareUrl,
    author_nickname: input.authorNickname ?? null,
    author_sec_uid: input.authorSecUid ?? null,
    is_top: post.isTop ? 1 : 0,
    play_count: post.playCount,
    digg_count: post.diggCount,
    comment_count: post.commentCount,
    share_count: post.shareCount,
    interact_total: interact,
    stats_updated_at: now,
    is_hot: 0,
    is_backfill: input.isBackfill ? 1 : 0,
    published_at: post.publishedAt ? toDb(post.publishedAt) : now,
    fetched_at: now,
  })
  if (!inserted) {
    // 并发插入被唯一键拦截：视为已存在，走刷新分支
    const v = await getVideoByPlatformId(input.platform, post.videoId, db)
    if (v) return { video: v, isNew: false }
    throw err.internal('视频写入失败')
  }

  const video = (await getVideoById(id, db))!
  if (input.allowAlert && !input.isBackfill) {
    await createAlert({ type: 'new_publish', accountId: input.accountId, videoId: id, payload: buildPayload(video) }, db)
  }
  return { video, isNew: true }
}

function buildPayload(v: VideoRow): Record<string, unknown> {
  return {
    title: v.title,
    nickname: v.authorNickname,
    coverUrl: v.coverUrl,
    diggCount: v.diggCount,
    commentCount: v.commentCount,
    shareCount: v.shareCount,
    interactTotal: v.interactTotal,
    publishedAt: v.publishedAt,
    videoId: v.videoId,
  }
}

/**
 * FR-B4 爆款判定（D10 口径：互动 > 该账号近 30 条互动均值 × 3）
 * - 基线样本 < minSample（默认 5）不判定；基线均值为 0 不判定
 * - is_hot 一旦为 true 保持不变；同一视频的爆款告警只发一次（hot_alerted_at）
 * - 判定快照写入 hot_baseline，可追溯
 */
export async function evaluateHot(
  video: VideoRow,
  opts: { allowAlert?: boolean; db?: Db } = {},
): Promise<{ isHot: boolean; reason?: string }> {
  const db = opts.db ?? getDb()
  if (video.isHot) return { isHot: true, reason: 'already_hot' }
  if (!video.accountId) return { isHot: false, reason: 'adhoc_video' }

  const rows = await db.all<{ interact_total: number }>(
    `SELECT \`interact_total\` FROM \`benchmark_video\`
     WHERE \`account_id\` = ? AND \`id\` <> ?
     ORDER BY \`published_at\` DESC LIMIT ?`,
    [video.accountId, video.id, config.hot.baselineSample],
  )
  const sample = rows.length
  if (sample < config.hot.minSample) return { isHot: false, reason: 'sample_insufficient' }
  const sum = rows.reduce((a, r) => a + Number(r.interact_total ?? 0), 0)
  const avg = sum / sample
  if (avg <= 0) return { isHot: false, reason: 'zero_baseline' }

  const threshold = avg * config.hot.multiplier
  const snapshot = {
    interact: video.interactTotal,
    baselineAvg: Number(avg.toFixed(2)),
    sample,
    multiplier: config.hot.multiplier,
    threshold: Number(threshold.toFixed(2)),
    judgedAt: toDb(utcNow()),
  }

  // 普通作品也保留判定依据，供页面解释，而非只存爆款快照。
  await db.run('UPDATE `benchmark_video` SET `hot_baseline` = ? WHERE `id` = ?', [JSON.stringify(snapshot), video.id])

  if (video.interactTotal > threshold) {
    await db.run('UPDATE `benchmark_video` SET `is_hot` = 1, `hot_baseline` = ? WHERE `id` = ?', [
      JSON.stringify(snapshot),
      video.id,
    ])
    if (opts.allowAlert !== false && !video.hotAlertedAt) {
      await createAlert(
        { type: 'hot', accountId: video.accountId, videoId: video.id, payload: { ...buildPayload(video), ...snapshot } },
        db,
      )
      await db.run('UPDATE `benchmark_video` SET `hot_alerted_at` = ? WHERE `id` = ?', [toDb(utcNow()), video.id])
    }
    logger.info({ videoId: video.id, interact: video.interactTotal, threshold }, 'video.hot_marked')
    return { isHot: true, reason: 'above_threshold' }
  }
  return { isHot: false, reason: 'below_threshold' }
}

/* ── 列表（FR-B5） ────────────────────────────────────────────────── */
export async function listVideos(
  q: Record<string, unknown>,
): Promise<PageResult<BenchVideoOut> & { meta: { showPlayCount: boolean } }> {
  const db = getDb()
  const p = parsePaging(q, 20, 100)
  const where: string[] = []
  const params: unknown[] = []
  const formatConditions: Record<string, string> = {
    landscape: 'v.`video_width` > v.`video_height` AND v.`video_height` > 0',
    portrait: 'v.`video_height` > v.`video_width` AND v.`video_width` > 0',
    square: 'v.`video_width` = v.`video_height` AND v.`video_width` > 0',
  }
  if (formatConditions[String(q.format)]) where.push(formatConditions[String(q.format)])
  if (q.dataSource === 'real') {
    where.push("NOT EXISTS (SELECT 1 FROM `benchmark_account` demo WHERE demo.`id` = v.`account_id` AND demo.`added_by` = 'smoke' AND demo.`nickname` LIKE '示例账号_%')")
    where.push("COALESCE(v.`author_nickname`, '') NOT LIKE '示例账号_%'")
  }
  if (q.accountId) {
    where.push('v.`account_id` = ?')
    params.push(String(q.accountId))
  }
  if (q.onlyHot === '1' || q.onlyHot === 'true' || q.onlyHot === true) {
    where.push('v.`is_hot` = 1')
  }
  if (q.origin) {
    where.push('v.`origin` = ?')
    params.push(String(q.origin))
  }
  if (q.extractStatus) {
    const st = String(q.extractStatus)
    if (st === 'none') {
      where.push('c.`status` IS NULL')
    } else {
      where.push('c.`status` = ?')
      params.push(st)
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total =
    (await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM \`benchmark_video\` v
       LEFT JOIN \`script_extract_cache\` c ON c.\`platform\` = v.\`platform\` AND c.\`video_id\` = v.\`video_id\`
       ${whereSql}`,
      params,
    ))?.c ?? 0

  const rows = await db.all<Record<string, any>>(
    `SELECT v.*, a.\`nickname\` AS account_nickname, c.\`status\` AS extract_status, c.\`error\` AS extract_error,
            (SELECT COUNT(*) FROM \`copy\` cp WHERE cp.\`source_ref_type\` = 'benchmark_video' AND cp.\`source_ref_id\` = v.\`id\`) AS sent_copy_count
     FROM \`benchmark_video\` v
     LEFT JOIN \`benchmark_account\` a ON a.\`id\` = v.\`account_id\`
     LEFT JOIN \`script_extract_cache\` c ON c.\`platform\` = v.\`platform\` AND c.\`video_id\` = v.\`video_id\`
     ${whereSql}
     ORDER BY ${q.sort === 'interaction' ? 'v.`interact_total` DESC,' : ''} v.\`published_at\` DESC
     LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  )

  const items: BenchVideoOut[] = rows.map((r) => ({
    ...mapVideo(r),
    accountNickname: r.account_nickname ?? null,
    extractStatus: (r.extract_status as ExtractStatus) ?? 'none',
    extractError: r.extract_error ?? null,
    sentCopyCount: Number(r.sent_copy_count ?? 0),
  }))
  return {
    ...pageResult(items, total, p),
    meta: { showPlayCount: config.playCountVisible },
  }
}

/** 近 N 天内已入库视频（用于监控刷新互动并重判爆款，FR-B3/B4） */
export async function listRecentVideosByAccount(accountId: string, days: number): Promise<VideoRow[]> {
  const db = getDb()
  const since = toDb(new Date(Date.now() - days * 86_400_000))
  const rows = await db.all<Record<string, any>>(
    'SELECT * FROM `benchmark_video` WHERE `account_id` = ? AND `published_at` >= ? ORDER BY `published_at` DESC',
    [accountId, since],
  )
  return rows.map(mapVideo)
}
