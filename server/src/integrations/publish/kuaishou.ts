/**
 * 快手发布引擎（PU3 · A8 平移 publishToKuaishou，去 Electron 化）。
 *
 * 流程：导航 article/publish/video?tabType=1 → 登录判定（URL login/auth/passport 或离站）→
 * 视频 input 等待最长 30 秒（video accept 优先 / 唯一 input 兜底）→ 点击事件 stopPropagation 注入 →
 * setInputFiles → 标题（placeholder 标题族）→ 描述（#work-description-edit contenteditable 优先，
 * **快手语义：标题与描述均键入描述框**——title + Enter → description + Enter → #tag + 空格）→
 * 封面（封面设置 ._cover-full-editor → 上传封面 tab ._header-title-item → image input 取最后一个
 * 合法项 → 确认按钮族）→ 发布按钮（12 选择器、文本精确匹配、点击失败 DOM el.click() 兜底）→
 * 确认对话框族 → 15 分钟确认轮询。AIGC 自标识（PB7）为新增开发，本轮不勾选。
 */
import fs from 'node:fs'
import type { BrowserContext, Page } from './browser.js'
import { logger } from '../../log.js'
import { extractVideoIdFromUrl } from './selectors.js'
import { waitForPublishConfirmation, type PublishExecutionResult } from './confirm.js'
import type { PlatformPublishParams, PlatformPublishResult } from './douyin.js'

/** 快手上传 input 的原生点击会弹系统对话框：click/mousedown/mouseup/focus 捕获段 stopPropagation */
const STOP_PROPAGATION_SCRIPT = `(() => {
  document.querySelectorAll('input[type="file"]').forEach((input) => {
    for (const ev of ['click', 'mousedown', 'mouseup', 'focus']) {
      input.addEventListener(ev, (e) => { e.stopPropagation(); e.stopImmediatePropagation() }, true)
    }
  })
})()`

export async function publishToKuaishou(
  context: BrowserContext,
  params: PlatformPublishParams,
  confirmTimeoutMs = params.confirmTimeoutMs,
): Promise<PlatformPublishResult> {
  let page: Page | null = null

  try {
    if (!fs.existsSync(params.videoPath)) throw new Error(`视频文件不存在: ${params.videoPath}`)

    page = await context.newPage()
    page.setDefaultTimeout(60_000)
    page.setDefaultNavigationTimeout(60_000)

    const uploadUrl = 'https://cp.kuaishou.com/article/publish/video?tabType=1'
    await page.goto(uploadUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(5000)
    let currentUrl = page.url()

    // 登录判定（服务端模型不等待人工扫码，由 pollLogin 驱动）
    const isLoginPage =
      currentUrl.includes('login') || currentUrl.includes('auth') || currentUrl.includes('passport') || (!currentUrl.includes('cp.kuaishou.com') && currentUrl !== 'about:blank')
    if (isLoginPage || (!currentUrl.includes('cp.kuaishou.com/article/publish') && currentUrl.includes('cp.kuaishou.com'))) {
      throw new Error('快手登录已过期，请先在账号管理中重新扫码登录')
    }
    if (!currentUrl.includes('cp.kuaishou.com/article/publish/video')) {
      await page.goto(uploadUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(5000)
    }
    await page.waitForTimeout(3000)

    // 视频上传：input 等待最长 30 秒（期间 URL 离站则重导航）
    params.onPhase?.('uploading')
    let videoInput = null
    const inputStart = Date.now()
    while (Date.now() - inputStart < 30_000 && !videoInput) {
      try {
        if (!page.url().includes('cp.kuaishou.com')) {
          await page.goto(uploadUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
          await page.waitForTimeout(3000)
        }
        for (const selector of ['input[type="file"][accept*="video"]', 'input[type="file"]']) {
          if ((await page.locator(selector).count()) > 0) {
            const candidate = page.locator(selector).first()
            const accept = await candidate.getAttribute('accept').catch(() => '')
            if (accept?.includes('video') || !accept || (await page.locator('input[type="file"]').count()) === 1) {
              videoInput = candidate
              break
            }
          }
        }
        if (videoInput) break
        await page.waitForTimeout(1000)
      } catch {
        await page.waitForTimeout(1000)
      }
    }
    if (!videoInput) throw new Error('未找到视频文件输入框，页面可能未正确加载')

    // 多 input 时精确挑选（video accept / 无 accept / 唯一）
    let actualFileInput = videoInput
    try {
      const all = await page.locator('input[type="file"]').all()
      for (const input of all) {
        const accept = await input.getAttribute('accept').catch(() => '')
        const visible = await input.isVisible().catch(() => false)
        if (visible && (accept?.includes('video') || !accept || all.length === 1)) {
          actualFileInput = input
          break
        }
      }
    } catch {
      actualFileInput = videoInput
    }
    if (!actualFileInput) throw new Error('无法找到可用的文件输入框')

    await page.evaluate(STOP_PROPAGATION_SCRIPT)
    try {
      await actualFileInput.setInputFiles(params.videoPath, { timeout: 60_000 })
    } catch (e) {
      throw new Error(`文件上传失败: ${(e as Error).message}`)
    }
    await page.waitForTimeout(3000)

    // 标题（placeholder 标题族）
    try {
      for (const selector of [
        'input[placeholder*="标题"]',
        'input[placeholder*="作品标题"]',
        'input[type="text"][placeholder*="标题"]',
        'input[class*="title"]',
        'textarea[placeholder*="标题"]',
      ]) {
        const el = page.locator(selector).first()
        if ((await page.locator(selector).count()) > 0 && (await el.isVisible().catch(() => false))) {
          await el.click()
          await page.waitForTimeout(300)
          await el.fill('')
          await page.waitForTimeout(200)
          await el.fill(params.title)
          await page.waitForTimeout(500)
          break
        }
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'publish.kuaishou.title_fill_failed')
    }

    // 描述（#work-description-edit contenteditable 优先；快手语义：标题+Enter → 描述 → 话题）
    let descInput = null
    for (const selector of [
      '#work-description-edit',
      'div#work-description-edit',
      'div[contenteditable="true"][placeholder*="添加合适的话题"]',
      'div[contenteditable="true"][id*="description"]',
      'div[contenteditable="true"][id*="work-description"]',
      'div[contenteditable="true"]',
    ]) {
      const el = page.locator(selector).first()
      if ((await page.locator(selector).count()) > 0) {
        const placeholder = (await el.getAttribute('placeholder').catch(() => '')) ?? ''
        if ((await el.isVisible().catch(() => false)) && (placeholder.includes('添加合适的话题') || selector.includes('work-description'))) {
          descInput = el
          break
        }
      }
    }
    if (!descInput) {
      for (const div of await page.locator('div[contenteditable="true"]').all()) {
        const placeholder = (await div.getAttribute('placeholder').catch(() => '')) ?? ''
        const id = (await div.getAttribute('id').catch(() => '')) ?? ''
        if ((await div.isVisible().catch(() => false)) && (placeholder.includes('添加合适的话题') || id.includes('description') || id.includes('work-description'))) {
          descInput = div
          break
        }
      }
    }
    if (descInput) {
      try {
        await descInput.scrollIntoViewIfNeeded()
        await page.waitForTimeout(500)
        await descInput.click()
        await page.waitForTimeout(300)
        await page.keyboard.type(params.title, { delay: 50 })
        await page.waitForTimeout(300)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(200)
        if (params.description.trim()) {
          await page.keyboard.type(params.description, { delay: 30 })
          await page.waitForTimeout(500)
          if (params.tags.length > 0) {
            await page.keyboard.press('Enter')
            await page.waitForTimeout(200)
          }
        }
        for (const tag of params.tags) {
          await page.keyboard.type('#', { delay: 100 })
          await page.waitForTimeout(200)
          await page.keyboard.type(tag, { delay: 100 })
          await page.waitForTimeout(300)
          await page.keyboard.press('Space')
          await page.waitForTimeout(200)
        }
        await page.waitForTimeout(500)
      } catch (e) {
        throw new Error(`填写描述失败: ${(e as Error).message}`)
      }
    }

    // 封面（coverPath 存在时）：封面设置 → 上传封面 tab → image input（取最后一个合法）→ 确认
    if (params.coverPath && fs.existsSync(params.coverPath)) {
      try {
        let coverSettingsFound = false
        for (const selector of [
          'div[class*="_cover-full-editor"]:has-text("封面设置")',
          'div[class*="_cover-full-editor"]',
          'text=/封面设置/',
        ]) {
          for (const element of await page.locator(selector).all()) {
            const visible = await element.isVisible().catch(() => false)
            const text = (await element.textContent().catch(() => '')) ?? ''
            const cls = (await element.getAttribute('class').catch(() => '')) ?? ''
            if (visible && (text.includes('封面设置') || cls.includes('_cover-full-editor'))) {
              await element.scrollIntoViewIfNeeded()
              await page.waitForTimeout(300)
              await element.click()
              await page.waitForTimeout(2500)
              coverSettingsFound = true
              break
            }
          }
          if (coverSettingsFound) break
        }
        if (coverSettingsFound) {
          await page.waitForTimeout(1000)
          let uploadCoverFound = false
          for (const selector of ['div[class*="_header-title-item"]:has-text("上传封面")', 'div[class*="_header-title-item"]', 'text=/上传封面/']) {
            for (const element of await page.locator(selector).all()) {
              const visible = await element.isVisible().catch(() => false)
              const text = (await element.textContent().catch(() => '')) ?? ''
              const cls = (await element.getAttribute('class').catch(() => '')) ?? ''
              if (visible && (text.includes('上传封面') || cls.includes('_header-title-item'))) {
                await element.scrollIntoViewIfNeeded()
                await page.waitForTimeout(300)
                await element.click()
                await page.waitForTimeout(2500)
                uploadCoverFound = true
                break
              }
            }
            if (uploadCoverFound) break
          }
          await page.waitForTimeout(1000)
          // 封面 input：image accept 且非 video，取最后一个（页面后出现的多为封面上传框）
          let coverInput = null
          const allFileInputs = await page.locator('input[type="file"]').all()
          const valid: Array<{ input: (typeof allFileInputs)[number] }> = []
          for (const input of allFileInputs) {
            const accept = (await input.getAttribute('accept').catch(() => '')) ?? ''
            const visible = await input.isVisible().catch(() => false)
            if (visible && accept.includes('image') && !accept.includes('video')) valid.push({ input })
          }
          if (valid.length > 0) {
            coverInput = valid[valid.length - 1].input
            await page.evaluate(STOP_PROPAGATION_SCRIPT)
            await coverInput.setInputFiles(params.coverPath)
            await page.waitForTimeout(3000)
            // 等裁剪/预览出现后点确认按钮族
            await page.waitForTimeout(2000)
            let confirmFound = false
            for (const selector of ['button:has-text("确定")', 'button:has-text("确认")', 'button:has-text("保存")', 'button:has-text("完成")', 'text=/确定/', 'text=/确认/', 'text=/保存/', 'text=/完成/']) {
              for (const element of await page.locator(selector).all()) {
                const visible = await element.isVisible().catch(() => false)
                const text = ((await element.textContent().catch(() => '')) ?? '').trim()
                if (visible && text && (text.includes('确定') || text.includes('确认') || text.includes('保存') || text.includes('完成'))) {
                  await element.scrollIntoViewIfNeeded()
                  await page.waitForTimeout(300)
                  await element.click()
                  await page.waitForTimeout(1000)
                  confirmFound = true
                  break
                }
              }
              if (confirmFound) break
            }
            await page.waitForTimeout(1000)
          }
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'publish.kuaishou.cover_skipped')
      }
    }
    await page.waitForTimeout(2000)

    // 发布按钮（12 选择器、文本精确匹配；点击失败 DOM el.click() 兜底）
    let publishClicked = false
    for (const selector of [
      'div:text-is("发布")',
      'div:has-text("发布"):not(:has-text("发布作品"))',
      'button:text-is("发布")',
      'button:has-text("发布")',
      'button:has-text("立即发布")',
      'button:has-text("确认发布")',
      'button:has-text("上传并发布")',
      'div[class*="publish"]:has-text("发布")',
      'span:text-is("发布")',
      'button[type="submit"]:has-text("发布")',
      'button[class*="publish"]',
      'button[class*="submit"]',
    ]) {
      for (const element of await page.locator(selector).all()) {
        try {
          const visible = await element.isVisible().catch(() => false)
          const text = ((await element.textContent().catch(() => '')) ?? '').trim()
          const disabled = await element.getAttribute('disabled').catch(() => null)
          const isPublish = visible && !disabled && (text === '发布' || text === '立即发布' || text === '确认发布')
          if (!isPublish) continue
          await element.scrollIntoViewIfNeeded()
          await page.waitForTimeout(500)
          try {
            await element.click()
          } catch {
            await element.evaluate(`(el) => el.click()`)
          }
          publishClicked = true
          await page.waitForTimeout(2000)
          break
        } catch {
          // 尝试下一个
        }
      }
      if (publishClicked) break
    }

    if (!publishClicked) {
      return {
        success: false,
        status: 'manual_pending',
        message: '视频已上传，但未能自动确认发布，请在浏览器中手动完成发布',
        videoUrl: page.url(),
        videoId: '',
        keepPageOpen: true,
      }
    }

    // 点击后的确认对话框族（快手有二次确认弹窗）
    await page.waitForTimeout(3000)
    for (const selector of ['button:has-text("确认发布")', 'button:has-text("确定")', 'button:has-text("确认")', 'text=/确认发布/']) {
      const btn = page.locator(selector).first()
      if ((await page.locator(selector).count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click()
        await page.waitForTimeout(2000)
        break
      }
    }

    const result = await waitForPublishConfirmation(page, 'kuaishou', confirmTimeoutMs, (msg, detail) =>
      logger.warn({ msg, detail }, 'publish.kuaishou.confirm'),
    )
    return {
      ...result,
      externalVideoId: result.videoUrl ? extractVideoIdFromUrl(result.videoUrl) : '',
    }
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'publish.kuaishou.failed')
    throw e
  }
}
