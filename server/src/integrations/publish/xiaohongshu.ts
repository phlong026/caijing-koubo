/**
 * 小红书发布引擎（PU3 · A10 平移 publishToXiaohongshu，去 Electron 化）。
 *
 * 流程：文件存在性前置 → 导航上传页 → 登录判定（URL login/passport/account + 用户标识缺失）→
 * 视频上传（.mp4/.mov accept 优先）→ 等编辑页跳转（上传后 /publish/<id>，多页面扫描）→
 * 处理等待（最长 2 分钟）→ 封面（等「设置封面」最长 5 分钟 → image input → 确认按钮）→
 * 标题（「填写标题会有更多赞哦」精确 placeholder 优先）→ 描述（小红书 TiPTip 编辑器为
 * contenteditable 内 p[data-placeholder] 结构：innerHTML 直写 + 向 contenteditable 父级冒泡 input 事件）→
 * 话题（描述框内 #tag + 空格 + 建议弹窗回车，标签间补 #）→ 发布按钮 → 15 分钟确认轮询。
 * AIGC 自标识（PB7）为新增开发，本轮不勾选。
 */
import fs from 'node:fs'
import type { BrowserContext, Page } from './browser.js'
import { logger } from '../../log.js'
import { extractVideoIdFromUrl } from './selectors.js'
import { waitForPublishConfirmation, type PublishExecutionResult } from './confirm.js'
import type { PlatformPublishParams, PlatformPublishResult } from './douyin.js'

async function safePageWait(page: Page, ms: number): Promise<void> {
  try {
    await page.waitForTimeout(ms)
  } catch {
    // 页面关闭忽略
  }
}

export async function publishToXiaohongshu(
  context: BrowserContext,
  params: PlatformPublishParams,
  confirmTimeoutMs = params.confirmTimeoutMs,
): Promise<PlatformPublishResult> {
  let page: Page | null = null
  let shouldClosePage = false

  try {
    if (!fs.existsSync(params.videoPath)) throw new Error(`视频文件不存在: ${params.videoPath}`)
    if (params.coverPath && !fs.existsSync(params.coverPath)) throw new Error(`封面文件不存在: ${params.coverPath}`)

    page = await context.newPage()
    page.setDefaultTimeout(60_000)
    page.setDefaultNavigationTimeout(60_000)

    const uploadUrl = 'https://creator.xiaohongshu.com/publish/publish?from=menu&target=video'
    try {
      await page.goto(uploadUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch {
      // 加载慢继续
    }
    await page.waitForTimeout(3000)

    // 登录判定
    let currentUrl = page.url()
    if (currentUrl.includes('login') || currentUrl.includes('passport') || currentUrl.includes('account')) {
      throw new Error('未登录小红书，请先在账号管理中扫码登录')
    }
    const loginIndicator = await page.$('.user-info, .avatar, .user-avatar, [data-testid="user-avatar"]')
    if (!loginIndicator) {
      await page.waitForTimeout(3000)
      const retryIndicator = await page.$('.user-info, .avatar, .user-avatar, [data-testid="user-avatar"]')
      if (!retryIndicator && (await page.locator('input[type="file"]').count()) === 0) {
        throw new Error('小红书登录已过期，请重新扫码登录')
      }
    }
    if (!currentUrl.includes('/publish/publish')) {
      await page.goto(uploadUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(3000)
    }

    // 视频上传（.mp4/.mov accept 优先）
    params.onPhase?.('uploading')
    try {
      await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 60_000 })
    } catch {
      throw new Error('发布页面加载超时，请检查网络或重新登录')
    }
    let fileInput =
      (await page.$('input.upload-input[type="file"][accept*=".mp4,.mov"]')) ??
      (await page.$('input[type="file"][accept*="video"]')) ??
      (await page.$('input[type="file"]'))
    if (!fileInput) throw new Error('未找到文件上传输入框，请检查页面或重新登录')
    await fileInput.setInputFiles(params.videoPath)
    await page.waitForTimeout(6000)

    // 等编辑页（上传后跳 /publish/<id>，平台可能开新 Tab —— 多页面扫描切换）
    const editStart = Date.now()
    while (Date.now() - editStart < 10_000) {
      try {
        const isEdit = (u: string) => !!u.match(/\/publish\/\d+/) || (u.includes('/publish/') && !u.endsWith('/publish') && u !== 'https://creator.xiaohongshu.com/publish/publish')
        const u = page.url()
        if (u.includes('creator.xiaohongshu.com') && isEdit(u)) break
        for (const p of context.pages()) {
          if (p.isClosed() || p === page) continue
          const pu = p.url()
          if (pu.includes('creator.xiaohongshu.com') && isEdit(pu)) {
            await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
            await p.waitForTimeout(2000)
            page = p
            break
          }
        }
        if (isEdit(page.url())) break
      } catch {
        // 继续
      }
      await page.waitForTimeout(1000)
    }
    await page.waitForTimeout(5000)

    // 处理等待（最长 2 分钟：处理完成/上传成功/视频源/预览区出现）
    const processStart = Date.now()
    while (Date.now() - processStart < 120_000) {
      let processed = false
      for (const selector of ['text="处理完成"', 'text="上传成功"', '*:has-text("处理完成")', '*:has-text("上传成功")', 'video[src]', '[class*="preview"]', '[class*="cover"]']) {
        if ((await page.locator(selector).count()) > 0) {
          processed = true
          break
        }
      }
      if (processed) break
      await page.waitForTimeout(2000)
    }

    // 封面：等「设置封面」最长 5 分钟 → image input → 确认按钮
    if (params.coverPath) {
      const coverStart = Date.now()
      while (Date.now() - coverStart < 300_000) {
        let found = false
        for (const selector of ['text="设置封面"', '*:has-text("更换封面")', 'button:has-text("编辑封面")', 'button:has-text("更换封面")', '*:has-text("编辑封面")', 'text="编辑"', 'button:has-text("编辑")', '[class*="edit-cover"]', '[class*="cover-edit"]']) {
          const el = page.locator(selector).first()
          if ((await page.locator(selector).count()) > 0 && (await el.isVisible().catch(() => false))) {
            found = true
            break
          }
        }
        if (found) break
        await page.waitForTimeout(1000)
      }
      try {
        let coverBtn = null
        for (const selector of ['text="设置封面"', '*:has-text("更换封面")', 'button:has-text("编辑封面")', 'button:has-text("更换封面")', 'input[type="file"][accept*="image"]']) {
          const el = page.locator(selector).first()
          if ((await page.locator(selector).count()) > 0 && (await el.isVisible().catch(() => false))) {
            coverBtn = el
            break
          }
        }
        if (coverBtn) {
          await coverBtn.scrollIntoViewIfNeeded()
          await page.waitForTimeout(500)
          await coverBtn.click()
          await page.waitForTimeout(2000)
          let coverInput = null
          for (const selector of ['input[type="file"][accept*="image"]', 'input[type="file"]']) {
            const el = page.locator(selector).first()
            if ((await page.locator(selector).count()) > 0) {
              const accept = await el.getAttribute('accept').catch(() => '')
              coverInput = el
              if (accept?.includes('image') || !accept) break
            }
          }
          if (coverInput) {
            try {
              await coverInput.setInputFiles(params.coverPath, { timeout: 30_000 })
              await page.waitForTimeout(2000)
              for (const selector of ['button:has-text("确认")', 'button:has-text("确定")', 'button:has-text("保存")', 'button:has-text("完成")']) {
                const btn = page.locator(selector).first()
                if ((await page.locator(selector).count()) > 0 && (await btn.isVisible().catch(() => false))) {
                  await btn.click()
                  await page.waitForTimeout(2000)
                  break
                }
              }
            } catch (e) {
              logger.warn({ err: (e as Error).message }, 'publish.xiaohongshu.cover_upload_failed')
            }
          }
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'publish.xiaohongshu.cover_skipped')
      }
      await page.waitForTimeout(2000)
    }

    // 标题（小红书精确 placeholder 优先）
    try {
      const titleSelectors = [
        'input[placeholder="填写标题会有更多赞哦～"]',
        'input[placeholder*="填写标题会有更多赞哦"]',
        'textarea[placeholder*="填写标题会有更多赞哦"]',
        'input[placeholder*="填写标题"]',
        'textarea[placeholder*="填写标题"]',
        'input[placeholder*="标题"]',
        'textarea[placeholder*="标题"]',
        '[class*="title"] input',
        '[class*="title"] textarea',
      ]
      let titleInput = null
      for (const selector of titleSelectors) {
        const count = await page.locator(selector).count()
        if (count > 0) {
          for (let i = 0; i < count; i++) {
            const input = page.locator(selector).nth(i)
            if (!(await input.isVisible().catch(() => false))) continue
            const placeholder = (await input.getAttribute('placeholder').catch(() => '')) ?? ''
            if (placeholder.includes('填写标题会有更多赞哦') || selector.includes('填写标题')) {
              titleInput = input
              break
            }
            if (i === 0 && placeholder.includes('标题')) {
              titleInput = input
              break
            }
          }
          if (titleInput) break
        }
      }
      if (titleInput) {
        await titleInput.scrollIntoViewIfNeeded()
        await page.waitForTimeout(500)
        await titleInput.fill(params.title)
        await page.waitForTimeout(300)
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'publish.xiaohongshu.title_fill_failed')
    }
    await page.waitForTimeout(1000)

    // 描述（TiPTip 编辑器：contenteditable 内 p[data-placeholder]，innerHTML 直写 + 父级冒泡 input）
    try {
      const descSelectors = [
        'p[data-placeholder="输入正文描述，真诚有价值的分享予人温暖"]',
        'p[data-placeholder*="输入正文描述"]',
        '[contenteditable] p[data-placeholder*="输入正文描述"]',
        'textarea[placeholder*="输入正文描述"]',
        'div[contenteditable][placeholder*="输入正文描述"]',
        'textarea[placeholder*="描述"]',
        'textarea[placeholder*="正文"]',
        'div[contenteditable][placeholder*="描述"]',
        '[class*="input-editor"]',
        'div[contenteditable="true"]',
      ]
      let descInput = null
      let descIsP = false
      for (const selector of descSelectors) {
        const count = await page.locator(selector).count()
        if (count > 0) {
          for (let i = 0; i < count; i++) {
            const input = page.locator(selector).nth(i)
            if (!(await input.isVisible().catch(() => false))) continue
            const dp = (await input.getAttribute('data-placeholder').catch(() => '')) ?? ''
            const ph = (await input.getAttribute('placeholder').catch(() => '')) ?? ''
            const combined = dp || ph
            if (combined.includes('输入正文描述') || combined.includes('真诚有价值的分享予人温暖')) {
              descInput = input
              descIsP = selector.startsWith('p[')
              break
            }
            if (i === 0 && (combined.includes('描述') || combined.includes('正文'))) {
              descInput = input
              descIsP = selector.startsWith('p[')
              break
            }
          }
          if (descInput) break
        }
      }
      if (descInput) {
        await descInput.scrollIntoViewIfNeeded()
        await page.waitForTimeout(500)
        await descInput.click()
        await page.waitForTimeout(300)
        if (descIsP) {
          await descInput.evaluate(`(el, text) => {
            el.innerHTML = ''
            el.textContent = text
            el.classList.remove('is-empty', 'is-editor-empty')
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
            let parent = el.parentElement
            while (parent) {
              if (parent.getAttribute('contenteditable') === 'true') {
                parent.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }))
                break
              }
              parent = parent.parentElement
            }
          }`, params.description)
          await page.waitForTimeout(500)
        } else {
          const contentEditable = await descInput.getAttribute('contenteditable').catch(() => '')
          if (contentEditable !== null && contentEditable !== undefined) {
            await descInput.evaluate(`(el, text) => {
              el.focus()
              el.textContent = text
              el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }))
            }`, params.description)
          } else {
            await descInput.fill(params.description)
          }
          await page.waitForTimeout(500)
        }
        // 话题（描述框内键入）
        if (params.tags.length > 0) {
          await page.keyboard.type('#', { delay: 100 })
          await page.waitForTimeout(500)
          for (let i = 0; i < params.tags.length; i++) {
            const cleanTag = params.tags[i].trim().replace(/^#/, '')
            if (!cleanTag) continue
            await page.keyboard.type(cleanTag, { delay: 100 })
            await page.waitForTimeout(300)
            await page.keyboard.press('Space')
            await page.waitForTimeout(500)
            try {
              const topicPopup = page.locator('[class*="topic"], [class*="hashtag"], [class*="suggest"]').first()
              if (await topicPopup.isVisible({ timeout: 1000 })) {
                await page.keyboard.press('Enter')
                await page.waitForTimeout(300)
              }
            } catch {
              // 无弹窗继续
            }
            if (i < params.tags.length - 1) {
              await page.keyboard.type('#', { delay: 100 })
              await page.waitForTimeout(300)
            }
          }
          await page.waitForTimeout(500)
        }
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'publish.xiaohongshu.desc_failed')
    }

    // 发布
    let publishBtn = null
    for (const selector of ['button:has-text("发布")', 'div[class*="publish"] button', 'button[class*="submit"]', 'button:has-text("立即发布")', 'div:text-is("发布")']) {
      const btn = page.locator(selector).first()
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        publishBtn = btn
        break
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
    params.onPhase?.('confirming')
    try {
      await Promise.race([
        page.locator('text="发布成功"').waitFor({ timeout: 10_000 }),
        page.locator('text="上传成功"').waitFor({ timeout: 10_000 }),
        page.locator('text="已发布"').waitFor({ timeout: 10_000 }),
        new Promise((r) => setTimeout(r, 5000)),
      ])
    } catch {
      // 已点击，交给确认轮询
    }

    const result = await waitForPublishConfirmation(page, 'xiaohongshu', confirmTimeoutMs, (msg, detail) =>
      logger.warn({ msg, detail }, 'publish.xiaohongshu.confirm'),
    )
    if (result.success) shouldClosePage = true
    return {
      ...result,
      externalVideoId: result.videoUrl ? extractVideoIdFromUrl(result.videoUrl) : '',
    }
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'publish.xiaohongshu.failed')
    throw e
  } finally {
    if (page && shouldClosePage) {
      try {
        await page.close()
      } catch {
        // 忽略
      }
    }
  }
}
