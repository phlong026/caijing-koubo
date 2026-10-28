import { describe, expect, it } from 'vitest'
import { extractRiskText, formatFindings, mapExternalStatus, toSubmitText } from '../../src/modules/copy/jiaoduitai.js'

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

  it('机审高危拦截不在映射表：与驳回同样走「审核意见」本地退回，由 syncSubmission 单独处理', () => {
    expect(mapExternalStatus('pending_revise')).toBeNull()
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

describe('formatFindings（机审风险项 → 可读审核意见）', () => {
  const body = {
    findings: [
      {
        severity_label: '高风险',
        rule_name: '[RULE-147] 禁止稳赚不赔等违规表述',
        excerpt: '稳赚不赔',
        description: '使用了稳赚不赔等违规表述',
        suggestion: '删除该表述',
      },
      { severity_label: '高风险', rule_name: '[RULE-324] 禁止绝对化用语', excerpt: '名列前茅', description: '隐含绝对化用语' },
    ],
  }

  it('逐条编号，含等级/规则/摘录/说明/建议', () => {
    const text = formatFindings(body)!
    expect(text).toContain('1. 高风险｜[RULE-147] 禁止稳赚不赔等违规表述，原文「稳赚不赔」，使用了稳赚不赔等违规表述，建议：删除该表述')
    expect(text).toContain('2. 高风险｜[RULE-324] 禁止绝对化用语，原文「名列前茅」，隐含绝对化用语')
  })

  it('findings 为空 / 缺失 / 非对象时返回 null', () => {
    expect(formatFindings({ findings: [] })).toBeNull()
    expect(formatFindings({ status: 'pending_revise' })).toBeNull()
    expect(formatFindings(null)).toBeNull()
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

