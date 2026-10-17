import { initDb, closeAll } from '../src/db/index.js'
import { fetchAndStore } from '../src/modules/news/service.js'

/**
 * 不依赖 Redis/队列的「采集 → 入库」验证。
 *
 * 背景：`fetchAndStore()` 本身只依赖数据库，不依赖 BullMQ/Redis；
 * 队列只是「什么时候触发它」。所以 Redis 不可用时，直接调用本函数
 * 依然能完整验证 provider → classify → insertNews 的真实链路。
 *
 * 用法：npx tsx scripts/test-saturn-ingest.ts
 */

async function main() {
  const db = await initDb()

  console.log('=== [1] 真实采集一轮（fetchAndStore）===')
  const t0 = Date.now()
  const outcome = await fetchAndStore()
  console.log(`耗时 ${Date.now() - t0}ms`)
  console.log('本次抓取:', outcome.fetched, '| 新入库:', outcome.inserted)
  console.log('各源结果:')
  for (const s of outcome.bySource) {
    console.log(`  ${s.ok ? '✅' : '❌'} ${s.source.padEnd(14)} ${String(s.count).padStart(4)} 条 ${s.error ?? ''}`)
  }

  console.log('\n=== [2] 库内核验 saturn-* ===')
  const total = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM `news_item` WHERE `external_id` LIKE 'saturn-%'")
  console.log('总条数:', total?.c ?? 0)

  const bySource = await db.all<{ source: string; c: number }>(
    "SELECT `source`, COUNT(*) AS c FROM `news_item` WHERE `external_id` LIKE 'saturn-%' GROUP BY `source` ORDER BY c DESC",
  )
  console.log('按来源:')
  for (const x of bySource) console.log(`  ${String(x.c).padStart(4)} ${x.source}`)

  const byCat = await db.all<{ category: string; c: number }>(
    "SELECT `category`, COUNT(*) AS c FROM `news_item` WHERE `external_id` LIKE 'saturn-%' GROUP BY `category` ORDER BY c DESC",
  )
  console.log('按分类（验证自动打标）:')
  for (const x of byCat) console.log(`  ${String(x.c).padStart(4)} ${x.category}`)

  const samples = await db.all<Record<string, any>>(
    "SELECT `source`,`category`,`title`,`content_url`,`published_at`,`summary` FROM `news_item` WHERE `external_id` LIKE 'saturn-%' ORDER BY `published_at` DESC LIMIT 5",
  )
  console.log('\n最新 5 条:')
  for (const s of samples) {
    console.log(`  [${s.source} / ${s.category}] ${String(s.title).slice(0, 40)}`)
    console.log(`    ${s.published_at} | ${s.content_url ?? '无URL'}`)
    console.log(`    ${String(s.summary ?? '').slice(0, 70)}...`)
  }

  console.log('\n=== [3] 数据质量 ===')
  const dup = await db.all<{ source: string; external_id: string; c: number }>(
    "SELECT `source`, `external_id`, COUNT(*) AS c FROM `news_item` WHERE `external_id` LIKE 'saturn-%' GROUP BY `source`, `external_id` HAVING COUNT(*) > 1",
  )
  console.log('重复 (source, external_id):', dup.length, dup.length ? dup.slice(0, 3) : '✅ 无')

  const bad = await db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM `news_item` WHERE `external_id` LIKE 'saturn-%' AND (`title` = '' OR `title` LIKE '%undefined%' OR `title` LIKE '%<%%')",
  )
  console.log('脏数据（空标题/含 undefined/含标签）:', bad?.c ?? 0, (bad?.c ?? 0) === 0 ? '✅' : '❌')

  const noTime = await db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM `news_item` WHERE `external_id` LIKE 'saturn-%' AND `published_at` IS NULL",
  )
  console.log('无发布时间:', noTime?.c ?? 0)

  console.log('\n=== [4] 幂等复跑（第二轮采集）===')
  const outcome2 = await fetchAndStore()
  const shuguang2 = outcome2.bySource.find((s) => s.source === '曙光舆情')
  console.log('本轮曙光新入库:', shuguang2?.count ?? 0)
  const total2 = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM `news_item` WHERE `external_id` LIKE 'saturn-%'")
  console.log('复跑后总条数:', total2?.c ?? 0)
  // 允许少量新增：两次采集之间公众号仍在发文，属正常
  const grew = (total2?.c ?? 0) - (total?.c ?? 0)
  console.log(`相比首轮增长 ${grew} 条（跨轮新增属正常；去重保证见上）`)

  await closeAll()
  process.exit(0)
}

main().catch(async (e) => {
  console.error('❌ 失败:', (e as Error).message, '\n', (e as Error).stack)
  await closeAll().catch(() => {})
  process.exit(1)
})
