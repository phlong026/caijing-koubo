/**
 * 内存队列适配器（无 Redis 降级）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 爆款选题的全部异步链路都建立在队列之上：
 *   资讯定时采集 → 选题生成（LLM，分钟级）→ 视频提取（下载/转写/上传）→ 文案生成
 *
 * 原先只要 Redis 连不上，`index.ts` 就整块跳过队列注册，服务退化为「只读 + 手动同步采集」，
 * 选题生成、视频提取、文案生成**全部不可用**。这在两种场景下都很致命：
 *   1. 本地开发/验收环境没有 Redis（本机 Docker 引擎起不来时就是死局）；
 *   2. 生产环境 Redis 抖动时，业务直接瘫一半。
 *
 * 这里提供一个**进程内**队列实现，语义与 BullMQ 对齐到「够用」的程度：
 *   - enqueue       ：投递任务，按 deduplication.id 去重（仅未完成时）
 *   - registerWorker：注册消费者，按 concurrency 并发消费
 *   - scheduleRepeatable：周期任务（setTimeout 自续期）
 *   - attempts/backoff：失败重试与指数退避
 *
 * ── 与 BullMQ 的刻意的差异 ──────────────────────────────────────
 *
 * - **不持久化**：进程重启后未执行的任务丢失。这是降级模式固有的取舍，
 *   所以启动时必须打醒目告警，且 `/health` 明确标注 `queue:"memory"`，
 *   绝不让人误以为跑的是生产级队列。
 * - **单实例**：只在当前进程内有效，多实例部署下任务不会被其他实例消费。
 * - **不实现 removeOnComplete 等存储策略**：内存里只保留有限条历史用于统计。
 *
 * ── 为什么不去掉 BullMQ 直接用内存 ──────────────────────────────
 *
 * Redis 可用时仍走 BullMQ：需要跨进程/跨重启的可靠性、以及多实例下的分布式锁。
 * 内存队列是**降级兜底**，不是替代品。
 */
import { logger } from '../log.js'

export interface MemoryJob<T = any> {
  id: string
  name: string
  data: T
  /** 已失败的次数（从 0 开始），与 BullMQ 语义一致 */
  attemptsMade: number
  opts: { attempts?: number; backoff?: { type: string; delay: number } }
  timestamp: number
}

type Processor = (job: MemoryJob) => Promise<unknown>

interface WorkerEntry {
  processor: Processor
  concurrency: number
  running: number
}

interface QueueEntry {
  waiting: MemoryJob[]
  worker?: WorkerEntry
  /** 当前未完成任务（waiting + running）的 dedup id → job.id */
  dedup: Map<string, string>
  stats: { completed: number; failed: number }
  timer?: NodeJS.Timeout
  timerName?: string
}

const queues = new Map<string, QueueEntry>()
let seq = 0

function entry(name: string): QueueEntry {
  let q = queues.get(name)
  if (!q) {
    q = { waiting: [], dedup: new Map(), stats: { completed: 0, failed: 0 } }
    queues.set(name, q)
  }
  return q
}

function nextId(name: string): string {
  seq += 1
  return `mem-${name}-${Date.now().toString(36)}-${seq}`
}

/** worker 消费循环：按 concurrency 补位 */
function pump(queueName: string): void {
  const q = entry(queueName)
  const w = q.worker
  if (!w) return
  while (w.running < w.concurrency && q.waiting.length) {
    const job = q.waiting.shift()!
    w.running += 1
    void (async () => {
      const maxAttempts = job.opts.attempts ?? 1
      try {
        await w.processor(job)
        q.stats.completed += 1
        q.dedup.delete(`job:${job.id}`)
        for (const [k, v] of q.dedup) if (v === job.id) q.dedup.delete(k)
        logger.debug({ queue: queueName, jobId: job.id, name: job.name }, 'memjob.completed')
      } catch (e: any) {
        job.attemptsMade += 1
        logger.error(
          { queue: queueName, jobId: job.id, name: job.name, attempt: job.attemptsMade, maxAttempts, err: e?.message },
          'memjob.failed',
        )
        if (job.attemptsMade < maxAttempts) {
          // 指数退避重投；重投期间仍算「未完成」，保留 dedup 占位
          const base = job.opts.backoff?.delay ?? 1000
          const delay = job.opts.backoff?.type === 'exponential' ? base * 2 ** (job.attemptsMade - 1) : base
          setTimeout(() => {
            q.waiting.push(job)
            pump(queueName)
          }, delay).unref?.()
        } else {
          q.stats.failed += 1
          for (const [k, v] of q.dedup) if (v === job.id) q.dedup.delete(k)
        }
      } finally {
        w.running -= 1
        pump(queueName)
      }
    })()
  }
}

/** 投递任务；返回 null 表示因去重被跳过（与 BullMQ 行为一致） */
export function memEnqueue(
  queueName: string,
  jobName: string,
  data: Record<string, unknown>,
  opts: { deduplication?: { id?: string }; attempts?: number; backoff?: { type: string; delay: number } } = {},
): MemoryJob | null {
  const q = entry(queueName)
  const dedupId = opts.deduplication?.id
  if (dedupId) {
    const existing = q.dedup.get(`dedup:${dedupId}`)
    if (existing) {
      logger.debug({ queue: queueName, name: jobName, dedupId, existing }, 'memjob.deduped')
      return null
    }
  }
  const job: MemoryJob = {
    id: nextId(queueName),
    name: jobName,
    data,
    attemptsMade: 0,
    opts: { attempts: opts.attempts, backoff: opts.backoff },
    timestamp: Date.now(),
  }
  if (dedupId) q.dedup.set(`dedup:${dedupId}`, job.id)
  q.dedup.set(`job:${job.id}`, job.id)
  q.waiting.push(job)
  logger.debug({ queue: queueName, jobId: job.id, name: jobName }, 'memjob.enqueued')
  pump(queueName)
  return job
}

export function memRegisterWorker(queueName: string, processor: Processor, concurrency = 1): void {
  const q = entry(queueName)
  q.worker = { processor, concurrency, running: 0 }
  // 已有积压时立刻开跑（worker 可能在任务之后注册）
  pump(queueName)
}

/** 周期任务：first run 立即执行，之后每 everyMs 一次 */
export function memScheduleRepeatable(
  queueName: string,
  schedulerId: string,
  everyMs: number,
  jobName: string,
  data: Record<string, unknown> = {},
): void {
  const q = entry(queueName)
  if (q.timer) clearInterval(q.timer)
  q.timer = setInterval(() => {
    memEnqueue(queueName, jobName, data)
  }, everyMs)
  q.timer.unref?.()
  q.timerName = schedulerId
  logger.info({ queue: queueName, schedulerId, everyMs }, 'memqueue.scheduled')
}

export function memQueueStats(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const [name, q] of queues) {
    out[name] = {
      waiting: q.waiting.length,
      active: q.worker?.running ?? 0,
      completed: q.stats.completed,
      failed: q.stats.failed,
    }
  }
  return out
}

export function memCloseQueues(): void {
  for (const q of queues.values()) {
    if (q.timer) clearInterval(q.timer)
  }
  queues.clear()
}
