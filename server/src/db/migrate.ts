import type { Db } from './index.js'
import { getDb, insertIgnore, upsert } from './index.js'
import { TABLES, createIndexSql, createTableSql } from './schema.js'
import { logger } from '../log.js'
import { newId } from '../lib/util.js'
import { toDb, utcNow } from '../lib/time.js'
import { seedCopyWorkshop, seedPersonaExtensions } from './seed-copy.js'

export interface Migration {
  version: string
  name: string
  up: (db: Db) => Promise<void>
}

/**
 * 结构对齐（幂等），**顺序必须是：建表 → 补列 → 建索引**。
 *
 * P1-15：原来的顺序是建表+建索引一起跑，再靠 `003_copy_columns` 补列。老库的 `copy` 表
 * 没有 `updated_at` 列时，`CREATE INDEX idx_copy_status_upd(status, updated_at)` 会直接
 * 报错导致服务启动失败；且补列只绑定在一次性的 003 版本里，以后再加列不会自动补齐。
 * 现在补列每次启动都幂等执行，并前移到建索引之前。
 */
async function syncSchema(db: Db): Promise<void> {
  for (const t of TABLES) {
    await db.exec(createTableSql(t, db.kind))
  }
  // 补列必须在建索引之前：索引可能引用新增列
  await addMissingColumns(db)
  for (const t of TABLES) {
    for (const i of t.indexes ?? []) {
      if (db.kind === 'sqlite') {
        await db.exec(createIndexSql(t, i, 'sqlite'))
      } else if (!(await db.indexExists(i.name))) {
        // 老库可能残留同名列/冲突索引，单个索引失败不应阻断启动
        try {
          await db.exec(createIndexSql(t, i, 'mysql'))
        } catch (e) {
          logger.warn({ table: t.name, index: i.name, err: (e as Error).message }, 'db.index_create_skipped')
        }
      }
    }
  }
}

/**
 * 已有库的列补全（任务书 §4.1「copy 扩展」）。
 * MySQL 的 CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，故按 information_schema 比对后 ALTER。
 * SQLite 分支走「整表重建」成本过高，改为 ALTER TABLE ADD COLUMN（SQLite 支持逐列追加）。
 */
async function addMissingColumns(db: Db): Promise<void> {
  for (const t of TABLES) {
    const existing = await existingColumns(db, t.name)
    // 表不存在则跳过（新建表由上一步建表负责）
    if (!existing.size) continue
    for (const c of t.cols) {
      if (existing.has(c.name)) continue
      const ddl = columnDdl(c, db.kind)
      logger.info({ table: t.name, column: c.name }, 'db.column_added')
      await db.exec(`ALTER TABLE ${q(db.kind, t.name)} ADD COLUMN ${q(db.kind, c.name)} ${ddl}`)
    }
  }
}

function q(kind: 'mysql' | 'sqlite', s: string): string {
  return kind === 'mysql' ? `\`${s}\`` : `"${s}"`
}

/** 单列 DDL（与 createTableSql 的类型映射保持一致） */
function columnDdl(c: { type: string; len?: number; scale?: number; def?: string | number | null; nullable?: boolean }, kind: 'mysql' | 'sqlite'): string {
  let type: string
  switch (c.type) {
    case 'varchar':
      type = kind === 'mysql' ? `VARCHAR(${c.len ?? 64})` : 'TEXT'
      break
    case 'longtext':
      type = kind === 'mysql' ? 'LONGTEXT' : 'TEXT'
      break
    case 'int':
      type = kind === 'mysql' ? 'INT' : 'INTEGER'
      break
    case 'bigint':
      type = kind === 'mysql' ? 'BIGINT' : 'INTEGER'
      break
    case 'tinyint':
      type = kind === 'mysql' ? 'TINYINT' : 'INTEGER'
      break
    case 'decimal':
      type = kind === 'mysql' ? `DECIMAL(${c.len ?? 12},${c.scale ?? 6})` : 'REAL'
      break
    case 'datetime':
      type = kind === 'mysql' ? 'DATETIME' : 'TEXT'
      break
    case 'json':
      type = kind === 'mysql' ? 'JSON' : 'TEXT'
      break
    default:
      type = 'TEXT'
  }
  // ALTER ADD COLUMN 必须允许 NULL（已存在数据行需要安全默认值，FR-X1）
  const nullable = 'NULL'
  let def = ''
  if (c.def !== undefined && c.def !== null) {
    const d = typeof c.def === 'number' ? String(c.def) : `'${String(c.def).replace(/'/g, "''")}'`
    def = ` DEFAULT ${d}`
  }
  return `${type} ${nullable}${def}`
}

async function existingColumns(db: Db, table: string): Promise<Set<string>> {
  if (db.kind === 'mysql') {
    const rows = await db.all<{ c: string }>(
      'SELECT COLUMN_NAME AS c FROM information_schema.columns WHERE table_schema = database() AND table_name = ?',
      [table],
    )
    return new Set(rows.map((r) => String(r.c)))
  }
  try {
    const rows = await db.all<{ name: string }>(`PRAGMA table_info(${q('sqlite', table)})`)
    return new Set(rows.map((r) => String(r.name)))
  } catch {
    return new Set()
  }
}

/** 种子：人物桩（D13）、提示词模板（FR-C2）、分类规则（FR-N2） */
async function seedBaseData(db: Db): Promise<void> {
  const now = toDb(utcNow())

  // 1) persona 只读桩：M1 人物库就绪后由数据源替换，字段为其子集
  const personas: Array<{ id: string; name: string; line: string; ip: Record<string, unknown> }> = [
    {
      id: 'ps_manager_demo',
      name: '张经理（示例）',
      line: 'manager',
      ip: {
        role: '基金经理 / 宏观研究负责人',
        service_scope: '宏观与市场解读、资产配置框架',
        target_audience: '30~50 岁稳健型投资者，已有一定持仓',
        expression_style: '沉稳克制、数据先行，少情绪词，结论留有余地',
        forbidden_claims: ['不承诺收益', '不使用绝对化表述（稳赚、必涨）', '不给出个股买卖建议'],
        // §4.3 文案工坊可选扩展字段（M1 人物库落地后由其提供）
        audience_needs: '想知道当前市场处于什么位置、自己的持仓要不要调整，怕追高也怕踏空',
        factual_background:
          '从业 12 年，长期跟踪宽基指数估值与宏观流动性；擅长用估值分位与股债性价比讲清配置逻辑。',
        sample_script:
          '今天先给结论：这一轮调整更像是估值修复后的正常回摆，不是趋势反转。判断依据有三点，第一……',
      },
    },
    {
      id: 'ps_kos_demo',
      name: '小林投教（示例）',
      line: 'kos',
      ip: {
        role: '投资者教育专员',
        service_scope: '基金基础知识、定投与费用科普',
        target_audience: '25~40 岁理财新手',
        expression_style: '口语化、比喻多、短句，先讲规则再讲方法',
        forbidden_claims: ['不承诺收益', '不推荐具体产品', '不使用夸大表述'],
        audience_needs: '刚接触基金，分不清申购赎回与费用，想知道定投到底适不适合自己',
        factual_background: '负责营业部投资者教育三年，日常解答新手高频问题，熟悉基金合同与费用结构。',
        sample_script: '很多人以为定投就是每月固定买一点，其实关键不在买多少，而在你买的是什么。',
      },
    },
    {
      id: 'ps_persona_demo',
      name: '老周聊债基（示例）',
      line: 'persona',
      ip: {
        role: '债券基金观察者',
        service_scope: '债基与固收+、利率与信用风险解读',
        target_audience: '偏好低波动的存量投资者',
        expression_style: '接地气、讲案例，强调风险边界',
        forbidden_claims: ['不承诺保本', '不预测具体点位', '不做收益对比排名'],
        audience_needs: '手里有一笔闲钱，想要比活期高一点又怕亏本金，想知道债基为什么会跌',
        factual_background: '自己做债基配置六年，记录过几轮利率波动中债基净值回撤的过程与修复节奏。',
        sample_script: '债基也会跌，这点必须先说清楚。去年那波调整，很多人是第一次看到债基净值连着绿。',
      },
    },
  ]
  for (const p of personas) {
    await upsert(db, {
      table: 'persona',
      row: {
        id: p.id,
        name: p.name,
        line: p.line,
        enabled: 1,
        ip_profile: JSON.stringify(p.ip),
        is_stub: 1,
        created_at: now,
        updated_at: now,
      },
      uniqueCols: ['id'],
      updateCols: ['name', 'line', 'ip_profile', 'updated_at'],
    })
  }

  // 2) 提示词种子模板（P2-7：内置基础合规约束）
  const compliance =
    '\n\n【合规约束】不得承诺收益或保本；不得使用绝对化表述（稳赚、必涨、最高）；不得给出个股或具体产品的买卖建议；风险提示必须保留。'
  const templates: Array<{ id: string; name: string; builtin: string; content: string; def: number }> = [
    {
      id: 'tpl_seed_market',
      name: '市场解读',
      builtin: 'market',
      def: 1,
      content:
        '你是{role}。请基于下方资讯，为{target_audience}生成口播选题。\n要求：先给结论再给依据；每条包含 title / direction / hook / rationale 四个字段；hook 为一句话开场，口语可播；rationale 说明为什么这个角度现在值得讲。\n表达风格：{expression_style}\n禁用表达：{forbidden_claims}' +
        compliance,
    },
    {
      id: 'tpl_seed_education',
      name: '投教科普',
      builtin: 'education',
      def: 0,
      content:
        '你是{role}，做投资者教育内容。请基于下方资讯，生成面向{target_audience}的科普型口播选题。\n要求：从一个常见误解切入，讲清规则与边界；每条包含 title / direction / hook / rationale。\n表达风格：{expression_style}\n禁用表达：{forbidden_claims}' +
        compliance,
    },
    {
      id: 'tpl_seed_product',
      name: '产品推荐',
      builtin: 'product',
      def: 0,
      content:
        '你是{role}。请基于下方资讯，生成与产品类型讲解相关的口播选题（只讲品类与选择逻辑，不做具体产品推荐）。\n要求：先讲适用人群与风险，再讲选择维度；每条包含 title / direction / hook / rationale。\n表达风格：{expression_style}\n禁用表达：{forbidden_claims}' +
        compliance,
    },
    {
      id: 'tpl_seed_comment',
      name: '热点评论',
      builtin: 'comment',
      def: 0,
      content:
        '你是{role}。请基于下方热点资讯，生成观点型口播选题。\n要求：观点鲜明但不越界，给出两条以上支撑理由；每条包含 title / direction / hook / rationale。\n表达风格：{expression_style}\n禁用表达：{forbidden_claims}' +
        compliance,
    },
  ]
  for (const t of templates) {
    await upsert(db, {
      table: 'topic_prompt_template',
      row: {
        id: t.id,
        name: t.name,
        content: t.content,
        is_default: t.def,
        builtin: t.builtin,
        created_by: 'system',
        created_at: now,
        updated_at: now,
      },
      uniqueCols: ['id'],
      updateCols: ['name', 'content', 'updated_at'],
    })
  }

  // 3) 分类关键词规则（priority 高者优先，主分类唯一）
  const rules: Array<[string, string, number]> = [
    ['政策', '央行', 30], ['政策', '降准', 30], ['政策', '降息', 30], ['政策', '货币政策', 30],
    ['政策', '证监会', 28], ['政策', '监管', 28], ['政策', '财政部', 28], ['政策', '发改委', 28],
    ['政策', '国务院', 26], ['政策', '外汇局', 26], ['政策', '政策', 24], ['政策', 'IPO', 20],
    ['基金', '基金', 25], ['基金', 'ETF', 25], ['基金', '定投', 25], ['基金', '净值', 24],
    ['基金', '债基', 24], ['基金', '红利', 22], ['基金', '份额', 22], ['基金', '基金经理', 22],
    ['基金', '申购', 20], ['基金', '赎回', 20], ['基金', 'FOF', 20],
    ['行业', '新能源', 20], ['行业', '半导体', 20], ['行业', '医药', 20], ['行业', '汽车', 20],
    ['行业', '房地产', 20], ['行业', '银行', 18], ['行业', '保险', 18], ['行业', '券商', 18],
    ['行业', '算力', 18], ['行业', '光伏', 18], ['行业', '白酒', 16], ['行业', '产业链', 16],
    ['行业', '行业', 14],
    ['市场', '沪指', 12], ['市场', '创业板', 12], ['市场', 'A股', 12], ['市场', '港股', 12],
    ['市场', '美股', 12], ['市场', '两市', 10], ['市场', '北向', 10], ['市场', '成交额', 10],
    ['市场', '涨停', 10], ['市场', '收盘', 10], ['市场', '指数', 8], ['市场', '资金', 8],
    ['市场', '行情', 6], ['市场', '板块', 6],
  ]
  for (const [category, keyword, priority] of rules) {
    const ok = await insertIgnore(db, 'news_category_rule', {
      id: newId('rule'),
      category,
      keyword,
      priority,
      enabled: 1,
      created_at: now,
    })
    if (!ok) {
      // 已存在则仅更新优先级，避免重复种子
      await db.run('UPDATE `news_category_rule` SET priority = ?, enabled = 1 WHERE category = ? AND keyword = ?', [
        priority,
        category,
        keyword,
      ])
    }
  }
}

/** copy 扩展列补全（幂等，已有库安全） */
const migrateCopyWorkshop: Migration['up'] = async (db) => {
  await addMissingColumns(db)
  // 已有库的 persona 桩可能缺 §4.3 三个扩展字段（JSON 列需读改写）
  await seedPersonaExtensions(db)
}

/**
 * 迁移清单。
 * 说明：`001_init`（建表与索引）不再纳入版本判断，改为在 runMigrations 中**每次**幂等执行，
 * 这样新增表对「新装库」与「已装库」都立即生效，老库无需等待某个新版本号。
 * 下面只保留需要「执行一次」的数据迁移：种子、列补全、词库种子。
 */
export const migrations: Migration[] = [
  { version: '002_seed', name: '种子数据（persona 桩/提示词模板/分类规则）', up: seedBaseData },
  { version: '003_copy_columns', name: '文案工坊：已有表列补全（copy 扩展等）', up: migrateCopyWorkshop },
  {
    version: '004_copy_seed',
    name: '文案工坊：模板/风格/合规词库种子',
    up: seedCopyWorkshop,
  },
]

export async function runMigrations(db: Db = getDb()): Promise<string[]> {
  // 版本表先于其它表建立
  const versionTable = TABLES.find((t) => t.name === 'schema_migrations')!
  await db.exec(createTableSql(versionTable, db.kind))

  // 结构对齐始终执行（幂等）：迁移清单只承担「数据种子」，
  // 建表/补列/建索引不纳入版本判断，老库与新装库都能立即对齐。
  await syncSchema(db)

  const appliedRows = await db.all<{ version: string }>('SELECT `version` FROM `schema_migrations`')
  const applied = new Set(appliedRows.map((r) => r.version))
  const done: string[] = []

  for (const m of migrations) {
    if (applied.has(m.version)) continue
    logger.info({ version: m.version, name: m.name }, 'db.migration')
    await m.up(db)
    await db.run('INSERT INTO `schema_migrations` (`version`, `applied_at`) VALUES (?, ?)', [
      m.version,
      toDb(utcNow()),
    ])
    done.push(m.version)
  }
  if (!done.length) logger.info('db.migration: 已是最新（幂等）')
  return done
}
