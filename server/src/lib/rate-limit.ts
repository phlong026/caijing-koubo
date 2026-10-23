/**
 * 令牌桶限流（P2-12）：按「规则 + 操作人」计数，进程内实现。
 * 多实例部署时每个实例各自计数（上限按实例数放大），对防误操作 / 防刷量足够；
 * 需要严格全局配额时再迁到 Redis。
 */

interface Bucket {
  tokens: number
  updatedAt: number
}

export interface RateRule {
  /** 每分钟允许的次数（也是桶容量，允许短时突发） */
  perMinute: number
}

const buckets = new Map<string, Bucket>()

/** 取一个令牌；不足时返回需要等待的秒数 */
export function takeToken(key: string, rule: RateRule, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
  const capacity = Math.max(1, rule.perMinute)
  const refillPerMs = capacity / 60_000
  const b = buckets.get(key) ?? { tokens: capacity, updatedAt: now }
  b.tokens = Math.min(capacity, b.tokens + (now - b.updatedAt) * refillPerMs)
  b.updatedAt = now
  if (b.tokens >= 1) {
    b.tokens -= 1
    buckets.set(key, b)
    return { ok: true }
  }
  buckets.set(key, b)
  return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / refillPerMs / 1000) }
}

/** 清理长时间未用的桶，避免 Map 无限增长 */
export function pruneBuckets(maxIdleMs = 10 * 60_000, now = Date.now()): void {
  for (const [key, b] of buckets) if (now - b.updatedAt > maxIdleMs) buckets.delete(key)
}

export function resetBuckets(): void {
  buckets.clear()
}
