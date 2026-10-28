import type { Db } from '../../db/index.js'
import { getDb } from '../../db/index.js'
import { toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { config } from '../../config.js'
import { recordOperation } from '../audit/repo.js'
import { computeNextCheck } from '../benchmark/accounts.js'

/**
 * 对标监控优先级一键降档（FR-M9 / AC-M9）。
 *
 * 一期只做手动一键（Q4）：爆款命中已监控的对标账号时，把 monitor_interval_hours
 * 沿 24 → 6 → 2 降一档，封顶 2 小时。不做自动联动——误判会放大 TikHub 抓取频率与费用。
 */

export interface PriorityResult {
  accountId: string
  nickname: string | null
  from: number
  to: number
  /** 已是最低档，未变更 */
  capped: boolean
  nextCheckAt: string
}

export async function raiseBenchmarkPriority(
  accountId: string,
  operator: string,
  db: Db = getDb(),
): Promise<PriorityResult> {
  const row = await db.get<{ id: string; nickname: string | null; monitor_interval_hours: number; removed_at: string | null }>(
    'SELECT `id`, `nickname`, `monitor_interval_hours`, `removed_at` FROM `benchmark_account` WHERE `id` = ?',
    [accountId],
  )
  if (!row || row.removed_at) throw err.notFound('对标账号不存在或已移出监控列表')

  const current = Number(row.monitor_interval_hours ?? 24)
  const ladder = [...config.analytics.benchmarkLadder].sort((a, b) => b - a) // [24, 6, 2]
  const lower = ladder.filter((h) => h < current)
  const next = lower.length ? Math.max(...lower) : Math.min(...ladder)
  const capped = next >= current

  if (!capped) {
    await db.run('UPDATE `benchmark_account` SET `monitor_interval_hours` = ?, `next_check_at` = ? WHERE `id` = ?', [
      next,
      toDb(computeNextCheck(next, utcNow())),
      accountId,
    ])
  }
  await recordOperation({
    operator,
    action: 'analytics.benchmark_priority',
    targetType: 'benchmark_account',
    targetId: accountId,
    detail: { from: current, to: capped ? current : next, capped },
  })

  return {
    accountId,
    nickname: row.nickname ?? null,
    from: current,
    to: capped ? current : next,
    capped,
    nextCheckAt: toDb(computeNextCheck(capped ? current : next, utcNow())),
  }
}
