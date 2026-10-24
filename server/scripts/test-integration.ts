import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bootIsolated } from './lib/isolated-env.js'

// Run the merged HTTP flows against disposable data and local model mocks only.
//   默认            临时 SQLite + 内存队列
//   --real          真实 MySQL（临时库）+ 真实 Redis/BullMQ（独立前缀），参数取 DB_* / REDIS_*
//   --oss           本地 OSS 协议仿真，人物库素材走 put / getStream / 签名 URL 全链路
//   --serve         只启动隔离服务（端口 9897）供手工联调
const real = process.env.INTEGRATION_BACKEND === 'real' || process.argv.includes('--real')
const withOss = process.argv.includes('--oss')
const serve = process.argv.includes('--serve')
const serverRoot = fileURLToPath(new URL('..', import.meta.url))

const env = await bootIsolated({ real, oss: withOss, port: serve ? 9897 : 0 })

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
  console.log(`Isolated integration API: ${env.base}`)
  const health = await fetch(`${env.base}/health`).then((r) => r.json()) as any
  assert.equal(health.data.db.up, true)
  assert.equal(health.data.db.dialect, real ? 'mysql' : 'sqlite')
  assert.equal(health.data.queue.backend, real ? 'redis' : 'memory')
  if (!real) assert.equal(health.data.status, 'degraded')
  for (const q of ['persona-asset-process', 'persona-clone', 'persona-auth-expiry']) {
    assert.ok(health.data.queue.stats[q], `health lists queue ${q}`)
  }

  if (serve) {
    await new Promise<void>((accept) => {
      process.once('SIGINT', accept)
      process.once('SIGTERM', accept)
    })
  } else {
    await runSmoke('smoke.ts', env.base)
    await runSmoke('smoke-topics.ts', env.base)
    await runSmoke('smoke-copy.ts', env.base)
    await runSmoke('smoke-personas.ts', env.base)
    if (env.emu) {
      const stored = env.emu.objects.size
      assert.ok(stored > 0, 'persona assets were stored in the OSS emulator')
      assert.ok(env.emu.requests.some((r) => r.method === 'GET' && r.status === 200), 'assets were read back through OSS')
      assert.equal(env.emu.requests.filter((r) => r.status === 403).length, 0, 'no OSS request was rejected')
      console.log(`OSS emulator: ${stored} objects, ${env.emu.requests.length} requests, 0 rejected`)
    }
    console.log(`All four isolated HTTP smoke suites passed (${real ? 'MySQL + Redis/BullMQ' : 'SQLite + memory queue'}${env.emu ? ' + OSS' : ''})`)
  }
} finally {
  await env.shutdown()
}
