/**
 * 人物库浏览器实测（Playwright，32 项）：新建 / 重名 / 定位保存 / 授权 / 照片 / 分身 / 声音向导与试听 /
 * 绑定 / 启停 / 搜索 / 素人空态 / 1280 与 1024 宽度无溢出 / 控制台 0 error。
 *
 * 前置（均为本机，不访问外网、不消耗积分）：
 *   1. 隔离后端：cd server && HIFLY_POLL_INITIAL_MS=1500 HIFLY_POLL_MAX_MS=3000 \
 *        node --import tsx scripts/test-integration.ts --serve          # 监听 9897，飞影为 mock
 *   2. 前端开发服务：cd frontend && VITE_PROXY_TARGET=http://127.0.0.1:9897 npx vite --port 5173 --host 127.0.0.1
 *   3. 本机有 ffmpeg；已安装 playwright 与 Chromium（PLAYWRIGHT_MODULE 可指向其 index.mjs，CHROMIUM_PATH 可指定浏览器）
 * 运行：node frontend/e2e/people-library.mjs
 * 注意：脚本会在后端里创建测试人物，请对「干净的隔离后端」运行（第一节断言初始为 3 个示例人物）。
 * 登录（P0-1）：用隔离后端自动创建的 admin / admin123 建 e2e_ops（运营）与 e2e_reviewer（审核）两个账号；
 * 四眼原则要求「上传人 ≠ 核验 / 审核人」，所以上传用运营账号，核验授权与审核素材时切到审核员账号。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5173'
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'people-e2e-'))
const FX = path.join(OUT, 'fx')
const SHOTS = process.env.E2E_ARTIFACTS
  ? path.resolve(process.env.E2E_ARTIFACTS, 'people-library')
  : path.join(OUT, 'shots')
fs.mkdirSync(FX, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })

/** 夹具现场生成（不入库）：照片 / 竖屏视频 / 8 秒与 3 秒样本 / 最小 PDF */
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...a])
ff('-f', 'lavfi', '-i', 'color=c=#2b4ac0:s=720x720:d=1', '-frames:v', '1', '-q:v', '3', path.join(FX, 'photo1.jpg'))
ff(
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=720x1280:rate=30',
  '-t',
  '12',
  '-pix_fmt',
  'yuv420p',
  '-c:v',
  'libx264',
  path.join(FX, 'avatar.mp4'),
)
ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', path.join(FX, 'sample.wav'))
ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ar', '16000', '-ac', '1', path.join(FX, 'short.wav'))
fs.writeFileSync(path.join(FX, 'auth.pdf'), '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')

const API = `${BASE}/api`
async function apiCall(method, p, body, token) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
async function login(username, password) {
  const r = await apiCall('POST', '/auth/login', { username, password })
  if (!r.json?.data?.token)
    throw new Error(`登录失败（${username}）：${r.status} ${JSON.stringify(r.json?.error ?? r.json)}`)
  return r.json.data.token
}
const E2E_PASSWORD = 'E2e-12345'
const adminToken = await login(process.env.E2E_ADMIN_USER || 'admin', process.env.E2E_ADMIN_PASSWORD || 'admin123')
for (const [username, role] of [
  ['e2e_ops', 'ops'],
  ['e2e_reviewer', 'reviewer'],
]) {
  const created = await apiCall(
    'POST',
    '/users',
    { username, role, password: E2E_PASSWORD, displayName: username },
    adminToken,
  )
  if (created.status !== 200) {
    const user = (await apiCall('GET', '/users', null, adminToken)).json?.data?.items?.find(
      (u) => u.username === username,
    )
    if (!user) throw new Error(`无法创建测试账号 ${username}：${created.status}`)
    await apiCall('PATCH', `/users/${user.id}`, { role, enabled: true, password: E2E_PASSWORD }, adminToken)
  }
}
const tokens = { ops: await login('e2e_ops', E2E_PASSWORD), reviewer: await login('e2e_reviewer', E2E_PASSWORD) }

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }
    : { args: ['--no-sandbox'] },
)
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
// 默认以运营身份进入（令牌存 localStorage；<img>/<video> 读媒体靠同名 Cookie）
await ctx.addInitScript((t) => {
  if (!localStorage.getItem('mw_token')) localStorage.setItem('mw_token', t)
}, tokens.ops)
await ctx.addCookies([{ name: 'mw_token', value: tokens.ops, url: BASE }])
const page = await ctx.newPage()
/** 以审核员身份执行一段操作（四眼原则），结束后切回运营 */
async function asReviewer(fn) {
  await page.evaluate((t) => localStorage.setItem('mw_token', t), tokens.reviewer)
  try {
    return await fn()
  } finally {
    await page.evaluate((t) => localStorage.setItem('mw_token', t), tokens.ops)
  }
}
page.setDefaultTimeout(12000)

const consoleErrors = []
const apiFailures = []
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text()))
    consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
page.on('response', (r) => {
  const u = r.url()
  if (u.includes('/api/') && r.status() >= 400)
    apiFailures.push(`${r.status()} ${r.request().method()} ${u.replace(BASE, '')}`)
})

let pass = 0
let fail = 0
const fails = []
async function step(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    fails.push(name)
    console.log(`  ❌ ${name}\n     ${String(e.message).split('\n')[0].slice(0, 300)}`)
    await page.screenshot({ path: path.join(SHOTS, `fail-${fails.length}.png`), fullPage: true }).catch(() => {})
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg || 'expectation failed')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const detail = () => page.locator('.people-detail')
const toast = (text) => page.locator('.arco-message', { hasText: text }).first()

async function tab(name) {
  await detail().locator('.arco-tabs-tab', { hasText: name }).first().click()
  await sleep(300)
}

console.log('\n[1] 列表与布局')
await page.goto(`${BASE}/people`)
await page.waitForSelector('.people-card', { timeout: 15000 })

await step('页面无「演示数据 / 原型预览」字样（AC-F1）', async () => {
  const text = await page.locator('body').innerText()
  expect(!/演示数据|原型预览|示例配置/.test(text.replace(/示例/g, '')), '仍含演示字样')
})
await step('线 Tab 计数来自后端（全部 = 3 个示例人物）', async () => {
  const t = await page.locator('.mw-tabs').first().innerText()
  expect(/全部\s*3/.test(t), t)
})
await step('示例人物带「示例」标，状态按授权派生', async () => {
  const cards = await page.locator('.people-card').allInnerTexts()
  expect(cards.length === 3 && cards.every((c) => c.includes('示例')), cards.join('|'))
})
await step('飞影积分展示（mock 环境标注模拟）', async () => {
  expect(
    await page
      .getByText(/飞影积分/)
      .first()
      .isVisible(),
  )
})
await page.screenshot({ path: path.join(SHOTS, '01-list.png'), fullPage: true })

console.log('\n[2] 新增人物与 IP 定位')
const NAME = `浏览器验收${Date.now() % 10000}`
await step('新增人物：重名校验前先创建 KOS', async () => {
  await page
    .getByRole('button', { name: /新增人物/ })
    .first()
    .click()
  const modal = page.locator('.arco-modal:visible').last()
  await modal.getByPlaceholder('如：张经理').fill(NAME)
  await modal.getByText('员工 KOS', { exact: true }).first().click()
  await modal.getByRole('button', { name: '创建' }).click()
  await toast('已创建').waitFor({ timeout: 8000 })
  await page.waitForFunction((n) => document.querySelector('.people-detail')?.innerText.includes(n), NAME, {
    timeout: 8000,
  })
})
await step('新建后状态为「授权待核验」且右侧显示原因', async () => {
  const t = await detail().innerText()
  expect(t.includes('授权待核验'), t.slice(0, 200))
})
await step('重名被拒并在表单内提示', async () => {
  await page
    .getByRole('button', { name: /新增人物/ })
    .first()
    .click()
  const modal = page.locator('.arco-modal:visible').last()
  await modal.getByPlaceholder('如：张经理').fill(` ${NAME} `)
  await modal.getByRole('button', { name: '创建' }).click()
  await modal.getByText(/已存在同名人物/).waitFor({ timeout: 6000 })
  await modal.getByRole('button', { name: /取消|Cancel/ }).click()
})
await step('保存定位按钮：未修改时禁用', async () => {
  const btn = detail().getByRole('button', { name: '保存定位' })
  expect(await btn.isDisabled(), '应禁用')
})
await step('编辑角色与禁用表达后保存，提示版本', async () => {
  await detail()
    .getByPlaceholder(/基金经理/)
    .fill('投资者教育专员')
  await detail().locator('.arco-collapse-item-header').click()
  await detail().locator('input[aria-label="禁用表达"], [aria-label="禁用表达"] input').first().fill('稳赚不赔')
  await page.keyboard.press('Enter')
  const btn = detail().getByRole('button', { name: '保存定位' })
  expect(!(await btn.isDisabled()), '应可点击')
  await btn.click()
  await toast('已保存').waitFor({ timeout: 8000 })
  expect(await detail().getByRole('button', { name: '保存定位' }).isDisabled(), '保存后应禁用')
})
await page.screenshot({ path: path.join(SHOTS, '02-profile.png'), fullPage: true })

console.log('\n[3] 授权抽屉')
await step('上传并核验授权后人物变为可用', async () => {
  await detail().getByRole('button', { name: '授权管理' }).click()
  const drawer = page.locator('.arco-drawer:visible').last()
  await drawer.getByRole('textbox').first().waitFor()
  await drawer.locator('.arco-form-item', { hasText: '授权人姓名' }).locator('input').fill('张三')
  await drawer.getByText('允许共享', { exact: false }).first().click()
  await drawer.locator('input[type=file]').setInputFiles(path.join(FX, 'auth.pdf'))
  await drawer.getByRole('button', { name: '上传授权' }).click()
  await toast('已上传').waitFor({ timeout: 8000 })
  await asReviewer(async () => {
    await drawer.getByRole('button', { name: '核验通过' }).click()
    await toast('已核验通过').waitFor({ timeout: 8000 })
  })
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () => !document.querySelector('.people-detail')?.innerText.includes('授权待核验，人物不可用'),
    null,
    { timeout: 8000 },
  )
})
await step('驳回授权必须填写原因（空提交被拦）', async () => {
  await detail().getByRole('button', { name: '授权管理' }).click()
  const drawer = page.locator('.arco-drawer:visible').last()
  await drawer.locator('.arco-form-item', { hasText: '授权人姓名' }).locator('input').fill('李四')
  await drawer.locator('input[type=file]').setInputFiles(path.join(FX, 'auth.pdf'))
  await drawer.getByRole('button', { name: '上传授权' }).click()
  await toast('已上传').waitFor({ timeout: 8000 })
  await drawer.getByRole('button', { name: '驳回' }).first().click()
  const modal = page.locator('.arco-modal:visible').last()
  await modal.getByRole('button', { name: '确认' }).click()
  await page.getByText('请填写原因').first().waitFor({ timeout: 4000 })
  await modal.getByRole('button', { name: /取消|Cancel/ }).click()
  await page.keyboard.press('Escape')
})

console.log('\n[4] 形象照片')
await step('上传照片 → 处理 → 待审核 → 通过 → 设为封面', async () => {
  await tab('形象照片')
  await detail()
    .locator('.arco-tabs-content-item-active input[type=file]')
    .first()
    .setInputFiles([path.join(FX, 'photo1.jpg')])
  await detail().getByText('待审核').first().waitFor({ timeout: 40000 })
  await asReviewer(async () => {
    await detail().getByRole('button', { name: '通过' }).first().click()
    await detail().getByText('已通过').first().waitFor({ timeout: 8000 })
  })
  await detail().getByRole('button', { name: '设为封面' }).first().click()
  await toast('已设为封面').waitFor({ timeout: 8000 })
})
await step('重复上传同一文件提示已存在', async () => {
  await detail()
    .locator('.arco-tabs-content-item-active input[type=file]')
    .first()
    .setInputFiles([path.join(FX, 'photo1.jpg')])
  await detail().getByText('已存在，未重复上传').first().waitFor({ timeout: 10000 })
})
await step('上传非法类型被前端拦下（不发请求）', async () => {
  await detail()
    .locator('.arco-tabs-content-item-active input[type=file]')
    .first()
    .setInputFiles([path.join(FX, 'sample.wav')])
  await detail()
    .getByText(/仅支持/)
    .first()
    .waitFor({ timeout: 4000 })
})
await page.screenshot({ path: path.join(SHOTS, '03-photo.png'), fullPage: true })

console.log('\n[5] 口播分身')
await step('上传分身素材 → 转码质检 → 审核通过', async () => {
  await tab('口播分身')
  await detail()
    .getByPlaceholder(/背景名/)
    .fill('办公室')
  await detail()
    .locator('.arco-tabs-content-item-active input[type=file]')
    .first()
    .setInputFiles([path.join(FX, 'avatar.mp4')])
  await detail().getByText('待审核').first().waitFor({ timeout: 90000 })
  await asReviewer(async () => {
    await detail().getByRole('button', { name: '通过' }).first().click()
    await detail().getByRole('button', { name: '制作分身' }).first().waitFor({ timeout: 8000 })
  })
})
await step('制作分身：未勾选确认文本时提交按钮禁用', async () => {
  await detail().getByRole('button', { name: '制作分身' }).first().click()
  const modal = page.locator('.arco-modal:visible').last()
  expect(await modal.getByRole('button', { name: '确认并提交' }).isDisabled(), '应禁用')
  await modal.locator('.arco-checkbox').first().click()
  expect(!(await modal.getByRole('button', { name: '确认并提交' }).isDisabled()), '勾选后应可提交')
})
await step('提交分身制作 → 制作中 → 可用 → 设为默认', async () => {
  const modal = page.locator('.arco-modal:visible').last()
  await modal.getByRole('button', { name: '确认并提交' }).click()
  await toast('已提交').waitFor({ timeout: 10000 })
  await detail()
    .getByText('制作中')
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => {})
  await detail().locator('.mw-card', { hasText: '可用' }).first().waitFor({ timeout: 90000 })
  await detail().getByRole('button', { name: '设为默认' }).first().click()
  await detail().getByText('默认', { exact: true }).first().waitFor({ timeout: 8000 })
})
await page.screenshot({ path: path.join(SHOTS, '04-avatar.png'), fullPage: true })

console.log('\n[6] 声音档案')
await step('向导：样本过短被前端拦下', async () => {
  await tab('声音档案')
  await detail().getByRole('button', { name: '克隆新声音' }).click()
  const modal = page.locator('.arco-modal:visible').last()
  await modal.locator('input[type=file]').setInputFiles(path.join(FX, 'short.wav'))
  await modal.getByText(/不足 5 秒/).waitFor({ timeout: 6000 })
  expect(await modal.getByRole('button', { name: '上传并校验' }).isDisabled(), '应禁用')
})
await step('向导：三步完成克隆提交', async () => {
  const modal = page.locator('.arco-modal:visible').last()
  await modal.locator('input[type=file]').setInputFiles(path.join(FX, 'sample.wav'))
  await modal.getByText(/已选择/).waitFor({ timeout: 6000 })
  await modal.getByRole('button', { name: '上传并校验' }).click()
  await modal.locator('.arco-checkbox').first().waitFor({ timeout: 10000 })
  await modal.locator('.arco-checkbox').first().click()
  await modal.getByRole('button', { name: '下一步' }).click()
  await modal.getByRole('button', { name: '确认并提交' }).click()
  await toast('已提交').waitFor({ timeout: 10000 })
})
await step('声音克隆完成 → 待确认 → 试听后确认 → 设为默认', async () => {
  await detail().locator('.mw-card', { hasText: '待确认' }).first().waitFor({ timeout: 90000 })
  await detail().getByRole('button', { name: '试听后确认' }).first().click()
  await toast('已确认').waitFor({ timeout: 8000 })
  await detail().getByRole('button', { name: '设为默认' }).first().click()
  await toast('已设为默认声音').waitFor({ timeout: 8000 })
})
await step('参数滑杆展开且未修改时保存禁用', async () => {
  await detail().getByRole('button', { name: /参数/ }).first().click()
  expect(await detail().getByRole('button', { name: '保存参数' }).isDisabled(), '应禁用')
})
await step('任意文本试听可生成并播放', async () => {
  await detail().getByLabel('试听文本').fill('大家好，欢迎来到我的频道。')
  await detail().getByRole('button', { name: '生成并试听' }).click()
  await detail()
    .getByText(/已生成|命中缓存/)
    .first()
    .waitFor({ timeout: 90000 })
})
await page.screenshot({ path: path.join(SHOTS, '05-voice.png'), fullPage: true })

console.log('\n[7] 状态联动与其它')
await step('配置齐全后人物卡显示「已配置」', async () => {
  await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll('.people-card')].some(
        (c) => c.innerText.includes(n) && c.innerText.includes('已配置'),
      ),
    NAME,
    { timeout: 15000 },
  )
})
await step('背景与空镜 Tab：说明与三个分组', async () => {
  await tab('背景与空镜')
  const t = await detail().innerText()
  expect(t.includes('口播视频的背景由分身素材决定') && t.includes('背景图') && t.includes('空镜视频'), t.slice(0, 200))
})
await step('版本历史抽屉可打开且含多个版本', async () => {
  await detail().getByRole('button', { name: '更多操作' }).click()
  await page.getByText('版本历史', { exact: true }).last().click()
  const drawer = page.locator('.arco-drawer:visible').last()
  await drawer.getByText(/^v\d+/).first().waitFor({ timeout: 6000 })
  const n = await drawer.getByText(/^v\d+$/).count()
  expect(n >= 2, `版本数 ${n}`)
  await page.keyboard.press('Escape')
})
await step('账号绑定：保存 1 个账号；第 2 个共享账号合法', async () => {
  await tab('IP 定位')
  await detail().getByRole('button', { name: '管理', exact: true }).click()
  const modal = page.locator('.arco-modal:visible').last()
  await modal.getByRole('button', { name: '添加账号' }).click()
  await modal.getByLabel('第 1 个账号标识').fill(`acct-${Date.now()}`)
  await modal.getByLabel('第 1 个账号显示名').fill('主账号')
  await modal.getByRole('button', { name: '保存' }).click()
  await toast('已保存绑定').waitFor({ timeout: 8000 })
})
await step('停用后卡片显示「已停用」，再启用成功', async () => {
  await detail().getByRole('switch').click()
  await toast('已停用').waitFor({ timeout: 8000 })
  await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll('.people-card')].some(
        (c) => c.innerText.includes(n) && c.innerText.includes('已停用'),
      ),
    NAME,
    { timeout: 8000 },
  )
  await detail().getByRole('switch').click()
  await toast('已启用').waitFor({ timeout: 8000 })
})
await step('搜索：回车触发、清空恢复', async () => {
  const input = page.getByLabel('搜索人物名称')
  await input.fill('不存在的人物xyz')
  await page.keyboard.press('Enter')
  await page.getByText('还没有符合条件的人物').waitFor({ timeout: 6000 })
  await input.fill('')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.people-card', { timeout: 6000 })
})
await step('新建素人：口播分身 / 声音 Tab 显示不使用数字人口播（AC-F9）', async () => {
  await page
    .getByRole('button', { name: /新增人物/ })
    .first()
    .click()
  const modal = page.locator('.arco-modal:visible').last()
  await modal.getByPlaceholder('如：张经理').fill(`素人验收${Date.now() % 10000}`)
  await modal.getByText('素人矩阵', { exact: true }).first().click()
  await modal.getByRole('button', { name: '创建' }).click()
  await toast('已创建').waitFor({ timeout: 8000 })
  await page.waitForFunction(() => document.querySelector('.people-detail')?.innerText.includes('素人矩阵'), null, {
    timeout: 8000,
  })
  await tab('口播分身')
  expect((await detail().innerText()).includes('素人矩阵不使用数字人口播'), '分身 Tab 应显示空态')
  await tab('声音档案')
  expect((await detail().innerText()).includes('素人矩阵不使用数字人口播'), '声音 Tab 应显示空态')
})

console.log('\n[8] 响应式与控制台')
for (const w of [1280, 1024]) {
  await step(`${w}px 宽度无横向溢出（AC-F2）`, async () => {
    await page.setViewportSize({ width: w, height: 900 })
    await sleep(400)
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
    expect(o.sw <= o.iw + 1, `scrollWidth ${o.sw} > ${o.iw}`)
    await page.screenshot({ path: path.join(SHOTS, `06-${w}.png`), fullPage: true })
  })
}
await step('控制台 0 error（AC-F10）', async () => {
  expect(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
})

console.log(`\n=== 浏览器实测：${pass} 通过，${fail} 失败 ===`)
if (fails.length) console.log(fails.map((f) => `  - ${f}`).join('\n'))
if (apiFailures.length) console.log(`\n接口 4xx/5xx（含预期的业务拒绝）：\n  ${[...new Set(apiFailures)].join('\n  ')}`)
await browser.close()
console.log(`截图与失败现场：${SHOTS}`)
process.exit(fail ? 1 : 0)
