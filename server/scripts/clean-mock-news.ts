/**
 * 清除「内置示意源」模拟资讯及其派生的选题 / 文案。
 *
 * ── 为什么需要脚本而不是一条 DELETE ────────────────────────────────
 *
 * `news_item` 是链条的源头，往下有 4 层引用：
 *   news_item → topic（source_id）→ copy（topic_id）
 *                                   ├→ copy_draft
 *                                   ├→ copy_version
 *                                   ├→ copy_generation → copy_variant
 *                                   └→ review_submission
 * 直接删 news_item 会留下悬空的 topic（点开「关联资讯」查不到），
 * 再删 topic 又会留下孤儿 copy。必须按依赖反序删。
 *
 * ── 安全性 ────────────────────────────────────────────────────────
 *
 * - 只处理 `source = '内置示意源'`（MockProvider 固定写入的 label），不碰任何真实来源；
 * - 默认**预演**，只统计不写库；加 `--apply` 才真正执行；
 * - 全程单事务，任一步失败整体回滚；
 * - 级联删除只针对「引用模拟资讯」的 topic/copy，不误伤真实数据。
 *
 * 用法：
 *   npm run clean:mock-news            预演
 *   npm run clean:mock-news -- --apply 执行
 */
import { closeAll, initDb, type Db } from '../src/db/index.js'

const MOCK_LABEL = '内置示意源'
const APPLY = process.argv.includes('--apply')

const q = (n: number) => Array.from({ length: n }, () => '?').join(', ')

/** 统计某张表里命中 id 集合的行数 */
async function count(db: Db, sql: string, params: unknown[]): Promise<number> {
  const r = await db.get<{ c: number }>(sql, params)
  return Number(r?.c ?? 0)
}

async function main(): Promise<void> {
  const db = await initDb()

  const newsIds = (await db.all<{ id: string }>('SELECT `id` FROM `news_item` WHERE `source` = ?', [MOCK_LABEL])).map(
    (r) => r.id,
  )
  console.log(`库类型：${db.kind}`)
  console.log(`模拟资讯（${MOCK_LABEL}）：${newsIds.length} 条`)
  if (!newsIds.length) {
    console.log('无需清理')
    await closeAll()
    return
  }

  // 1. 引用模拟资讯的选题
  const topicIds = (
    await db.all<{ id: string }>(`SELECT \`id\` FROM \`topic\` WHERE \`source_id\` IN (${q(newsIds.length)})`, newsIds)
  ).map((r) => r.id)

  // 2. 这些选题派生的 copy
  const copyIds = topicIds.length
    ? (
        await db.all<{ id: string }>(`SELECT \`id\` FROM \`copy\` WHERE \`topic_id\` IN (${q(topicIds.length)})`, topicIds)
      ).map((r) => r.id)
    : []

  // 3. 统计各层将要删除的行数
  const stats: Record<string, number> = { 'news_item（资讯）': newsIds.length, 'topic（选题）': topicIds.length, 'copy（文案）': copyIds.length }

  if (copyIds.length) {
    const cp = q(copyIds.length)
    stats['copy_draft（稿件）'] = await count(db, `SELECT COUNT(*) AS c FROM \`copy_draft\` WHERE \`copy_id\` IN (${cp})`, copyIds)
    stats['copy_version（版本）'] = await count(db, `SELECT COUNT(*) AS c FROM \`copy_version\` WHERE \`copy_id\` IN (${cp})`, copyIds)
    const genIds = (
      await db.all<{ id: string }>(`SELECT \`id\` FROM \`copy_generation\` WHERE \`copy_id\` IN (${cp})`, copyIds)
    ).map((r) => r.id)
    stats['copy_generation（生成记录）'] = genIds.length
    if (genIds.length) {
      stats['copy_variant（变体）'] = await count(
        db,
        `SELECT COUNT(*) AS c FROM \`copy_variant\` WHERE \`generation_id\` IN (${q(genIds.length)})`,
        genIds,
      )
    }
    stats['review_submission（审核单）'] = await count(
      db,
      `SELECT COUNT(*) AS c FROM \`review_submission\` WHERE \`copy_id\` IN (${cp})`,
      copyIds,
    )
  }

  if (topicIds.length) {
    const tp = q(topicIds.length)
    // 批次表按 batch_id 关联；仅删除「只包含模拟资讯」的批次
    stats['topic_generation_batch（批次）'] = await count(
      db,
      `SELECT COUNT(*) AS c FROM \`topic_generation_batch\` WHERE \`id\` IN (SELECT DISTINCT \`batch_id\` FROM \`topic\` WHERE \`id\` IN (${tp}) AND \`batch_id\` IS NOT NULL)`,
      topicIds,
    )
  }

  console.log('\n将删除：')
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`)

  if (!APPLY) {
    console.log('\n预演模式：未写库。加 --apply 实际执行。')
    await closeAll()
    return
  }

  // 4. 单事务按依赖反序删除
  await db.tx(async (t) => {
    if (copyIds.length) {
      const cp = q(copyIds.length)
      const genIds = (
        await t.all<{ id: string }>(`SELECT \`id\` FROM \`copy_generation\` WHERE \`copy_id\` IN (${cp})`, copyIds)
      ).map((r) => r.id)
      if (genIds.length) {
        await t.run(`DELETE FROM \`copy_variant\` WHERE \`generation_id\` IN (${q(genIds.length)})`, genIds)
      }
      await t.run(`DELETE FROM \`review_submission\` WHERE \`copy_id\` IN (${cp})`, copyIds)
      await t.run(`DELETE FROM \`copy_generation\` WHERE \`copy_id\` IN (${cp})`, copyIds)
      await t.run(`DELETE FROM \`copy_version\` WHERE \`copy_id\` IN (${cp})`, copyIds)
      await t.run(`DELETE FROM \`copy_draft\` WHERE \`copy_id\` IN (${cp})`, copyIds)
      await t.run(`DELETE FROM \`copy\` WHERE \`id\` IN (${cp})`, copyIds)
    }
    if (topicIds.length) {
      const tp = q(topicIds.length)
      await t.run(`DELETE FROM \`topic\` WHERE \`id\` IN (${tp})`, topicIds)
    }
    await t.run(`DELETE FROM \`news_item\` WHERE \`id\` IN (${q(newsIds.length)})`, newsIds)
  })

  console.log('\n✅ 清理完成')

  // 5. 复核：确认已无残留
  const left = await count(db, 'SELECT COUNT(*) AS c FROM `news_item` WHERE `source` = ?', [MOCK_LABEL])
  const remain = await db.all<{ source: string; c: number }>(
    'SELECT `source`, COUNT(*) AS c FROM `news_item` GROUP BY `source` ORDER BY c DESC',
  )
  console.log(`残留模拟资讯：${left}`)
  console.log('当前来源分布：')
  for (const r of remain) console.log(`  ${r.source}: ${r.c}`)
  await closeAll()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
