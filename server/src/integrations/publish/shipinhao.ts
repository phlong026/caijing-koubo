/**
 * 视频号发布引擎（PU3 · A9 平移 publishToShipin，去 Electron 化）。
 *
 * 流程：导航 post/create → 登录判定（URL login/auth/qr 且无文件框 = 未登录，服务端模型下直接报错，
 * 扫码等待由 pollLogin 外部驱动）→ 视频上传（判定已上传则跳过；setInputFiles + change 事件）→
 * 封面（等「编辑」出现最长 5 分钟 → 竖封面 → image input 排除 video → 确认按钮）→
 * 标题（选择器链 + 通用 input 扫描；已有内容前置标题）→ 描述（contenteditable 优先）→
 * 话题（独立标签框或复用描述框，#tag+空格+弹窗回车）→ 发表按钮 → 15 分钟确认轮询。
 * AIGC 自标识（PB7）为新增开发，本轮不勾选。
 */
import type { BrowserContext, Page } from './browser.js'
import { logger } from '../../log.js'
import { extractVideoIdFromUrl } from './selectors.js'
import { waitForPublishConfirmation, type PublishExecutionResult } from './confirm.js'
import type { PlatformPublishParams, PlatformPublishResult } from './douyin.js'

/** 阻止浏览器原生文件选择对话框（setInputFiles 前置，平移 AI-Studio preventFileDialog） */
function preventFileDialogScript(): string {
  return `
  (() => {
    const prevent = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return false }
    document.querySelectorAll('input[type="file"]').forEach((input) => {
      input.onclick = prevent; input.onmousedown = prevent; input.onmouseup = prevent; input.onfocus = prevent
      for (const ev of ['click', 'mousedown', 'mouseup', 'focus']) {
        input.addEventListener(ev, prevent, { capture: true, passive: false })
      }
    })
  })()`
}

async function safePageWait(page: Page, ms: number): Promise<void> {
  try {
    await page.waitForTimeout(ms)
  } catch {
    // 页面关闭忽略
  }
}

/** input 元素摘要（type/accept/已含文件） */
async function inputMeta(el: import('playwright').Locator) {
  const accept = await el.getAttribute('accept').catch(() => '')
  const hasFiles = await el.evaluate((e) => !!(e.files && e.files.length > 0)).catch(() => false)
  return { accept: accept ?? '', hasFiles }
}

export async function publishToShipinhao(
  context: BrowserContext,
  params: PlatformPublishParams,
  confirmTimeoutMs = params.confirmTimeoutMs,
): Promise<PlatformPublishResult> {
  let page: Page | null = null
  let shouldClosePage = false

  try {
    page = await context.newPage()
    page.setDefaultTimeout(60_000)
    page.setDefaultNavigationTimeout(60_000)

    const uploadUrl = 'https://channels.weixin.qq.com/platform/post/create'
    await page.goto(uploadUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(5000)

    // 登录判定：URL 登录关键词 + 页面无文件输入框 = 未登录（服务端模型不等待人工扫码，由 pollLogin 驱动）
    const currentUrl = page.url()
    const urlIndicatesLogin =
      currentUrl.includes('login') || currentUrl.includes('auth') || currentUrl.includes('weixin.qq.com/qr') || currentUrl.includes('mp.weixin.qq.com')
    const fileInputCount = await page.locator('input[type="file"]').count().catch(() => 0)
    if (urlIndicatesLogin && fileInputCount === 0) {
      throw new Error('视频号登录已过期，请先在账号管理中重新扫码登录')
    }

    await safePageWait(page, 5000)
    try {
      await page.locator('input[type="file"]').first().waitFor({ timeout: 10_000, state: 'attached' })
    } catch {
      // 继续按已上传判定
    }

    // 视频上传（已上传判定：file 已含视频 / 页面出现处理中|上传成功 / 预览视频元素存在）
    let videoAlreadyUploaded = false
    for (const input of await page.locator('input[type="file"]').all()) {
      try {
        const { accept, hasFiles } = await inputMeta(input)
        if (hasFiles && (accept.includes('video') || accept.includes('mp4') || !accept)) {
          videoAlreadyUploaded = true
          break
        }
      } catch {
        // 继续
      }
    }
    if (!videoAlreadyUploaded) {
      for (const selector of ['text="上传成功"', 'text="处理完成"', '*:has-text("上传成功")', '*:has-text("处理完成")']) {
        if ((await page.locator(selector).count()) > 0) {
          videoAlreadyUploaded = true
          break
        }
      }
    }
    if (!videoAlreadyUploaded) {
      try {
        const info = await page.evaluate<boolean>(`(() => {
          for (const video of Array.from(document.querySelectorAll('video'))) {
            if (video.src || video.poster || video.currentSrc) return true
          }
          for (const img of Array.from(document.querySelectorAll('img'))) {
            if ((img.src.includes('video') || img.className.includes('preview') || img.className.includes('thumbnail')) && img.complete && img.naturalWidth > 0) return true
          }
          return false
        })()`)
        if (info) videoAlreadyUploaded = true
      } catch {
        // 继续
      }
    }
    if (!videoAlreadyUploaded) {
      params.onPhase?.('uploading')
      await page.evaluate(preventFileDialogScript())
      let fileInput = null
      for (const selector of ['input[type="file"][accept*="video"]', 'input[type="file"]']) {
        if ((await page.locator(selector).count()) > 0) {
          const candidate = page.locator(selector).first()
          const { accept } = await inputMeta(candidate)
          fileInput = candidate
          if (accept.includes('video') || !accept) break
        }
      }
      if (!fileInput) throw new Error('未找到视频上传输入框')
      const { hasFiles } = await inputMeta(fileInput)
      if (!hasFiles) {
        await fileInput.setInputFiles(params.videoPath, { timeout: 60_000 })
        await fileInput.evaluate(`(el) => {
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }))
        }`)
        await safePageWait(page, 3000)
      }
    }

    // 封面：等「编辑」出现（转码最长 5 分钟）→ 竖封面 → image input（排除 video）→ 确认
    if (params.coverPath) {
      const coverEditStart = Date.now()
      while (Date.now() - coverEditStart < 300_000) {
        let found = false
        for (const selector of ['*:has-text("个人主页和分享卡片") *:has-text("编辑")', 'text="编辑"', 'button:has-text("编辑")']) {
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
        for (const selector of ['*:has-text("个人主页和分享卡片") *:has-text("编辑")', 'text="编辑"', 'button:has-text("编辑")']) {
          const el = page.locator(selector).first()
          if ((await page.locator(selector).count()) > 0 && (await el.isVisible().catch(() => false))) {
            coverBtn = el
            break
          }
        }
        if (coverBtn) {
          await coverBtn.click()
          await page.waitForTimeout(2000)
          for (const selector of ['img.cover-img-vertical', 'img[class*="cover-img-vertical"]', '[class*="cover-img"]']) {
            const img = page.locator(selector).first()
            if ((await page.locator(selector).count()) > 0 && (await img.isVisible().catch(() => false))) {
              await img.click()
              await page.waitForTimeout(2500)
              break
            }
          }
          await page.evaluate(preventFileDialogScript())
          // 封面 input：未含文件且非 video accept（两轮匹配：image 优先 → 放宽到非 video）
          let coverInput = null
          const inputs = await page.locator('input[type="file"]').all()
          for (const input of inputs) {
            const { accept, hasFiles } = await inputMeta(input)
            if (!hasFiles && accept.includes('image') && !accept.includes('video')) {
              coverInput = input
              break
            }
          }
          if (!coverInput) {
            for (const input of inputs) {
              const { accept, hasFiles } = await inputMeta(input)
              if (!hasFiles && !accept.includes('video') && !accept.includes('mp4')) {
                coverInput = input
                break
              }
            }
          }
          if (coverInput) {
            try {
              await coverInput.setInputFiles(params.coverPath, { timeout: 30_000 })
              await coverInput.evaluate(`(el) => {
                el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }))
                el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
              }`)
              await page.waitForTimeout(2000)
              for (const selector of [
                'button:has-text("确认")',
                'button:has-text("确定")',
                'button:has-text("保存")',
                '[role="dialog"] button:has-text("确认")',
                '.weui-desktop-dialog button:has-text("确认")',
              ]) {
                const btn = page.locator(selector).first()
                if ((await page.locator(selector).count()) > 0 && (await btn.isVisible().catch(() => false))) {
                  await btn.scrollIntoViewIfNeeded()
                  await page.waitForTimeout(300)
                  await btn.click()
                  await page.waitForTimeout(2000)
                  break
                }
              }
            } catch (e) {
              logger.warn({ err: (e as Error).message }, 'publish.shipinhao.cover_upload_failed')
            }
          }
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'publish.shipinhao.cover_skipped')
      }
      await safePageWait(page, 2000)
    }

    // 标题（选择器链 + 通用 input 扫描；已有内容 → 标题前置）
    let titleInput = null
    for (const selector of [
      'input[placeholder*="添加描述"]',
      'textarea[placeholder*="添加描述"]',
      'input[placeholder*="描述"]',
      'textarea[placeholder*="描述"]',
      'input[placeholder*="标题"]',
      'textarea[placeholder*="标题"]',
      '[class*="description"] input',
      '[class*="description"] textarea',
      '[class*="desc"] input',
      '[class*="desc"] textarea',
      '[class*="title"] input',
      '[class*="title"] textarea',
    ]) {
      const el = page.locator(selector).first()
      if ((await page.locator(selector).count()) > 0 && (await el.isVisible().catch(() => false))) {
        titleInput = el
        break
      }
    }
    if (titleInput) {
      try {
        await titleInput.scrollIntoViewIfNeeded()
        const currentValue = (await titleInput.inputValue().catch(() => '')) ?? ''
        if (currentValue.trim() && !currentValue.includes(params.description.slice(0, 10)) && currentValue.trim() !== params.title) {
          await titleInput.fill(`${params.title}\n\n${currentValue}`)
        } else if (!currentValue.trim()) {
          await titleInput.fill(params.title)
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'publish.shipinhao.title_fill_failed')
      }
    }

    // 描述（contenteditable data-placeholder 优先）
    let descInput = null
    for (const selector of [
      'div[contenteditable][data-placeholder*="添加描述"]',
      'div[contenteditable][data-placeholder*="描述"]',
      'div[contenteditable="true"][data-placeholder*="添加描述"]',
      '[class*="input-editor"]',
      'div[contenteditable][class*="editor"]',
      'textarea[placeholder*="添加描述"]',
      'textarea[placeholder*="描述"]',
      '[class*="description"] textarea',
    ]) {
      const el = page.locator(selector).first()
      if ((await page.locator(selector).count()) > 0 && (await el.isVisible().catch(() => false))) {
        descInput = el
        break
      }
    }
    if (descInput) {
      try {
        await descInput.scrollIntoViewIfNeeded()
        const contentEditable = await descInput.getAttribute('contenteditable').catch(() => '')
        await descInput.click()
        await safePageWait(page, 300)
        if (contentEditable !== null && contentEditable !== undefined) {
          if (params.description.trim()) {
            await page.keyboard.type(params.description, { delay: 30 })
            await safePageWait(page, 500)
          }
        } else if (params.description.trim()) {
          await descInput.fill(params.description)
          await safePageWait(page, 500)
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'publish.shipinhao.desc_fill_failed')
      }
    }

    // 话题（独立标签框优先，否则复用描述框；#tag + 空格 + 建议弹窗回车）
    if (params.tags.length > 0) {
      let tagInput = null
      for (const selector of [
        'div[contenteditable][data-placeholder*="标签"]',
        'div[contenteditable][data-placeholder*="话题"]',
        'input[placeholder*="标签"]',
        'input[placeholder*="话题"]',
        '[class*="tag"] div[contenteditable]',
        '[class*="topic"] div[contenteditable]',
      ]) {
        const el = page.locator(selector).first()
        if ((await page.locator(selector).count()) > 0 && (await el.isVisible().catch(() => false))) {
          tagInput = el
          break
        }
      }
      if (!tagInput && descInput) tagInput = descInput
      if (tagInput) {
        try {
          await tagInput.scrollIntoViewIfNeeded()
          const contentEditable = await tagInput.getAttribute('contenteditable').catch(() => '')
          if (contentEditable !== null && contentEditable !== undefined) {
            await tagInput.evaluate(`(el) => {
              el.focus()
              const selection = window.getSelection()
              const range = document.createRange()
              range.selectNodeContents(el)
              range.collapse(false)
              selection.removeAllRanges()
              selection.addRange(range)
            }`)
          }
          await safePageWait(page, 200)
          for (const raw of params.tags) {
            const cleanTag = raw.trim().replace(/^#/, '')
            if (!cleanTag) continue
            await page.keyboard.type('#', { delay: 50 })
            await safePageWait(page, 100)
            await page.keyboard.type(cleanTag, { delay: 50 })
            await safePageWait(page, 300)
            await page.keyboard.press('Space')
            await safePageWait(page, 500)
            try {
              const topicPopup = page.locator('[class*="topic"], [class*="hashtag"], [class*="suggest"]').first()
              if (await topicPopup.isVisible({ timeout: 1000 })) {
                await page.keyboard.press('Enter')
                await safePageWait(page, 300)
              }
            } catch {
              // 无弹窗继续
            }
          }
        } catch (e) {
          logger.warn({ err: (e as Error).message }, 'publish.shipinhao.tags_failed')
        }
      }
    }

    // 发表
    let publishBtn = null
    for (const selector of [
      'button:has-text("发表")',
      'div:text-is("发表")',
      'button:has-text("发布")',
      'div[class*="publish"] button',
      'button[class*="publish"]',
      'div:text-is("发布")',
      'button:has-text("确定发布")',
    ]) {
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
        message: '未找到明确的发表按钮，请在浏览器中手动确认发布',
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
        page.locator('text="发表成功"').waitFor({ timeout: 10_000 }),
        page.locator('text="发布成功"').waitFor({ timeout: 10_000 }),
        new Promise((r) => setTimeout(r, 5000)),
      ])
    } catch {
      // 已点击，交给确认轮询
    }

    const result = await waitForPublishConfirmation(page, 'shipinhao', confirmTimeoutMs, (msg, detail) =>
      logger.warn({ msg, detail }, 'publish.shipinhao.confirm'),
    )
    if (result.success) shouldClosePage = true
    return {
      ...result,
      externalVideoId: result.videoUrl ? extractVideoIdFromUrl(result.videoUrl) : '',
    }
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'publish.shipinhao.failed')
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
