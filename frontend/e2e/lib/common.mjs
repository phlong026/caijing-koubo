/**
 * 浏览器端到端脚本共用：接口调用 / 登录与测试账号 / 夹具 / 步骤计数与失败截图。
 * 只依赖 Node 内置模块与 playwright；不 import 前后端源码。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

export const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5173'
export const API = `${BASE}/api`
export const E2E_PASSWORD = 'E2e-12345'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const expect = (cond, msg) => {
  if (!cond) throw new Error(msg || 'expectation failed')
}

export async function apiCall(method, p, body, token, headers = {}) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, data: json?.data }
}

export async function login(username, password) {
  const r = await apiCall('POST', '/auth/login', { username, password })
  if (!r.data?.token) throw new Error(`登录失败（${username}）：${r.status} ${JSON.stringify(r.json?.error ?? r.json)}`)
  return r.data.token
}

/** 用管理员创建（或重置）测试账号并登录，返回 { admin, ops, reviewer } 令牌 */
export async function ensureUsers(users) {
  const admin = await login(process.env.E2E_ADMIN_USER || 'admin', process.env.E2E_ADMIN_PASSWORD || 'admin123')
  const tokens = { admin }
  for (const [key, username, role] of users) {
    const created = await apiCall(
      'POST',
      '/users',
      { username, role, password: E2E_PASSWORD, displayName: username },
      admin,
    )
    if (created.status !== 200) {
      const user = (await apiCall('GET', '/users', null, admin)).data?.items?.find((u) => u.username === username)
      if (!user) throw new Error(`无法创建测试账号 ${username}：${created.status}`)
      await apiCall('PATCH', `/users/${user.id}`, { role, enabled: true, password: E2E_PASSWORD }, admin)
    }
    tokens[key] = await login(username, E2E_PASSWORD)
  }
  return tokens
}

export async function waitFor(desc, timeoutMs, intervalMs, fn) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await fn()
    if (r) return r
    await sleep(intervalMs)
  }
  throw new Error(`等待超时：${desc}`)
}

/** 现场生成的媒体夹具（不入库） */
export function makeFixtures(prefix) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  const fx = path.join(out, 'fx')
  // 截图默认随临时目录；设 E2E_ARTIFACTS 时落到该目录下（CI 失败时上传）
  const shots = process.env.E2E_ARTIFACTS ? path.resolve(process.env.E2E_ARTIFACTS, prefix) : path.join(out, 'shots')
  fs.mkdirSync(fx, { recursive: true })
  fs.mkdirSync(shots, { recursive: true })
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...a])
  const files = {
    avatar: path.join(fx, 'avatar.mp4'),
    sample: path.join(fx, 'sample.wav'),
    pdf: path.join(fx, 'auth.pdf'),
  }
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
    files.avatar,
  )
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', files.sample)
  fs.writeFileSync(files.pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
  return { out, fx, shots, files }
}

function fileForm(fields, filePath, type) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([fs.readFileSync(filePath)], { type }), path.basename(filePath))
  return fd
}

/**
 * 接口准备「满配 KOS 人物」：授权核验 → 分身素材审核 → mock 克隆分身 / 声音 → 设默认。
 * 人物库页面本身的浏览器操作由 people-library.mjs 覆盖，这里只作为主链路的前置数据。
 */
export async function createReadyKos(tokens, files, name) {
  const { ops, reviewer } = tokens
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const must = (r, what) => {
    if (r.status !== 200)
      throw new Error(`${what} 失败：${r.status} ${JSON.stringify(r.json?.error ?? r.json).slice(0, 300)}`)
    return r.data
  }
  const persona = must(await apiCall('POST', '/personas', { name, line: 'kos' }, ops), '创建人物')
  const pid = persona.id
  const auth = must(
    await apiCall(
      'POST',
      `/personas/${pid}/authorizations`,
      fileForm(
        { grantorName: '授权人', scopes: 'portrait,voice,share', effectiveFrom: day(-1), expiresAt: day(365) },
        files.pdf,
        'application/pdf',
      ),
      ops,
    ),
    '上传授权',
  )
  must(
    await apiCall('POST', `/persona-authorizations/${auth.id}/verify`, { decision: 'verified' }, reviewer),
    '核验授权',
  )

  const src = must(
    await apiCall(
      'POST',
      `/personas/${pid}/assets`,
      fileForm({ kind: 'avatar_source', backgroundLabel: '白色简洁' }, files.avatar, 'video/mp4'),
      ops,
    ),
    '上传分身素材',
  )
  await waitFor('分身素材处理', 60_000, 500, async () =>
    ((await apiCall('GET', `/personas/${pid}/assets`, null, ops)).data ?? []).some(
      (a) => a.id === src.assetId && a.status === 'pending_review',
    ),
  )
  must(
    await apiCall('POST', `/persona-assets/${src.assetId}/review`, { decision: 'approved' }, reviewer),
    '审核分身素材',
  )

  const { consentTextVersion } = must(await apiCall('GET', '/personas/options', null, ops), '人物库选项')
  const c1 = must(
    await apiCall(
      'POST',
      `/personas/${pid}/consents`,
      {
        authorizationId: auth.id,
        purpose: 'AVATAR_CLONE',
        sourceKind: 'avatar_source',
        sourceId: src.assetId,
        consentTextVersion,
      },
      ops,
    ),
    '分身确认',
  )
  const av = must(
    await apiCall(
      'POST',
      `/personas/${pid}/avatars`,
      { name: `${name}分身`, sourceAssetId: src.assetId, consentId: c1.consentId },
      ops,
      { 'Idempotency-Key': `e2e-av-${pid}` },
    ),
    '提交分身',
  )
  await waitFor(
    '分身 ready',
    90_000,
    1000,
    async () => (await apiCall('GET', `/persona-avatars/${av.avatarId}`, null, ops)).data?.status === 'ready',
  )
  must(await apiCall('POST', `/persona-avatars/${av.avatarId}/set-default`, null, ops), '默认分身')

  const sample = must(
    await apiCall('POST', `/personas/${pid}/voice-samples`, fileForm({}, files.sample, 'audio/wav'), ops),
    '上传声音样本',
  )
  const c2 = must(
    await apiCall(
      'POST',
      `/personas/${pid}/consents`,
      {
        authorizationId: auth.id,
        purpose: 'VOICE_CLONE',
        sourceKind: 'voice_sample',
        sourceId: sample.sampleId,
        consentTextVersion,
      },
      ops,
    ),
    '声音确认',
  )
  const vo = must(
    await apiCall(
      'POST',
      `/personas/${pid}/voices`,
      { name: `${name}声音`, sampleId: sample.sampleId, consentId: c2.consentId },
      ops,
      { 'Idempotency-Key': `e2e-vo-${pid}` },
    ),
    '提交声音',
  )
  await waitFor(
    '声音 ready',
    90_000,
    1000,
    async () => (await apiCall('GET', `/persona-voices/${vo.voiceId}`, null, ops)).data?.status === 'ready',
  )
  must(await apiCall('POST', `/persona-voices/${vo.voiceId}/confirm`, null, ops), '确认声音')
  must(await apiCall('POST', `/persona-voices/${vo.voiceId}/set-default`, null, ops), '默认声音')
  return pid
}

/** 步骤计数器：失败不中断，截图留现场 */
export function createRunner(page, shots) {
  const state = { pass: 0, fail: 0, fails: [], skipped: [] }
  async function step(name, fn) {
    try {
      await fn()
      state.pass++
      console.log(`  ✅ ${name}`)
      return true
    } catch (e) {
      state.fail++
      state.fails.push(name)
      console.log(
        `  ❌ ${name}\n     ${String(e?.message ?? e)
          .split('\n')[0]
          .slice(0, 300)}`,
      )
      await page
        .screenshot({ path: path.join(shots, `fail-${state.fails.length}.png`), fullPage: true })
        .catch(() => {})
      return false
    }
  }
  return { state, step }
}

/** 收集控制台错误与接口 4xx/5xx */
export function watchPage(page) {
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
  return { consoleErrors, apiFailures }
}

/** 优先 PLAYWRIGHT_MODULE / 本地依赖；ESM 不读 NODE_PATH，退回 require 解析全局安装 */
export async function loadPlaywright() {
  try {
    return await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
  } catch {
    return createRequire(import.meta.url)('playwright')
  }
}

export async function launch(token) {
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }
      : { args: ['--no-sandbox'] },
  )
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addInitScript((t) => {
    if (!localStorage.getItem('mw_token')) localStorage.setItem('mw_token', t)
  }, token)
  await ctx.addCookies([{ name: 'mw_token', value: token, url: BASE }])
  const page = await ctx.newPage()
  page.setDefaultTimeout(12000)
  return { browser, ctx, page }
}

/** 切换当前页面的登录身份（令牌在 localStorage，媒体读取靠同名 Cookie），并重新加载 */
export async function switchUser(page, token, url) {
  await page.evaluate((t) => localStorage.setItem('mw_token', t), token)
  await page.context().addCookies([{ name: 'mw_token', value: token, url: BASE }])
  await page.goto(url ?? page.url())
}
