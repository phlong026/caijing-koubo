import type { Db } from '../../db/index.js'
import { getDb } from '../../db/index.js'
import { toDb, utcNow, fromDb } from '../../lib/time.js'
import { parsePaging, type PageQuery } from '../../lib/util.js'
import { err } from '../../errors.js'
import { config } from '../../config.js'
import { LINE_LABELS } from '../personas/types.js'
import { PUBLISH_PLATFORMS, type Platform } from '../publish/types.js'
import { PLATFORM_LABELS } from '../personas/types.js'
import {
  interactOf,
  METRIC_WINDOWS,
  type MetricSnapshot,
  type MetricWindow,
} from './types.js'
import { countDueLogs, getSnapshotsByLogIds, lastCapturedAt } from './snapshot.js'
import { providerStatus } from './provider.js'

/**
 * 效果看板聚合（FR-M5 / FR-M10 / AC-M5）。
 *
 * 聚合方式：先按筛选条件取发布记录（publish_log × plan × copy × persona × account），
 * 再一次性取这些记录的两个窗口快照，在内存里按「每内容最新窗口（T+7 优先，Q7）」汇总。
 * 量级日产 ≤ 百条，比窗口函数 SQL 更易跨 MySQL / SQLite 保持同一口径。
 */

export interface OverviewQuery {
  days?: unknown
  line?: unknown
  platform?: unknown
  page?: unknown
  pageSize?: unknown
}

interface LogRow {
  id: string
  platform: string
  account_id: string
  title: string | null
  finished_at: string | null
  external_video_id: string | null
  cover_source: string | null
  copy_id: string | null
  copy_title: string | null
  persona_id: string | null
  persona_name: string | null
  persona_line: string | null
  account_name: string | null
  account_line: string | null
}

export interface ContentPerfRow {
  publishLogId: string
  title: string
  platform: string
  platformLabel: string
  accountName: string | null
  line: string | null
  lineLabel: string | null
  personaName: string | null
  finishedAt: string | null
  playsT1: number | null
  playsT7: number | null
  plays: number | null
  interacts: number | null
  completionRate: number | null
  fansGained: number | null
  isHot: 0 | 1 | null
  accountAvgPlays: number | null
  /** 该内容命中对标账号时给出一键降档入口（FR-M9），未命中为 null */
  benchmark: { accountId: string; nickname: string | null; intervalHours: number } | null
}

export interface OverviewResult {
  range: { days: number; from: string; to: string; dayKeys: string[] }
  cards: {
    published: number
    captured: number
    plays: number
    interacts: number
    completionRate: number | null
    hotCount: number
  }
  trend: {
    dayKeys: string[]
    series: Array<{ line: string; name: string; values: number[] }>
  }
  lines: Array<{ line: string; name: string; count: number; avgPlays: number | null }>
  contents: {
    items: ContentPerfRow[]
    total: number
    page: number
    pageSize: number
  }
  capture: Record<MetricWindow, { lastCapturedAt: string | null; pending: number }>
  provider: { name: string; available: boolean; hint: string }
  /** 无任何快照时为 true，前端展示引导空态（AC-M13） */
  empty: boolean
}

function dayKeyCst(utcStr: string | null): string | null {
  if (!utcStr) return null
  const d = new Date(`${utcStr.replace(' ', 'T')}Z`)
  if (Number.isNaN(d.getTime())) return null
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function pickLatest(snaps: MetricSnapshot[]): { snap: MetricSnapshot | null; t1: MetricSnapshot | null; t7: MetricSnapshot | null } {
  const t1 = snaps.find((s) => s.window === 't1') ?? null
  const t7 = snaps.find((s) => s.window === 't7') ?? null
  return { snap: t7 ?? t1 ?? null, t1, t7 }
}

export async function buildOverview(q: OverviewQuery, db: Db = getDb()): Promise<OverviewResult> {
  const days = Math.min(config.analytics.maxDays, Math.max(1, Number(q.days ?? 7) || 7))
  const line = q.line ? String(q.line) : ''
  const platform = q.platform ? String(q.platform) : ''
  if (line && !LINE_LABELS[line as keyof typeof LINE_LABELS]) {
    throw err.badRequest('line 取值无效', { allowed: Object.keys(LINE_LABELS) })
  }
  if (platform && !PUBLISH_PLATFORMS.includes(platform as Platform)) {
    throw err.badRequest('platform 取值无效', { allowed: PUBLISH_PLATFORMS })
  }
  const paging: PageQuery = parsePaging(q as Record<string, unknown>, 10, config.analytics.maxDays)

  const now = utcNow()
  const since = toDb(new Date(now.getTime() - days * 86_400_000))

  const where: string[] = ["l.`status` = 'published'", 'l.`finished_at` IS NOT NULL', 'l.`finished_at` >= ?']
  const params: unknown[] = [since]
  if (platform) {
    where.push('l.`platform` = ?')
    params.push(platform)
  }
  if (line) {
    where.push('COALESCE(pe.`line`, pa.`line`) = ?')
    params.push(line)
  }

  const logs = await db.all<LogRow>(
    `SELECT l.\`id\`, l.\`platform\`, l.\`account_id\`, l.\`title\`, l.\`finished_at\`, l.\`external_video_id\`,
            p.\`cover_source\`, p.\`copy_id\`,
            c.\`title\` AS copy_title, c.\`persona_id\`,
            pe.\`name\` AS persona_name, pe.\`line\` AS persona_line,
            pa.\`display_name\` AS account_name, pa.\`line\` AS account_line
     FROM \`publish_log\` l
     LEFT JOIN \`publish_plan\` p ON p.\`id\` = l.\`plan_id\`
     LEFT JOIN \`copy\` c ON c.\`id\` = p.\`copy_id\`
     LEFT JOIN \`persona\` pe ON pe.\`id\` = c.\`persona_id\`
     LEFT JOIN \`platform_account\` pa ON pa.\`id\` = l.\`account_id\`
     WHERE ${where.join(' AND ')}
     ORDER BY l.\`finished_at\` DESC`,
    params,
  )

  const snaps = await getSnapshotsByLogIds(logs.map((l) => l.id), db)
  const snapMap = new Map<string, MetricSnapshot[]>()
  for (const s of snaps) {
    const list = snapMap.get(s.publishLogId) ?? []
    list.push(s)
    snapMap.set(s.publishLogId, list)
  }

  // 对标匹配：标题一致即认为是对标账号的同款内容（一期按标题，FR-M9 的入口判定）
  const titles = Array.from(new Set(logs.map((l) => l.title).filter((t): t is string => !!t)))
  const benchByTitle = await matchBenchmarkByTitles(titles, db)

  // 日桶：近 days 天（北京时间自然日，含今天）
  const dayKeys: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    dayKeys.push(new Date(now.getTime() + 8 * 3600_000 - i * 86_400_000).toISOString().slice(0, 10))
  }
  const trendMap = new Map<string, Map<string, number>>()
  for (const k of dayKeys) trendMap.set(k, new Map())

  let plays = 0
  let interacts = 0
  let hotCount = 0
  let captured = 0
  const rates: number[] = []
  const lineAgg = new Map<string, { count: number; plays: number; captured: number }>()
  const items: ContentPerfRow[] = []

  for (const l of logs) {
    const { snap, t1, t7 } = pickLatest(snapMap.get(l.id) ?? [])
    const lineOf = l.persona_line ?? l.account_line ?? null
    const interact = snap ? interactOf(snap) : null

    if (snap) {
      captured += 1
      plays += snap.plays
      interacts += interact ?? 0
      if (snap.isHot === 1) hotCount += 1
      if (snap.completionRate !== null) rates.push(snap.completionRate)
      const dk = dayKeyCst(l.finished_at)
      if (dk && trendMap.has(dk) && lineOf) {
        const bucket = trendMap.get(dk)!
        bucket.set(lineOf, (bucket.get(lineOf) ?? 0) + snap.plays)
      }
    }

    const la = lineAgg.get(lineOf ?? 'unknown') ?? { count: 0, plays: 0, captured: 0 }
    la.count += 1
    if (snap) {
      la.plays += snap.plays
      la.captured += 1
    }
    lineAgg.set(lineOf ?? 'unknown', la)

    items.push({
      publishLogId: l.id,
      title: l.title || l.copy_title || '未命名内容',
      platform: l.platform,
      platformLabel: PLATFORM_LABELS[l.platform as Platform] ?? l.platform,
      accountName: l.account_name,
      line: lineOf,
      lineLabel: lineOf ? LINE_LABELS[lineOf as keyof typeof LINE_LABELS] ?? lineOf : null,
      personaName: l.persona_name,
      finishedAt: fromDb(l.finished_at),
      playsT1: t1 ? t1.plays : null,
      playsT7: t7 ? t7.plays : null,
      plays: snap ? snap.plays : null,
      interacts: interact,
      completionRate: snap ? snap.completionRate : null,
      fansGained: snap ? snap.fansGained : null,
      isHot: snap ? snap.isHot : null,
      accountAvgPlays: snap ? snap.accountAvgPlays : null,
      benchmark: l.title ? benchByTitle.get(l.title) ?? null : null,
    })
  }

  const series = (['manager', 'kos', 'persona'] as const).map((key) => ({
    line: key,
    name: LINE_LABELS[key],
    values: dayKeys.map((k) => trendMap.get(k)?.get(key) ?? 0),
  }))

  const lines = (['manager', 'kos', 'persona'] as const)
    .map((key) => {
      const agg = lineAgg.get(key)
      return {
        line: key,
        name: LINE_LABELS[key],
        count: agg?.count ?? 0,
        avgPlays: agg && agg.captured ? Math.round(agg.plays / agg.captured) : null,
      }
    })
    .filter((r) => r.count > 0)

  const capture = {} as Record<MetricWindow, { lastCapturedAt: string | null; pending: number }>
  for (const w of METRIC_WINDOWS) {
    capture[w] = {
      lastCapturedAt: fromDb(await lastCapturedAt(w, db)),
      pending: await countDueLogs(w, db),
    }
  }

  const start = paging.offset
  return {
    range: { days, from: since, to: toDb(now), dayKeys },
    cards: {
      published: logs.length,
      captured,
      plays,
      interacts,
      completionRate: rates.length ? Number((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(4)) : null,
      hotCount,
    },
    trend: { dayKeys, series },
    lines,
    contents: {
      items: items.slice(start, start + paging.limit),
      total: items.length,
      page: paging.page,
      pageSize: paging.pageSize,
    },
    capture,
    provider: providerStatus(),
    empty: snaps.length === 0,
  }
}

interface BenchmarkHit {
  accountId: string
  nickname: string | null
  intervalHours: number
}

/** 标题 → 对标账号（同标题多条取第一条；无对标数据时返回空 Map） */
export async function matchBenchmarkByTitles(
  titles: string[],
  db: Db = getDb(),
): Promise<Map<string, BenchmarkHit>> {
  const out = new Map<string, BenchmarkHit>()
  if (!titles.length) return out
  const chunk = titles.slice(0, 200)
  const ph = chunk.map(() => '?').join(', ')
  const rows = await db.all<{ title: string; account_id: string | null; nickname: string | null; interval: number | null }>(
    `SELECT v.\`title\`, v.\`account_id\`, a.\`nickname\`, a.\`monitor_interval_hours\` AS \`interval\`
     FROM \`benchmark_video\` v
     LEFT JOIN \`benchmark_account\` a ON a.\`id\` = v.\`account_id\`
     WHERE v.\`title\` IN (${ph}) AND v.\`account_id\` IS NOT NULL`,
    chunk,
  )
  for (const r of rows) {
    if (!r.account_id) continue
    if (out.has(r.title)) continue
    out.set(r.title, {
      accountId: r.account_id,
      nickname: r.nickname ?? null,
      intervalHours: Number(r.interval ?? 24),
    })
  }
  return out
}
