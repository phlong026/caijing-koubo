import { initDb, getDb, closeAll } from './index.js'
import { runMigrations } from './migrate.js'
import { logger } from '../log.js'

async function main() {
  const db = await initDb()
  const applied = await runMigrations(db)
  const tables = await db.all<{ name: string }>(
    db.kind === 'mysql'
      ? 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name'
      : "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    db.kind === 'mysql' ? [process.env.DB_NAME ?? 'viral_topics'] : [],
  )
  logger.info({ dialect: db.kind, applied, tableCount: tables.length }, 'migrate.done')
  console.log(`\n数据库方言：${db.kind}`)
  console.log(`本次执行迁移：${applied.length ? applied.join(', ') : '无（已最新）'}`)
  console.log(`数据表（${tables.length}）：${tables.map((t) => t.name).join(', ')}\n`)
  await closeAll()
}

main().catch((e) => {
  logger.error({ err: e }, 'migrate.failed')
  process.exit(1)
})
