import { initDb } from '../src/db/index.js'
import { providers } from '../src/modules/news/providers.js'

process.on('uncaughtException', (e) => {
  console.error('!!! uncaughtException:', e)
  process.exit(9)
})
process.on('unhandledRejection', (e) => {
  console.error('!!! unhandledRejection:', e)
  process.exit(8)
})

async function main() {
  await initDb()
  const p = providers.find((x) => x.name === 'finstep_alpha_morning')!
  console.log('start', p.name, 'enabled=', p.enabled)
  const items = await p.fetchLatest()
  console.log('got', items.length)
}
main().then(() => process.exit(0)).catch((e) => {
  console.error('caught:', e)
  process.exit(7)
})
