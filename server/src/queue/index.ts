import { randomUUID } from 'node:crypto'
import { startHeartbeat } from './heartbeat.js'
import { Redis } from 'ioredis'
import { Queue, QueueEvents, Worker, type Job, type JobsOptions, type WorkerOptions } from 'bullmq'
import { config } from '../config.js'
import { logger } from '../log.js'
import { memCloseQueues, memEnqueue, memQueueStats, memRegisterWorker, memScheduleRepeatable } from './memory.js'

/**
 * 队列后端选择。
 *
 * `redis`  —— 默认，BullMQ（跨进程、可持久、支持多实例）
 * `memory` —— 降级，进程内队列（无 Redis 时仍然让选题生成/视频提取/文案生成可用）
 *
 * 由 `probeRedis()` 在启动时确定，之后 `enqueue` / `registerWorker` /
 * `scheduleRepeatable` 三个出口按此分流。这样上层业务代码完全不需要感知后端差异。
 */
export type QueueBackend = 'redis' | 'memory'
let backend: QueueBackend = 'redis'

export function getQueueBackend(): QueueBackend {
  return backend
}

/** 由启动流程显式设置；设为 memory 时同时把 redisHealthy 置 false */
export function setQueueBackend(b: QueueBackend): void {
  backend = b
  if (b === 'memory') redisHealthy = false
  logger.warn({ backend: b }, b === 'memory' ? 'queue.backend_memory：使用进程内队列（不持久化、单实例）' : 'queue.backend_redis')
}

/** BullMQ 连接：maxRetriesPerRequest 必须为 null（长任务要求） */
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  db: config.redis.db,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
})

/**
 * Redis 连接健康标记。
 * 连不上时 BullMQ 会持续重连并刷日志，这里做两件事：
 *   1. 错误日志降频（只打第一次和每 60 秒一次），避免刷屏淹没真正的业务日志；
 *   2. 让 enqueue 快速失败而不是挂在无限重试上。
 */
let redisHealthy = false
let lastRedisErrorLog = 0

redis.on('error', (e: Error) => {
  const now = Date.now()
  if (now - lastRedisErrorLog > 60_000) {
    lastRedisErrorLog = now
    logger.error({ err: e.message, host: config.redis.host, port: config.redis.port }, 'redis.error')
  }
})
redis.on('ready', () => {
  redisHealthy = true
  logger.info({ host: config.redis.host, port: config.redis.port }, 'redis.connected')
})
redis.on('close', () => {
  redisHealthy = false
})

/** Redis 当前是否可用（供路由层决定是否走队列） */
export function isRedisHealthy(): boolean {
  return redisHealthy && redis.status === 'ready'
}

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
  // 降级后端：内存定时器，幂等由「同 schedulerId 只保留一个 timer」保证
  if (backend === 'memory') {
    memScheduleRepeatable(queueName, schedulerId, everyMs, jobName, data)
    return
  }
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
  // 内存后端没有「下次排期」的概念（timer 自续期），返回 null 表示未知
  if (backend === 'memory') return null
  // Redis 不可用时直接返回 null，避免调用方挂在 BullMQ 的重连上
  if (!isRedisHealthy()) return null
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
  if (backend === 'memory') {
    // 内存后端永不「失败」：只要进程活着就能执行，无需关心 Redis
    const job = memEnqueue(queueName, jobName, data, opts as any)
    return job as unknown as Job | null
  }
  // Redis 不可用时立刻失败，不要把调用方挂在 BullMQ 的无限重连上
  if (!isRedisHealthy()) {
    throw new Error(`Redis 不可用（${config.redis.host}:${config.redis.port}），无法入队 ${queueName}/${jobName}`)
  }
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
  if (backend === 'memory') {
    memRegisterWorker(queueName, processor as any, opts.concurrency ?? 1)
    return undefined as unknown as Worker
  }
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
  if (backend === 'memory') return memQueueStats()
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
  memCloseQueues()
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

