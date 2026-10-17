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

/** 数组去重 + 去空 */
export function uniq(arr: unknown[]): string[] {
  return Array.from(new Set(arr.filter(Boolean).map((x) => String(x))))
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 简单互斥锁：用于手动刷新与定时任务并发（P2-8） */
export class Mutex {
  private locked = false
  private key = ''
  constructor(private name = 'mutex') {}
  async run<T>(key: string, fn: () => Promise<T>, onBusy?: () => T | null): Promise<T | null> {
    if (this.locked && this.key === key) {
      if (onBusy) return onBusy()
      throw new Error(`${this.name}: 已有相同任务在执行（key=${key}）`)
    }
    this.locked = true
    this.key = key
    try {
      return await fn()
    } finally {
      this.locked = false
      this.key = ''
    }
  }
}
