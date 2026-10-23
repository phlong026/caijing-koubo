import { initDb, closeAll } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'

const db = await initDb()
const done = await runMigrations(db)
console.log('迁移完成:', done.join(', ') || '(无新版本)')
for (const t of ['platform_account', 'publish_login_session', 'publish_plan', 'publish_log', 'persona_account_binding']) {
  const r = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${t}\``)
  console.log('  表', t, '→', r?.n, '行')
}
const done2 = await runMigrations(db)
console.log('幂等重跑:', done2.length === 0 ? 'OK（无重复迁移）' : done2.join(','))
await closeAll()
