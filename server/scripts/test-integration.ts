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
Object.assign(process.env, {
  NODE_ENV: 'test', DB_DRIVER: 'sqlite', DB_SQLITE_PATH: join(temp, 'test.db'),
  TEMP_DIR: join(temp, 'media'), MOCK_FALLBACK: 'true', NEWS_MOCK_SOURCE: 'true',
  REVIEW_STUB_ENABLED: 'true', REVIEW_STUB_STEP_MS: '300', LOG_LEVEL: 'silent',
  DASHSCOPE_API_KEY: '', COPY_LLM_API_KEY: '', TIKHUB_API_KEY: '',
  FINSTEP_API_KEY: '', SATURN_NEWS_MCP_KEY: '',
  OSS_ACCESS_KEY_ID: '', OSS_ACCESS_KEY_SECRET: '', OSS_BUCKET: '',
})

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
const { createTopic } = await import('../src/modules/topics/repo.js')
const { buildApp } = await import('../src/app.js')

redis.disconnect()
setQueueBackend('memory')
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
  await fetchAndStore()
  await createTopic({ source: 'manual', title: '尚未分配人物的集成测试选题' })
  const address = await app.listen({ host: '127.0.0.1', port: serve ? 9897 : 0 })
  const base = `${address}/api`
  console.log(`Isolated integration API: ${base}`)
  const health = await fetch(`${base}/health`).then((r) => r.json()) as any
  assert.equal(health.data.db.up, true)
  assert.equal(health.data.queue.backend, 'memory')
  assert.equal(health.data.status, 'degraded')

  if (serve) {
    await new Promise<void>((accept) => {
      process.once('SIGINT', accept)
      process.once('SIGTERM', accept)
    })
  } else {
    await runSmoke('smoke.ts', base)
    await runSmoke('smoke-topics.ts', base)
    await runSmoke('smoke-copy.ts', base)
    console.log('All three isolated HTTP smoke suites passed')
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
  redis.disconnect()
  await closeAll()
  if (dirname(temp) !== tempRoot || !basename(temp).startsWith('koubo-integration-')) {
    throw new Error('Unexpected integration cleanup path')
  }
  rmSync(temp, { recursive: true, force: true })
}
