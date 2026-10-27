import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import {
  computeSimilarity,
  createSimilarityScorer,
  normalizeForSimilarity,
  similarityRanges,
} from '../../src/modules/copy/text.js'

const original =
  '大家好，今天聊一个很多人忽略的问题。基金定投适合长期坚持，不要因为短期波动就放弃。先看规则，再看收益，顺序不能反。'

describe('createSimilarityScorer（实时原创度）', () => {
  it('与预检查重同一口径：同样的输入得到同样的相似度', () => {
    const rewritten = '朋友们，基金定投适合长期坚持，不要因为短期波动就放弃，这是我的看法。'
    const live = createSimilarityScorer(original, 'persona')(rewritten)
    const check = computeSimilarity(original, rewritten, 'persona')
    expect(live.similarity).toBe(check.similarity)
    expect(live.blocked).toBe(check.blocked)
    expect(live.threshold).toBe(check.threshold)
  })

  it('完全照搬接近 100%，完全改写为 0', () => {
    const score = createSimilarityScorer(original, 'persona')
    expect(score(original).similarity).toBeGreaterThan(0.95)
    expect(score('这是一段完全不同的内容，讲的是怎样给孩子准备教育金，不涉及原文任何句子。').similarity).toBe(0)
  })

  it('只有素人线超过阈值才算被拦，其他线只提示', () => {
    for (const [line, blocked] of [['persona', true], ['kos', false], ['manager', false], [null, false]] as const) {
      expect(createSimilarityScorer(original, line)(original).blocked).toBe(blocked)
    }
  })

  it('改写稿或原文太短时记 0，不会误拦', () => {
    expect(createSimilarityScorer(original, 'persona')('定投').similarity).toBe(0)
    expect(createSimilarityScorer('', 'persona')(original).similarity).toBe(0)
  })

  it('原文只建一次集合，可对多份稿连续打分', () => {
    const score = createSimilarityScorer(original, 'kos')
    const a = score(original).similarity
    const b = score('基金定投适合长期坚持，换一种完全不同的说法来讲讲。').similarity
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(0)
  })
})

describe('similarityRanges（重合片段的位置）', () => {
  const n = config.copy.similarityN

  it('返回的区间落在稿文本里，且取出的片段归一化后确实出现在原文中', () => {
    const text = '朋友们，基金定投适合长期坚持，不要因为短期波动就放弃，对吧。'
    const ranges = similarityRanges(original, [{ index: 0, text }])
    expect(ranges.length).toBeGreaterThan(0)
    const src = normalizeForSimilarity(original)
    for (const r of ranges) {
      expect(r.sectionIndex).toBe(0)
      const piece = text.slice(r.start, r.end)
      expect(normalizeForSimilarity(piece).length).toBeGreaterThanOrEqual(n)
      expect(src).toContain(normalizeForSimilarity(piece))
    }
    // 开头的「朋友们」是新写的，不应落进重合区间
    expect(ranges[0]!.start).toBeGreaterThan(text.indexOf('，'))
  })

  it('中间只隔标点的重合连成一段；被新写内容隔开的是两段', () => {
    const joined = similarityRanges(original, [{ index: 0, text: '基金定投适合长期坚持，不要因为短期波动就放弃' }])
    expect(joined).toHaveLength(1)
    const split = similarityRanges(original, [
      { index: 0, text: '基金定投适合长期坚持，我自己的补充是先攒应急金，不要因为短期波动就放弃' },
    ])
    expect(split).toHaveLength(2)
  })

  it('标题用 -1，各段独立计算，区间下标相对各自的文本', () => {
    const ranges = similarityRanges(original, [
      { index: -1, text: '基金定投适合长期坚持' },
      { index: 0, text: '一段全新的内容，没有任何重合' },
      { index: 1, text: '先看规则，再看收益，顺序不能反' },
    ])
    expect(ranges.map((r) => r.sectionIndex)).toEqual([-1, 1])
    expect(ranges[0]).toMatchObject({ start: 0, end: 10 })
  })

  it('全角字符、大小写、标点不影响命中，位置仍按原文字符计', () => {
    const src = 'ＡＢＣ基金ＡＩ策略很重要'
    const text = '前缀说明，abc基金，ai策略很重要！'
    const ranges = similarityRanges(src, [{ index: 0, text }], 30)
    expect(ranges.length).toBeGreaterThan(0)
    const piece = text.slice(ranges[0]!.start, ranges[0]!.end)
    expect(normalizeForSimilarity(piece)).toContain('abc基金')
  })

  it('原文为空、没有重合、数量超限都安全', () => {
    expect(similarityRanges('', [{ index: 0, text: original }])).toEqual([])
    expect(similarityRanges(original, [{ index: 0, text: '完全不相干的一句话，没有重合内容出现' }])).toEqual([])
    const many = Array.from({ length: 60 }, (_, i) => ({ index: i, text: '基金定投适合长期坚持' }))
    expect(similarityRanges(original, many, 30)).toHaveLength(30)
  })
})
