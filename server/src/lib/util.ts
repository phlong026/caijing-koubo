import { randomUUID } from 'node:crypto'

/** 业务主键：带前缀、可排序性无关、便于日志定位 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export interface PageQuery {
  page: number
  pageSize: number
  offset: number
  limit: number
}

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export function parsePaging(q: Record<string, unknown>, defaultSize = 20, maxSize = 100): PageQuery {
  const page = Math.max(1, Number(q.page ?? 1) || 1)
  const raw = Number(q.pageSize ?? defaultSize) || defaultSize
  const pageSize = Math.min(maxSize, Math.max(1, raw))
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize }
}

export function pageResult<T>(items: T[], total: number, p: PageQuery): PageResult<T> {
  return { items, total, page: p.page, pageSize: p.pageSize }
}

/** JSON 列读写 */
export function jenc(v: unknown): string | null {
  if (v === undefined || v === null) return null
  return JSON.stringify(v)
}
export function jdec<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return fallback
  }
}

export function toInt(v: unknown, def = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : def
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * 关键词「包含」匹配的 LIKE 参数：转义 % _ 与转义符本身，配合 `LIKE ? ESCAPE '!'` 使用。
 * 用 `!` 而非反斜杠作转义符，MySQL 与 SQLite 对字符串字面量的解释一致。
 */
export function likeContains(keyword: string): string {
  return `%${keyword.replace(/[!%_]/g, '!$&')}%`
}

/** 数组去重 + 去空 */
export function uniq(arr: unknown[]): string[] {
  return Array.from(new Set(arr.filter(Boolean).map((x) => String(x))))
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 简单互斥锁：用于手动刷新与定时任务并发（P2-8）。
 *
 * ⚠️ 已踩坑：早期实现是「已锁定就直接返回 busy」，这在采集变慢后是致命的——
 * 接入 FinStep 后单轮采集要 60~90s（两个源各一次 LLM ReAct），期间任何手动刷新
 * 都拿到 202 busy，前端表现为「点了刷新没反应」，smoke 也永远等不到 200。
 *
 * 正确语义分两种，由调用方选择：
 *   - `run(key, fn, onBusy)`：**立即失败**（onBusy 返回兜底值）。适合「重复触发无意义」的场景；
 *   - `runQueued(key, fn, waitMs)`：**排队等待**，拿到锁后再执行。适合「用户主动点击、期望有结果」的场景。
 */
export class Mutex {
  /**
   * 每个 key 独立加锁（P2-13d）：key → 等待队列；Map 中有该 key 即表示被占用。
   * 原实现只有一个全局 locked / key：不同 key 并发时第二个调用不等待且覆盖 key，
   * 先结束的一方会把锁整体释放，而另一方仍在执行。
   */
  private held = new Map<string, Array<() => void>>()
  constructor(private name = 'mutex') {}

  async run<T>(key: string, fn: () => Promise<T>, onBusy?: () => T | null): Promise<T | null> {
    if (this.held.has(key)) {
      if (onBusy) return onBusy()
      throw new Error(`${this.name}: 已有相同任务在执行（key=${key}）`)
    }
    this.held.set(key, [])
    try {
      return await fn()
    } finally {
      this.release(key)
    }
  }

  /**
   * 排队版：同一 key 的并发请求按到达顺序串行执行。
   * 超过 `waitMs` 仍未拿到锁则放弃（返回 onTimeout 的值），避免请求无限挂起。
   */
  async runQueued<T>(
    key: string,
    fn: () => Promise<T>,
    waitMs = 120_000,
    onTimeout?: () => T | null,
  ): Promise<T | null> {
    if (!this.held.has(key)) {
      this.held.set(key, [])
    } else {
      const acquired = await this.waitForHandoff(key, waitMs)
      if (!acquired) return onTimeout ? onTimeout() : null
    }
    try {
      return await fn()
    } finally {
      this.release(key)
    }
  }

  /** 当前是否有任一 key 被占用 */
  get busy(): boolean {
    return this.held.size > 0
  }

  /** 等待持有者释放；释放时锁直接移交给队首等待者，中间不会被其它调用插队 */
  private waitForHandoff(key: string, waitMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const onWake = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        if (done) return
        done = true
        const queue = this.held.get(key)
        if (queue) this.held.set(key, queue.filter((w) => w !== onWake))
        resolve(false)
      }, waitMs)
      this.held.get(key)!.push(onWake)
    })
  }

  private release(key: string): void {
    const queue = this.held.get(key)
    const next = queue?.shift()
    if (next) next()
    else this.held.delete(key)
  }
}
