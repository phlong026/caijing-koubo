import { config } from '../../config.js'
import { QUEUE_NAMES, enqueue, nextScheduledRun, registerWorker, scheduleRepeatable } from '../../queue/index.js'
import { logger } from '../../log.js'
import { runFetchExclusive } from './service.js'

export const NEWS_SCHEDULER_ID = 'news-fetch-every-15m'

/** 15 分钟 repeatable 采集任务（FR-N1） */
export async function registerNewsJobs(): Promise<void> {
  await scheduleRepeatable(
    QUEUE_NAMES.newsFetch,
    NEWS_SCHEDULER_ID,
    Math.max(1, config.news.fetchIntervalMin) * 60_000,
    'fetch',
    { trigger: 'schedule' },
    { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
  )
  registerWorker(QUEUE_NAMES.newsFetch, async () => {
    const outcome = await runFetchExclusive()
    if (!outcome) {
      logger.warn('news.job_skipped_busy')
      return { skipped: 'busy' }
    }
    return outcome
  })
}

export async function triggerFetch(trigger: string): Promise<void> {
  await enqueue(
    QUEUE_NAMES.newsFetch,
    'fetch',
    { trigger },
    { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
  )
}

/** T1 验收：可查看下次执行时间 */
export async function nextFetchAt(): Promise<number | null> {
  return nextScheduledRun(QUEUE_NAMES.newsFetch, NEWS_SCHEDULER_ID)
}
