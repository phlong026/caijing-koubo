import type { Db } from '../../db/index.js'
import { getDb, upsert } from '../../db/index.js'
import { newId } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { config } from '../../config.js'
import type { MetricSnapshot, MetricValues, MetricWindow } from './types.js'

/**
 * 快照写入与爆款判定（FR-M2 / FR-M3 / DB3）。
 *
 * 关键口径：
 *  - 唯一键 (publish_log_id, window)：同窗口重导覆盖（captured_at 刷新，指标以最新为准）；
 *  - 爆款判定在快照写入后同步重算：基准 = 该账号近 90 天该窗口全部快照的播放均值 ×3；
 *    账号样本 < 5 条 → is_hot = null（前端显示「样本不足」），避免小样本误标；
 *  - 判定基准 account_avg_plays 落库，保证结论可解释。
 *
 * 重算按「账号 × 窗口」整批进行而不是逐行：同一次导入的多条记录共用同一均值，
 * 否则先导入的记录会用不含自身的均值判定，出现同批数据口径不一致。
 */

export interface SnapshotInput {
  publishLogId: string
  platform: string
  accountId: string
  window: MetricWindow
  metrics: MetricValues
  source: 'csv' | 'provider'
  capturedAt?: Date
}

function mapSnapshot(r: Record<string, any>): MetricSnapshot {
  return {
    id: r.id,
    publishLogId: r.publish_log_id,
    platform: r.platform,
    accountId: r.account_id,
    window: r.window,
    plays: Number(r.plays ?? 0),
    likes: Number(r.likes ?? 0),
    comments: Number(r.comments ?? 0),
    shares: Number(r.shares ?? 0),
    collects: Number(r.collects ?? 0),
    fansGained: Number(r.fans_gained ?? 0),
    completionRate: r.completion_rate === null || r.completion_rate === undefined ? null : Number(r.completion_rate),
    isHot: r.is_hot === null || r.is_hot === undefined ? null : (Number(r.is_hot) ? 1 : 0),
    accountAvgPlays: r.account_avg_plays === null || r.account_avg_plays === undefined ? null : Number(r.account_avg_plays),
    capturedAt: r.captured_at ?? null,
    source: (r.source ?? 'csv') as 'csv' | 'provider',
  }
}

/** 写入（或覆盖）一条快照，返回是否为新增 */
export async function upsertSnapshot(input: SnapshotInput, db: Db = getDb()): Promise<{ created: boolean }> {
  const existing = await db.get<{ id: string }>(
    'SELECT `id` FROM `metric_snapshot` WHERE `publish_log_id` = ? AND `window` = ?',
    [input.publishLogId, input.window],
  )
  const now = toDb(input.capturedAt ?? utcNow())
  const m = input.metrics
  await upsert(db, {
    table: 'metric_snapshot',
    row: {
      id: existing?.id ?? newId('msnp'),
      publish_log_id: input.publishLogId,
      platform: input.platform,
      account_id: input.accountId,
      window: input.window,
      plays: m.plays,
      likes: m.likes,
      comments: m.comments,
      shares: m.shares,
      collects: m.collects,
      fans_gained: m.fansGained,
      completion_rate: m.completionRate,
      is_hot: null,
      account_avg_plays: null,
      captured_at: now,
      source: input.source,
      created_at: now,
    },
    uniqueCols: ['publish_log_id', 'window'],
    updateCols: [
      'platform',
      'account_id',
      'plays',
      'likes',
      'comments',
      'shares',
      'collects',
      'fans_gained',
      'completion_rate',
      'captured_at',
      'source',
    ],
  })
  return { created: !existing }
}

/**
 * 重算指定账号 × 窗口的爆款标记。
 * 均值基准窗口 config.analytics.hotWindowDays，样本门槛 hotMinSamples，倍数 hotMultiplier。
 */
export async function recalcHotForAccounts(
  accountIds: string[],
  windows: MetricWindow[],
  db: Db = getDb(),
): Promise<number> {
  const ids = Array.from(new Set(accountIds.filter(Boolean)))
  if (!ids.length) return 0
  const since = toDb(new Date(Date.now() - config.analytics.hotWindowDays * 86_400_000))
  let updated = 0
  for (const accountId of ids) {
    for (const window of windows) {
      const stat = await db.get<{ avg: number | null; n: number }>(
        'SELECT AVG(`plays`) AS avg, COUNT(*) AS n FROM `metric_snapshot` WHERE `account_id` = ? AND `window` = ? AND `captured_at` >= ?',
        [accountId, window, since],
      )
      const n = Number(stat?.n ?? 0)
      const avgRaw = stat?.avg === null || stat?.avg === undefined ? null : Number(stat.avg)
      const hasSample = n >= config.analytics.hotMinSamples && avgRaw !== null && Number.isFinite(avgRaw)
      const avg = hasSample ? Math.round(avgRaw!) : null
      const threshold = hasSample ? avgRaw! * config.analytics.hotMultiplier : null

      // 样本不足：is_hot 与基准都置 null（前端显示「样本不足」），不留下会误导的阈值
      await db.run(
        hasSample
          ? 'UPDATE `metric_snapshot` SET `account_avg_plays` = ?, `is_hot` = CASE WHEN `plays` > ? THEN 1 ELSE 0 END WHERE `account_id` = ? AND `window` = ?'
          : 'UPDATE `metric_snapshot` SET `account_avg_plays` = NULL, `is_hot` = NULL WHERE `account_id` = ? AND `window` = ?',
        hasSample ? [avg, threshold, accountId, window] : [accountId, window],
      )
      updated += n
    }
  }
  return updated
}

export interface DueLogRow {
  id: string
  platform: string
  account_id: string
  finished_at: string
}

/** 窗口到期但尚无快照的发布记录（FR-M4 调度输入） */
export async function listDueLogs(
  window: MetricWindow,
  db: Db = getDb(),
  limit = config.analytics.sweepBatch,
): Promise<DueLogRow[]> {
  const delayHours = window === 't1' ? config.analytics.t1DelayHours : config.analytics.t7DelayHours
  const dueBefore = toDb(new Date(Date.now() - delayHours * 3600_000))
  return db.all<DueLogRow>(
    `SELECT l.\`id\`, l.\`platform\`, l.\`account_id\`, l.\`finished_at\`
     FROM \`publish_log\` l
     WHERE l.\`status\` = 'published' AND l.\`finished_at\` IS NOT NULL AND l.\`finished_at\` <= ?
       AND NOT EXISTS (
         SELECT 1 FROM \`metric_snapshot\` s WHERE s.\`publish_log_id\` = l.\`id\` AND s.\`window\` = ?
       )
     ORDER BY l.\`finished_at\` ASC
     LIMIT ?`,
    [dueBefore, window, limit],
  )
}

export async function countDueLogs(window: MetricWindow, db: Db = getDb()): Promise<number> {
  const delayHours = window === 't1' ? config.analytics.t1DelayHours : config.analytics.t7DelayHours
  const dueBefore = toDb(new Date(Date.now() - delayHours * 3600_000))
  const r = await db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM \`publish_log\` l
     WHERE l.\`status\` = 'published' AND l.\`finished_at\` IS NOT NULL AND l.\`finished_at\` <= ?
       AND NOT EXISTS (
         SELECT 1 FROM \`metric_snapshot\` s WHERE s.\`publish_log_id\` = l.\`id\` AND s.\`window\` = ?
       )`,
    [dueBefore, window],
  )
  return Number(r?.c ?? 0)
}

/** 每窗口最近一次成功采集时间（FR-M10「最近回步」） */
export async function lastCapturedAt(window: MetricWindow, db: Db = getDb()): Promise<string | null> {
  const r = await db.get<{ t: string | null }>(
    'SELECT MAX(`captured_at`) AS t FROM `metric_snapshot` WHERE `window` = ?',
    [window],
  )
  return r?.t ?? null
}

export async function getSnapshotsByLogIds(logIds: string[], db: Db = getDb()): Promise<MetricSnapshot[]> {
  if (!logIds.length) return []
  const ph = logIds.map(() => '?').join(', ')
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`metric_snapshot\` WHERE \`publish_log_id\` IN (${ph})`,
    logIds,
  )
  return rows.map(mapSnapshot)
}

export async function hasAnySnapshot(db: Db = getDb()): Promise<boolean> {
  const r = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM `metric_snapshot`')
  return Number(r?.c ?? 0) > 0
}
