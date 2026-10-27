/**
 * 桌面版入口（由 desktop/ 壳工程的 Electron utilityProcess 拉起）。
 *
 * 与裸跑（src/index.ts）的区别全部由宿主注入的环境变量表达：
 *   PORT=0（动态端口）、DATA_DIR / DB_SQLITE_PATH（userData）、QUEUE_BACKEND=memory、
 *   LOG_FILE（userData/logs）、AUTH_JWT_SECRET（首启生成持久化）、FFMPEG_PATH（随包 ffmpeg）、
 *   STATIC_DIR（随包前端产物）、NODE_ENV=production。
 *
 * ⚠️ 必须在任何 src 模块 import 之前注入 DESKTOP_MODE——config 在首次 import 时固化，
 * 因此这里只做环境标记 + 动态 import（与 scripts/lib/isolated-env.ts 同一约定）。
 */
process.env.DESKTOP_MODE = process.env.DESKTOP_MODE ?? '1'

const { bootServer } = await import('./boot.js')
const { logger } = await import('./log.js')

try {
  const { port } = await bootServer()
  // 实际端口回报 Electron 宿主；非 utilityProcess 环境（直接 node 跑）时打印到 stdout
  const parentPort = (process as { parentPort?: { postMessage: (m: unknown) => void } }).parentPort
  if (parentPort) parentPort.postMessage({ cmd: 'server-ready', port })
  else console.log(`[desktop-entry] server-ready port=${port}`)
} catch (e) {
  const parentPort = (process as { parentPort?: { postMessage: (m: unknown) => void } }).parentPort
  parentPort?.postMessage({ cmd: 'server-error', message: (e as Error).message })
  logger.error({ err: (e as Error).message, stack: (e as Error).stack }, 'desktop.boot_failed')
  process.exit(1)
}
