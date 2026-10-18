import { initDb, closeAll } from '../src/db/index.js'
import { config, hasSaturnNews } from '../src/config.js'
import { searchByKeyword, listIndustries, listThemes } from '../src/integrations/saturn-news/client.js'
import { mapSaturnItems } from '../src/integrations/saturn-news/extract.js'

/**
 * 曙光舆情 MCP 真实联调脚本（会发真实网络请求）。
 * 用法：npx tsx scripts/test-saturn.ts
 */

async function main() {
  await initDb()

  console.log('=== 配置自检 ===')
  console.log('hasSaturnNews:', hasSaturnNews())
  console.log('url:', config.saturnNews.url)
  console.log('key 长度:', config.saturnNews.apiKey.length)
  console.log('keywords:', config.saturnNews.keywords)
  console.log('channels:', config.saturnNews.channels)
  if (!hasSaturnNews()) {
    console.error('\n❌ SATURN_NEWS_MCP_KEY 未配置，无法继续')
    process.exit(1)
  }

  /* 1. 关键词检索 */
  console.log('\n=== [1] search_saturn_news_keyword ===')
  const t0 = Date.now()
  const r = await searchByKeyword({
    query: 'A股',
    dateRange: `${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}~today`,
    limit: 20,
    sortBy: 'time',
    channels: ['flash', 'wechat', 'web_v1'],
  })
  console.log(`耗时 ${Date.now() - t0}ms | count=${r.count} | results=${r.results?.length} | trace=${r.meta?.trace_id}`)
  const srcDist: Record<string, number> = {}
  for (const it of r.results ?? []) srcDist[it.source] = (srcDist[it.source] ?? 0) + 1
  console.log('通道分布:', srcDist)

  /* 2. 映射 */
  console.log('\n=== [2] 映射到 NewsDTO ===')
  const mapped = mapSaturnItems(r.results ?? [], config.saturnNews.summaryMaxChars)
  console.log(`映射 ${mapped.length} / ${r.results?.length} 条`)
  for (const m of mapped.slice(0, 3)) {
    console.log(`  [${m.source}] ${m.title.slice(0, 40)}`)
    console.log(`     ${m.publishedAt?.toISOString() ?? '无时间'} | ${m.contentUrl ?? '无URL'}`)
    console.log(`     ${(m.summary ?? '').slice(0, 60)}...`)
  }

  /* 3. 清单工具 */
  console.log('\n=== [3] list_saturn_news_industries ===')
  const inds = await listIndustries(undefined, 1, 8)
  console.log('L1 行业（前8）:', inds.join(' / '))

  console.log('\n=== [4] list_saturn_news_themes ===')
  const themes = await listThemes(undefined, 5)
  console.log('主题（前5）:', themes.join(' / '))

  /* 4. 自检 */
  console.log('\n=== [5] 数据质量自检 ===')
  const problems: string[] = []
  const extIds = new Set<string>()
  for (const m of mapped) {
    if (extIds.has(m.externalId)) problems.push(`externalId 重复: ${m.externalId}`)
    extIds.add(m.externalId)
    if (!m.title) problems.push(`空标题: ${m.externalId}`)
    if (/undefined|null/i.test(m.title)) problems.push(`标题含脏字面量: ${m.title}`)
    if (/<[a-z]/i.test(m.title)) problems.push(`标题含 HTML: ${m.title}`)
    if (m.contentUrl && !/^https?:\/\//.test(m.contentUrl)) problems.push(`非法 URL: ${m.contentUrl}`)
    if (m.publishedAt && Number.isNaN(m.publishedAt.getTime())) problems.push(`非法时间: ${m.externalId}`)
  }
  if (problems.length) {
    console.log('❌ 发现问题:', problems.slice(0, 10))
  } else {
    console.log(`✅ 全部通过：${mapped.length} 条无重复 / 无空标题 / 无脏字面量 / 无 HTML / URL 合法`)
  }

  await closeAll()
  process.exit(problems.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error('❌ 失败:', (e as Error).message)
  await closeAll().catch(() => {})
  process.exit(1)
})
