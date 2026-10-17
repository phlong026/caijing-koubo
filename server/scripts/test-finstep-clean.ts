/**
 * FinStep 数据清洗单元测试（不发网络请求）。
 * 用真实抓到的脏样本作为夹具，确保清洗规则不会退化。
 * 用法：npx tsx scripts/test-finstep-clean.ts
 */
import { cleanStr, stripHtml, clip, normalizeSummary, mapAlphaMorning, mapHotTopic } from '../src/integrations/finstep/extract.js'

let pass = 0
let fail = 0
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}\n     实际: ${JSON.stringify(actual)}\n     期望: ${JSON.stringify(expected)}`)
  }
}
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}`, detail ?? '')
  }
}

console.log('\n=== FinStep 清洗规则单元测试 ===\n')

console.log('[cleanStr] 上游会把缺失字段序列化成字面量')
eq('"undefined" → null', cleanStr('undefined'), null)
eq('"null" → null', cleanStr('null'), null)
eq('空白 → null', cleanStr('   '), null)
eq('正常值保留', cleanStr(' 财联社 '), '财联社')
eq('数字 0 保留为 "0"', cleanStr(0), '0')

console.log('\n[stripHtml] 实测样本含 <br/> 与 <img idx>')
eq('去 <br/> 换行', stripHtml('宏观新闻<br/>1、内容'), '宏观新闻\n1、内容')
eq('去 <img>', stripHtml('前文<img idx="0"/>后文'), '前文后文')
eq('去实体', stripHtml('A&amp;B&nbsp;C'), 'A&B C')
eq('去段落标签', stripHtml('<p>一段</p><p>二段</p>'), '一段\n二段')
eq('去 script', stripHtml('<script>alert(1)</script>正文'), '正文')

console.log('\n[clip] 不硬切半句')
ok('短文本原样', clip('短句。', 100) === '短句。')
ok('按句号收尾', clip('第一句内容在这里。第二句也要一些内容。', 12).endsWith('。'))
ok('无句号时加省略号', clip('一二三四五六七八九十', 5).endsWith('…'))

console.log('\n[normalizeSummary] 去推广与栏目标题')
const ws = `2027见闻历预售开启｜超值早鸟价 99元
让每一个重要日子，都有备而来。
华见早安之声
请各位听众升级为见闻最新版APP，以便成功收听以下音频。
要闻精选
A股尾盘20分钟突然爆量，大资金涌入宽基ETF。`
const cleaned = normalizeSummary(ws)
ok('去掉预售推广行', !cleaned.includes('预售'))
ok('去掉栏目标题行', !cleaned.includes('要闻精选') && !cleaned.includes('华见早安之声'))
ok('去掉 APP 推广', !cleaned.includes('最新版APP'))
ok('保留真实内容', cleaned.includes('A股尾盘20分钟'))
ok('无残留空行', !cleaned.includes('\n\n'))

console.log('\n[mapAlphaMorning] 真实样本')
const am = mapAlphaMorning(
  {
    article_id: 2507379,
    source: 5,
    title: '周六你需要知道的隔夜全球要闻',
    content: '【周六你需要知道的隔夜全球要闻】 1、美股三大指数集体收跌。<br/>2、黄仁勋谈AI市场震荡。',
    publish_time: '2026-10-17 06:25:01',
    url: 'https://www.cls.cn/detail/2507379',
    from_source: null,
  },
  300,
)
ok('非空', !!am)
eq('externalId 稳定', am?.externalId, 'finstep-am-2507379')
eq('source 数字 5 → 财联社', am?.source, '财联社')
ok('摘要去掉了【标题】前缀', !am?.summary.startsWith('【'))
ok('摘要去掉了 HTML', !am?.summary.includes('<'))
ok('保留 URL', am?.contentUrl === 'https://www.cls.cn/detail/2507379')

console.log('\n[mapHotTopic] 真实脏样本')
const bad = mapHotTopic({ subject_name: 'undefined', subject_desc: 'x', publish_time: '2026-10-17 12:36:40' })
eq('subject_name="undefined" 被丢弃', bad, null)

const good = mapHotTopic({
  subject_name: '量子计算新突破！错误率下降40倍',
  subject_desc: '谷歌跑通魔态培育，错误率降约40倍。',
  publish_time: '2026-10-17 13:20:24',
  site_name: '同花顺',
  url_from: 'eq10jqka',
  section: '同花顺热榜',
  section_1: '热门',
  section_2: undefined,
})
ok('正常条目保留', !!good)
eq('source 用 site_name', good?.source, '同花顺')
ok('externalId 有前缀', good?.externalId?.startsWith('finstep-ht-') === true)
ok('不伪造 URL', good?.contentUrl === null)

const same1 = mapHotTopic({ subject_name: '同一条', site_name: '同花顺', url_from: 'x' })
const same2 = mapHotTopic({ subject_name: '同一条', site_name: '同花顺', url_from: 'x' })
eq('同一话题 externalId 稳定（去重前提）', same1?.externalId, same2?.externalId)

const diff = mapHotTopic({ subject_name: '同一条', site_name: '东方财富', url_from: 'y' })
ok('不同来源不互相覆盖', diff?.externalId !== same1?.externalId)

console.log(`\n=== 结果：通过 ${pass} 项，失败 ${fail} 项 ===\n`)
if (fail > 0) process.exitCode = 1
