import { randomUUID } from 'node:crypto'
import { startHeartbeat } from './heartbeat.js'
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

const instanceId = `${process.pid}-${randomUUID()}`
let stopHeartbeat: (() => Promise<void>) | undefined

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
 * 注册/更新 repeatable 任务。
 *
 * ── 为什么不是简单地每次 upsert ────────────────────────────────────
 *
 * BullMQ 的 `every` 模式在 Lua 里用 `nextMillis = prevMillis + every` 推进排期，
 * 而 `upsertJobScheduler` **每次调用都会读到上次存的 prevMillis 再往后加一个周期**。
 * 于是「每次启动都 upsert」= 每次重启把排期往后推一格。实测反复重启后，
 * delayed zset 里堆了 134 条、最晚排到了 23 万年之后（`+234595-01-03`），
 * 周期性采集彻底失效，同时 `news-fetch` 永远处于「有任务待执行」的假忙状态。
 *
 * 正确语义：
 *   - 已存在且周期未变 → **完全跳过**，什么都不做（真正的幂等）；
 *   - 已存在但周期变了 → `removeJobScheduler` 后重建，避免新旧叠加；
 *   - 不存在 → 建。
 *
 * 另注：`repeatOpts.limit` 是「总迭代次数上限」，不是「副本数」。设 limit:1 会让任务只跑一次，别用。
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
  const existing = await (q as any)
    .getJobSchedulers()
    .then((list: any[]) => list.find((s) => s.id === schedulerId || s.key === schedulerId))
    .catch(() => undefined)

  if (existing && Number(existing.every) === everyMs) {
    // 周期一致，保持现状。绝不能重复 upsert（会让排期不断后移）。
    logger.info({ queue: queueName, schedulerId, everyMs, next: existing.next }, 'queue.schedule_kept')
    return
  }

  if (existing) {
    // 周期变了：先摘掉旧的，再重建，避免 prevMillis 叠加。
    await (q as any).removeJobScheduler(schedulerId).catch(() => {})
    logger.info({ queue: queueName, schedulerId, oldEvery: existing.every, everyMs }, 'queue.schedule_replaced')
  }

  await (q as any).upsertJobScheduler(
    schedulerId,
    { every: everyMs },
    {
      name: jobName,
      data,
      opts: { removeOnComplete: 100, removeOnFail: 200, ...opts },
    },
  )
  logger.info({ queue: queueName, schedulerId, everyMs }, 'queue.scheduled')
}

/**
 * 一次性体检：清理某 scheduler 下陈旧的预生成副本。
 *
 * 只在显式调用时执行（不挂在启动路径上），避免误删 BullMQ 正在使用的排期。
 * 用于升级后清理历史残留。判定「陈旧」的条件：该 hash 的 `timestamp` 早于 7 天前。
 */
export async function pruneStaleRepeatKeys(
  queueName: QueueName,
  schedulerId: string,
  olderThanMs = 7 * 24 * 60 * 60 * 1000,
): Promise<number> {
  const base = `${config.queuePrefix}:${queueName}:repeat:${schedulerId}`
  const cutoff = Date.now() - olderThanMs
  try {
    const keys = await redis.keys(`${base}:*`)
    const stale: string[] = []
    for (const k of keys) {
      const raw = await redis.hget(k, 'timestamp')
      const ts = raw ? Number(raw) : Number.NaN
      // 没有 timestamp 字段的（老格式）也一并视为可清理
      if (!Number.isFinite(ts) || ts < cutoff) stale.push(k)
    }
    if (!stale.length) return 0
    await redis.del(...stale)
    logger.info({ queue: queueName, schedulerId, pruned: stale.length }, 'queue.repeat_pruned')
    return stale.length
  } catch (e) {
    logger.debug({ err: (e as Error).message }, 'queue.repeat_prune_skipped')
    return 0
  }
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
  // FR-B3 入队去重：**必须用 deduplication**，不要用固定 jobId。
  // BullMQ 5.x 的 jobId 语义是「同 id 的任务哈希存在即视为重复」（含已完成/已失败但未清理的
  // 任务），配合 removeOnComplete 会把后续所有入队静默丢弃。deduplication.id 只在任务
  // 未结束时去重，任务落地后自动释放，正是周期任务与「失败重试」需要的语义。
  const job = await q.add(jobName, data, opts)
  return job ?? null
}

/**
 * 生成「仅未完成时去重」的 job 配置。
 * 用法：入队时传 `{ ...dedupOpts(`fetch-${accountId}`), attempts: 3 }`，不要设置 jobId。
 */
export function dedupOpts(id: string): JobsOptions {
  return { deduplication: { id } } as JobsOptions
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
  await stopHeartbeat?.()
  stopHeartbeat = undefined
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
  const key = `${config.queuePrefix}:instance:${instanceId}`
  if (!stopHeartbeat) {
    stopHeartbeat = startHeartbeat(redis, key, dbTag, (e) => {
      logger.debug({ err: String(e) }, 'queue.instance_heartbeat_failed')
    })
  }
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
  } catch (e) {
    logger.debug({ err: (e as Error).message }, 'queue.instance_check_skipped')
  }
}

