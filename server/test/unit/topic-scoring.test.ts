import { describe, expect, it } from 'vitest'
import { scoreTopic } from '../../src/modules/topics/scoring.js'

describe('scoreTopic（候选选题启发式打分）', () => {
  it('标准好题：数字+悬念+代入，钩子与理由齐全，得高分并给出依据', () => {
    const r = scoreTopic({
      title: '3 个信号，普通散户最容易忽视',
      hook: '先说结论：这 3 个信号出现的时候，大多数人都看反了。',
      rationale: '该角度基于今日资讯事实展开，覆盖目标受众的常见误区，适合口播开场。',
    })
    expect(r.score).toBeGreaterThanOrEqual(90)
    expect(r.reasons.join('；')).toContain('数字')
    expect(r.reasons.join('；')).toContain('悬念')
  })

  it('风险词重扣：收益承诺类表述必须显著降分并标注', () => {
    const good = scoreTopic({ title: '3 个信号值得关注', hook: '先说结论。', rationale: '理由充分合理。' })
    const risky = scoreTopic({
      title: '这支板块稳赚必涨',
      hook: '先说结论。',
      rationale: '理由充分合理。',
    })
    expect(good.score - risky.score).toBeGreaterThanOrEqual(25)
    expect(risky.reasons.join('；')).toContain('风险')
  })

  it('要素缺失降分：无钩子无理由的裸标题得分更低', () => {
    const full = scoreTopic({ title: '别再乱买了', hook: '一句话开场钩子足够长一些。', rationale: '这里是超过二十个字的选题理由，说明为什么现在值得讲。' })
    const bare = scoreTopic({ title: '别再乱买了', hook: '', rationale: '' })
    expect(bare.score).toBeLessThan(full.score)
  })

  it('分数夹在 0~100 区间', () => {
    const r = scoreTopic({
      title: '',
      hook: '',
      rationale: '',
    })
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
  })
})
