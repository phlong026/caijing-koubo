import { bootIsolated } from './lib/isolated-env.js'

/**
 * 浏览器端到端用的隔离后端（frontend/e2e/*.mjs）。
 *
 * 与 `test-integration --serve` 的区别：按 src/index.ts 的启动序列补齐发布模块（登录 / 执行 / sweep）
 * 与审核桩续推，并把各轮询 / sweep 周期压到秒级——浏览器里不能像 smoke 那样手动调 runVideoSweep。
 * 数据库为临时 SQLite（或 --real 的临时 MySQL），第三方全部 mock，不访问外网、不消耗积分。
 *
 * 用法：node --import tsx scripts/serve-e2e.ts [--real] [--oss]     # 端口取 E2E_API_PORT，默认 9897
 */
const real = process.argv.includes('--real')
const oss = process.argv.includes('--oss')
const port = Number(process.env.E2E_API_PORT || 9897)

const env = await bootIsolated({
  real,
  oss,
  port,
  env: {
    LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
    HIFLY_POLL_INITIAL_MS: '1500',
    HIFLY_POLL_MAX_MS: '3000',
    VIDEO_POLL_INTERVAL_MS: '2000',
    CUT_SWEEP_INTERVAL_MS: '2000',
    PUBLISH_LOGIN_POLL_INTERVAL_MS: '1000',
  },
})

const { registerPublishModule } = await import('../src/modules/publish/index.js')
await registerPublishModule()
const { resumeStubSubmissions } = await import('../src/modules/copy/review.js')
await resumeStubSubmissions()

console.log(`E2E API ready: ${env.base}`)

let closing = false
async function stop(): Promise<void> {
  if (closing) return
  closing = true
  await env.shutdown().catch((e) => console.error('shutdown failed', e))
  process.exit(0)
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
