/**
 * 文案工坊前端冒烟（Playwright 一次性脚本）。
 * 用法：node scripts/_ui-copy.mjs [baseUrl]
 */
import { chromium } from 'file:///C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173'
const OUT = 'E:/口播数字人/财经口播数字人/.playwright-cli'

const errors = []
let step = 0
function log(msg) {
  console.log(msg)
}

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
})
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })

page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console] ${m.text()}`)
})
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

async function shot(name) {
  step += 1
  await page.screenshot({ path: `${OUT}/${String(step).padStart(2, '0')}-${name}.png`, fullPage: true })
}

try {
  // 1) 打开文案工坊（无 id → 应自动弹出文案列表）
  await page.goto(`${BASE}/copy`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await shot('open')
  log(`[1] 页面标题：${await page.title()}`)

  const hasDrawer = await page.locator('text=文案列表').count()
  log(`[1] 文案列表抽屉出现：${hasDrawer > 0}`)

  // 2) 关闭抽屉，看空态
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  await shot('empty')
  const emptyText = await page.locator('text=还没有打开任何文案').count()
  log(`[2] 空态文案：${emptyText > 0}`)

  // 3) 打开列表并选择第一条已有文案
  await page.getByRole('button', { name: '文案列表', exact: true }).click()
  await page.waitForTimeout(900)
  await shot('list')

  const rows = page.locator('.list-row')
  const rowCount = await rows.count()
  log(`[3] 列表行数：${rowCount}`)

  if (rowCount > 0) {
    await rows.first().click()
    await page.waitForTimeout(1800)
    await shot('detail')

    const url = page.url()
    log(`[4] 跳转后 URL：${url}`)

    // 左侧来源 + 设置
    const hasSource = await page.locator('text=来源材料').count()
    const hasSettings = await page.locator('text=创作设置').count()
    const hasEditor = await page.locator('.section-item').count()
    log(`[4] 来源面板：${hasSource > 0}，创作设置：${hasSettings > 0}，段落数：${hasEditor}`)

    // 模板 chip 与风格
    const chips = await page.locator('.tpl-chip').count()
    log(`[4] 模板数：${chips}`)

    // 5) 编辑正文 → 保存
    const firstTextarea = page.locator('.section-item textarea').first()
    if (await firstTextarea.count()) {
      const before = await firstTextarea.inputValue()
      await firstTextarea.click()
      await firstTextarea.fill(`${before} 这是一段自动化补测文字。`)
      await page.waitForTimeout(400)
      await shot('edited')

      const saveBtn = page.getByRole('button', { name: '保存', exact: true })
      if (await saveBtn.count()) {
        await saveBtn.click()
        await page.waitForTimeout(1500)
        await shot('saved')
        const savedHint = await page.locator('text=/已保存/').count()
        log(`[5] 保存反馈出现：${savedHint > 0}`)
      } else {
        log(`[5] ⚠️ 未找到保存按钮（可能处于审核中/只读）`)
      }
    }

    // 6) 提交前检查
    const submitBtn = page.getByRole('button', { name: /提交审核/ })
    const submitEnabled =
      (await submitBtn.count()) > 0 &&
      !(await submitBtn
        .first()
        .isDisabled()
        .catch(() => true))
    if (submitEnabled) {
      await submitBtn.first().click()
      await page.waitForTimeout(2500)
      await shot('precheck')
      const modalTitle = await page.locator('text=提交前检查').count()
      const checkRows = await page.locator('.check-row').count()
      log(`[6] 预检弹窗：${modalTitle > 0}，检查项：${checkRows}`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
    } else {
      log(`[6] 当前文案不可提交（状态不允许），跳过`)
    }

    // 7) 历史版本抽屉
    const verBtn = page.getByRole('button', { name: /历史版本/ })
    if (await verBtn.count()) {
      await verBtn.click()
      await page.waitForTimeout(1200)
      await shot('versions')
      const verRows = await page.locator('.version-row').count()
      log(`[7] 历史版本行数：${verRows}`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }

    // 8) 配置抽屉
    const cfgBtn = page.getByRole('button', { name: /^配置$/ })
    if (await cfgBtn.count()) {
      await cfgBtn.click()
      await page.waitForTimeout(1200)
      await shot('config')
      const cfgRows = await page.locator('.cfg-row').count()
      log(`[8] 配置项行数：${cfgRows}`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
  }

  // 9) ?ids= 入口（爆款选题跳转口径）
  await page.goto(`${BASE}/copy?ids=nonexistent_1,nonexistent_2`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await shot('bad-id')
  const notFound = await page.locator('text=文案不存在或已被删除').count()
  log(`[9] 无效 id 走空/错误态：${notFound > 0}`)
} catch (e) {
  errors.push(`[fatal] ${e.message}`)
  await shot('fatal').catch(() => {})
}

await browser.close()

log('\n=== 控制台错误 ===')
if (!errors.length) log('（无）')
else errors.slice(0, 20).forEach((e) => log(e))

log(`\n截图目录：${OUT}`)
process.exit(errors.length ? 1 : 0)
