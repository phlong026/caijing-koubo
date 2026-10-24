/**
 * 登录辅助（PU2 · A5/A6/A14 平移）：
 *  - openHomeWithLogin：打开创作者首页（已登录 Cookie 直接命中判定组）；
 *  - detectLoggedIn：登录判定组 + URL 排除词（轮询单次调用，由 publish-login sweep 驱动）；
 *  - extractQrPng：二维码提取（img src dataURL → canvas 截图 → 整页截图兜底，A14）；
 *  - extractNickname：昵称提取（选择器 alt/title/text → Cookie 兜底）；
 *  - checkLoginStatus：导航到发布页判定登录态（A6 actuallyCheckLoginStatus 平移，四平台）。
 */
import type { BrowserContext, Page } from './browser.js'
import { LOGIN_DETECT, LOGIN_URL_CHECK, NICKNAME_SELECTORS, PLATFORM_URLS, QR_SELECTORS, type PublishPlatform } from './selectors.js'

export async function newOrExistingPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages().find((p) => !p.isClosed())
  return existing ?? (await context.newPage())
}

export async function gotoWithRetry(page: Page, url: string, timeoutMs = 30_000): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  } catch {
    // 平台页面加载慢（domcontentloaded 超时），沿用 AI-Studio「继续执行」策略
  }
  await page.waitForTimeout(2000)
}

/** 登录判定（单次）：命中判定组且 URL 无排除词 = 已登录 */
export async function detectLoggedIn(page: Page, platform: PublishPlatform): Promise<boolean> {
  const cfg = LOGIN_DETECT[platform]
  try {
    const currentUrl = page.url()
    if (cfg.urlExclude.some((kw) => currentUrl.includes(kw))) return false
    for (const selector of cfg.selectors) {
      const count = await page.locator(selector).count().catch(() => 0)
      if (count > 0) return true
    }
    return false
  } catch {
    return false
  }
}

/** 二维码提取（A14）：img[dataURL] → canvas.screenshot → 整页截图兜底 */
export async function extractQrPng(page: Page, platform: PublishPlatform): Promise<Buffer | null> {
  const cfg = QR_SELECTORS[platform]
  try {
    await page.waitForSelector(cfg.img.join(', '), { timeout: 10_000 })
  } catch {
    // 无 img 形态，走 canvas / 截图兜底
  }
  for (const selector of cfg.img) {
    try {
      const el = await page.$(selector)
      if (!el) continue
      const src = await el.getAttribute('src')
      if (src?.startsWith('data:image')) {
        return Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
      }
      if (src?.startsWith('http')) {
        // http 形态的二维码图直接下载
        const res = await page.request.get(src)
        if (res.ok()) return Buffer.from(await res.body())
      }
    } catch {
      // 尝试下一个
    }
  }
  for (const selector of cfg.canvas) {
    try {
      const el = await page.$(selector)
      if (!el) continue
      const buf = await el.screenshot({ type: 'png' })
      if (buf.length > 100) return buf
    } catch {
      // 尝试下一个
    }
  }
  // 兜底：整页截图（Web 端展示可人工辨认；灰度期按平台 DOM 探明后收敛）
  try {
    return await page.screenshot({ type: 'png' })
  } catch {
    return null
  }
}

/** 昵称提取（选择器 alt/title/text → Cookie 兜底 → 用户_xxxx） */
export async function extractNickname(context: BrowserContext, page: Page, platform: PublishPlatform): Promise<string> {
  const selectors = NICKNAME_SELECTORS[platform] ?? []
  for (const selector of selectors) {
    try {
      const el = await page.$(selector)
      if (!el) continue
      const alt = await el.getAttribute('alt').catch(() => '')
      if (alt && alt.length > 0 && alt !== '头像') return alt
      const title = await el.getAttribute('title').catch(() => '')
      if (title && title.length > 0) return title
      const text = await el.textContent().catch(() => '')
      if (text && text.trim().length > 0 && text.trim().length < 20) return text.trim()
    } catch {
      // 继续
    }
  }
  try {
    const cookies = await context.cookies()
    for (const cookie of cookies) {
      if (cookie.name === 'LOGIN_STATUS' || cookie.name === 'passport_user_name') {
        try {
          const decoded = decodeURIComponent(cookie.value)
          if (decoded.length > 0 && decoded.length < 30) return decoded
        } catch {
          // 忽略解码失败
        }
      }
    }
  } catch {
    // 忽略
  }
  return `用户_${Date.now().toString(36).slice(-4)}`
}

export interface LoginCheckResult {
  isLoggedIn: boolean
  nickname?: string
}

/**
 * 登录态检测（A6 平移）：导航到发布页（已在目标 URL 则复用当前页），
 * URL 关键词判定 + DOM 判定（头像元素 / 文件输入框）。四平台通用。
 */
export async function checkLoginStatus(
  context: BrowserContext,
  platform: PublishPlatform,
): Promise<LoginCheckResult> {
  const urls = PLATFORM_URLS[platform]
  const urlCheck = LOGIN_URL_CHECK[platform]
  const page = await newOrExistingPage(context)
  page.setDefaultTimeout(20_000)
  page.setDefaultNavigationTimeout(20_000)

  try {
    const currentPageUrl = page.url()
    const onTarget =
      currentPageUrl.includes(urls.checkUrl.split('/').slice(-2).join('/')) ||
      (currentPageUrl.includes(new URL(urls.checkUrl).host) && !urlCheck.notLoggedInKeywords.some((k) => currentPageUrl.includes(k)))
    if (!onTarget) {
      await gotoWithRetry(page, urls.checkUrl, 20_000)
    }
    await page.waitForTimeout(1500)
    const currentUrl = page.url()

    if (urlCheck.notLoggedInKeywords.some((k) => currentUrl.includes(k))) return { isLoggedIn: false }
    if (!currentUrl.includes(urlCheck.loggedInHost)) return { isLoggedIn: false }

    await page.waitForTimeout(3000)
    // DOM 判定：登录判定组任一命中
    if (await detectLoggedIn(page, platform)) {
      const nickname = await extractNickname(context, page, platform)
      return { isLoggedIn: true, nickname }
    }
    return { isLoggedIn: false }
  } catch {
    return { isLoggedIn: false }
  }
}
