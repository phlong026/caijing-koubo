import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { config, paths } from '../config.js'
import { logger } from '../log.js'

export type Dialect = 'mysql' | 'sqlite'
export type Row = Record<string, any>

export interface RunResult {
  affectedRows: number
  insertId: number | null
}

export interface Db {
  kind: Dialect
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | null>
  run(sql: string, params?: unknown[]): Promise<RunResult>
  exec(sql: string): Promise<void>
  /** 事务：mysql 取独立连接，sqlite 直接 BEGIN/COMMIT */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>
  tableExists(name: string): Promise<boolean>
  indexExists(name: string): Promise<boolean>
  close(): Promise<void>
}

const q = (s: string) => `\`${s}\``

/** 连接失败的可诊断错误：保留底层原因，同时给出可执行的修复指引 */
export class DbConnectError extends Error {
  constructor(
    message: string,
    readonly detail: string,
    readonly hint: string,
  ) {
    super(message)
    this.name = 'DbConnectError'
  }
}

/**
 * 把 mysql2 的底层连接错误翻译成可执行指引。
 * 真机接入时最常踩的三类坑：库不存在、凭证错误、服务/端口不通。
 */
function diagnoseMysqlError(e: unknown): DbConnectError {
  const err = e as { code?: string; errno?: number; message?: string; sqlMessage?: string }
  const raw = err?.sqlMessage || err?.message || String(e)
  const { host, port, user, database } = config.db
  const target = `${user}@${host}:${port}/${database}`

  switch (err?.errno) {
    case 1049: // ER_BAD_DB_ERROR
      return new DbConnectError(
        `MySQL 已连通，但数据库 ${database} 不存在`,
        raw,
        `先建库再迁移：CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;` +
          ` 或改 DB_NAME 指向已有库。`,
      )
    case 1045: // ER_ACCESS_DENIED_ERROR
      return new DbConnectError(
        `MySQL 账号或密码不正确（${user}）`,
        raw,
        `检查 .env 的 DB_USER / DB_PASSWORD；区分 Suite 安装与常规 MySQL 实例的认证方式。`,
      )
    case 1044: // ER_DBACCESS_DENIED_ERROR
      return new DbConnectError(
        `账号 ${user} 没有访问库 ${database} 的权限`,
        raw,
        `GRANT ALL PRIVILEGES ON ${database}.* TO '${user}'@'%'; FLUSH PRIVILEGES;`,
      )
    case 1040: // ER_CON_COUNT_ERROR
      return new DbConnectError(
        `MySQL 连接数已满`,
        raw,
        `调大 max_connections，或降低 DB_POOL_SIZE（当前 ${config.db.poolSize}）。`,
      )
    default:
      break
  }

  if (err?.code === 'ER_NOT_SUPPORTED_AUTH_MODE') {
    return new DbConnectError(
      `MySQL 8 默认 caching_sha2_password 认证未被客户端接受`,
      raw,
      `升级 mysql2 到最新版，或 ALTER USER '${user}'@'%' IDENTIFIED WITH mysql_native_password BY '...';`,
    )
  }
  if (err?.code === 'ECONNREFUSED' || err?.errno === 2003) {
    return new DbConnectError(
      `连不上 MySQL（${host}:${port} 拒绝连接）`,
      raw,
      `确认 MySQL 已启动且端口映射正确：docker port <container> 应能看到 ${port}；DB_DRIVER=auto 会自动退回本地 sqlite。`,
    )
  }
  if (err?.code === 'ENOTFOUND' || err?.errno === 2005) {
    return new DbConnectError(
      `MySQL 主机名无法解析（${host}）`,
      raw,
      `检查 DB_HOST；容器场景应为宿主机可达地址，不要填容器内名字。`,
    )
  }
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET') {
    return new DbConnectError(
      `MySQL 连接超时（${target}）`,
      raw,
      `检查防火墙/安全组是否放行 ${port}，或容器端口是否已映射到宿主机。`,
    )
  }
  return new DbConnectError(`MySQL 连接失败（${target}）`, raw, `请检查 .env 中 DB_* 配置与实例状态。`)
}

/* ── MySQL ─────────────────────────────────────────────────────────── */
async function createMysql(): Promise<Db> {
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: config.db.poolSize,
    timezone: 'Z', // 统一 UTC（P2-4）
    dateStrings: true,
    decimalNumbers: true,
    charset: 'utf8mb4',
  })

  const wrap = (execSql: (sql: string, params?: unknown[]) => Promise<any>): Db => ({
    kind: 'mysql',
    async all<T>(sql: string, params?: unknown[]) {
      const [rows] = await execSql(sql, params as any[])
      return rows as T[]
    },
    async get<T>(sql: string, params?: unknown[]) {
      const [rows] = await execSql(sql, params as any[])
      return ((rows as T[]) ?? [])[0] ?? null
    },
    async run(sql: string, params?: unknown[]) {
      const [res] = await execSql(sql, params as any[])
      return {
        affectedRows: (res as any)?.affectedRows ?? 0,
        insertId: (res as any)?.insertId ?? null,
      }
    },
    async exec(sql) {
      await execSql(sql)
    },
    async tx(fn) {
      const conn = await pool.getConnection()
      const runSql = async (sql: string, params?: unknown[]) => conn.query(sql, params as any[])
      const inner: Db = wrap(runSql)
      // MySQL 无嵌套事务语义：内层 BEGIN 会隐式提交外层事务。
      // 与其静默破坏原子性，不如显式报错让调用方把操作并入外层事务。
      inner.tx = async <T>(): Promise<T> => {
        throw new Error(
          'MySQL 不支持嵌套事务（内层 BEGIN 会隐式提交外层事务）。请在最外层事务内直接执行 SQL，不要嵌套调用 db.tx()。',
        )
      }
      try {
        await conn.beginTransaction()
        const r = await fn(inner)
        await conn.commit()
        return r
      } catch (e) {
        try {
          await conn.rollback()
        } catch {}
        throw e
      } finally {
        conn.release()
      }
    },
    async tableExists(name) {
      const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ? LIMIT 1',
        [config.db.database, name],
      )
      return (rows as any[]).length > 0
    },
    async indexExists(name) {
      const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.statistics WHERE table_schema = ? AND index_name = ? LIMIT 1',
        [config.db.database, name],
      )
      return (rows as any[]).length > 0
    },
    async close() {
      await pool.end()
    },
  })

  // 连通性探测（失败时转换为可诊断错误，并回收池避免残留连接）
  try {
    const conn = await pool.getConnection()
    await conn.ping()
    conn.release()
  } catch (e) {
    await pool.end().catch(() => {})
    throw diagnoseMysqlError(e)
  }
  return wrap((sql, params) => pool.query(sql, params as any[]))
}

/* ── SQLite（仅本地开发验证用，内置 node:sqlite 免安装） ─────────────── */
async function createSqlite(file: string): Promise<Db> {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (p: string) => any
  }
  const database = new DatabaseSync(file)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA foreign_keys = ON')

  const raw = (sql: string, params?: unknown[]) => {
    const stmt = database.prepare(sql)
    const isSelect = /^\s*(select|with|pragma)/i.test(sql)
    if (isSelect) return stmt.all(...(params ?? []))
    return stmt.run(...(params ?? []))
  }

  const db: Db = {
    kind: 'sqlite',
    async all<T>(sql: string, params?: unknown[]) {
      return raw(sql, params) as T[]
    },
    async get<T>(sql: string, params?: unknown[]) {
      const rows = raw(sql, params) as T[]
      return rows?.[0] ?? null
    },
    async run(sql: string, params?: unknown[]) {
      const res = raw(sql, params) as { changes: number | bigint; lastInsertRowid: number | bigint }
      return { affectedRows: Number(res.changes ?? 0), insertId: Number(res.lastInsertRowid ?? 0) }
    },
    async exec(sql) {
      database.exec(sql)
    },
    async tx(fn) {
      const inTx = (database as any).__inTx === true
      if (inTx) return fn(db) // sqlite 单连接，嵌套事务直接透传
      database.exec('BEGIN IMMEDIATE')
      ;(database as any).__inTx = true
      try {
        const r = await fn(db)
        database.exec('COMMIT')
        return r
      } catch (e) {
        try {
          database.exec('ROLLBACK')
        } catch {}
        throw e
      } finally {
        ;(database as any).__inTx = false
      }
    },
    async tableExists(name) {
      const rows = raw("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [name]) as Row[]
      return rows.length > 0
    },
    async indexExists(name) {
      const rows = raw("SELECT name FROM sqlite_master WHERE type='index' AND name = ?", [name]) as Row[]
      return rows.length > 0
    },
    async close() {
      database.close()
    },
  }
  return db
}

/* ── 单例 ──────────────────────────────────────────────────────────── */
let dbInstance: Db | null = null

export async function initDb(): Promise<Db> {
  if (dbInstance) return dbInstance
  const driver = config.db.driver
  if (driver === 'sqlite') {
    dbInstance = await createSqlite(config.db.sqlitePath)
    logger.info({ kind: 'sqlite', file: config.db.sqlitePath }, 'db.ready')
    return dbInstance
  }
  if (driver === 'mysql' || driver === 'auto') {
    try {
      dbInstance = await createMysql()
      logger.info({ kind: 'mysql', db: config.db.database }, 'db.ready')
      return dbInstance
    } catch (e) {
      const diag = e instanceof DbConnectError ? e : diagnoseMysqlError(e)
      if (driver === 'mysql') {
        logger.error({ err: diag.message, detail: diag.detail, hint: diag.hint }, 'db.mysql_connect_failed')
        throw diag
      }
      logger.warn({ err: diag.detail, hint: diag.hint }, 'db.mysql_unavailable_fallback_sqlite')
      dbInstance = await createSqlite(path.join(paths.dataDir, 'dev.db'))
      return dbInstance
    }
  }
  throw new Error(`不支持的 DB_DRIVER: ${driver}`)
}

export function getDb(): Db {
  if (!dbInstance) throw new Error('数据库未初始化，请先调用 initDb()')
  return dbInstance
}

export async function closeAll(): Promise<void> {
  if (!dbInstance) return
  await dbInstance.close()
  dbInstance = null
}

/* ── 方言无关的便捷操作 ────────────────────────────────────────────── */

/**
 * 判断是否唯一键冲突（方言无关）。
 *
 * 用于「先查后插」型幂等的兜底：并发下两个请求可能同时通过查重，
 * 由数据库唯一索引拦下后写者，此时调用方应回查先写者并返回其结果。
 *
 * - SQLite: `UNIQUE constraint failed: table.col`
 * - MySQL:  errno 1062 / code `ER_DUP_ENTRY` / SQLSTATE 23000
 */
export function isDuplicateKey(e: unknown): boolean {
  const err = e as { code?: string; errno?: number; message?: string }
  if (!err) return false
  if (err.errno === 1062 || err.code === 'ER_DUP_ENTRY' || err.code === 'SQLITE_CONSTRAINT_UNIQUE') return true
  const msg = err.message ?? ''
  return /UNIQUE constraint failed|Duplicate entry/i.test(msg)
}

export interface UpsertArgs {
  table: string
  row: Record<string, unknown>
  uniqueCols: string[]
  updateCols: string[]
}

/** 冲突即更新（依赖目标表上的唯一键） */
export async function upsert(db: Db, args: UpsertArgs): Promise<void> {
  const keys = Object.keys(args.row)
  const cols = keys.map(q).join(', ')
  const ph = keys.map(() => '?').join(', ')
  const params = keys.map((k) => args.row[k])
  const updates = args.updateCols.filter((c) => !args.uniqueCols.includes(c))
  if (db.kind === 'mysql') {
    const setSql = updates.length
      ? ` ON DUPLICATE KEY UPDATE ${updates.map((c) => `${q(c)} = VALUES(${q(c)})`).join(', ')}`
      : ' ON DUPLICATE KEY UPDATE id = id'
    await db.run(`INSERT INTO ${q(args.table)} (${cols}) VALUES (${ph})${setSql}`, params)
    return
  }
  const conflict = args.uniqueCols.map(q).join(', ')
  const setSql = updates.length
    ? ` DO UPDATE SET ${updates.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}`
    : ` DO NOTHING`
  await db.run(
    `INSERT INTO ${q(args.table)} (${cols}) VALUES (${ph}) ON CONFLICT(${conflict})${setSql}`,
    params,
  )
}

/** 已存在则忽略（唯一键冲突返回 inserted=false） */
export async function insertIgnore(db: Db, table: string, row: Record<string, unknown>): Promise<boolean> {
  const keys = Object.keys(row)
  const cols = keys.map(q).join(', ')
  const ph = keys.map(() => '?').join(', ')
  const params = keys.map((k) => row[k])
  const sql =
    db.kind === 'mysql'
      ? `INSERT IGNORE INTO ${q(table)} (${cols}) VALUES (${ph})`
      : `INSERT OR IGNORE INTO ${q(table)} (${cols}) VALUES (${ph})`
  const res = await db.run(sql, params)
  return res.affectedRows > 0
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}
