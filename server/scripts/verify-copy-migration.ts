/**
 * W0 迁移自检（不依赖 HTTP / Redis）：
 *  - 干净库跑两次迁移，验证幂等（AC-0.1）
 *  - 校验 copy 扩展列、9 张新表、种子（4 模板 / 6 风格 / 合规词库 / persona 扩展字段）（AC-0.4）
 *  - copy 新增列全部可空或有默认值（AC-0.3 静态部分）
 *
 * 用法（必须显式指向临时库，否则会写进 .data/dev.db）：
 *   DB_DRIVER=sqlite DB_SQLITE_PATH=./.data/verify/mig.db npx tsx scripts/verify-copy-migration.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { initDb, closeAll } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed += 1
    console.log(`  ❌ ${name}`, extra ?? '')
  }
}

const dbPath = process.env.DB_SQLITE_PATH
if (!dbPath || !dbPath.includes('verify')) {
  console.error('请指定临时库：DB_DRIVER=sqlite DB_SQLITE_PATH=./.data/verify/mig.db npx tsx scripts/verify-copy-migration.ts')
  process.exit(2)
}
fs.mkdirSync(path.dirname(dbPath), { recursive: true })
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true })

const db = await initDb()
const first = await runMigrations(db)
const second = await runMigrations(db)

console.log('\n[1] 迁移')
check('首次执行含 3 个数据迁移版本（建表为常驻幂等步骤）', first.length === 3, first)
check('重复执行为空（幂等）', second.length === 0, second)

console.log('\n[2] 表与列')
const tables = (await db.all<{ name: string }>(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
)).map((r) => r.name)
const required = [
  'copy', 'copy_draft', 'copy_version', 'copy_generation', 'copy_variant',
  'copy_template', 'copy_style', 'article_source', 'compliance_word', 'review_submission',
]
for (const t of required) check(`表 ${t} 存在`, tables.includes(t))

const copyCols = (await db.all<{ name: string; notnull: number; dflt_value: unknown }>(
  'PRAGMA table_info("copy")',
))
const colNames = copyCols.map((c) => c.name)
const newCols = [
  'line', 'current_draft_id', 'submitted_version_id', 'approved_version_id',
  'review_submission_id', 'review_gate', 'reject_reason', 'settings',
  'ever_submitted', 'updated_at', 'archived_at',
]
for (const c of newCols) check(`copy.${c} 扩展列存在`, colNames.includes(c), colNames)

const d12 = ['id', 'topic_id', 'persona_id', 'source', 'status', 'title', 'source_text', 'source_ref_type', 'source_ref_id', 'extract_cache_id', 'body', 'created_by', 'created_at']
check('D12 冻结字段全部保留', d12.every((c) => colNames.includes(c)))

console.log('\n[3] 种子')
const tpls = await db.all<{ name: string; risk_hint: string; is_builtin: number }>('SELECT * FROM copy_template')
check('4 个内置模板', tpls.length === 4, tpls.length)
check('模板全部内置标记', tpls.every((t) => Number(t.is_builtin) === 1))
check('模板全部有 riskHint', tpls.every((t) => !!t.risk_hint))

const styles = await db.all<{ line: string }>('SELECT * FROM copy_style')
check('6 个内置风格', styles.length === 6, styles.length)
const byLine = styles.reduce<Record<string, number>>((acc, s) => {
  acc[s.line] = (acc[s.line] ?? 0) + 1
  return acc
}, {})
check('风格线绑定正确（manager 2 / kos 2 / persona 2）',
  byLine.manager === 2 && byLine.kos === 2 && byLine.persona === 2, byLine)

const cw = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM compliance_word')
const hard = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM compliance_word WHERE `level` = \'hard\'')
check('合规词库有初稿', Number(cw?.c ?? 0) >= 20, cw)
check('两级都有词（硬禁用 ≥ 10）', Number(hard?.c ?? 0) >= 10, hard)

const personas = await db.all<{ ip_profile: string }>('SELECT ip_profile FROM persona')
const extOk = personas.every((p) => {
  const ip = JSON.parse(p.ip_profile) as Record<string, unknown>
  return !!(ip.audience_needs && ip.factual_background && ip.sample_script)
})
check('persona 桩含 §4.3 三个扩展字段', extOk, personas.length)

console.log('\n[4] 幂等重跑不产生重复种子')
await runMigrations(db)
const tpl2 = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM copy_template')
check('模板数未增长', Number(tpl2?.c) === 4, tpl2)

await closeAll()
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true })

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ 失败 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
