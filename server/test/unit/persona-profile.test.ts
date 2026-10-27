import { describe, expect, it } from 'vitest'
import { normalizeProfileInput, profileToDb } from '../../src/modules/personas/profile.js'
import { readProfile } from '../../src/modules/personas/repo.js'

describe('选题方法配比与默认表达风格（人物 IP 档案）', () => {
  it('配比项可引用选题方法；比例规则不变', () => {
    const p = normalizeProfileInput({
      contentMix: [
        { label: '市场解读', methodId: ' tpl_seed_market ', ratio: 60 },
        { label: '投教科普', methodId: 'tpl_seed_education', ratio: 40 },
      ],
    })
    expect(p.contentMix).toEqual([
      { label: '市场解读', methodId: 'tpl_seed_market', ratio: 60 },
      { label: '投教科普', methodId: 'tpl_seed_education', ratio: 40 },
    ])
    expect(() =>
      normalizeProfileInput({ contentMix: [{ label: 'a', methodId: 'x', ratio: 60 }, { label: 'b', methodId: 'y', ratio: 30 }] }),
    ).toThrow(/合计必须等于 100/)
  })

  it('引用选题方法的项，显示名过长时截断而不是报错（方法名可长达 128 字）', () => {
    const p = normalizeProfileInput({ contentMix: [{ label: '很长的自定义选题方法名'.repeat(3), methodId: 'tpl_x' }] })
    expect(p.contentMix?.[0]?.label.length).toBe(20)
    expect(() => normalizeProfileInput({ contentMix: [{ label: 'x'.repeat(21) }] })).toThrow(/20/)
  })

  it('选题方法 id 过长时拒绝', () => {
    expect(() => normalizeProfileInput({ contentMix: [{ label: 'a', methodId: 'x'.repeat(41) }] })).toThrow(/选题方法/)
  })

  it('默认表达风格可选；空值不写入', () => {
    expect(normalizeProfileInput({ defaultStyleId: 'csty_manager_plain' }).defaultStyleId).toBe('csty_manager_plain')
    expect(normalizeProfileInput({ defaultStyleId: '  ' }).defaultStyleId).toBeUndefined()
    expect(profileToDb(normalizeProfileInput({})).default_style_id).toBeUndefined()
  })

  it('入库再读出保持一致（含 methodId 与默认风格）', () => {
    const p = normalizeProfileInput({
      defaultStyleId: 'csty_kos_edu',
      contentMix: [{ label: '投教科普', methodId: 'tpl_seed_education' }],
    })
    const back = readProfile(profileToDb(p))
    expect(back.defaultStyleId).toBe('csty_kos_edu')
    expect(back.contentMix).toEqual([{ label: '投教科普', methodId: 'tpl_seed_education' }])
  })

  it('旧数据（只有 label）照常读取', () => {
    expect(readProfile({ content_mix: [{ label: '知识科普', ratio: 100 }] }).contentMix).toEqual([{ label: '知识科普', ratio: 100 }])
  })
})
