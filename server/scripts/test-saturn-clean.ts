import { mapSaturnItem, mapSaturnItems, parseBeijingTime } from '../src/integrations/saturn-news/extract.js'

/**
 * 曙光舆情映射层单测。纯函数，不发网络请求。
 * 全部用真实接口返回的样本作夹具（见 .data 里的探测记录）。
 */

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/* ── 1. 时区解析 ─────────────────────────────────────────────────── */
console.log('\n[1] 北京时间解析（YYYY-MM-DD HH:mm:ss 必须按 +08:00）')
{
  const d = parseBeijingTime('2026-10-17 19:11:13')
  check('能被解析', d instanceof Date && !Number.isNaN(d!.getTime()))
  // 2026-10-17 19:11:13 +08:00 = 2026-10-17T11:11:13Z
  check('按东八区换算正确', d!.toISOString() === '2026-10-17T11:11:13.000Z', d?.toISOString())

  const d2 = parseBeijingTime('2026-10-17T11:11:13Z')
  check('ISO 带 Z 不再叠加时区', d2!.toISOString() === '2026-10-17T11:11:13.000Z', d2?.toISOString())

  const d3 = parseBeijingTime('2026-10-17T11:11:13+08:00')
  check('ISO 带偏移量不再叠加', d3!.toISOString() === '2026-10-17T03:11:13.000Z', d3?.toISOString())

  check('只有日期也能解析', parseBeijingTime('2026-10-17') !== null)
  check('空值返回 null', parseBeijingTime('') === null)
  check('undefined 返回 null', parseBeijingTime(undefined) === null)
  check('垃圾字符串返回 null', parseBeijingTime('不是时间') === null)
}

/* ── 2. 单条映射 ─────────────────────────────────────────────────── */
console.log('\n[2] 单条映射（真实样本）')
{
  const real = {
    id: '254572957',
    title: '大家好！今天是周六，一起看看国内外市场主要消息面。1、美股三大指数集体收跌…',
    snippet: '大家好！今天是周六，一起看看国内外市场主要消息面。1、美股三大指数集体收跌，芯片股大跌。',
    date: '2026-10-17 19:11:13',
    source: '微信公众号',
    url: 'https://bigdata-s3-data.datayes.com/newsbody/b1l79tN-U3VP_cWegQ9j0Q',
  }
  const m = mapSaturnItem(real, 300)
  check('正常样本映射成功', m !== null)
  check('externalId 用服务端 id', m?.externalId === 'saturn-254572957', m?.externalId)
  check('来源加「曙光·」前缀', m?.source === '曙光·微信公众号', m?.source)
  check('保留原始 URL', m?.contentUrl === real.url)
  check('发布时间正确', m?.publishedAt?.toISOString() === '2026-10-17T11:11:13.000Z', m?.publishedAt?.toISOString())
  check('摘要被截断到 300 字内', (m?.summary?.length ?? 0) <= 300, m?.summary?.length)
}

console.log('\n[3] 脏数据与边界')
{
  const noTitle = mapSaturnItem(
    { id: 'x1', title: '', snippet: '正文里有内容但没有标题，需要用首句兜底成标题。', date: '2026-10-17 10:00:00', source: '快讯', url: null } as any,
    300,
  )
  check('标题空时用正文首句兜底', !!noTitle?.title && noTitle.title.length > 0, noTitle?.title)

  const empty = mapSaturnItem({ id: 'x2', title: '', snippet: '', date: '', source: '', url: null } as any, 300)
  check('标题正文全空则丢弃', empty === null)

  const noId = mapSaturnItem(
    { id: '', title: '没有 id 的条目', snippet: '正文', date: '2026-10-17 10:00:00', source: '快讯', url: 'https://a.com/1' } as any,
    300,
  )
  check('缺 id 时用哈希兜底', !!noId?.externalId && noId.externalId.startsWith('saturn-h-'), noId?.externalId)
  const noId2 = mapSaturnItem(
    { id: '', title: '没有 id 的条目', snippet: '正文', date: '2026-10-17 10:00:00', source: '快讯', url: 'https://a.com/1' } as any,
    300,
  )
  check('哈希兜底稳定（两次一致）', noId?.externalId === noId2?.externalId)

  const jsUrl = mapSaturnItem(
    { id: 'x3', title: '带 javascript 链接', snippet: '正文', date: '2026-10-17 10:00:00', source: '快讯', url: 'javascript:alert(1)' } as any,
    300,
  )
  check('javascript: 伪协议被拦截', jsUrl?.contentUrl === null, jsUrl?.contentUrl)

  const htmlTitle = mapSaturnItem(
    { id: 'x4', title: '<b>带标签</b>的&nbsp;标题<br/>', snippet: '正文', date: '2026-10-17 10:00:00', source: '网络新闻', url: null } as any,
    300,
  )
  check('标题 HTML 被清洗', htmlTitle?.title === '带标签的 标题' || (htmlTitle?.title ?? '').indexOf('<') === -1, htmlTitle?.title)

  const undefStr = mapSaturnItem(
    { id: 'x5', title: '标题', snippet: 'undefined', date: '2026-10-17 10:00:00', source: '快讯', url: null } as any,
    300,
  )
  check('summary 字面量 "undefined" 被清成 null', undefStr?.summary === null, undefStr?.summary)
}

/* ── 4. 批量映射与批内去重 ───────────────────────────────────────── */
console.log('\n[4] 批量映射去重')
{
  const items = [
    { id: '1', title: 'A', snippet: 'a', date: '2026-10-17 10:00:00', source: '快讯', url: null },
    { id: '1', title: 'A 重复', snippet: 'a2', date: '2026-10-17 10:01:00', source: '快讯', url: null },
    { id: '2', title: 'B', snippet: 'b', date: '2026-10-17 10:02:00', source: '快讯', url: null },
    { id: '3', title: '', snippet: '', date: '', source: '', url: null },
  ] as any[]
  const out = mapSaturnItems(items, 300)
  check('同 id 只留一条', out.length === 2, out.map((x) => x.externalId))
  check('保留的是第一次出现的那条', out[0].title === 'A', out[0].title)
  check('空条目被丢弃', out.every((x) => x.title.length > 0))
}

/* ── 5. externalId 前缀不冲突 ────────────────────────────────────── */
console.log('\n[5] 与其它源不撞键')
{
  const m = mapSaturnItem(
    { id: '999', title: 't', snippet: 's', date: '2026-10-17 10:00:00', source: '快讯', url: null } as any,
    300,
  )
  check('曙光用 saturn- 前缀', m!.externalId.startsWith('saturn-'))
  check('不与 finstep-am-* 冲突', !m!.externalId.startsWith('finstep-'))
  check('不与 finstep-ht-* 冲突', !m!.externalId.startsWith('finstep-ht-'))
  check('不与 mock-* 冲突', !m!.externalId.startsWith('mock-'))
}

console.log(`\n=== 结果：通过 ${pass} 项，失败 ${fail} 项 ===`)
process.exit(fail ? 1 : 0)
