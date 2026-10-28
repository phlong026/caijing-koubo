import type { Db } from '../../db/index.js'
import { getDb } from '../../db/index.js'
import { err } from '../../errors.js'
import { recordOperation } from '../audit/repo.js'
import { config } from '../../config.js'
import { toDb, utcNow } from '../../lib/time.js'
import { parseMetricsCsv, type ParseResult } from './csv.js'
import { recalcHotForAccounts, upsertSnapshot } from './snapshot.js'
import type { MetricWindow } from './types.js'

/**
 * CSV 导入主流程（FR-M1 / §3.2 / AC-M1、AC-M2）。
 *
 * 步骤：解析 → 两级匹配 → upsert 快照 → 整批重算爆款 → 反哺建议刷新。
 *
 * 拒绝策略：不匹配行占比 ≥ config.analytics.unmatchedRejectRatio（默认 80%）时**整单拒绝**，
 * 一行都不写。这是为了防止「错平台 / 错账号」的批量脏数据把账号均值带偏——
 * 均值一旦被污染，爆款标记会连带失真，且很难事后发现。
 */

export interface ImportOptions {
  platform: string
  window: MetricWindow
  csvText: string
  operator: string
  /** 文件名，仅用于留痕 */
  filename?: string
}

export interface UnmatchedRow {
  lineNo: number
  reason: string
  title?: string | null
  externalVideoId?: string | null
}

export interface ImportResult {
  platform: string
  window: MetricWindow
  total: number
  imported: number
  created: number
  updated: number
  unmatchedCount: number
  rejectedCount: number
  unmatched: UnmatchedRow[]
  mapping: ParseResult['mapping']
  capturedAt: string
  accounts: number
  /** 导入后刷新出的新建议数 */
  suggestions: number
}

interface CandidateLog {
  id: string
  platform: string
  account_id: string
  external_video_id: string | null
  title: string | null
  finished_at: string | null
  display_name: string | null
}

const DAY_MS = 86_400_000

function normText(v: string | null | undefined): string {
  return String(v ?? '')
    .replace(/[\s\u3000]+/g, '')
    .trim()
    .toLowerCase()
}

/** 加载该平台已发布记录作为匹配池（量级：日产 ≤ 百条，一次载入足够） */
async function loadCandidates(platform: string, db: Db): Promise<CandidateLog[]> {
  return db.all<CandidateLog>(
    `SELECT l.\`id\`, l.\`platform\`, l.\`account_id\`, l.\`external_video_id\`, l.\`title\`, l.\`finished_at\`,
            pa.\`display_name\`
     FROM \`publish_log\` l
     LEFT JOIN \`platform_account\` pa ON pa.\`id\` = l.\`account_id\`
     WHERE l.\`platform\` = ? AND l.\`status\` = 'published'
     ORDER BY l.\`finished_at\` DESC
     LIMIT 5000`,
    [platform],
  )
}

export async function importMetricsCsv(opts: ImportOptions, db: Db = getDb()): Promise<ImportResult> {
  const parsed = parseMetricsCsv(opts.csvText, opts.platform)
  const candidates = await loadCandidates(opts.platform, db)
  if (!candidates.length) {
    throw err.metricUnmatchedRows(
      `平台「${opts.platform}」没有已发布的记录可供匹配，请先完成发布或核对导入平台`,
      { platform: opts.platform, total: parsed.total },
    )
  }

  const byVideoId = new Map<string, CandidateLog>()
  const byTitle = new Map<string, CandidateLog[]>()
  for (const c of candidates) {
    if (c.external_video_id) byVideoId.set(String(c.external_video_id).trim(), c)
    if (c.title) {
      const key = normText(c.title)
      const list = byTitle.get(key) ?? []
      list.push(c)
      byTitle.set(key, list)
    }
  }

  const unmatched: UnmatchedRow[] = parsed.rejected.map((r) => ({ lineNo: r.lineNo, reason: r.reason }))
  const matched: Array<{ log: CandidateLog; row: ParseResult['rows'][number] }> = []

  for (const row of parsed.rows) {
    // ① external_video_id 精确
    if (row.externalVideoId) {
      const hit = byVideoId.get(row.externalVideoId.trim())
      if (hit) {
        matched.push({ log: hit, row })
        continue
      }
    }
    // ② 账号 + 标题完全一致 + 发布日期 ±1 天
    if (row.title) {
      const list = byTitle.get(normText(row.title)) ?? []
      const byAccount = row.accountName
        ? list.filter((c) => normText(c.display_name) === normText(row.accountName))
        : list
      if (!byAccount.length) {
        unmatched.push({
          lineNo: row.lineNo,
          reason: '未找到匹配的发布记录（视频ID 与「账号+标题」两级均未命中）',
          title: row.title,
          externalVideoId: row.externalVideoId,
        })
        continue
      }
      let picked: CandidateLog | null = null
      if (row.publishedAt) {
        // 发布时间用于消歧：取 finished_at 与 CSV 发布时间相差 ≤1 天的记录
        const t = row.publishedAt.getTime()
        const near = byAccount.filter((c) => {
          if (!c.finished_at) return false
          const ft = new Date(`${c.finished_at.replace(' ', 'T')}Z`).getTime()
          return Number.isFinite(ft) && Math.abs(ft - t) <= DAY_MS
        })
        if (near.length === 1) picked = near[0]!
        else if (near.length > 1) {
          // 同标题同账号同一天多条：取发布时间最接近的一条
          picked = near.reduce((a, b) => {
            const da = Math.abs(new Date(`${a.finished_at!.replace(' ', 'T')}Z`).getTime() - t)
            const dbb = Math.abs(new Date(`${b.finished_at!.replace(' ', 'T')}Z`).getTime() - t)
            return dbb < da ? b : a
          })
        }
      }
      if (!picked && byAccount.length === 1) picked = byAccount[0]!
      if (!picked) {
        unmatched.push({
          lineNo: row.lineNo,
          reason: '标题匹配到多条发布记录，且发布时间缺失或超出 ±1 天，无法唯一确定',
          title: row.title,
          externalVideoId: row.externalVideoId,
        })
        continue
      }
      matched.push({ log: picked, row })
      continue
    }
    unmatched.push({
      lineNo: row.lineNo,
      reason: '未找到匹配的发布记录',
      externalVideoId: row.externalVideoId,
    })
  }

  const totalRows = parsed.total
  const unmatchedRatio = totalRows ? unmatched.length / totalRows : 1
  if (!matched.length || unmatchedRatio >= config.analytics.unmatchedRejectRatio) {
    throw err.metricUnmatchedRows(
      `不匹配行占比 ${(unmatchedRatio * 100).toFixed(0)}%（${unmatched.length}/${totalRows}），已整单拒绝；请核对导入平台与账号后重试`,
      {
        platform: opts.platform,
        window: opts.window,
        total: totalRows,
        unmatchedCount: unmatched.length,
        threshold: config.analytics.unmatchedRejectRatio,
        unmatched: unmatched.slice(0, 30),
      },
    )
  }

  const capturedAt = utcNow()
  const accountIds = new Set<string>()
  let created = 0
  let updated = 0
  for (const { log, row } of matched) {
    const r = await upsertSnapshot(
      {
        publishLogId: log.id,
        platform: log.platform,
        accountId: log.account_id,
        window: opts.window,
        metrics: row.metrics,
        source: 'csv',
        capturedAt,
      },
      db,
    )
    if (r.created) created += 1
    else updated += 1
    accountIds.add(log.account_id)
  }

  // 整批重算：同一次导入共用同一账号均值，避免批内口径不一致
  await recalcHotForAccounts(Array.from(accountIds), [opts.window], db)

  await recordOperation({
    operator: opts.operator,
    action: updated > 0 ? 'analytics.reimport' : 'analytics.import',
    targetType: 'analytics',
    detail: {
      platform: opts.platform,
      window: opts.window,
      filename: opts.filename ?? null,
      total: totalRows,
      created,
      updated,
      unmatchedCount: unmatched.length,
      accounts: accountIds.size,
    },
  })

  // 反哺建议：导入成功后立即按最新数据刷新（失败不影响导入结果）
  let suggestions = 0
  try {
    const { refreshSuggestions } = await import('./suggestions.js')
    suggestions = await refreshSuggestions({ window: opts.window, operator: opts.operator }, db)
  } catch {
    /* 建议刷新失败不回滚导入 */
  }

  return {
    platform: opts.platform,
    window: opts.window,
    total: totalRows,
    imported: matched.length,
    created,
    updated,
    unmatchedCount: unmatched.length,
    rejectedCount: parsed.rejected.length,
    unmatched: unmatched.slice(0, 100),
    mapping: parsed.mapping,
    capturedAt: toDb(capturedAt),
    accounts: accountIds.size,
    suggestions,
  }
}
