/**
 * 静态检查：业务代码中 `UPDATE \`t\` SET \`col\` = …` 与 `INSERT INTO \`t\` (\`col\`, …)` 引用的列
 * 必须在 schema.ts 中存在（P1-3：试听轮询写了不存在的 updated_at，只在运行时才报错）。
 *
 * 只检查表名、列名都是字面量的语句；动态拼接的列（如 `${k}`）跳过。
 * 用法：npm run check:sql-columns
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TABLES } from '../src/db/schema.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const columns = new Map(TABLES.map((t) => [t.name, new Set(t.cols.map((c) => c.name))]))

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

// 源码里的反引号可能写成 \` （模板字符串内转义）
const BT = '\\\\?`'
const ident = `${BT}(\\w+)${BT}`
const updateRe = new RegExp(`UPDATE\\s+${ident}\\s+SET\\s+([\\s\\S]*?)\\s+WHERE`, 'g')
const insertRe = new RegExp(`INSERT(?:\\s+IGNORE|\\s+OR\\s+IGNORE)?\\s+INTO\\s+${ident}\\s*\\(([^)]*)\\)`, 'g')
const colRe = new RegExp(`${BT}(\\w+)${BT}\\s*=`, 'g')
const listColRe = new RegExp(`${BT}(\\w+)${BT}`, 'g')

const problems: string[] = []
let checked = 0

for (const file of walk(root)) {
  const src = fs.readFileSync(file, 'utf8')
  const rel = path.relative(path.resolve(root, '..'), file)
  const lineOf = (idx: number) => src.slice(0, idx).split('\n').length

  for (const m of src.matchAll(updateRe)) {
    const table = m[1]!
    const cols = columns.get(table)
    if (!cols) continue // 动态表名或非本库表
    checked++
    for (const c of m[2]!.matchAll(colRe)) {
      if (!cols.has(c[1]!)) problems.push(`${rel}:${lineOf(m.index!)} UPDATE \`${table}\` 引用了不存在的列 \`${c[1]}\``)
    }
  }
  for (const m of src.matchAll(insertRe)) {
    const table = m[1]!
    const cols = columns.get(table)
    if (!cols) continue
    checked++
    for (const c of m[2]!.matchAll(listColRe)) {
      if (!cols.has(c[1]!)) problems.push(`${rel}:${lineOf(m.index!)} INSERT INTO \`${table}\` 引用了不存在的列 \`${c[1]}\``)
    }
  }
}

if (problems.length) {
  console.error(`❌ SQL 列名检查失败（${problems.length} 处）：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`✅ SQL 列名检查通过（${checked} 条 UPDATE / INSERT 语句）`)
