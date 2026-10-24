/**
 * 真实发布引擎（PU2/PU3）：Playwright 四平台引擎注册与 PublishEngine 适配。
 *
 * 已平移平台：douyin（PU2 · publishToDouyin 完整链路）。
 * 待平移平台：kuaishou / shipinhao / xiaohongshu（PU3）——真实模式下明确抛
 * PUBLISH_PLATFORM_NOT_MIGRATED，mock 模式（MOCK_FALLBACK=true）回落 mock 引擎保持联调。
 *
 * 启用判定（resolvePublishEngine 接线，engine.ts）：
 *   PUBLISH_REAL_ENGINE=auto（默认）→ MOCK_FALLBACK=false 时已平移平台走真实；
 *   显式 true → 无视 MOCK_FALLBACK 强制真实（开发机验证用）；显式 false → 全 mock。
 */
import { config } from '../../config.js'
import { logger } from '../../log.js'
import { err } from '../../errors.js'
import type { PlatformAccount } from '../../modules/publish/types.js'
import type { EngineCheckResult, EngineLoginPoll, EngineLoginStart, EnginePublishInput, EnginePublishResult, PublishEngine } from '../../modules/publish/engine.js'
import { acquireContext, closeContext, playwrightInstalled } from './browser.js'
import { checkLoginStatus, detectLoggedIn, extractNickname, extractQrPng, gotoWithRetry, newOrExistingPage } from './login.js'
import { PLATFORM_URLS, type PublishPlatform } from './selectors.js'
import { publishToDouyin } from './douyin.js'

/** 已完成 Playwright 平移的平台（PU3 扩展时在此追加并补 publishTo* 实现） */
export const MIGRATED_PLATFORMS: PublishPlatform[] = ['douyin']

export function isMigrated(platform: string): platform is PublishPlatform {
  return MIGRATED_PLATFORMS.includes(platform as PublishPlatform)
}

/** 真实引擎是否对指定平台生效（realEngine 配置 × 平移状态 × playwright 可用性） */
export function realEngineActiveFor(platform: string): boolean {
  if (!isMigrated(platform)) return false
  if (!playwrightInstalled()) {
    logger.warn({ platform }, 'publish.real_engine_playwright_missing')
    return false
  }
  if (config.publish.realEngine === 'true') return true
  if (config.publish.realEngine === 'false') return false
  return !config.mockFallback // auto
}

/** 健康观测：引擎形态（resolvePublishEngine 的 mock 标记 + 平台明细） */
export function realEngineStatus(): { migrated: PublishPlatform[]; playwright: boolean; mode: string } {
  return {
    migrated: [...MIGRATED_PLATFORMS],
    playwright: playwrightInstalled(),
    mode: config.publish.realEngine,
  }
}

function platformOf(account: PlatformAccount): PublishPlatform {
  if (!isMigrated(account.platform)) {
    // 调用方已按 realEngineActiveFor 过滤；此处兜底防误路由
    throw err.publishPlatformNotMigrated(account.platform)
  }
  return account.platform
}

/** 创建真实引擎实例（对 account.platform 已判定生效后使用） */
export function createRealEngine(): PublishEngine {
  return {
    mock: false,

    /** 发起扫码登录：打开创作者首页并提取二维码（img dataURL → canvas → 页面截图） */
    async startLogin(account: PlatformAccount): Promise<EngineLoginStart> {
      const platform = platformOf(account)
      const { context } = await acquireContext(platform, account.id)
      const page = await newOrExistingPage(context)
      await gotoWithRetry(page, PLATFORM_URLS[platform].home)
      const qrPng = await extractQrPng(page, platform)
      if (!qrPng) return { qrPng: null, error: '未能获取登录二维码（页面结构变化或网络异常），请重试' }
      return { qrPng }
    },

    /** 登录态轮询（publish-login sweep 单次驱动）：命中登录判定组 = confirmed */
    async pollLogin(account: PlatformAccount): Promise<EngineLoginPoll> {
      const platform = platformOf(account)
      const { context } = await acquireContext(platform, account.id)
      const page = await newOrExistingPage(context)
      // sweep 间隔内页面若还停在首页/登录页，补一次导航尝试（URL 判定由 detectLoggedIn 内部排除）
      if (!page.isClosed() && !page.url().includes(new URL(PLATFORM_URLS[platform].home).host)) {
        await gotoWithRetry(page, PLATFORM_URLS[platform].home)
      }
      if (await detectLoggedIn(page, platform)) {
        const nickname = await extractNickname(context, page, platform)
        return { status: 'confirmed', nickname }
      }
      return { status: 'waiting' }
    },

    /** 登录态检测（FR-L3）：导航发布页 URL + DOM 判定 */
    async checkLogin(account: PlatformAccount): Promise<EngineCheckResult> {
      const platform = platformOf(account)
      const { context } = await acquireContext(platform, account.id)
      const r = await checkLoginStatus(context, platform)
      return { loggedIn: r.isLoggedIn, nickname: r.nickname }
    },

    /** 执行发布：上传 → 填表 → 点发布 → 15 分钟确认轮询（douyin 完整链路） */
    async publish(account: PlatformAccount, input: EnginePublishInput): Promise<EnginePublishResult> {
      const platform = platformOf(account)
      const { context } = await acquireContext(platform, account.id)
      const r = await publishToDouyin(context, {
        videoPath: input.videoPath,
        coverPath: input.coverPath,
        title: input.title,
        description: input.description,
        tags: input.tags,
        confirmTimeoutMs: input.confirmTimeoutMs,
        onPhase: input.onPhase,
      })
      return {
        // AI-Studio 内部形态 success → 引擎契约 published
        status: r.status === 'success' ? 'published' : r.status,
        videoUrl: r.videoUrl,
        externalVideoId: r.externalVideoId || undefined,
        message: r.message,
      }
    },
  }

}

/** 登录会话清理（账号删除 / expired 置位后由上层调用） */
export async function closeAccountContext(account: PlatformAccount): Promise<void> {
  await closeContext(account.platform, account.id)
}
