import { QUEUE_NAMES, enqueue, nextScheduledRun, registerWorker, scheduleRepeatable } from '../../queue/index.js'
import { config } from '../../config.js'
import { getDb } from '../../db/index.js'
import { toDb } from '../../lib/time.js'
import { logger } from '../../log.js'
import { computeNextCheck, getAccount, listDueAccounts } from './accounts.js'
import { failFetch, fetchAccountVideos, recoverUncertainExtracts } from './fetch.js'

export const SWEEP_SCHEDULER_ID = 'benchmark-sweep-10m'

/** FR-B3 每 10 分钟扫描到期账号并逐个入队 */
export async function registerBenchmarkJobs(): Promise<void> {
  await recoverUncertainExtracts()

  await scheduleRepeatable(
    QUEUE_NAMES.benchmarkSweep,
    SWEEP_SCHEDULER_ID,
    Math.max(1, config.sweep.intervalMin) * 60_000,
    'sweep',
    {},
    { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
  )

  registerWorker(QUEUE_NAMES.benchmarkSweep, async () => runSweep())

  // 限流：并发上限与速率可配（默认并发 3、5 次/秒）
  registerWorker(
    QUEUE_NAMES.benchmarkFetch,
    async (job) => {
      const { accountId, reason, backfill } = job.data as {
        accountId: string
        reason: 'add' | 'schedule' | 'manual'
        backfill?: boolean
      }
      try {
        return await fetchAccountVideos(accountId, { reason, backfill })
      } catch (e) {
        await failFetch(accountId, e)
        throw e
      }
    },
    {
      concurrency: config.fetchQueue.concurrency,
      limiter: { max: Math.max(1, config.fetchQueue.ratePerSec), duration: 1000 },
    },
  )
}

export async function enqueueFetch(
  accountId: string,
  reason: 'add' | 'schedule' | 'manual',
  opts: { backfill?: boolean; advanceSchedule?: boolean } = {},
): Promise<void> {
  const db = getDb()
  // FR-B3 入队去重：jobId = fetch:{accountId}；入队时即推进 next_check_at，避免抓取未完成时被重复入队
  if (opts.advanceSchedule !== false) {
    const acc = await getAccount(accountId)
    if (acc) {
      await db.run('UPDATE `benchmark_account` SET `next_check_at` = ? WHERE `id` = ?', [
        toDb(computeNextCheck(acc.monitorIntervalHours)),
        accountId,
      ])
    }
  }
  await enqueue(
    QUEUE_NAMES.benchmarkFetch,
    'fetch',
    { accountId, reason, backfill: !!opts.backfill },
    {
      jobId: `fetch-${accountId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  )
}

export async function runSweep(): Promise<{ enqueued: number }> {
  const due = await listDueAccounts(50)
  for (const a of due) {
    try {
      await enqueueFetch(a.id, 'schedule')
    } catch (e) {
      logger.error({ accountId: a.id, err: (e as Error).message }, 'sweep.enqueue_failed')
    }
  }
  if (due.length) logger.info({ enqueued: due.length }, 'sweep.done')
  return { enqueued: due.length }
}

export async function nextSweepAt(): Promise<number | null> {
  return nextScheduledRun(QUEUE_NAMES.benchmarkSweep, SWEEP_SCHEDULER_ID)
}
