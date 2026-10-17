import { Redis } from 'ioredis'
import { Queue, QueueEvents, Worker, type Job, type JobsOptions, type WorkerOptions } from 'bullmq'
import { config } from '../config.js'
import { logger } from '../log.js'

/** BullMQ 连接：maxRetriesPerRequest 必须为 null（长任务要求） */
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  db: config.redis.db,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
})

redis.on('error', (e: Error) => logger.error({ err: e.message }, 'redis.error'))
redis.on('connect', () => logger.info({ host: config.redis.host, port: config.redis.port }, 'redis.connected'))

export const QUEUE_NAMES = {
  newsFetch: 'news-fetch',
  topicGenerate: 'topic-generate',
  benchmarkFetch: 'benchmark-fetch',
  benchmarkSweep: 'benchmark-sweep',
  scriptExtract: 'script-extract',
  copyGenerate: 'copy-generate',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

const queueMap = new Map<string, Queue>()
const workerMap = new Map<string, Worker>()

export function getQueue(name: QueueName): Queue {
  const key = name
  if (!queueMap.has(key)) {
    queueMap.set(
      key,
      new Queue(name, {
        connection: redis as any,
        prefix: config.queuePrefix,
        defaultJobOptions: { removeOnComplete: 500, removeOnFail: 1000 },
      }),
    )
  }
  return queueMap.get(key)!
}

export function getQueueEvents(name: QueueName): QueueEvents {
  return new QueueEvents(name, { connection: redis as any, prefix: config.queuePrefix })
}

/**
 * 注册/更新 repeatable 任务（幂等：同一 schedulerId 重复调用只更新，不产生重复任务）。
 * BullMQ v5 推荐用 Job Scheduler（替代已废弃的 repeat + every）。
 */
export async function scheduleRepeatable(
  queueName: QueueName,
  schedulerId: string,
  everyMs: number,
  jobName: string,
  data: Record<string, unknown> = {},
  opts: JobsOptions = {},
): Promise<void> {
  const q = getQueue(queueName)
  await (q as any).upsertJobScheduler(schedulerId, { every: everyMs }, { name: jobName, data, opts })
  logger.info({ queue: queueName, schedulerId, everyMs }, 'queue.scheduled')
}

export async function nextScheduledRun(queueName: QueueName, schedulerId: string): Promise<number | null> {
  const q = getQueue(queueName)
  const schedulers = await q.getJobSchedulers()
  const s = schedulers.find((x) => x.id === schedulerId || x.key === schedulerId) as
    | { next?: number | string }
    | undefined
  const ms = s?.next !== undefined ? Number(s.next) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

export async function enqueue(
  queueName: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  opts: JobsOptions = {},
): Promise<Job | null> {
  const q = getQueue(queueName)
  // FR-B3 入队去重：同一 jobId 未完成时不会重复入队
  const job = await q.add(jobName, data, opts)
  return job ?? null
}

export function registerWorker(
  queueName: QueueName,
  processor: (job: Job) => Promise<unknown>,
  opts: Partial<WorkerOptions> = {},
): Worker {
  if (workerMap.has(queueName)) return workerMap.get(queueName)!
  const worker = new Worker(queueName, processor as any, {
    connection: redis as any,
    prefix: config.queuePrefix,
    concurrency: opts.concurrency ?? 1,
    limiter: opts.limiter,
    ...opts,
  })
  worker.on('failed', (job, err) => {
    logger.error({ queue: queueName, jobId: job?.id, name: job?.name, err: err?.message }, 'job.failed')
  })
  worker.on('completed', (job) => {
    logger.debug({ queue: queueName, jobId: job.id, name: job.name }, 'job.completed')
  })
  workerMap.set(queueName, worker)
  return worker
}

export async function queueStats(): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {}
  for (const name of Object.values(QUEUE_NAMES)) {
    try {
      const q = getQueue(name)
      const counts = await q.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
        'prioritized',
      )
      out[name] = counts as Record<string, number>
    } catch (e) {
      out[name] = { error: 1 }
    }
  }
  return out
}

export async function closeQueues(): Promise<void> {
  for (const w of workerMap.values()) await w.close().catch(() => {})
  for (const q of queueMap.values()) await q.close().catch(() => {})
  workerMap.clear()
  queueMap.clear()
}

/**
 * 队列前缀冲突自检（D9 / 本地多实例防护）。
 *
 * 多个 server 实例若共用同一 Redis 前缀、却各自连不同的库（如 8787 用 dev.db、
 * 8788 用 verify/api.db），BullMQ 的 job 会被**任意一个**实例抢到消费，结果就是
 * 「任务已入队、有实例执行过，但发起方库里状态永远 pending」——极难排查。
 *
 * 这里用 `<prefix>:instance:<id>` 心跳键登记当前实例（含库标识），启动时若发现
 * 已有其他库的实例在跑，打醒目告警并要求用 QUEUE_PREFIX 隔离。
 */
export async function warnIfQueuePrefixShared(): Promise<void> {
  const dbTag =
    config.db.driver === 'mysql'
      ? `mysql:${config.db.host}:${config.db.port}/${config.db.database}`
      : `sqlite:${config.db.sqlitePath}`
  const key = `${config.queuePrefix}:instance:${process.pid}`
  try {
    // 列出同前缀下的其他实例心跳
    const keys = await redis.keys(`${config.queuePrefix}:instance:*`)
    const others: string[] = []
    for (const k of keys) {
      if (k === key) continue
      const v = await redis.get(k)
      if (v && v !== dbTag) others.push(`${k.replace(`${config.queuePrefix}:instance:`, 'pid=')}=>${v}`)
    }
    if (others.length) {
      logger.warn(
        { self: dbTag, others, queuePrefix: config.queuePrefix },
        'queue.prefix_shared_across_dbs：检测到其他实例共用同一 QUEUE_PREFIX 但连的是不同数据库，' +
          'job 可能被错误实例消费导致状态长期 pending。请为每个实例设置不同的 QUEUE_PREFIX（或 REDIS_DB）。',
      )
    }
    // 登记心跳（不带 TTL，实例退出时删除；异常退出留下的陈旧条目只用于提示，不影响运行）
    await redis.set(key, dbTag)
    process.once('beforeExit', () => void redis.del(key).catch(() => {}))
  } catch (e) {
    logger.debug({ err: (e as Error).message }, 'queue.instance_check_skipped')
  }
}
