import { config } from '../../config.js'
import { QUEUE_NAMES, registerWorker, scheduleRepeatable } from '../../queue/index.js'
import { logger } from '../../log.js'
import { recordOperation } from '../audit/repo.js'
import { getDb } from '../../db/index.js'
import { isApiError } from '../../errors.js'
import { toDb, utcNow } from '../../lib/time.js'
import { METRIC_WINDOWS, WINDOW_LABELS, type MetricWindow } from './types.js'
import { listDueLogs, recalcHotForAccounts, upsertSnapshot } from './snapshot.js'
import { getProvider, providerStatus } from './provider.js'

/**
 * T+1 / T+7 采集调度（FR-M4 / AC-M4）。
 *
 * 语义：
 *  - 扫描「窗口已到期但该窗口无快照」的已发布记录；
 *  - 交给 Provider 采集；Provider 未启用时把这些记录登记为 pending 明细（不写空快照、不报错）；
 *  - 已有快照的记录永不被重复采集（listDueLogs 的 NOT EXISTS 保证）；
 *  - 自动化只影响本域队列，异常不外溢（AC-R2）。
 */

export const ANALYTICS_SCHEDULER_ID = 'analytics-collect'

export interface PendingItem {
  publishLogId: string
  window: MetricWindow
  reason: string
}

export interface CollectOutcome {
  window: MetricWindow
  due: number
  collected: number
  pending: PendingItem[]
  provider: string
  message: string
}

export async function runCollect(
  opts: { window?: MetricWindow; operator?: string } = {},
): Promise<{ windows: CollectOutcome[]; provider: { name: string; available: boolean; hint: string } }> {
  const db = getDb()
  const windows = opts.window ? [opts.window] : METRIC_WINDOWS
  const provider = getProvider()
  const results: CollectOutcome[] = []

  for (const window of windows) {
    const due = await listDueLogs(window, db)
    if (!due.length) {
      results.push({
        window,
        due: 0,
        collected: 0,
        pending: [],
        provider: provider.name,
        message: `${WINDOW_LABELS[window]} 窗口暂无到期未采集的记录`,
      })
      continue
    }

    let collected = 0
    const pending: PendingItem[] = []
    if (provider.available()) {
      try {
        const metrics = await provider.collect(
          window,
          due.map((l) => ({ publishLogId: l.id, platform: l.platform, accountId: l.account_id })),
        )
        const accounts = new Set<string>()
        for (const m of metrics) {
          await upsertSnapshot(
            {
              publishLogId: m.publishLogId,
              platform: m.platform,
              accountId: m.accountId,
              window,
              metrics: m.values,
              source: 'provider',
              capturedAt: utcNow(),
            },
            db,
          )
          accounts.add(m.accountId)
          collected += 1
        }
        if (accounts.size) await recalcHotForAccounts(Array.from(accounts), [window], db)
      } catch (e) {
        // Provider 已启用但采集失败：全部转 pending，保留原因
        const reason = isApiError(e) ? e.message : (e as Error).message
        for (const l of due) pending.push({ publishLogId: l.id, window, reason })
      }
    } else {
      const reason = `${provider.name === 'csv' ? '当前为 CSV 人工导入' : '创作者中心自动回采未启用'}，请导入回采数据`
      for (const l of due) pending.push({ publishLogId: l.id, window, reason })
    }

    await recordOperation({
      operator: opts.operator ?? 'system',
      action: 'analytics.collect',
      targetType: 'analytics',
      detail: { window, due: due.length, collected, pending: pending.length, provider: provider.name },
    })

    results.push({
      window,
      due: due.length,
      collected,
      pending: pending.slice(0, 50),
      provider: provider.name,
      message: collected
        ? `${WINDOW_LABELS[window]} 窗口采集到 ${collected} 条`
        : `${WINDOW_LABELS[window]} 窗口 ${due.length} 条到期记录待回采（${provider.name === 'csv' ? 'CSV 导入' : 'Provider 未启用'}）`,
    })
  }

  return { windows: results, provider: providerStatus() }
}

/** 注册周期采集任务（默认 30 分钟一轮，config.analytics.sweepIntervalMs） */
export async function registerAnalyticsJobs(): Promise<void> {
  await scheduleRepeatable(
    QUEUE_NAMES.metricCollect,
    ANALYTICS_SCHEDULER_ID,
    Math.max(60_000, config.analytics.sweepIntervalMs),
    'collect',
    { trigger: 'schedule' },
    { attempts: 2, backoff: { type: 'exponential', delay: 10_000 } },
  )
  registerWorker(QUEUE_NAMES.metricCollect, async (job) => {
    const trigger = String((job.data as { trigger?: string } | undefined)?.trigger ?? 'schedule')
    try {
      const out = await runCollect({ operator: 'system' })
      logger.info(
        { trigger, windows: out.windows.map((w) => ({ w: w.window, due: w.due, collected: w.collected })) },
        'analytics.collect_done',
      )
      return { ok: true }
    } catch (e) {
      // 采集失败只影响本域：记录日志，不向外抛（AC-R2）
      logger.error({ trigger, err: (e as Error).message }, 'analytics.collect_failed')
      return { ok: false, error: (e as Error).message }
    }
  })
}

/** 供 overview 显示的调度状态（最近采集时间由快照表推导，见 snapshot.lastCapturedAt） */
export function schedulerStatus(): { intervalMs: number; windowHours: { t1: number; t7: number }; now: string } {
  return {
    intervalMs: config.analytics.sweepIntervalMs,
    windowHours: { t1: config.analytics.t1DelayHours, t7: config.analytics.t7DelayHours },
    now: toDb(utcNow()),
  }
}
