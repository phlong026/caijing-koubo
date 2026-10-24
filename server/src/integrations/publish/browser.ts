/**
 * Playwright 懒加载 + 持久化浏览器上下文池（PU2/PB5）。
 *
 * 平移 AI-Studio getBrowserContext：launchPersistentContext（userDataDir 按 账号 持久化，
 * Cookie/登录态跨进程存活）+ stealth 注入。服务端差异：
 *  - playwright 动态 import——未安装时真实引擎不可用（报 PUBLISH_BROWSER_MISSING），mock 链路零依赖；
 *  - headless 由 config.publish.headless 控制（真实灰度首验不过回退 false 须配 Xvfb）；
 *  - 并发上限 config.publish.maxContexts + 获取排队（PUBLISH_ACQUIRE_TIMEOUT_MS，超时抛
 *    PUBLISH_CONTEXT_BUSY 由 execute worker 落 failed → sweep 下轮重试）；
 *  - 空闲回收 closeIdleIdle 由 publish-sweep 的主扫描节流调用（PB5）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { config, paths } from '../../config.js'
import { logger } from '../../log.js'
import { err } from '../../errors.js'
import { STEALTH_UA } from './selectors.js'

export type PlaywrightModule = typeof import('playwright')
export type BrowserContext = import('playwright').BrowserContext
export type Page = import('playwright').Page

let pwModule: PlaywrightModule | null = null

/** playwright 是否可用（已安装驱动包） */
export function playwrightInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('playwright')
    return true
  } catch {
    return false
  }
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  if (pwModule) return pwModule
  try {
    pwModule = (await import('playwright')) as PlaywrightModule
    return pwModule
  } catch (e) {
    throw err.badRequest('未安装 playwright（npm i playwright && npx playwright install chromium），真实发布引擎不可用', {
      code: 'PUBLISH_BROWSER_MISSING',
      cause: (e as Error).message,
    })
  }
}

/** 持久化上下文根目录（默认 .data/browser-data，含登录态——须排除在备份/同步之外） */
function userDataDirFor(platform: string, accountId: string): string {
  const dir = path.resolve(paths.browserData, 'publish', `${platform}_${accountId}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

interface PoolEntry {
  context: BrowserContext
  lastUsedAt: number
}

const pool = new Map<string, PoolEntry>()
/** 排队中的获取数量（maxContexts 上限闸） */
let pendingAcquires = 0

function contextKey(platform: string, accountId: string): string {
  return `${platform}_${accountId}`
}

/** 复用存活上下文（AI-Studio：pages() 可枚举 = 存活） */
function takeAlive(key: string): BrowserContext | null {
  const entry = pool.get(key)
  if (!entry) return null
  try {
    void entry.context.pages()
    entry.lastUsedAt = Date.now()
    return entry.context
  } catch {
    pool.delete(key)
    return null
  }
}

export async function acquireContext(
  platform: string,
  accountId: string,
): Promise<{ context: BrowserContext; created: boolean }> {
  const key = contextKey(platform, accountId)
  const alive = takeAlive(key)
  if (alive) return { context: alive, created: false }

  // 并发闸：活跃（含排队）上下文达上限则排队等待
  const deadline = Date.now() + config.publish.acquireTimeoutMs
  while (pool.size - closedButNotReaped() >= config.publish.maxContexts) {
    if (Date.now() > deadline) throw err.publishContextBusy(`发布浏览器上下文已达上限（${config.publish.maxContexts}），请稍后重试`)
    pendingAcquires++
    await new Promise((r) => setTimeout(r, 1000)).finally(() => pendingAcquires--)
    const again = takeAlive(key)
    if (again) return { context: again, created: false }
  }

  const { chromium } = await loadPlaywright()
  const userDataDir = userDataDirFor(platform, accountId)
  logger.info({ platform, accountId, userDataDir }, 'publish.context_creating')
  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: config.publish.headless,
      viewport: null,
      userAgent: STEALTH_UA,
      ignoreHTTPSErrors: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      acceptDownloads: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-popup-blocking',
        '--disable-features=IsolateOrigins,site-per-process',
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
    await context.addInitScript(stealthInitScript())
    pool.set(key, { context, lastUsedAt: Date.now() })
    context.on('close', () => {
      logger.info({ platform, accountId }, 'publish.context_closed')
      pool.delete(key)
    })
    logger.info({ platform, accountId }, 'publish.context_created')
    return { context, created: true }
  } catch (e) {
    const msg = (e as Error).message || '未知错误'
    logger.error({ err: msg, platform, accountId }, 'publish.context_create_failed')
    throw err.badRequest(`浏览器启动失败：${msg}`, { code: 'PUBLISH_BROWSER_LAUNCH_FAILED' })
  }
}

/** 已 close 但尚未从池中摘除的数量（close 事件会摘，此处兜底计数） */
function closedButNotReaped(): number {
  let n = 0
  for (const [key, entry] of pool) {
    try {
      void entry.context.pages()
    } catch {
      pool.delete(key)
      n++
    }
  }
  return n
}

/** 关闭单账号上下文（登录会话过期清理 / 账号删除用） */
export async function closeContext(platform: string, accountId: string): Promise<void> {
  const key = contextKey(platform, accountId)
  const entry = pool.get(key)
  if (!entry) return
  pool.delete(key)
  await entry.context.close().catch(() => undefined)
}

/** 空闲回收（PB5：超过 idleCloseMs 未使用的上下文关闭，释放内存） */
export async function closeIdleContexts(): Promise<number> {
  let closed = 0
  for (const [key, entry] of pool) {
    if (Date.now() - entry.lastUsedAt < config.publish.idleCloseMs) continue
    pool.delete(key)
    await entry.context.close().catch(() => undefined)
    closed++
  }
  if (closed) logger.info({ closed }, 'publish.context_idle_closed')
  return closed
}

/** 当前池状态（health 观测用） */
export function contextPoolStats(): { size: number; pending: number } {
  return { size: pool.size, pending: pendingAcquires }
}

/** 进程退出时关闭全部上下文（优雅停机链路调用） */
export async function closeAllContexts(): Promise<void> {
  for (const [key, entry] of pool) {
    pool.delete(key)
    await entry.context.close().catch(() => undefined)
  }
}

/** stealth 注入脚本（平移 AI-Studio STEALTH_INIT_SCRIPT 的核心段：webdriver/plugins/languages/特征清理） */
function stealthInitScript(): string {
  return `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  window.chrome = window.chrome || { runtime: { connect: function(){ return { onDisconnect: { addListener: function(){} }, onMessage: { addListener: function(){}, postMessage: function(){}, disconnect: function(){} }; } }, app: { isInstalled: false } };
  Object.defineProperty(navigator, 'plugins', { get: () => [{ name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 1 }, { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', length: 2 }, { name: 'Native Client', description: '', filename: 'internal-nacl-plugin', length: 2 }], configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  delete window.__playwright;
  delete window.__pw_manual;
  delete window.__selenium_unwrapped;
  delete window.__webdriver_evaluate;
  delete window._phantom;
  delete window.callPhantom;
  delete window.webdriver;
`
}
