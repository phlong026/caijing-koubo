import { QUEUE_NAMES, dedupOpts, enqueue, nextScheduledRun, registerWorker, scheduleRepeatable } from '../../queue/index.js'
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
        // FR-B3：全部重试失败才计一次「周期失败」。attemptsMade 从 0 开始，
        // 最后一次尝试时 attemptsMade + 1 === attempts，此前的尝试不计失败。
        const maxAttempts = job.opts.attempts ?? 1
        if (job.attemptsMade + 1 >= maxAttempts) await failFetch(accountId, e)
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
  // FR-B3 入队去重：用 deduplication（仅任务未结束时去重），**不能用固定 jobId**——
  // BullMQ 5.x 对 jobId 的去重是「同 id 任务哈希存在即忽略」，已完成/已失败但未清理的
  // 任务会永久占位，导致后续每一轮 sweep 与「立即检查」都被静默吞掉（P0-1）。
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
      ...dedupOpts(`fetch-${accountId}`),
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
