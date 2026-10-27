/**
 * 抖音发布引擎（PU2 · A7 完整平移 publishToDouyin，去 Electron 化）。
 *
 * 流程：导航上传页 → 登录校验（#header-avatar / input[type=file]）→ 上传视频 → 等待处理 →
 * 封面上传（coverPath 非空时；失败不阻塞）→ 标题（≤20 字）→ 描述 + 话题标签（逐个 #tag + 空格 + 弹窗回车）→
 * 点击发布 → waitForPublishConfirmation（15 分钟窗口）。
 *
 * PB7（AIGC 自标识）为新增开发：AI-Studio 无此逻辑，本平移不勾选，灰度期按平台 DOM 探明后补充。
 */
import type { BrowserContext, Page } from './browser.js'
import { logger } from '../../log.js'
import { extractVideoIdFromUrl, type PublishPlatform } from './selectors.js'
import { waitForPublishConfirmation, type PublishExecutionResult } from './confirm.js'

export interface PlatformPublishParams {
  videoPath: string
  coverPath: string | null
  title: string
  description: string
  tags: string[]
  /** 确认窗口（毫秒） */
  confirmTimeoutMs: number
  /** 阶段回调（uploading=开始上传；confirming=已点发布） */
  onPhase?: (phase: 'uploading' | 'confirming') => void
}

export interface PlatformPublishResult extends PublishExecutionResult {
  externalVideoId?: string
}

async function safePageWait(page: Page, ms: number): Promise<void> {
  try {
    await page.waitForTimeout(ms)
  } catch {
    // 页面已关闭等场景忽略
  }
}

/** 抖音封面与标题/描述区域弹窗的统一关闭（「暂不设置」/ X 按钮） */
async function closePopups(page: Page): Promise<void> {
  try {
    await safePageWait(page, 1000)
    const skipBtn = page.locator('button:has-text("暂不设置"), button:has-text("暂不"), button:has-text("跳过")').first()
    if ((await skipBtn.count()) > 0) {
      await skipBtn.click()
      await safePageWait(page, 1000)
    }
    const closeButtons = await page.$$('.semi-modal-close, [aria-label="close"], [class*="close-icon"], [class*="CloseBtn"]')
    for (const closeBtn of closeButtons) {
      try {
        await closeBtn.click()
        await safePageWait(page, 500)
      } catch {
        // 忽略单个关闭失败
      }
    }
  } catch {
    // 忽略
  }
}

export async function publishToDouyin(
  context: BrowserContext,
  params: PlatformPublishParams,
  confirmTimeoutMs = params.confirmTimeoutMs,
): Promise<PlatformPublishResult> {
  let page: Page | null = null
  let shouldClosePage = false
  let publishTriggered = false

  try {
    page = await context.newPage()
    page.setDefaultTimeout(60_000)
    page.setDefaultNavigationTimeout(60_000)

    // 导航到上传页
    const uploadUrl = 'https://creator.douyin.com/creator-micro/content/upload'
    await page.goto(uploadUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    const currentUrl = page.url()
    // 登录校验：#header-avatar 缺失时区分「未登录」与「Cookie 过期」
    const avatarElement = await page.$('#header-avatar')
    if (!avatarElement) {
      if (currentUrl.includes('login') || currentUrl.includes('passport')) {
        throw new Error('未登录抖音，请先在账号管理中扫码登录')
      }
      await page.waitForTimeout(5000)
      const avatarRetry = await page.$('#header-avatar')
      if (!avatarRetry) {
        throw new Error('抖音登录已过期，请重新扫码登录')
      }
    }

    if (!currentUrl.includes('content/upload')) {
      await page.goto(uploadUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(3000)
    }

    // 步骤 1：上传视频
    params.onPhase?.('uploading')
    logger.info('publish.douyin.uploading')
    try {
      await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 60_000 })
    } catch {
      throw new Error('上传页面加载超时，请检查网络或重新登录')
    }
    const fileInput = await page.$('input[type="file"]')
    if (!fileInput) throw new Error('未找到文件上传输入框')
    await fileInput.setInputFiles(params.videoPath)
    await page.waitForTimeout(3000)

    // 步骤 2：等待视频处理（预览元素 / 上传成功标识 / 标题框可用，最长 5 分钟，超时继续尝试）
    try {
      await Promise.race([
        page.locator('text="预览视频"').waitFor({ timeout: 60_000 }).catch(() => null),
        page.locator('text="预览"').waitFor({ timeout: 60_000 }).catch(() => null),
        new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), 60_000)),
      ]).catch(() => undefined)
    } catch {
      // 继续按上传轮询兜底
    }
    await page.waitForTimeout(2000)

    let uploadComplete = false
    const startTime = Date.now()
    while (!uploadComplete && Date.now() - startTime < 300_000) {
      try {
        const successIndicator = page.locator('[data-e2e="upload-success"], .upload-success, [class*="success"]').first()
        if (await successIndicator.isVisible({ timeout: 1000 })) {
          uploadComplete = true
          break
        }
      } catch {
        // 继续
      }
      try {
        const titleInput = page.locator('textarea[placeholder*="标题"], input[placeholder*="标题"]').first()
        if ((await titleInput.isVisible({ timeout: 1000 })) && (await titleInput.isEnabled())) {
          uploadComplete = true
          break
        }
      } catch {
        // 继续
      }
      await page.waitForTimeout(2000)
    }
    if (!uploadComplete) logger.warn('publish.douyin.upload_wait_timeout_continue')

    // 步骤 3：封面上传（coverPath 为空跳过；失败不阻塞——抖音可自动取帧）
    if (params.coverPath) {
      await safePageWait(page, 3000)
      try {
        const coverControlXPath = '//div[contains(@class, "coverControl-CjlzqC")][.//div[contains(text(), "竖封面3:4")]]'
        let coverControl = await page.$(coverControlXPath)
        if (!coverControl) {
          const coverBtn = page.locator('text="选择封面"').first()
          if ((await coverBtn.count()) > 0) {
            await coverBtn.click()
            await safePageWait(page, 3000)
            coverControl = await page.$(coverControlXPath)
          }
        }
        if (coverControl) {
          await coverControl.click()
          await safePageWait(page, 2000)
          try {
            await page.waitForSelector('.upload-BvM5FF .semi-upload-hidden-input', { state: 'attached', timeout: 10_000 })
            const uploadInput = await page.$('.upload-BvM5FF .semi-upload-hidden-input')
            if (uploadInput) {
              await uploadInput.setInputFiles(params.coverPath)
              await safePageWait(page, 3000)
            } else {
              const imageInput = await page.$('input[type="file"][accept*="image/png"]')
              if (imageInput) {
                await imageInput.setInputFiles(params.coverPath)
                await safePageWait(page, 3000)
              }
            }
          } catch {
            const imageInput = await page.$('input[type="file"][accept*="image/png"]')
            if (imageInput) {
              await imageInput.setInputFiles(params.coverPath)
              await safePageWait(page, 3000)
            }
          }
          // 完成按钮（tooltip 容器首个按钮 → 备用「完成」）
          const completeBtnXPath = '//*[@id="tooltip-container"]//button[1]'
          try {
            await page.waitForSelector(completeBtnXPath, { timeout: 10_000 })
            const completeBtn = await page.$(completeBtnXPath)
            if (completeBtn) {
              await safePageWait(page, 2000)
              await completeBtn.click()
              await safePageWait(page, 2000)
            }
          } catch {
            const doneBtn = page.locator('button:has-text("完成")').first()
            if ((await doneBtn.count()) > 0) {
              await doneBtn.click()
              await safePageWait(page, 2000)
            }
          }
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'publish.douyin.cover_skipped')
      }
      await closePopups(page)
    }

    // 步骤 4：标题（抖音 ≤20 字硬截断，与发布侧「实质修改」基准一致由业务层保证）
    try {
      const titleSelectors = [
        'input[placeholder*="填写作品标题"]',
        'input[placeholder*="标题"]',
        'input[placeholder*="作品"]',
        '//input[contains(@placeholder, "填写作品标题")]',
      ]
      let titleInput = null
      for (const selector of titleSelectors) {
        const count = await page.locator(selector).count()
        if (count > 0) {
          titleInput = page.locator(selector).first()
          break
        }
      }
      if (titleInput) {
        const title = params.title.slice(0, 20)
        await titleInput.fill(title)
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'publish.douyin.title_fill_failed')
    }
    await page.waitForTimeout(1000)

    // 步骤 5：描述 + 话题标签
    try {
      const descSelectors = [
        'textarea[placeholder*="描述"]',
        'textarea[placeholder*="简介"]',
        'textarea[placeholder*="作品"]',
        '[class*="desc"] textarea',
        '[class*="content"] textarea',
        'div[contenteditable="true"]',
      ]
      let descInput = null
      for (const selector of descSelectors) {
        try {
          const element = page.locator(selector).first()
          await element.waitFor({ timeout: 2000 })
          if (await element.isVisible()) {
            descInput = element
            break
          }
        } catch {
          // 继续尝试
        }
      }
      if (descInput) {
        await descInput.click()
        await page.waitForTimeout(300)
        await descInput.fill('')
        await page.waitForTimeout(300)
        if (params.description && params.description.trim()) {
          await page.keyboard.type(params.description, { delay: 30 })
          await page.waitForTimeout(500)
          if (params.tags.length > 0) {
            await page.keyboard.press('Enter')
            await page.waitForTimeout(300)
          }
        }
        for (const raw of params.tags) {
          const tag = raw.trim()
          if (!tag) continue
          const cleanTag = tag.startsWith('#') ? tag : `#${tag}`
          await page.keyboard.type(cleanTag, { delay: 50 })
          await page.waitForTimeout(300)
          await page.keyboard.press('Space')
          await page.waitForTimeout(500)
          try {
            const topicPopup = page.locator('[class*="topic"], [class*="hashtag"]').first()
            if (await topicPopup.isVisible({ timeout: 1000 })) {
              await page.keyboard.press('Enter')
              await page.waitForTimeout(300)
            }
          } catch {
            // 无弹窗继续
          }
        }
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'publish.douyin.desc_fill_failed')
    }
    await page.waitForTimeout(1000)

    // 步骤 6：点击发布
    const publishBtnSelectors = [
      'button.primary:text-is("发布")',
      'button[class*="primary"]:text-is("发布")',
      'button[class*="button-"]:text-is("发布")',
      '#popover-tip-container button:text-is("发布")',
      'button:text-is("发布")',
      'button[class*="primary"]:has-text("发布")',
      'button:has-text("确定发布")',
    ]
    let publishBtn = null
    for (const selector of publishBtnSelectors) {
      try {
        const btns = await page.locator(selector).all()
        for (const btn of btns) {
          if (await btn.isVisible().catch(() => false)) {
            const text = (await btn.textContent().catch(() => ''))?.trim() || ''
            if (text === '发布' || text === '确定发布') {
              publishBtn = btn
              break
            }
          }
        }
        if (publishBtn) break
      } catch {
        // 尝试下一选择器
      }
    }

    if (!publishBtn) {
      return {
        success: false,
        status: 'manual_pending',
        message: '未找到明确的发布按钮，请在浏览器中手动确认发布',
        videoUrl: page.url(),
        videoId: '',
        keepPageOpen: true,
      }
    }

    await page.waitForTimeout(2000)
    await publishBtn.click()
    publishTriggered = true
    params.onPhase?.('confirming')

    try {
      await Promise.race([
        page.locator('text="发布成功"').waitFor({ timeout: 10_000 }),
        page.locator('text="上传成功"').waitFor({ timeout: 10_000 }),
        new Promise((r) => setTimeout(r, 5000)),
      ])
    } catch {
      // 已点击，交给确认轮询
    }

    const result = await waitForPublishConfirmation(page, 'douyin' as PublishPlatform, confirmTimeoutMs, (msg, detail) =>
      logger.warn({ msg, detail }, 'publish.douyin.confirm'),
    )
    if (result.success) shouldClosePage = true
    return {
      ...result,
      externalVideoId: result.videoUrl ? extractVideoIdFromUrl(result.videoUrl) : '',
    }
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'publish.douyin.failed')
    throw e
  } finally {
    if (page && shouldClosePage) {
      try {
        await page.close()
      } catch {
        // 忽略
      }
    }
    // 上下文保留（登录态持久化），由 context-pool 的 idle 回收负责关闭
  }
}
