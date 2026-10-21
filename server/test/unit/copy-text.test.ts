import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import {
  computeSimilarity,
  contentHash,
  countBodyWords,
  countSectionsWords,
  countWords,
  estimateSeconds,
  hardHitCount,
  longestCommonSubstring,
  normalizeForSimilarity,
  normalizeSections,
  sanitizeText,
  scanCompliance,
  toPlainText,
  type ComplianceWordRow,
} from '../../src/modules/copy/text.js'

describe('countWords（FR-E5 计字规则）', () => {
  it('汉字每字计 1，标点与空白不计', () => {
    expect(countWords('基金定投，入门指南。')).toBe(8)
    expect(countWords('  \n\t')).toBe(0)
    expect(countWords('')).toBe(0)
  })

  it('连续英文字母或数字串整体计 1', () => {
    expect(countWords('ETF')).toBe(1)
    expect(countWords('2026年A股')).toBe(4)
    expect(countWords('沪深300ETF')).toBe(3)
  })

  it('被标点或空格隔开的英文数字串分别计数', () => {
    expect(countWords('3.5')).toBe(2)
    expect(countWords('CPI PPI')).toBe(2)
  })

  it('扩展 A 区与兼容区汉字也计 1', () => {
    expect(countWords('㐀豈')).toBe(2)
  })

  it('整稿字数 = 标题 + 各段；正文字数不含标题', () => {
    const sections = [
      { label: '段落1', text: '先看结论' },
      { label: '段落2', text: '再看数据' },
    ]
    expect(countSectionsWords('标题', sections)).toBe(10)
    expect(countSectionsWords(null, sections)).toBe(8)
    expect(countBodyWords(sections)).toBe(8)
  })

  it('预计秒数按每秒字数换算并保留一位小数', () => {
    const cps = config.copy.charsPerSec || 3.5
    expect(estimateSeconds(0)).toBe(0)
    expect(estimateSeconds(70)).toBe(Math.round((70 / cps) * 10) / 10)
  })
})

describe('结构化正文', () => {
  it('toPlainText 只拼可朗读文本，段落间空一行，忽略空段', () => {
    const text = toPlainText(' 标题 ', [
      { label: '段落1', text: ' 第一段 ' },
      { label: '段落2', text: '   ' },
      { label: '段落3', text: '第三段' },
    ])
    expect(text).toBe('标题\n\n第一段\n\n第三段')
    expect(toPlainText('', [{ label: 'a', text: '正文' }])).toBe('正文')
  })

  it('contentHash 忽略首尾空白，但段落名或正文变化会改变 hash', () => {
    const a = contentHash('标题', [{ label: '段落1', text: '正文' }])
    expect(contentHash(' 标题 ', [{ label: ' 段落1', text: '正文 ' }])).toBe(a)
    expect(contentHash('标题', [{ label: '段落2', text: '正文' }])).not.toBe(a)
    expect(contentHash('标题', [{ label: '段落1', text: '正文。' }])).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sanitizeText 去控制字符、统一换行并收敛多余空行', () => {
    expect(sanitizeText('a\u0000b\u0007c')).toBe('abc')
    expect(sanitizeText('第一行\r\n第二行\r第三行')).toBe('第一行\n第二行\n第三行')
    expect(sanitizeText('上\n\n\n\n下')).toBe('上\n\n下')
    expect(sanitizeText(null)).toBe('')
  })

  it('normalizeSections 丢弃空段、补段落名、解析 sourceRefs，最多 8 段', () => {
    const out = normalizeSections([
      { label: '', text: '有内容' },
      { label: '空段', text: '  ' },
      { text: '带引用', source_refs: ['1', 2.7, 'x'] },
      null,
    ])
    expect(out).toEqual([
      { label: '段落 1', text: '有内容' },
      { label: '段落 2', text: '带引用', sourceRefs: [1, 2] },
    ])
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `段${i}`, text: `正文${i}` }))
    expect(normalizeSections(many)).toHaveLength(8)
    expect(normalizeSections('not-array')).toEqual([])
  })
})

describe('查重（§3.5）', () => {
  it('预处理：全角转半角、转小写、去标点与空白', () => {
    expect(normalizeForSimilarity('ＡＢＣ，Hello  世界！１２３')).toBe('abchello世界123')
  })

  it('最长公共子串返回长度、文本与两边起点', () => {
    const r = longestCommonSubstring('abcdefg', 'xxcdefyy')
    expect(r).toEqual({ length: 4, text: 'cdef', aStart: 2, bStart: 2 })
    expect(longestCommonSubstring('', 'abc').length).toBe(0)
  })

  it('完全照搬相似度为 1；素人线超过阈值拦截，其他线只提示', () => {
    const original = '今天我们聊一聊基金定投为什么适合普通投资者长期坚持'
    const persona = computeSimilarity(original, original, 'persona')
    expect(persona.similarity).toBe(1)
    expect(persona.blocked).toBe(true)
    expect(persona.fragments[0]?.text).toBe(normalizeForSimilarity(original))
    const manager = computeSimilarity(original, original, 'manager')
    expect(manager.similarity).toBe(1)
    expect(manager.blocked).toBe(false)
  })

  it('完全改写相似度为 0，不拦截', () => {
    const r = computeSimilarity('今天我们聊一聊基金定投', '市场波动时先认清自己的风险承受能力', 'persona')
    expect(r.similarity).toBe(0)
    expect(r.blocked).toBe(false)
    expect(r.fragments).toEqual([])
  })

  it('改写稿短于 n 字或原文为空时相似度记 0', () => {
    const n = Math.max(2, config.copy.similarityN)
    expect(computeSimilarity('原文内容很长很长', '短'.repeat(n - 1), 'persona').similarity).toBe(0)
    expect(computeSimilarity('', '任意改写稿内容足够长', 'persona').similarity).toBe(0)
  })

  it('部分重合按 |R∩S|/|R| 计算，标点差异不影响', () => {
    const r = computeSimilarity('基金定投适合长期坚持。', '基金定投，适合长期坚持！另外还要看费率高低', 'persona')
    expect(r.similarity).toBeGreaterThan(0)
    expect(r.similarity).toBeLessThan(1)
    expect(r.longest.text).toBe('基金定投适合长期坚持')
  })
})

describe('合规扫描（FR-R1）', () => {
  const words: ComplianceWordRow[] = [
    { word: '稳赚不赔', level: 'hard', category: '收益承诺' },
    { word: '保本', level: 'hard', category: '收益承诺' },
    { word: '第一', level: 'soft', category: '绝对化' },
  ]
  const sec = (text: string) => [{ label: '段落1', text }]

  it('命中硬禁用词并给出段内位置', () => {
    const hits = scanCompliance(sec('这只基金稳赚不赔'), words)
    expect(hits).toEqual([
      { word: '稳赚不赔', level: 'hard', category: '收益承诺', sectionIndex: 0, start: 4, end: 8, fromPersona: false },
    ])
    expect(hardHitCount(hits)).toBe(1)
  })

  it('标题也参与扫描，位置记为第 -1 段', () => {
    const hits = scanCompliance(sec('正文没有问题'), words, [], '保本理财推荐')
    expect(hits.map((h) => [h.word, h.sectionIndex])).toEqual([['保本', -1]])
  })

  it('否定前缀（不保本）视为合规免责表述', () => {
    expect(scanCompliance(sec('基金不保本，投资需谨慎'), words)).toEqual([])
    expect(scanCompliance(sec('本产品并非保本'), words)).toEqual([])
  })

  it('疑问反问与引述语境不算承诺', () => {
    expect(scanCompliance(sec('债基真的稳赚不赔吗？'), words)).toEqual([])
    expect(scanCompliance(sec('听到“保本”两个字，先问依据在哪'), words)).toEqual([])
  })

  it('「第一」用作序号放行，用作排名仍命中', () => {
    expect(scanCompliance(sec('第一，先看费率。'), words)).toEqual([])
    expect(scanCompliance(sec('第一步，先开户。'), words)).toEqual([])
    const ranked = scanCompliance(sec('这家公司是行业第一'), words)
    expect(ranked.map((h) => [h.word, h.level])).toEqual([['第一', 'soft']])
    expect(hardHitCount(ranked)).toBe(0)
  })

  it('人物禁用规则句拆成可匹配的词，按硬禁用处理', () => {
    const hits = scanCompliance(sec('这个板块必涨，明天就能翻倍'), [], ['使用绝对化表述（必涨、稳赚）', '不得出现「翻倍」'])
    expect(hits.map((h) => [h.word, h.level, h.fromPersona])).toEqual([
      ['必涨', 'hard', true],
      ['翻倍', 'hard', true],
    ])
  })

  it('同一位置同一词只记一次，结果按段落与位置排序', () => {
    const hits = scanCompliance(
      [
        { label: '1', text: '保本保本' },
        { label: '2', text: '稳赚不赔' },
      ],
      [...words, { word: '保本', level: 'hard', category: '重复词条' }],
    )
    expect(hits.map((h) => `${h.sectionIndex}:${h.start}:${h.word}`)).toEqual(['0:0:保本', '0:2:保本', '1:0:稳赚不赔'])
  })
})
