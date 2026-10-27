import { describe, expect, it } from 'vitest'
import {
  copyTemplateFor,
  inheritedMethod,
  mainMethod,
  unmatchedMixLabels,
  matchMethodByLabel,
  personaMethods,
  pickMethod,
  type MethodLite,
} from '../../src/modules/topics/methods.js'

const m = (builtin: string, name: string, extra: Partial<MethodLite> = {}): MethodLite => ({
  id: `tpl_seed_${builtin}`,
  name,
  builtin,
  isDefault: builtin === 'market',
  copyTemplateId: null,
  ...extra,
})
const ALL = [m('market', '市场解读'), m('education', '投教科普'), m('product', '产品推荐'), m('comment', '热点评论')]

describe('personaMethods（人物可用的选题方法）', () => {
  it('没有勾选时：经理可用全部方法，标记为未配置', () => {
    const r = personaMethods({ line: 'manager', contentMix: [] }, ALL)
    expect(r.configured).toBe(false)
    expect(r.items.map((x) => x.method.builtin)).toEqual(['market', 'education', 'product', 'comment'])
  })

  it('没有勾选时：素人矩阵默认不含产品推荐', () => {
    const r = personaMethods({ line: 'persona', contentMix: [] }, ALL)
    expect(r.items.map((x) => x.method.builtin)).toEqual(['market', 'education', 'comment'])
  })

  it('素人矩阵勾选了产品推荐后可用', () => {
    const r = personaMethods({ line: 'persona', contentMix: [{ label: '产品推荐', methodId: 'tpl_seed_product' }] }, ALL)
    expect(r.configured).toBe(true)
    expect(r.items.map((x) => x.method.builtin)).toEqual(['product'])
  })

  it('按勾选顺序返回，比例作为权重；未填比例按 1', () => {
    const r = personaMethods(
      {
        line: 'manager',
        contentMix: [
          { label: '市场解读', methodId: 'tpl_seed_market', ratio: 60 },
          { label: '投教科普', methodId: 'tpl_seed_education', ratio: 40 },
        ],
      },
      ALL,
    )
    expect(r.items.map((x) => [x.method.builtin, x.weight])).toEqual([
      ['market', 60],
      ['education', 40],
    ])
  })

  it('旧数据没有 methodId 时按名称识别；识别不了的忽略；已删除的方法忽略', () => {
    const r = personaMethods(
      {
        line: 'kos',
        contentMix: [
          { label: '知识科普', ratio: 50 },
          { label: '心理建设', ratio: 30 },
          { label: 'x', methodId: 'tpl_deleted', ratio: 20 },
        ],
      },
      ALL,
    )
    expect(r.configured).toBe(true)
    expect(r.items.map((x) => x.method.builtin)).toEqual(['education'])
  })

  it('同一方法重复出现时合并为一项，比例累加', () => {
    const r = personaMethods(
      { line: 'kos', contentMix: [{ label: '投教科普', methodId: 'tpl_seed_education', ratio: 40 }, { label: '知识科普', ratio: 30 }, { label: '热点评论', ratio: 30 }] },
      ALL,
    )
    expect(r.items.map((x) => [x.method.builtin, x.weight])).toEqual([
      ['education', 70],
      ['comment', 30],
    ])
  })

  it('非法比例（手工改库造成的 NaN / 0）按 1 处理，不让轮转出错', () => {
    const r = personaMethods({ line: 'kos', contentMix: [{ label: '投教科普', methodId: 'tpl_seed_education', ratio: Number.NaN }] }, ALL)
    expect(r.items[0]!.weight).toBe(1)
    expect(pickMethod(r, 3)?.builtin).toBe('education')
  })
})

describe('matchMethodByLabel', () => {
  it('精确名称与常见别名都能识别', () => {
    expect(matchMethodByLabel('市场解读', ALL)?.builtin).toBe('market')
    expect(matchMethodByLabel('知识科普', ALL)?.builtin).toBe('education')
    expect(matchMethodByLabel('产品品类讲解', ALL)?.builtin).toBe('product')
    expect(matchMethodByLabel('政策解读', ALL)).toBeNull()
  })

  it('自定义方法按名称精确识别', () => {
    const custom = m('x', '财报速读', { id: 'tpl_custom', builtin: null })
    expect(matchMethodByLabel('财报速读', [...ALL, custom])?.id).toBe('tpl_custom')
  })
})

describe('pickMethod（按人物配置自动分配）', () => {
  it('未配置时用默认方法', () => {
    const p = personaMethods({ line: 'manager', contentMix: [] }, ALL)
    expect([0, 1, 2].map((i) => pickMethod(p, i)?.builtin)).toEqual(['market', 'market', 'market'])
  })

  it('未配置且默认方法对该人物不可用时，取第一个可用方法', () => {
    const all = ALL.map((x) => ({ ...x, isDefault: x.builtin === 'product' }))
    const p = personaMethods({ line: 'persona', contentMix: [] }, all)
    expect(pickMethod(p, 0)?.builtin).toBe('market')
  })

  it('按比例平滑轮转，结果确定（重试得到同样结果）', () => {
    const p = personaMethods(
      {
        line: 'manager',
        contentMix: [
          { label: '市场解读', methodId: 'tpl_seed_market', ratio: 67 },
          { label: '投教科普', methodId: 'tpl_seed_education', ratio: 33 },
        ],
      },
      ALL,
    )
    const seq = [0, 1, 2].map((i) => pickMethod(p, i)?.builtin)
    expect(seq).toEqual(['market', 'education', 'market'])
    expect([0, 1, 2].map((i) => pickMethod(p, i)?.builtin)).toEqual(seq)
  })

  it('没有任何可用方法时返回 null', () => {
    expect(pickMethod({ configured: false, items: [] }, 0)).toBeNull()
  })
})

describe('copyTemplateFor（选题方法 → 文案模板）', () => {
  it('优先用方法上配置的文案模板', () => {
    expect(copyTemplateFor(m('market', '市场解读', { copyTemplateId: 'ctpl_x' }))).toBe('ctpl_x')
  })
  it('内置方法按内置键映射；自定义或缺失回落市场解读型', () => {
    expect(copyTemplateFor(m('education', '投教科普'))).toBe('ctpl_education')
    expect(copyTemplateFor(m('x', '自定义', { builtin: null }))).toBe('ctpl_market')
    expect(copyTemplateFor(null)).toBe('ctpl_market')
  })
})

describe('mainMethod（没有选题时，文案工坊默认用哪个方法）', () => {
  it('已配置：取比例最高的；比例相同取先勾选的', () => {
    const p = personaMethods(
      { line: 'kos', contentMix: [{ label: '投教科普', methodId: 'tpl_seed_education', ratio: 30 }, { label: '热点评论', methodId: 'tpl_seed_comment', ratio: 70 }] },
      ALL,
    )
    expect(mainMethod(p)?.builtin).toBe('comment')
    const q = personaMethods({ line: 'kos', contentMix: [{ label: '投教科普' }, { label: '热点评论' }] }, ALL)
    expect(mainMethod(q)?.builtin).toBe('education')
  })
  it('未配置：默认方法', () => {
    expect(mainMethod(personaMethods({ line: 'manager', contentMix: [] }, ALL))?.builtin).toBe('market')
  })
})

describe('unmatchedMixLabels（旧配比里对不上选题方法的标签）', () => {
  it('列出既没有有效 methodId、名称也识别不了的标签', () => {
    expect(
      unmatchedMixLabels(
        [{ label: '知识科普' }, { label: '心理建设' }, { label: '已删', methodId: 'tpl_deleted' }, { label: '市场解读', methodId: 'tpl_seed_market' }],
        ALL,
      ),
    ).toEqual(['心理建设', '已删'])
  })
})

describe('inheritedMethod（送入文案工坊时继承哪个方法）', () => {
  const persona = { line: 'persona', contentMix: [] }
  it('选题方法对该人物可用 → 随选题', () => {
    expect(inheritedMethod('tpl_seed_comment', persona, ALL)).toMatchObject({ from: 'topic', method: { builtin: 'comment' } })
  })
  it('选题方法该人物没开启（素人未勾选产品推荐）→ 随人物主方法', () => {
    expect(inheritedMethod('tpl_seed_product', persona, ALL)).toMatchObject({ from: 'persona', method: { builtin: 'market' } })
  })
  it('选题没有方法 → 随人物主方法', () => {
    expect(inheritedMethod(null, persona, ALL)).toMatchObject({ from: 'persona', method: { builtin: 'market' } })
  })
})
