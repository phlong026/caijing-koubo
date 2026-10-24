/**
 * 发布确认轮询（PU2 · A3/A4 原样平移）：
 * findVisibleSelectorInFrames / detectVerificationPrompt / detectPublishSuccess / waitForPublishConfirmation。
 * 纯 Playwright 逻辑，无平台业务；超时参数由 config.publish.confirmTimeoutMs 传入（默认 15 分钟）。
 */
import type { Page } from './browser.js'
import {
  PUBLISH_PAGE_MARKERS,
  PUBLISH_SUCCESS_SELECTORS,
  VERIFICATION_ACTION_SELECTORS,
  VERIFICATION_INPUT_SELECTORS,
  VERIFICATION_TEXT_SELECTORS,
  type PublishPlatform,
} from './selectors.js'

/** 发布执行结果（引擎内部形态，adapter 转换为 EnginePublishResult） */
export interface PublishExecutionResult {
  success: boolean
  status: 'success' | 'failed' | 'verification_required' | 'manual_pending'
  message: string
  videoUrl?: string
  videoId?: string
  requiresVerification?: boolean
  /** true = 引擎保留页面等待人工（验证码 / manual_pending），上下文不关闭 */
  keepPageOpen?: boolean
}

export function getSearchFrames(page: Page): ReturnType<Page['frames']> {
  try {
    return page.frames()
  } catch {
    return []
  }
}

export async function findVisibleSelectorInFrames(
  page: Page,
  selectors: string[],
): Promise<{ selector: string; frameUrl: string } | null> {
  for (const frame of getSearchFrames(page)) {
    for (const selector of selectors) {
      try {
        const locator = frame.locator(selector).first()
        const count = await locator.count().catch(() => 0)
        if (count > 0) {
          const visible = await locator.isVisible().catch(() => false)
          if (visible) return { selector, frameUrl: frame.url() }
        }
      } catch {
        // 选择器失败继续（平台改版容错）
      }
    }
  }
  return null
}

export async function detectVerificationPrompt(page: Page): Promise<{ detected: boolean; selector?: string; frameUrl?: string }> {
  const titleMatch = await findVisibleSelectorInFrames(page, VERIFICATION_TEXT_SELECTORS)
  const inputMatch = await findVisibleSelectorInFrames(page, VERIFICATION_INPUT_SELECTORS)
  const actionMatch = await findVisibleSelectorInFrames(page, VERIFICATION_ACTION_SELECTORS)

  if ((titleMatch && inputMatch) || (inputMatch && actionMatch)) {
    return {
      detected: true,
      selector: titleMatch?.selector || inputMatch?.selector || actionMatch?.selector,
      frameUrl: titleMatch?.frameUrl || inputMatch?.frameUrl || actionMatch?.frameUrl,
    }
  }
  return { detected: false }
}

export async function detectPublishSuccess(
  page: Page,
  platform: PublishPlatform,
): Promise<{ detected: boolean; reason?: string }> {
  const successMatch = await findVisibleSelectorInFrames(page, PUBLISH_SUCCESS_SELECTORS[platform] ?? [])
  if (successMatch) return { detected: true, reason: `success_selector:${successMatch.selector}` }

  const currentUrl = page.url()
  const publishMarkers = PUBLISH_PAGE_MARKERS[platform] ?? []
  const leftPublishPage = publishMarkers.length > 0 && !publishMarkers.some((marker) => currentUrl.includes(marker))

  if (leftPublishPage && !currentUrl.includes('login') && !currentUrl.includes('verify') && !currentUrl.includes('passport')) {
    return { detected: true, reason: `url_changed:${currentUrl}` }
  }
  return { detected: false }
}

/** 已点发布后的确认轮询（FR-E1 平移：15 分钟窗口；验证码检出 → 等人工；页面关闭 → failed） */
export async function waitForPublishConfirmation(
  page: Page,
  platform: PublishPlatform,
  timeoutMs: number,
  loggerWarn: (msg: string, detail?: unknown) => void,
): Promise<PublishExecutionResult> {
  const startTime = Date.now()
  let verificationDetected = false

  while (Date.now() - startTime < timeoutMs) {
    if (page.isClosed()) {
      return {
        success: false,
        status: verificationDetected ? 'verification_required' : 'failed',
        message: verificationDetected ? '发布页面已关闭，验证码流程未完成' : '发布页面已关闭',
        keepPageOpen: false,
      }
    }

    const verificationResult = await detectVerificationPrompt(page)
    if (verificationResult.detected && !verificationDetected) {
      verificationDetected = true
      loggerWarn(`检测到验证码弹窗，进入等待用户验证状态: ${platform}`, verificationResult)
    }

    const successResult = await detectPublishSuccess(page, platform)
    if (successResult.detected) {
      return {
        success: true,
        status: 'success',
        message: '发布成功',
        videoUrl: page.url(),
        videoId: '',
        keepPageOpen: false,
      }
    }

    await page.waitForTimeout(1500)
  }

  if (verificationDetected) {
    return {
      success: false,
      status: 'verification_required',
      message: '检测到短信验证码，请在浏览器中完成验证码输入并确认发布',
      videoUrl: page.url(),
      videoId: '',
      requiresVerification: true,
      keepPageOpen: true,
    }
  }

  return {
    success: false,
    status: 'manual_pending',
    message: '已点击发布按钮，但未检测到明确的发布成功标识，请人工确认发布状态',
    videoUrl: page.url(),
    videoId: '',
    keepPageOpen: true,
  }
}
