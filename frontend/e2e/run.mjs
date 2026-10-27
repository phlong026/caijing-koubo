/**
 * 浏览器端到端一键运行：拉起隔离后端（server/scripts/serve-e2e.ts，临时库 + 第三方 mock）与 Vite 开发服务，
 * 依次跑各套 Playwright 脚本，结束后关停并清理。CI 与本地同一入口。
 *
 * 用法（在 frontend 目录）：
 *   npm run e2e                         # 全部：人物库（people）+ 主链路（main）
 *   npm run e2e -- --suites=main        # 只跑主链路
 *   npm run e2e -- --real --oss         # 后端改用真实 MySQL + Redis（DB_* / REDIS_*）与 OSS 仿真
 * 环境变量：E2E_API_PORT（默认 9897）、E2E_WEB_PORT（默认 5173）、E2E_ARTIFACTS（截图目录，CI 上传用）。
 * 人物库套件断言初始只有 3 个示例人物，所以排在最前，且每次运行都用全新的隔离后端。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const frontendRoot = fileURLToPath(new URL('..', import.meta.url))
const serverRoot = path.join(frontendRoot, '..', 'server')
const SUITES = { people: 'e2e/people-library.mjs', main: 'e2e/main-chain.mjs' }

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const suites = (arg('suites') ?? 'people,main').split(',').map((s) => s.trim())
for (const s of suites) if (!SUITES[s]) throw new Error(`未知套件 ${s}（可选：${Object.keys(SUITES).join(', ')}）`)
const backendFlags = ['--real', '--oss'].filter((f) => process.argv.includes(f))

const apiPort = Number(process.env.E2E_API_PORT || 9897)
const webPort = Number(process.env.E2E_WEB_PORT || 5173)
const base = `http://127.0.0.1:${webPort}`

const children = []
function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  const tag = (chunk) => chunk.toString().replace(/^(?=.)/gm, `[${name}] `)
  child.stdout.on('data', (c) => process.env.E2E_VERBOSE && process.stdout.write(tag(c)))
  // 后端告警 / 报错始终透出，便于定位失败
  child.stderr.on('data', (c) => process.stderr.write(tag(c)))
  child.once('exit', (code, signal) => {
    if (!stopping) console.error(`[${name}] 意外退出（code=${code} signal=${signal}）`)
  })
  children.push(child)
  return child
}

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`等待 ${url} 超时`)
}

let stopping = false
async function stopAll() {
  stopping = true
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM')
  // 后端收到 SIGTERM 会清理临时库；给它几秒，再强杀
  await Promise.race([
    Promise.all(children.map((c) => (c.exitCode === null ? new Promise((r) => c.once('exit', r)) : null))),
    new Promise((r) => setTimeout(r, 8000)),
  ])
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
}
process.once('SIGINT', () => void stopAll().then(() => process.exit(130)))

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: frontendRoot,
      stdio: 'inherit',
      env: { ...process.env, E2E_BASE: base },
    })
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

let exitCode = 0
try {
  console.log(`启动隔离后端 :${apiPort}${backendFlags.length ? `（${backendFlags.join(' ')}）` : ''}`)
  start('api', process.execPath, ['--import', 'tsx', 'scripts/serve-e2e.ts', ...backendFlags], {
    cwd: serverRoot,
    env: { ...process.env, E2E_API_PORT: String(apiPort) },
  })
  await waitHttp(`http://127.0.0.1:${apiPort}/health`, 120_000)

  console.log(`启动前端开发服务 :${webPort}`)
  start(
    'web',
    process.execPath,
    [
      path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--port',
      String(webPort),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: frontendRoot,
      env: { ...process.env, VITE_PROXY_TARGET: `http://127.0.0.1:${apiPort}`, VITE_ENABLE_REVIEW_WORKBENCH: '1' },
    },
  )
  await waitHttp(`${base}/`, 60_000)
  await waitHttp(`${base}/api/health`, 10_000)

  const results = []
  for (const s of suites) {
    console.log(`\n━━━━━━━━ 套件：${s}（${SUITES[s]}）━━━━━━━━`)
    const code = await runSuite(SUITES[s])
    results.push([s, code])
    if (code !== 0) exitCode = 1
  }
  console.log(`\n━━━━━━━━ 汇总 ━━━━━━━━\n${results.map(([s, c]) => `  ${c === 0 ? '✅' : '❌'} ${s}`).join('\n')}`)
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await stopAll()
}
process.exit(exitCode)
