import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Run the merged HTTP flows against disposable data and local model mocks only.
const tempRoot = resolve(tmpdir())
const temp = mkdtempSync(join(tempRoot, 'koubo-integration-'))
// --real（或 INTEGRATION_BACKEND=real）：用真实 MySQL（临时库，结束即删）+ 真实 Redis/BullMQ（独立前缀，结束即清）。
// 连接参数沿用 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD 与 REDIS_HOST/REDIS_PORT；默认 local = 临时 SQLite + 内存队列。
const realBackend = process.env.INTEGRATION_BACKEND === 'real' || process.argv.includes('--real')
const runTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const dbBase = process.env.DB_NAME || 'viral_topics'
const realDbName = `${dbBase}_it_${runTag}`
const realPrefix = `it_${runTag}`
Object.assign(process.env, realBackend
  ? { DB_DRIVER: 'mysql', DB_NAME: realDbName, QUEUE_PREFIX: realPrefix }
  : { DB_DRIVER: 'sqlite', DB_SQLITE_PATH: join(temp, 'test.db') })
Object.assign(process.env, {
  NODE_ENV: 'test',
  TEMP_DIR: join(temp, 'media'), MOCK_FALLBACK: 'true', NEWS_MOCK_SOURCE: 'true',
  REVIEW_STUB_ENABLED: 'true', REVIEW_STUB_STEP_MS: '300', LOG_LEVEL: 'silent',
  DASHSCOPE_API_KEY: '', COPY_LLM_API_KEY: '', TIKHUB_API_KEY: '',
  FINSTEP_API_KEY: '', SATURN_NEWS_MCP_KEY: '',
  OSS_ACCESS_KEY_ID: '', OSS_ACCESS_KEY_SECRET: '', OSS_BUCKET: '',
  HIFLY_API_KEY: '',
})

if (realBackend) {
  const mysql = (await import('mysql2/promise')).default
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
  })
  await conn.query(`CREATE DATABASE \`${realDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await conn.end()
  console.log(`Real backend: MySQL database ${realDbName}, Redis prefix ${realPrefix}`)
}

// --oss：启动本地 OSS 协议仿真并让服务端按「已配置 OSS」运行，人物库素材走 put / getStream / 签名 URL 全链路
const withOss = process.argv.includes('--oss')
let ossEmu: Awaited<ReturnType<typeof import('./lib/oss-emulator.js').startOssEmulator>> | null = null
if (withOss) {
  const { startOssEmulator } = await import('./lib/oss-emulator.js')
  ossEmu = await startOssEmulator()
  Object.assign(process.env, {
    OSS_BUCKET: ossEmu.bucket, OSS_ACCESS_KEY_ID: ossEmu.accessKeyId, OSS_ACCESS_KEY_SECRET: ossEmu.accessKeySecret,
    OSS_ENDPOINT: ossEmu.endpoint, OSS_CNAME: 'true',
  })
  console.log(`OSS emulator: ${ossEmu.endpoint} (bucket ${ossEmu.bucket})`)
}

const { initDb, closeAll } = await import('../src/db/index.js')
const { runMigrations } = await import('../src/db/migrate.js')
const { redis, setQueueBackend, closeQueues, queueStats } = await import('../src/queue/index.js')
const { providers } = await import('../src/modules/news/providers.js')
const { fetchAndStore } = await import('../src/modules/news/service.js')
const { registerNewsJobs } = await import('../src/modules/news/jobs.js')
const { registerTopicJobs } = await import('../src/modules/topics/jobs.js')
const { registerBenchmarkJobs } = await import('../src/modules/benchmark/sweep.js')
const { registerExtractWorker } = await import('../src/modules/benchmark/extract.js')
const { registerCopyWorker } = await import('../src/modules/copy/worker.js')
const { registerPersonaModule } = await import('../src/modules/personas/index.js')
const { createTopic } = await import('../src/modules/topics/repo.js')
const { buildApp } = await import('../src/app.js')

if (!realBackend) {
  redis.disconnect()
  setQueueBackend('memory')
} else {
  setQueueBackend('redis')
}
providers.splice(0, providers.length, ...providers.filter((p) => p.name === 'mock'))
const app = await buildApp()
const serve = process.argv.includes('--serve')
const serverRoot = fileURLToPath(new URL('..', import.meta.url))

async function runSmoke(script: string, base: string): Promise<void> {
  console.log(`\nRunning ${script}`)
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', `scripts/${script}`], {
      cwd: serverRoot, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, BASE: base, SMOKE_BASE: base, SMOKE_GEN_TIMEOUT: '30000' },
    })
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${script} timed out`)) }, 180_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) accept()
      else reject(new Error(`${script} exited with ${code}`))
    })
  })
}

try {
  const db = await initDb()
  await runMigrations(db)
  await registerNewsJobs()
  await registerTopicJobs()
  await registerBenchmarkJobs()
  await registerExtractWorker()
  registerCopyWorker()
  await registerPersonaModule()
  await fetchAndStore()
  await createTopic({ source: 'manual', title: '尚未分配人物的集成测试选题' })
  const address = await app.listen({ host: '127.0.0.1', port: serve ? 9897 : 0 })
  const base = `${address}/api`
  console.log(`Isolated integration API: ${base}`)
  const health = await fetch(`${base}/health`).then((r) => r.json()) as any
  assert.equal(health.data.db.up, true)
  assert.equal(health.data.db.dialect, realBackend ? 'mysql' : 'sqlite')
  assert.equal(health.data.queue.backend, realBackend ? 'redis' : 'memory')
  if (!realBackend) assert.equal(health.data.status, 'degraded')
  for (const q of ['persona-asset-process', 'persona-clone', 'persona-auth-expiry']) {
    assert.ok(health.data.queue.stats[q], `health lists queue ${q}`)
  }

  if (serve) {
    await new Promise<void>((accept) => {
      process.once('SIGINT', accept)
      process.once('SIGTERM', accept)
    })
  } else {
    await runSmoke('smoke.ts', base)
    await runSmoke('smoke-topics.ts', base)
    await runSmoke('smoke-copy.ts', base)
    await runSmoke('smoke-personas.ts', base)
    if (ossEmu) {
      const stored = ossEmu.objects.size
      assert.ok(stored > 0, 'persona assets were stored in the OSS emulator')
      assert.ok(ossEmu.requests.some((r) => r.method === 'GET' && r.status === 200), 'assets were read back through OSS')
      assert.equal(ossEmu.requests.filter((r) => r.status === 403).length, 0, 'no OSS request was rejected')
      console.log(`OSS emulator: ${stored} objects, ${ossEmu.requests.length} requests, 0 rejected`)
    }
    console.log(`All four isolated HTTP smoke suites passed (${realBackend ? 'MySQL + Redis/BullMQ' : 'SQLite + memory queue'}${ossEmu ? ' + OSS' : ''})`)
  }
} finally {
  await app.close()
  // HTTP responses can precede asynchronous worker completion.
  for (let n = 0; n < 100; n++) {
    const stats = await queueStats()
    if (Object.values(stats).every((s) => !s.active && !s.waiting)) break
    await delay(50)
  }
  await closeQueues()
  if (realBackend) {
    // 清掉本次独立前缀下的全部 BullMQ / 心跳键，再删临时库
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${realPrefix}:*`, 'COUNT', 500)
      cursor = next
      if (keys.length) await redis.del(...keys)
    } while (cursor !== '0')
  }
  redis.disconnect()
  await closeAll()
  await ossEmu?.close()
  if (realBackend) {
    const mysql = (await import('mysql2/promise')).default
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
    })
    await conn.query(`DROP DATABASE IF EXISTS \`${realDbName}\``)
    await conn.end()
  }
  if (dirname(temp) !== tempRoot || !basename(temp).startsWith('koubo-integration-')) {
    throw new Error('Unexpected integration cleanup path')
  }
  rmSync(temp, { recursive: true, force: true })
}
