import { describe, expect, it } from 'vitest'
import {
  extractReviewedText,
  extractRiskText,
  mapExternalStatus,
  parseReviewedText,
  toSubmitText,
} from '../../src/modules/copy/jiaoduitai.js'

describe('toSubmitText（校对台文本送审正文）', () => {
  it('标题作首行，段落之间只空一行', () => {
    const text = toSubmitText('四季度债市展望', [
      { label: '开头', text: '债市进入震荡期。' },
      { label: '结尾', text: '历史业绩不代表未来。' },
    ])
    expect(text).toBe('四季度债市展望\n\n债市进入震荡期。\n\n历史业绩不代表未来。')
  })

  it('段内连续空行压成一个，避免被平台拆成多篇', () => {
    const text = toSubmitText('标题', [{ label: '正文', text: '第一句。\n\n\n\n第二句。\n \n\t\n第三句。' }])
    expect(text).not.toMatch(/\n[ \t]*\n[ \t]*\n/)
    expect(text).toBe('标题\n\n第一句。\n\n第二句。\n\n第三句。')
  })

  it('去掉整行只有重复分隔符的行（=== / --- 会被平台当作篇界）', () => {
    const text = toSubmitText('标题', [{ label: '正文', text: '上半段。\n===\n下半段。\n-----\n结尾。' }])
    expect(text).toBe('标题\n\n上半段。\n下半段。\n结尾。')
  })

  it('无标题时只送正文', () => {
    expect(toSubmitText('', [{ label: '正文', text: '只有正文。' }])).toBe('只有正文。')
  })
})

describe('mapExternalStatus（校对台状态 → 本地审核单状态）', () => {
  it('机审阶段对应第 1 关', () => {
    expect(mapExternalStatus('pending_machine')).toBe('gate1')
    expect(mapExternalStatus('machine_reviewing')).toBe('gate1')
  })

  it('机审高危拦截对应第 2 关', () => {
    expect(mapExternalStatus('pending_revise')).toBe('gate2')
  })

  it('人工初审 / 终审对应待人工复核', () => {
    for (const s of ['pending_first', 'first_reviewing', 'pending_final', 'final_reviewing']) {
      expect(mapExternalStatus(s)).toBe('pending_manual')
    }
  })

  it('终态原样返回，未知状态返回 null', () => {
    expect(mapExternalStatus('approved')).toBe('approved')
    expect(mapExternalStatus('rejected')).toBe('rejected')
    expect(mapExternalStatus('superseded')).toBeNull()
    expect(mapExternalStatus('whatever')).toBeNull()
  })
})

describe('extractReviewedText（取审核后的文案）', () => {
  it('取 content_text', () => {
    expect(extractReviewedText({ status: 'approved', content_text: '标题\n\n正文' })).toBe('标题\n\n正文')
  })

  it('缺失或为空返回 null', () => {
    expect(extractReviewedText({ status: 'approved' })).toBeNull()
    expect(extractReviewedText({ content_text: '   ' })).toBeNull()
    expect(extractReviewedText(null)).toBeNull()
  })
})

describe('extractRiskText（校对台返回的风险话术，决策 D4 预留）', () => {
  it('按配置的字段名取话术并去首尾空白', () => {
    expect(extractRiskText({ risk_tip: '  市场有风险，投资需谨慎。 ' }, 'risk_tip')).toBe('市场有风险，投资需谨慎。')
  })

  it('未配置字段名、字段缺失或为空时返回 null（取稿回退模板话术）', () => {
    expect(extractRiskText({ risk_tip: '话术' }, '')).toBeNull()
    expect(extractRiskText({ other: '话术' }, 'risk_tip')).toBeNull()
    expect(extractRiskText({ risk_tip: '   ' }, 'risk_tip')).toBeNull()
    expect(extractRiskText({ risk_tip: 123 }, 'risk_tip')).toBeNull()
    expect(extractRiskText(null, 'risk_tip')).toBeNull()
  })
})

describe('parseReviewedText（审核后文案 → 标题 + 段落）', () => {
  const original = {
    title: '四季度债市展望',
    sections: [
      { label: '开头', text: '旧开头。' },
      { label: '结尾', text: '旧结尾。' },
    ],
  }

  it('首行为标题，空行切段，按原段落顺序沿用段名', () => {
    const r = parseReviewedText('四季度债市展望（修订）\r\n\r\n新开头。\n\n新结尾。', original)
    expect(r.title).toBe('四季度债市展望（修订）')
    expect(r.sections).toEqual([
      { label: '开头', text: '新开头。' },
      { label: '结尾', text: '新结尾。' },
    ])
  })

  it('段数变多时，多出的段落按序号命名', () => {
    const r = parseReviewedText('标题\n\n一\n\n二\n\n三', original)
    expect(r.sections.map((s) => s.label)).toEqual(['开头', '结尾', '第3段'])
  })

  it('原稿无标题时整段都是正文', () => {
    const r = parseReviewedText('第一段。\n\n第二段。', { title: '', sections: original.sections })
    expect(r.title).toBe('')
    expect(r.sections.map((s) => s.text)).toEqual(['第一段。', '第二段。'])
  })
})
