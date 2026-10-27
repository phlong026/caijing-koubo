/**
 * 主链路浏览器端到端（Playwright）：爆款选题 → 文案工坊 → 文案审核 → 视频创作 → 视频剪辑 → 成片复审 → 发布管理 → 任务中心。
 *
 * 每一步都在页面上点击完成（不直接调业务接口），验证前端调用、后端状态流转与跨模块跳转是否对得上。
 * 只有两处前置数据用接口准备：测试账号，以及一个「满配 KOS 人物」（人物库页面本身由 people-library.mjs 覆盖）。
 *
 * 前置（本机，不访问外网、不消耗积分；推荐直接用 `npm run e2e`，会自动拉起下面两项）：
 *   1. 隔离后端：cd server && node --import tsx scripts/serve-e2e.ts        # 9897，第三方全部 mock
 *   2. 前端开发服务：cd frontend && VITE_PROXY_TARGET=http://127.0.0.1:9897 npx vite --port 5173
 * 运行：node frontend/e2e/main-chain.mjs
 * 角色：e2e_ops（运营）完成创作与发布；e2e_reviewer（审核）完成文案审核与成片复审（四眼原则：提交人不能裁决自己的提交）。
 */
import path from 'node:path'
import {
  BASE,
  apiCall,
  createReadyKos,
  createRunner,
  ensureUsers,
  expect,
  launch,
  makeFixtures,
  sleep,
  switchUser,
  waitFor,
  watchPage,
} from './lib/common.mjs'

const { shots, files } = makeFixtures('main-chain-e2e')
const tokens = await ensureUsers([
  ['ops', 'e2e_ops', 'ops'],
  ['reviewer', 'e2e_reviewer', 'reviewer'],
])

const RUN = `${Date.now() % 100000}`
const PERSONA = `链路验收${RUN}`
console.log(`\n[0] 前置：满配 KOS 人物「${PERSONA}」（接口准备，mock 克隆）`)
const personaId = await createReadyKos(tokens, files, PERSONA)
console.log(`  ✓ ${personaId}`)

const { browser, page } = await launch(tokens.ops)
const { consoleErrors, apiFailures } = watchPage(page)
const { state, step } = createRunner(page, shots)

const main = () => page.locator('main')
const toast = (text) => page.locator('.arco-message', { hasText: text }).first()
const visibleModal = () => page.locator('.arco-modal:visible').last()
const visibleDrawer = () => page.locator('.arco-drawer:visible').last()
/** Arco 下拉：展开后在可见的浮层里按文本选 */
async function pickOption(trigger, text) {
  await trigger.click()
  await page.locator('.arco-select-option:visible, .arco-dropdown-option:visible', { hasText: text }).first().click()
}
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }).catch(() => {})

/** 链路上下文：各步产出的 id，后续步骤与断言复用 */
const chain = { copyId: null, videoJobId: null, cutId: null }

/* ───────────────────────── 1. 爆款选题 ───────────────────────── */
console.log('\n[1] 爆款选题')
await page.goto(`${BASE}/topics`)
await page.locator('.topics-news-row').first().waitFor({ timeout: 15000 })

await step('勾选资讯 → 选择人物 → 生成候选选题', async () => {
  await page.locator('.topics-news-row .arco-checkbox').first().click()
  await page.getByText('已选 1 条资料').waitFor()
  await pickOption(page.locator('[aria-label="目标角色或人物"]'), PERSONA)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '生成候选选题' }).click()
  // 本批完成：候选区出现「本批 n/n」，且候选已预填为该人物
  await page.waitForFunction(
    () => /本批 (\d+)\/\1/.test(document.querySelector('.topics-candidate-column')?.textContent ?? ''),
    null,
    { timeout: 60000 },
  )
  const row = page.locator('.topics-candidate-row', { hasText: PERSONA }).first()
  await row.waitFor({ timeout: 10000 })
})

await step('勾选候选并送入文案工坊 → 跳转到新建文案', async () => {
  await page.locator('.topics-candidate-row', { hasText: PERSONA }).first().locator('.arco-checkbox').click()
  await page.getByText(/已选 1 条 · 已分配 1 条/).waitFor()
  await page.getByRole('button', { name: /送入文案工坊/ }).click()
  await toast('已送入文案工坊').waitFor({ timeout: 10000 })
  await page.waitForURL(/\/copy\?ids=copy_/, { timeout: 10000 })
  chain.copyId = new URL(page.url()).searchParams.get('ids').split(',')[0]
  expect(chain.copyId, '未拿到 copyId')
})
await shot('01-topics')

/* ───────────────────────── 2. 文案工坊 ───────────────────────── */
console.log('\n[2] 文案工坊')
await step('文案带入选题来源与人物', async () => {
  await main().getByText(PERSONA).first().waitFor({ timeout: 10000 })
  await main().getByText('爆款选题 / 资讯').first().waitFor()
})

await step('生成文案 → 正文就绪', async () => {
  await page.getByRole('button', { name: '生成文案' }).click()
  await page.waitForFunction(
    () => {
      const m = document.querySelector('main')?.textContent?.match(/正文 (\d+) 字/)
      return m && Number(m[1]) > 0
    },
    null,
    { timeout: 60000 },
  )
  await page
    .getByText(/生成完成/)
    .first()
    .waitFor({ timeout: 10000 })
})

await step('选稿：生成结果即当前稿（提交时锁定，无需单独定稿）', async () => {
  await page.getByRole('button', { name: /展开候选稿/ }).click()
  await page.locator('.candidate-card.selected').getByRole('button', { name: '当前稿' }).waitFor({ timeout: 8000 })
})

await step('提交前检查 → 确认提醒 → 提交审核', async () => {
  await page.getByRole('button', { name: '检查并提交审核' }).click()
  const modal = page.locator('.copy-submit-modal')
  await modal.getByText(/项通过/).waitFor({ timeout: 20000 })
  const ack = modal.getByText('我已了解以上提醒，继续提交')
  if (await ack.isVisible()) await ack.click()
  await modal.getByRole('button', { name: '确认提交审核' }).click()
  await toast('已提交审核').waitFor({ timeout: 10000 })
})

await step('审核桩三关走完 → 文案进入人工复核', async () => {
  await waitFor('reviewGate=pending_manual', 30000, 800, async () => {
    const d = (await apiCall('GET', `/copy/${chain.copyId}`, null, tokens.ops)).data
    return (d?.reviewGate ?? d?.copy?.reviewGate) === 'pending_manual'
  })
})

await step('运营角色看不到审核工作台（路由按角色拦截）', async () => {
  const nav = await page.locator('aside, nav').first().innerText()
  expect(!nav.includes('审核工作台'), '运营侧边栏不应出现审核工作台')
  await page.goto(`${BASE}/review`)
  await sleep(800)
  expect(!/\/review/.test(new URL(page.url()).pathname), `运营仍停留在 ${page.url()}`)
})
await shot('02-copy')

/* ───────────────────────── 3. 文案审核（审核员） ───────────────────────── */
console.log('\n[3] 文案审核')
await switchUser(page, tokens.reviewer, `${BASE}/review`)
await step('待审核列表出现该文案，三关结果展示', async () => {
  await main().getByText(PERSONA).first().waitFor({ timeout: 10000 })
  await main().getByText(PERSONA).first().click()
  for (const g of ['第 1 关', '第 2 关', '第 3 关']) await main().getByText(g).first().waitFor()
})
await step('审核员通过 → 待审核清空', async () => {
  await main().getByRole('button', { name: '通过', exact: true }).last().click()
  await toast('已通过').waitFor({ timeout: 8000 })
  await waitFor(
    '文案 approved',
    10000,
    500,
    async () => (await apiCall('GET', `/copy/${chain.copyId}/approved`, null, tokens.ops)).status === 200,
  )
})
await shot('03-review-copy')

/* ───────────────────────── 4. 视频创作 ───────────────────────── */
console.log('\n[4] 视频创作')
await switchUser(page, tokens.ops, `${BASE}/copy?ids=${chain.copyId}`)
await step('文案工坊「去视频创作」→ 带 copyId 跳转', async () => {
  await page.getByRole('button', { name: '去视频创作' }).click({ timeout: 15000 })
  await page.waitForURL(new RegExp(`/video/create\\?copyId=${chain.copyId}`))
  await main().getByText('人工复核通过').first().waitFor({ timeout: 10000 })
})
await step('人物生产档案带入：默认分身 / 克隆声音 / 配置检查全过', async () => {
  await main().getByText(`${PERSONA}分身`).first().waitFor()
  await main().getByText(`${PERSONA}声音`).first().waitFor()
  await main().getByText('配置完成点击下方「生成基础视频」').waitFor({ timeout: 10000 })
  expect(await page.getByRole('button', { name: '生成基础视频' }).isEnabled(), '生成按钮应可点')
})
await step('生成基础视频 → 排队 → 生成 → 完成（mock 飞影）', async () => {
  await page.getByRole('button', { name: '生成基础视频' }).click()
  await toast('已创建基础视频').waitFor({ timeout: 10000 })
  await page.getByRole('button', { name: '进入视频剪辑' }).waitFor({ timeout: 150000 })
  const list = (await apiCall('GET', `/video/jobs?copyId=${chain.copyId}`, null, tokens.ops)).data.items
  chain.videoJobId = list.find((j) => j.phase === 'completed')?.id
  expect(chain.videoJobId, `没有 completed 的视频任务：${JSON.stringify(list).slice(0, 200)}`)
})
await step('基础视频可在页面播放（媒体字节可读）', async () => {
  const src = await main().locator('video').first().getAttribute('src', { timeout: 10000 })
  expect(src, 'video 元素无 src')
  const r = await page.request.get(new URL(src, BASE).toString(), { headers: { Range: 'bytes=0-1023' } })
  expect([200, 206].includes(r.status()) && (await r.body()).length > 0, `媒体读取 ${r.status()}`)
})
await shot('04-video')

/* ───────────────────────── 5. 视频剪辑 ───────────────────────── */
console.log('\n[5] 视频剪辑')
const EDITED = `浏览器联调改字幕${RUN}`
await step('「进入视频剪辑」→ 字幕片段按时间轴载入，风险段锁定', async () => {
  await page.getByRole('button', { name: '进入视频剪辑' }).click()
  await page.waitForURL(/\/video\/edit\?videoJobId=/)
  await main().getByText('字幕片段').waitFor()
  await main().locator('textarea').first().waitFor({ timeout: 10000 })
  await main().getByText('风险提示 · 锁定').first().waitFor()
})
await step('编辑一段字幕 → 保存草稿', async () => {
  const ta = main().locator('textarea').first()
  await ta.fill(EDITED)
  await ta.blur()
  await page.getByRole('button', { name: '保存草稿' }).click()
  await toast(/已保存/).waitFor({ timeout: 8000 })
})
await step('渲染成片版本 → 渲染完成（mock 渲染引擎）', async () => {
  await page.getByRole('button', { name: '渲染成片版本' }).click()
  await page.getByRole('button', { name: '提交成片复审' }).waitFor({ timeout: 150000 })
  const { versions } = (await apiCall('GET', `/video/jobs/${chain.videoJobId}/cut-versions`, null, tokens.ops)).data
  chain.cutId = versions.find((c) => c.status === 'completed')?.id
  expect(chain.cutId, `没有 completed 的成片：${JSON.stringify(versions).slice(0, 200)}`)
})
await step('提交成片复审', async () => {
  await page.getByRole('button', { name: '提交成片复审' }).click()
  await toast(/复审/).waitFor({ timeout: 10000 })
})
await shot('05-cut')

/* ───────────────────────── 6. 成片复审（审核员） ───────────────────────── */
console.log('\n[6] 成片复审')
await switchUser(page, tokens.reviewer, `${BASE}/review`)
await step('成片复审队列出现该成片，展示字幕编辑对照与播放器', async () => {
  await page.getByText('成片复审', { exact: true }).click()
  const item = page.locator('.review-item').first()
  await item.waitFor({ timeout: 15000 })
  await item.click()
  await main().getByText(EDITED).first().waitFor({ timeout: 8000 })
  expect(await main().locator('video').count(), '复审详情应有播放器')
})
await step('审核员通过成片', async () => {
  await main().getByRole('button', { name: '通过', exact: true }).click()
  await toast(/通过/).waitFor({ timeout: 8000 })
  await waitFor(
    'final 契约放行',
    10000,
    500,
    async () => (await apiCall('GET', `/video/cuts/${chain.cutId}/final`, null, tokens.ops)).status === 200,
  )
})
await shot('06-review-cut')

/* ───────────────────────── 7. 发布管理 ───────────────────────── */
console.log('\n[7] 发布管理')
await switchUser(page, tokens.ops, `${BASE}/publish`)
const ACCOUNT = `链路抖音号${RUN}`
await step('添加 KOS 抖音账号 → 扫码登录（mock）→ 在线', async () => {
  await page.getByTestId('account-drawer').click()
  await visibleDrawer().getByTestId('add-account').click()
  const modal = visibleModal()
  await pickOption(modal.locator('.arco-form-item', { hasText: '平台' }).locator('.arco-select'), '抖音')
  await pickOption(modal.locator('.arco-form-item', { hasText: '所属生产线' }).locator('.arco-select'), '员工 KOS')
  await modal.getByPlaceholder(/王理财/).fill(ACCOUNT)
  await modal
    .getByRole('button', { name: /确定|添加|创建|OK/ })
    .last()
    .click()
  await waitFor('账号在线', 60000, 1000, async () => {
    const { items } = (await apiCall('GET', '/platform-accounts', null, tokens.ops)).data
    return items.find((a) => a.displayName === ACCOUNT)?.loginStatus === 'active'
  })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})
await step('待安排按过审标题列出该基础视频，选中后预填过审标题', async () => {
  chain.approvedTitle = (await apiCall('GET', `/copy/${chain.copyId}/approved`, null, tokens.ops)).data.title
  await page.reload()
  await page.getByText('待安排').first().click()
  const job = page.getByTestId('publishable-job').filter({ hasText: chain.approvedTitle }).first()
  await job.waitFor({ timeout: 10000 })
  await job.click()
  const input = page.getByPlaceholder('发布标题')
  await page.waitForFunction(
    (t) => document.querySelector('input[placeholder="发布标题"]')?.value === t,
    chain.approvedTitle,
    {
      timeout: 8000,
    },
  )
  expect((await input.inputValue()) === chain.approvedTitle, `预填标题 ${await input.inputValue()}`)
})
await step('选择账号 → 创建并立即发布（标题未改不触发审核确认）', async () => {
  await page.getByTestId('matrix-douyin').getByText(ACCOUNT).click()
  await page.getByTestId('create-and-execute').click()
  await toast('已开始发布').waitFor({ timeout: 10000 })
  const { items } = (await apiCall('GET', `/publish-plans?copyId=${chain.copyId}`, null, tokens.ops)).data
  expect(items[0]?.reviewState === 'none', `reviewState=${items[0]?.reviewState}`)
})
await step('发布记录：mock 引擎发布成功，记录页即时可见', async () => {
  await waitFor('发布成功', 90000, 1500, async () => {
    const { items } = (await apiCall('GET', `/publish-plans?copyId=${chain.copyId}`, null, tokens.ops)).data
    chain.plan = items[0]
    return chain.plan?.status === 'completed'
  }).catch((e) => {
    throw new Error(`${e.message}；计划=${JSON.stringify(chain.plan ?? null).slice(0, 300)}`)
  })
  await page.getByText('发布记录').first().click()
  await main().getByText(ACCOUNT).first().waitFor({ timeout: 10000 })
  await main().getByText('已发布').first().waitFor({ timeout: 10000 })
})
await shot('07-publish')

/* ───────────────────────── 8. 任务中心 ───────────────────────── */
console.log('\n[8] 任务中心')
await page.goto(`${BASE}/tasks`)
await step('任务中心汇总该内容：人物 / 阶段为已发布', async () => {
  const row = main().locator('.cursor-pointer', { hasText: PERSONA }).first()
  await row.waitFor({ timeout: 15000 })
  await row.click()
  await main().getByText('进度流程').waitFor()
  const t = await main().innerText()
  expect(/已发布|发布完成/.test(t), `任务中心未显示已发布：${t.slice(0, 300)}`)
})
await step('进度流程五个节点全部完成：选题 → 稿件过审 → 基础视频 → 成片过审 → 发布', async () => {
  const t = await main().innerText()
  for (const s of ['已进入创作', '已通过', '已生成', '成片已过审', '已发布'])
    expect(t.includes(s), `缺少节点状态「${s}」`)
  expect(!t.includes('需处理 1'), '链路走完后不应再有需处理项')
})
await shot('08-tasks')

/* ───────────────────────── 9. 全程质量 ───────────────────────── */
console.log('\n[9] 全程质量')
await step('全程无接口 5xx', async () => {
  const fivexx = apiFailures.filter((f) => /^5\d\d /.test(f))
  expect(fivexx.length === 0, [...new Set(fivexx)].join(' | '))
})
await step('控制台 0 error', async () => {
  expect(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
})

console.log(`\n=== 主链路浏览器端到端：${state.pass} 通过，${state.fail} 失败 ===`)
if (state.fails.length) console.log(state.fails.map((f) => `  - ${f}`).join('\n'))
if (apiFailures.length) console.log(`\n接口 4xx/5xx（含预期的业务拒绝）：\n  ${[...new Set(apiFailures)].join('\n  ')}`)
console.log(`链路：copy=${chain.copyId} video=${chain.videoJobId} cut=${chain.cutId}`)
console.log(`截图与失败现场：${shots}`)
await browser.close()
process.exit(state.fail ? 1 : 0)
