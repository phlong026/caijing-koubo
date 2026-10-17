/**
 * 修复历史数据：`status='candidate'` 但已写入 `persona_ids` 的错位记录。
 *
 * 背景：`topics/service.ts` 生成候选时固定写 `status:'candidate'`，同时又写入
 * `personaIds: [persona.id]`。于是库里大量记录满足「状态说未分配、数据说已分配」。
 * 后果：
 *   - 前端候选卡按 status 判断，显示「未分配人物，不能直接送入」，但下拉里人物是选中的；
 *   - `/topics/send` 预校验遇到 `status==='candidate'` 直接抛 409，
 *     这批「生成即带人物」的候选必须先手动重选一次人物才送得出去。
 *
 * 本脚本幂等：只把「已有人物」的 candidate 纠正为 assigned，可重复执行。
 * 用法：npm run fix:topic-status         （预演，仅统计）
 *      npm run fix:topic-status -- --apply（实际写库）
 */
import { closeAll, initDb } from '../src/db/index.js'

const APPLY = process.argv.includes('--apply')

function hasPersona(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false
  const s = String(raw).trim()
  if (!s || s === 'null' || s === 'undefined' || s === '[]') return false
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) && v.length > 0
  } catch {
    return true
  }
}

async function main(): Promise<void> {
  const db = await initDb()
  const rows = await db.all<{ id: string; persona_ids: string }>(
    "SELECT `id`, `persona_ids` FROM `topic` WHERE `status` = 'candidate'",
  )
  const bad = rows.filter((r) => hasPersona(r.persona_ids))
  console.log(`库类型：${db.kind}`)
  console.log(`candidate 总数：${rows.length}，其中已有人物（需纠正）：${bad.length}`)
  if (!bad.length) {
    console.log('无需修复')
    return
  }
  for (const r of bad.slice(0, 5)) console.log(`  示例 ${r.id} → ${r.persona_ids}`)
  if (!APPLY) {
    console.log('\n预演模式：未写库。加 --apply 实际执行。')
    return
  }
  let n = 0
  for (const r of bad) {
    // 条件更新：只纠正仍是 candidate 的记录，避免覆盖期间被人工改成别状态的数据
    const res = await db.run(
      "UPDATE `topic` SET `status` = 'assigned' WHERE `id` = ? AND `status` = 'candidate'",
      [r.id],
    )
    n += res.affectedRows ?? 0
  }
  console.log(`\n已纠正 ${n} 条`)
  await closeAll()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
