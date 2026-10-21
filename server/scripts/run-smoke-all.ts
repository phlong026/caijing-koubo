/**
 * 一键冒烟（P1-9）：起一个隔离的服务实例（临时 SQLite + 独立队列前缀 + 第三方 mock），
 * 依次跑 smoke / smoke:copy / smoke:topics / smoke:personas，结束后关闭服务并清理临时库。
 *
 * 用法：npm run smoke:all
 * 环境变量：
 *  - SMOKE_PORT       服务端口，默认 8797（避免与本地 dev 的 8787 冲突）
 *  - SMOKE_SUITES     逗号分隔，默认全部四套
 * Redis 可用时走 BullMQ（REDIS_HOST / REDIS_PORT），不可用时服务自动降级为内存队列。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = resolve(fileURLToPath(import.meta.url), '../..')
const port = Number(process.env.SMOKE_PORT ?? 8797)
const base = `http://127.0.0.1:${port}/api`
const suites = (process.env.SMOKE_SUITES ?? 'smoke,smoke-copy,smoke-topics,smoke-personas')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const temp = mkdtempSync(join(tmpdir(), 'koubo-smoke-'))
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(port),
  DB_DRIVER: 'sqlite',
  DB_SQLITE_PATH: join(temp, 'smoke.db'),
  TEMP_DIR: join(temp, 'tmp'),
  // 独立队列前缀：避免与同一 Redis 上的其它实例互抢任务（任务会落到别的库里）
  QUEUE_PREFIX: `smoke-${process.pid}`,
  MOCK_FALLBACK: 'true',
  NEWS_MOCK_SOURCE: 'true',
  SEED_DEMO: 'true',
  REVIEW_STUB_ENABLED: 'true',
  REVIEW_STUB_STEP_MS: '50',
  HIFLY_API_KEY: '',
  HIFLY_MOCK_POLLS_TO_DONE: '2',
  HIFLY_POLL_INITIAL_MS: '3000',
  HIFLY_POLL_SWEEP_MS: '2000',
  AUTH_BOOTSTRAP_ADMIN_USER: 'admin',
  AUTH_BOOTSTRAP_ADMIN_PASSWORD: 'admin123',
  // 冒烟脚本用同一账号在一分钟内连续生成多次，放大限流额度（限流本身由单测覆盖）
  RATE_LIMIT_SCALE: '20',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitHealthy(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务启动失败（exit ${child.exitCode}）`)
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return
    } catch {
      /* 尚未监听 */
    }
    await sleep(1000)
  }
  throw new Error('等待服务就绪超时（90 秒）')
}

function runSuite(name: string): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(serverRoot, 'scripts', `${name}.ts`)], {
      cwd: serverRoot,
      env: { ...env, SMOKE_BASE: base, BASE: base },
      stdio: 'inherit',
    })
    child.on('exit', (code) => resolveExit(code ?? 1))
  })
}

const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: serverRoot,
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
})

const results: Array<{ suite: string; code: number }> = []
try {
  await waitHealthy(server)
  for (const suite of suites) {
    console.log(`\n────────── ${suite} ──────────`)
    results.push({ suite, code: await runSuite(suite) })
  }
} catch (e) {
  console.error(`冒烟中止：${(e as Error).message}`)
  results.push({ suite: 'server', code: 1 })
} finally {
  server.kill('SIGTERM')
  await sleep(1500)
  if (server.exitCode === null) server.kill('SIGKILL')
  rmSync(temp, { recursive: true, force: true })
}

console.log('\n══════════ 冒烟汇总 ══════════')
for (const r of results) console.log(`${r.code === 0 ? '✅' : '❌'} ${r.suite}`)
process.exit(results.every((r) => r.code === 0) ? 0 : 1)
