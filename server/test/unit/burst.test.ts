import { describe, expect, it } from 'vitest'
import { createBurstCounter } from '../../src/lib/burst.js'

describe('createBurstCounter（P3-5）', () => {
  it('窗口内累计，超出窗口的旧记录不再计数', () => {
    const c = createBurstCounter(60_000)
    expect(c.hit(0)).toBe(1)
    expect(c.hit(10_000)).toBe(2)
    expect(c.hit(59_999)).toBe(3)
    // 0 时刻那次在 60_000 时刚好滑出窗口
    expect(c.hit(60_000)).toBe(3)
    expect(c.count(200_000)).toBe(0)
  })

  it('间隔分散的偶发事件始终只计 1', () => {
    const c = createBurstCounter(60_000)
    for (let i = 0; i < 5; i++) expect(c.hit(i * 61_000)).toBe(1)
  })
})
