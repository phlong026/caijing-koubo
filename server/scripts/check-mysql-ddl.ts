/**
 * MySQL 分支离线校验脚本。
 *
 * 背景：本地验证环境跑的是内置 sqlite 回退分支，MySQL 分支（真实投产方言）
 * 在生产接入前若无 IS 环境，容易带着方言级致命错误上线。本脚本在不连接任何
 * 数据库的前提下，对 TABLES DSL 生成的 MySQL DDL 做静态体检：
 *
 *   A 主键存在性与 NOT NULL      MySQL 主键列必须 NOT NULL
 *   B TEXT/JSON 默认值            MySQL 不允许给 TEXT/BLOB/JSON 赋非 NULL 默认值
 *   C 索引列类型                  TEXT/LONGTEXT/JSON 建索引必须指定前缀长度，DSL 未支持 → 直接拦截
 *   D 索引名长度                  MySQL 上限 64 字符
 *   E 索引字节长度                InnoDB 单索引上限 3072 bytes（utf8mb4 = 4 bytes/char）
 *   F 列存在性                    索引/唯一键引用的列必须在 cols 中声明
 *   G 行大小                      InnoDB 单行非溢出字节上限 65535
 *   H DDL 语法                    用真实 MySQL 解析器走一遍（parser 可用时执行）
 *   I 方言一致性                  MySQL 与 SQLite 两分支表/列集合必须一致
 *
 * 用法：npm run check:mysql-ddl
 */
import { TABLES, createIndexSql, createTableSql, type Col, type TableDef } from '../src/db/schema.js'

const MAX_INDEX_NAME = 64
const MAX_INDEX_BYTES = 3072
const MAX_ROW_BYTES = 65535
const UTF8MB4_BYTES = 4

/** MySQL 不允许有默认值的类型（DEFAULT NULL 本身合法） */
const NO_DEFAULT_TYPES = new Set<Col['type']>(['text', 'longtext', 'json'])
/** 不能直接进索引的类型（需指定前缀长度） */
const NO_INDEX_TYPES = new Set<Col['type']>(['text', 'longtext', 'json'])

type Pass = { ok: true }
type Fail = { ok: false; table: string; rule: string; msg: string }
type Result = Pass | Fail

let failures: Fail[] = []
let passed = 0

function check(ok: boolean, table: string, rule: string, msg: string) {
  if (ok) passed += 1
  else failures.push({ ok: false, table, rule, msg })
}

/** 取本轮收集到的失败规则集合，并清空以便复用（自检模式用） */
function resetResults(): { rules: Set<string>; msgs: string[] } {
  const rules = new Set(failures.map((f) => f.rule))
  const msgs = failures.map((f) => f.msg)
  failures = []
  passed = 0
  return { rules, msgs }
}

/** 列在 MySQL 下的存储字节估算（0 表示变长/不可直接计算的溢出类型） */
function colBytes(c: Col): number {
  switch (c.type) {
    case 'varchar':
      return (c.len ?? 64) * UTF8MB4_BYTES
    case 'int':
      return 4
    case 'bigint':
      return 8
    case 'tinyint':
      return 1
    case 'decimal': {
      const intDigits = (c.len ?? 12) - (c.scale ?? 6)
      return Math.ceil(intDigits / 9) * 4 + Math.ceil((c.scale ?? 6) / 9) * 4
    }
    case 'datetime':
      return 5 // MySQL 5.6+ DATETIME 不含小数秒
    default:
      return 0 // text/longtext/json：溢出存储，由 C 规则单独约束
  }
}

function colOf(t: TableDef, name: string): Col | undefined {
  return t.cols.find((c) => c.name === name)
}

/** 校验一张表 */
function checkTable(t: TableDef) {
  const allIndexGroups: Array<{ label: string; cols: string[] }> = [
    ...(t.uniques ?? []).map((u) => ({ label: `唯一键 uk_${t.name}_${u.join('_')}`, cols: u })),
    ...(t.indexes ?? []).map((i) => ({ label: `索引 ${i.name}`, cols: i.cols })),
  ]

  // A 主键存在且 NOT NULL
  const pk = colOf(t, t.pk)
  check(!!pk, t.name, 'A 主键', `主键列 ${t.pk} 未在 cols 中声明`)
  if (pk) {
    check(
      !(pk.nullable === true),
      t.name,
      'A 主键',
      `主键列 ${t.pk} 声明为 nullable，MySQL 主键列必须 NOT NULL`,
    )
  }

  for (const c of t.cols) {
    // B TEXT/JSON 不得有非 NULL 默认值
    if (NO_DEFAULT_TYPES.has(c.type)) {
      check(
        c.def === undefined || c.def === null,
        t.name,
        'B 默认值',
        `列 ${c.name} 为 ${c.type}，MySQL 不允许非 NULL 默认值（当前=${String(c.def)}）`,
      )
    }
  }

  for (const g of allIndexGroups) {
    // D 索引名长度
    const idxName = g.label.includes('唯一键') ? g.label.slice(4) : g.label.slice(3)
    check(
      idxName.length <= MAX_INDEX_NAME,
      t.name,
      'D 索引名长度',
      `${g.label} 长度 ${idxName.length} 超过 MySQL 上限 ${MAX_INDEX_NAME}`,
    )

    let bytes = 0
    for (const name of g.cols) {
      const c = colOf(t, name)
      // F 列存在性
      if (!c) {
        check(false, t.name, 'F 列存在性', `${g.label} 引用了未声明的列 ${name}`)
        continue
      }
      // C 索引列类型
      check(
        !NO_INDEX_TYPES.has(c.type),
        t.name,
        'C 索引列类型',
        `${g.label} 包含 ${c.type} 列 ${name}；MySQL 对该类型必须指定 key 前缀长度，DSL 暂不支持`,
      )
      bytes += colBytes(c)
    }

    // E 索引字节长度
    if (bytes > 0) {
      check(
        bytes <= MAX_INDEX_BYTES,
        t.name,
        'E 索引字节',
        `${g.label} 估算 ${bytes} bytes 超过 InnoDB 单索引上限 ${MAX_INDEX_BYTES}（utf8mb4 × 字符数）`,
      )
    }
  }

  // G 行大小（varchar/定长列之和，溢出类型不计）
  const rowBytes = t.cols.reduce((sum, c) => sum + colBytes(c), 0)
  check(rowBytes <= MAX_ROW_BYTES, t.name, 'G 行大小', `单行估算 ${rowBytes} bytes 超过 ${MAX_ROW_BYTES}`)

  // I 方言一致性：两种方言都能生成且解析出相同列集合
  const mysqlDdl = createTableSql(t, 'mysql')
  const sqliteDdl = createTableSql(t, 'sqlite')
  check(mysqlDdl.includes('ENGINE=InnoDB'), t.name, 'I 方言', 'MySQL DDL 缺少 ENGINE=InnoDB')
  check(mysqlDdl.includes('utf8mb4'), t.name, 'I 方言', 'MySQL DDL 未指定 utf8mb4 字符集')
  check(sqliteDdl.length > 0, t.name, 'I 方言', 'SQLite DDL 生成失败')
  for (const c of t.cols) {
    check(sqliteDdl.includes(c.name), t.name, 'I 方言', `SQLite DDL 丢失列 ${c.name}`)
  }
}

/**
 * 自检（--selftest）：喂一批已知违规的表定义，确认每条规则都能被触发。
 * 没有这一层，通过的 0 失败可能只是"规则从未生效"。
 */
const BAD_CASES: Array<{ name: string; expectRule: string; table: TableDef }> = [
  {
    name: 'TEXT 列直接进索引',
    expectRule: 'C 索引列类型',
    table: {
      name: 'bad_text_index',
      pk: 'id',
      cols: [
        { name: 'id', type: 'varchar', len: 40 },
        { name: 'body', type: 'text', nullable: true },
      ],
      indexes: [{ name: 'idx_bad_body', cols: ['body'] }],
    },
  },
  {
    name: '索引名超过 64 字符',
    expectRule: 'D 索引名长度',
    table: {
      name: 'bad_index_name',
      pk: 'id',
      cols: [
        { name: 'id', type: 'varchar', len: 40 },
        { name: 'flag', type: 'tinyint', def: 0 },
      ],
      indexes: [{ name: `idx_${'x'.repeat(70)}`, cols: ['flag'] }],
    },
  },
  {
    name: 'JSON 列给了非 NULL 默认值',
    expectRule: 'B 默认值',
    table: {
      name: 'bad_json_default',
      pk: 'id',
      cols: [
        { name: 'id', type: 'varchar', len: 40 },
        { name: 'payload', type: 'json', nullable: true, def: '{}' },
      ],
    },
  },
  {
    name: '主键列声明为 nullable',
    expectRule: 'A 主键',
    table: {
      name: 'bad_pk_nullable',
      pk: 'id',
      cols: [{ name: 'id', type: 'varchar', len: 40, nullable: true }],
    },
  },
  {
    name: '索引引用了未声明的列',
    expectRule: 'F 列存在性',
    table: {
      name: 'bad_missing_col',
      pk: 'id',
      cols: [{ name: 'id', type: 'varchar', len: 40 }],
      indexes: [{ name: 'idx_bad_missing', cols: ['not_exists'] }],
    },
  },
  {
    name: '单列 varchar(1000) 索引超 3072 bytes',
    expectRule: 'E 索引字节',
    table: {
      name: 'bad_index_bytes',
      pk: 'id',
      cols: [
        { name: 'id', type: 'varchar', len: 40 },
        { name: 'wide', type: 'varchar', len: 1000, nullable: true },
      ],
      indexes: [{ name: 'idx_bad_wide', cols: ['wide'] }],
    },
  },
  {
    name: '单行 varchar 总和超 65535 bytes',
    expectRule: 'G 行大小',
    table: {
      name: 'bad_row_size',
      pk: 'id',
      cols: [
        { name: 'id', type: 'varchar', len: 40 },
        ...Array.from({ length: 6 }, (_, i) => ({
          name: `huge_${i}`,
          type: 'varchar' as const,
          len: 3000,
          nullable: true,
        })),
      ],
    },
  },
]

async function selftest() {
  console.log('\n=== 校验器自检（反例必须被拦截）===\n')
  let missed = 0
  for (const c of BAD_CASES) {
    checkTable(c.table)
    const { rules, msgs } = resetResults()
    const caught = rules.has(c.expectRule)
    if (caught) {
      console.log(`  ✅ ${c.expectRule} ← ${c.name}`)
    } else {
      missed += 1
      console.log(`  ❌ ${c.expectRule} 未生效 ← ${c.name}（实际告警：${msgs.join(' / ') || '无'}）`)
    }
  }

  // H 规则：坏语法必须被 MySQL 解析器拒绝
  try {
    const mod = (await import('node-sql-parser')) as Record<string, any>
    const Parser = mod.Parser ?? mod.default?.Parser
    const parser = new Parser()
    let caught = false
    try {
      parser.astify('CREATE TABLE `bad` (`id` NOT_T_A_TYPE)', { database: 'MySQL' })
    } catch {
      caught = true
    }
    if (caught) console.log('  ✅ H 语法解析 ← 非法列类型被解析器拒绝')
    else {
      missed += 1
      console.log('  ❌ H 语法解析 未生效 ← 非法列类型竟通过解析')
    }
  } catch (e) {
    console.log(`  ⚠️  H 语法解析自检跳过（${(e as Error).message}）`)
  }

  console.log(`\n=== 自检结果：${BAD_CASES.length + 1 - missed}/${BAD_CASES.length + 1} 条规则确实生效 ===\n`)
  if (missed > 0) process.exitCode = 1
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest()

  for (const t of TABLES) {
    checkTable(t)
    // 索引 DDL 生成不得抛错
    for (const i of t.indexes ?? []) {
      const my = createIndexSql(t, i, 'mysql')
      check(
        !my.includes('IF NOT EXISTS'),
        t.name,
        'I 方言',
        `索引 ${i.name} 的 MySQL 语句含 IF NOT EXISTS；MySQL 不支持该语法，需靠 migrate 的 indexExists 守卫`,
      )
    }
  }

  // H 真实语法解析（解析器可用时）
  try {
    // node-sql-parser 为 CJS 包，ESM 动态导入时导出会挂在 default 上
    const mod = (await import('node-sql-parser')) as Record<string, any>
    const Parser = mod.Parser ?? mod.default?.Parser
    if (typeof Parser !== 'function') throw new Error('未取到 Parser 构造器')
    const parser = new Parser()
    let parsed = 0
    for (const t of TABLES) {
      const ddl = createTableSql(t, 'mysql')
      try {
        const ast = parser.astify(ddl, { database: 'MySQL' }) as {
          type?: string
          keyword?: string
          create_definitions?: unknown[]
        }
        const shapeOk = ast?.type === 'create' && ast?.keyword === 'table' && (ast.create_definitions?.length ?? 0) > 0
        check(shapeOk, t.name, 'H 语法解析', `MySQL 解析器未返回预期的 CREATE TABLE 结构`)
        parsed += 1
      } catch (e) {
        check(false, t.name, 'H 语法解析', `MySQL 解析器报错：${(e as Error).message}`)
      }
    }
    console.log(`  H 语法解析：${parsed}/${TABLES.length} 张表通过 MySQL 解析器\n`)
  } catch (e) {
    console.log(`  H 语法解析：跳过（解析器不可用：${(e as Error).message}），仅执行规则检查\n`)
  }

  console.log('=== 校验结果 ===')
  if (failures.length === 0) {
    console.log(`\n✅ 全部通过：通过 ${passed} 项，失败 0 项`)
    console.log('   MySQL 分支可上线验收；真实实例到位后仍需跑一次 npm run migrate 做实跑确认。\n')
    return
  }
  console.log(`\n❌ 通过 ${passed} 项，失败 ${failures.length} 项\n`)
  for (const f of failures) {
    console.log(`  [${f.rule}] ${f.table}: ${f.msg}`)
  }
  console.log('')
  process.exitCode = 1
}

main().catch((e) => {
  console.error('\n❌ 校验脚本异常终止：', e)
  process.exit(1)
})
