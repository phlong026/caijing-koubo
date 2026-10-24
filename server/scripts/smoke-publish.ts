/**
 * 发布管理模块 smoke（任务书 PU8 / AC-A、AC-L、AC-C、AC-E、AC-S、AC-R；隔离环境 mock 全链路）：
 *
 * 前置（复用视频创作链路）：满配 KOS 人物（mock 克隆）→ 文案过审（审核桩）→ 视频任务 completed。
 * 账号域：矩阵校验（越权 409）→ 建号自动登录（mock 轮询确认）→ active + uid 回填 → check-login。
 * 计划域：改标题 → needs_review（schedule 拦截）→ 审核确认 → execute-now → mock published；
 *         每日上限；取消；补录；人工结果；重发；窗口超时兜底；未过审文案拦截。
 * 用法：npm run smoke:publish
 */
import { bootIsolated } from './lib/isolated-env.js'
import { authHeader, initSmokeAuth, type SmokeRole } from './lib/smoke-auth.js'

const env = await bootIsolated({ env: { LOG_LEVEL: 'warn', PUBLISH_DAILY_LIMIT_PER_ACCOUNT: '6', PUBLISH_LOGIN_POLL_INTERVAL_MS: '1000' } })
const BASE = env.base
await initSmokeAuth(BASE)
// bootIsolated 只起 app 不跑 index.ts 启动序列：手动装配发布模块（worker / sweep），与视频 smoke 手动调 runVideoSweep 同理
const { registerPublishModule } = await import('../src/modules/publish/index.js')
await registerPublishModule()

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
  }
}

async function api<T = any>(
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
  asRole?: SmokeRole,
): Promise<{ status: number; data: T; raw: any; code?: string }> {
  const h: Record<string, string> = { ...(asRole ? authHeader(method, p, asRole) : authHeader(method, p)), ...headers }
  if (body !== undefined) h['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  const raw: any = await res.json().catch(() => ({}))
  return { status: res.status, data: raw?.data, raw, code: raw?.error?.code }
}

async function upload(p: string, fields: Record<string, string>, file: { buf: Buffer; filename: string; type: string }): Promise<any> {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([file.buf], { type: file.type }), file.filename)
  const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: authHeader('POST', p), body: fd })
  const raw: any = await res.json().catch(() => ({}))
  return { status: res.status, data: raw?.data, raw }
}

async function waitFor<T>(desc: string, timeoutMs: number, intervalMs: number, fn: () => Promise<T | null | false>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await fn()
    if (r) return r
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  console.log(`  ⚠️ 等待超时：${desc}`)
  return null
}

const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')
const pexec = promisify(execFile)
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-e2e-'))

const pdf = (): Buffer => Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1')
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
let nameSeq = 0
const uniq = (base: string): string => `${base}${String(++nameSeq).padStart(3, '0')}`

console.log('\n=== 发布管理 mock 全链路 ===\n')

/* ── 1. 前置：满配 KOS 人物 → 文案过审 → 视频任务 completed ── */
const pr = await api('POST', '/personas', { name: uniq('发布人物'), line: 'kos' })
check('创建人物', pr.status === 200, pr.raw)
const personaId = pr.data.id

const auth = await upload(`/personas/${personaId}/authorizations`, {
  grantorName: '授权人', scopes: 'portrait,voice,share', effectiveFrom: day(-1), expiresAt: day(365),
}, { buf: pdf(), filename: 'auth.pdf', type: 'application/pdf' })
await api('POST', `/persona-authorizations/${auth.data.id}/verify`, { decision: 'verified' })

const srcVideo = path.join(TMP, 'src.mp4')
await pexec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-t', '12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', srcVideo])
const srcUp = await upload(`/personas/${personaId}/assets`, { kind: 'avatar_source', backgroundLabel: '白色简洁' }, { buf: fs.readFileSync(srcVideo), filename: 'src.mp4', type: 'video/mp4' })
await waitFor('素材处理', 30_000, 500, async () => ((await api('GET', `/personas/${personaId}/assets`)).data ?? []).some((a: any) => a.id === srcUp.data.assetId && a.status === 'pending_review') || undefined)
await api('POST', `/persona-assets/${srcUp.data.assetId}/review`, { decision: 'approved' })

const consentVersionR = await api('GET', '/personas/options')
const consentTextVersion = consentVersionR.data.consentTextVersion
const consent1 = await api('POST', `/personas/${personaId}/consents`, { authorizationId: auth.data.id, purpose: 'AVATAR_CLONE', sourceKind: 'avatar_source', sourceId: srcUp.data.assetId, consentTextVersion })
const av = await api('POST', `/personas/${personaId}/avatars`, { name: uniq('分身'), sourceAssetId: srcUp.data.assetId, consentId: consent1.data.consentId }, { 'Idempotency-Key': `pub-av-${Date.now()}` })
await waitFor('分身 ready', 60_000, 1000, async () => {
  const r = await api('GET', `/persona-avatars/${av.data.avatarId}`)
  if (r.data?.status === 'running') await api('POST', `/persona-avatars/${av.data.avatarId}/refresh`)
  return r.data?.status === 'ready' ? r.data : null
})
await api('POST', `/persona-avatars/${av.data.avatarId}/set-default`)

const wavP = path.join(TMP, 's.wav')
await pexec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', wavP])
const sample = await upload(`/personas/${personaId}/voice-samples`, {}, { buf: fs.readFileSync(wavP), filename: 's.wav', type: 'audio/wav' })
const consent2 = await api('POST', `/personas/${personaId}/consents`, { authorizationId: auth.data.id, purpose: 'VOICE_CLONE', sourceKind: 'voice_sample', sourceId: sample.data.sampleId, consentTextVersion })
const vo = await api('POST', `/personas/${personaId}/voices`, { name: uniq('声音'), sampleId: sample.data.sampleId, consentId: consent2.data.consentId }, { 'Idempotency-Key': `pub-vo-${Date.now()}` })
await waitFor('声音 ready', 60_000, 1000, async () => {
  const r = await api('GET', `/persona-voices/${vo.data.voiceId}`)
  if (r.data?.status === 'running') await api('POST', `/persona-voices/${vo.data.voiceId}/refresh`)
  return r.data?.status === 'ready' ? r.data : null
})
await api('POST', `/persona-voices/${vo.data.voiceId}/confirm`)
await api('POST', `/persona-voices/${vo.data.voiceId}/set-default`)

const cr = await api('POST', '/copy', { source: 'manual', title: '定投的正确姿势', personaIds: [personaId], sourceText: '大家好。很多人问我定投怎么止盈。先说规则！市场越跌越要坚持定投，越涨越要分批止盈。' })
const copyId = cr.data.copyIds[0]
const draft = await api('POST', `/copy/${copyId}/drafts`)
const saved = await api('PUT', `/copy/${copyId}/drafts/${draft.data.id}`, { title: '定投的正确姿势', sections: [{ label: '正文', text: '大家好。很多人问我定投怎么止盈。先说规则！\n市场越跌越要坚持定投，越涨越要分批止盈。' }], rev: draft.data.rev })
check('保存稿', saved.status === 200, saved.raw)
const submitted = await api('POST', `/copy/${copyId}/submit`, { draftId: draft.data.id, rev: saved.data.rev })
check('提交审核', submitted.status === 200, submitted.raw)
const decided = await waitFor('审核桩到人工关', 30_000, 800, async () => {
  const d = await api('GET', `/copy/${copyId}`)
  const sid = d.data?.reviewSubmissionId ?? d.data?.copy?.reviewSubmissionId
  const gate = d.data?.reviewGate ?? d.data?.copy?.reviewGate
  return gate === 'pending_manual' ? sid : null
})
const { authHeader: ah } = await import('./lib/smoke-auth.js')
await fetch(`${BASE}/review/submissions/${decided}/manual-decision`, {
  method: 'POST',
  headers: { ...ah('POST', '/', 'reviewer'), 'Content-Type': 'application/json' },
  body: JSON.stringify({ result: 'approved' }),
})
await waitFor('文案过审', 15_000, 500, async () => ((await api('GET', `/copy/${copyId}/approved`)).status === 200 || null))

const vjob = await api('POST', '/video/jobs', { copyId, mode: 'avatar' }, { 'Idempotency-Key': `pub-vjob-${Date.now()}` })
check('创建视频任务', vjob.status === 200, vjob.raw)
const jobId = vjob.data?.jobId
const { runVideoSweep } = await import('../src/modules/video/worker.js')
const done = await waitFor('视频任务完成', 180_000, 1000, async () => {
  await runVideoSweep().catch(() => undefined)
  const r = await api('GET', `/video/jobs/${jobId}`)
  return ['completed', 'failed', 'save_failed'].includes(r.data?.phase) ? r.data : null
})
check('前置：视频任务 completed', done?.phase === 'completed', { phase: done?.phase, errorCode: done?.errorCode })
if (!jobId || done?.phase !== 'completed') {
  console.log('\n前置失败，终止（发布链路依赖已过审文案与已完成的基础视频）')
  await env.shutdown()
  process.exitCode = 1
  process.exit(1)
}

/* ── 2. 账号域（FR-A / FR-L）── */
console.log('\n[2] 平台账号与登录')
const mx = await api('GET', '/publish/platform-matrix')
check('矩阵：KOS 线抖音 allowed', mx.data?.matrix?.kos?.douyin?.allowed === true, mx.data?.matrix)
check('矩阵：经理线抖音不允许', mx.data?.matrix?.manager?.douyin?.allowed === false)

const forbid = await api('POST', '/platform-accounts', { platform: 'douyin', line: 'manager', displayName: '越权账号' })
check('越权建号 409 PLATFORM_LINE_FORBIDDEN', forbid.status === 409 && forbid.code === 'PLATFORM_LINE_FORBIDDEN', forbid.raw)

const reviewerCreate = await api('POST', '/platform-accounts', { platform: 'douyin', line: 'kos', displayName: '审核建号' }, {}, 'reviewer')
check('审核角色建号 403', reviewerCreate.status === 403, reviewerCreate.raw)

const acct = await api('POST', '/platform-accounts', { platform: 'douyin', line: 'kos', displayName: 'KOS主账号' })
check('建号 → pending_login + 自动登录会话', acct.status === 200 && acct.data?.account?.loginStatus === 'pending_login' && !!acct.data?.login?.session, acct.raw)
const accountId = acct.data.account.id
check('二维码 data URL（mock 无 OSS）', typeof acct.data.login?.qrDataUrl === 'string' && acct.data.login.qrDataUrl.startsWith('data:image/png'), acct.data.login?.qrDataUrl?.slice(0, 40))

const { sweepDueSessions, pollLoginSession } = await import('../src/modules/publish/login.js')
const confirmed = await waitFor('登录确认（sweep + mock 轮询）', 60_000, 500, async () => {
  const due = await sweepDueSessions()
  for (const sid of due) await pollLoginSession(sid)
  const r = await api('GET', `/platform-accounts/${accountId}`)
  return r.data?.loginStatus === 'active' ? r.data : null
})
check('账号 active + uid 回填', confirmed?.loginStatus === 'active' && typeof confirmed?.uid === 'string', confirmed)

const chk = await api('POST', `/platform-accounts/${accountId}/check-login`)
check('check-login → loggedIn', chk.status === 200 && chk.data?.loggedIn === true, chk.raw)

/* ── 3. 计划与复审（FR-C / FR-R）── */
console.log('\n[3] 发布计划与复审')
const engine = await import('../src/modules/publish/engine.js')

const badCopy = await api('POST', '/publish-plans', { copyId: 'copy_not_exists', videoJobId: jobId, items: [{ platform: 'douyin', accountId }] })
check('不存在/未过审文案被拒（404 / 409）', [404, 409].includes(badCopy.status), badCopy.raw)

// 改标题 → 实质修改 → needs_review
const planChanged = await api('POST', '/publish-plans', {
  copyId, videoJobId: jobId,
  items: [{ platform: 'douyin', accountId, title: '定投的正确姿势（修改版）' }],
  scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
})
check('改标题创建 → needs_review', planChanged.status === 200 && planChanged.data?.plan?.reviewState === 'needs_review', planChanged.raw)
const planChangedId = planChanged.data?.plan?.id
const schedBlocked = await api('POST', `/publish-plans/${planChangedId}/schedule`, { scheduledAt: new Date(Date.now() + 3600_000).toISOString() })
check('needs_review 排期 409 REVIEW_REQUIRED', schedBlocked.status === 409 && schedBlocked.code === 'REVIEW_REQUIRED', schedBlocked.raw)
const opsConfirm = await api('POST', `/publish-plans/${planChangedId}/review-confirm`)
check('运营确认复审 403', opsConfirm.status === 403, opsConfirm.raw)
const revConfirm = await api('POST', `/publish-plans/${planChangedId}/review-confirm`, undefined, {}, 'reviewer')
check('审核确认复审 → confirmed', revConfirm.status === 200 && revConfirm.data?.reviewState === 'confirmed', revConfirm.raw)

// 过期时间校验
const pastSched = await api('POST', `/publish-plans/${planChangedId}/schedule`, { scheduledAt: new Date(Date.now() - 60_000).toISOString() })
check('过去时间排期 400', pastSched.status === 400, pastSched.raw)

// 正常排期 + execute-now → mock published
const plan = await api('POST', '/publish-plans', {
  copyId, videoJobId: jobId,
  items: [{ platform: 'douyin', accountId, title: '定投的正确姿势', tags: ['定投', '基金'] }],
})
check('创建计划（首帧不变 → none）', plan.status === 200 && plan.data?.plan?.reviewState === 'none' && plan.data?.plan?.status === 'draft', plan.raw)
const planId = plan.data?.plan?.id
const execNow = await api('POST', `/publish-plans/${planId}/execute-now`)
check('execute-now', execNow.status === 200 && execNow.data?.status === 'scheduled', execNow.raw)

const published = await waitFor('发布成功（mock 引擎）', 30_000, 800, async () => {
  const r = await api('GET', `/publish-logs?planId=${planId}`)
  const log = (r.data?.items ?? [])[0]
  return log?.status === 'published' ? log : null
})
check('记录 published + video_url', published?.status === 'published' && typeof published?.videoUrl === 'string', published)
const planAfter = await api('GET', `/publish-plans/${planId}`)
check('计划收敛 completed', planAfter.data?.status === 'completed', planAfter.raw)

/* ── 4. 三态与人工窗口（FR-E / FR-S）── */
console.log('\n[4] 三态、人工窗口与重试')
engine.injectPublish('publish.execute', { behavior: 'verification' })
const planV = await api('POST', '/publish-plans', { copyId, videoJobId: jobId, items: [{ platform: 'douyin', accountId }] })
await api('POST', `/publish-plans/${planV.data?.plan?.id}/execute-now`)
const verifying = await waitFor('verification_required', 30_000, 800, async () => {
  const r = await api('GET', `/publish-logs?planId=${planV.data?.plan?.id}`)
  const log = (r.data?.items ?? [])[0]
  return log?.status === 'verification_required' ? log : null
})
check('注入验证码 → verification_required + 窗口', verifying?.status === 'verification_required' && !!verifying?.windowExpiresAt, verifying)
const rechecked = await api('POST', `/publish-logs/${verifying?.id}/recheck`)
check('重新检测（mock 注入已消费 → published）', rechecked.status === 200 && rechecked.data?.status === 'published', rechecked.raw)

engine.injectPublish('publish.execute', { behavior: 'failed' })
const planF = await api('POST', '/publish-plans', { copyId, videoJobId: jobId, items: [{ platform: 'douyin', accountId }] })
await api('POST', `/publish-plans/${planF.data?.plan?.id}/execute-now`)
const failedLog = await waitFor('failed + retry_at', 30_000, 800, async () => {
  const r = await api('GET', `/publish-logs?planId=${planF.data?.plan?.id}`)
  const log = (r.data?.items ?? [])[0]
  return log?.status === 'failed' ? log : null
})
check('失败 attempt=1 + retry_at（自动重试一次）', failedLog?.status === 'failed' && !!failedLog?.retryAt && failedLog?.attempt === 1, failedLog)
// 手动触发 sweep 到期重试（不必等 5 分钟）
const { sweepPublishLogs } = await import('../src/modules/publish/sweep.js')
const { getDb } = await import('../src/db/index.js')
getDb().run("UPDATE `publish_log` SET `retry_at` = ? WHERE `id` = ?", [new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' '), failedLog.id])
await sweepPublishLogs()
const retried = await waitFor('自动重试 → published', 30_000, 800, async () => {
  const r = await api('GET', `/publish-logs/${failedLog.id}`)
  return r.data?.status === 'published' ? r.data : null
})
check('sweep 到期重试 → published（attempt=2）', retried?.status === 'published' && retried?.attempt === 2, retried)

// verification 窗口超时 → manual_pending → 人工标记
engine.injectPublish('publish.execute', { behavior: 'verification' })
const planW = await api('POST', '/publish-plans', { copyId, videoJobId: jobId, items: [{ platform: 'douyin', accountId }] })
await api('POST', `/publish-plans/${planW.data?.plan?.id}/execute-now`)
const windowLog = await waitFor('verification（窗口）', 30_000, 800, async () => {
  const r = await api('GET', `/publish-logs?planId=${planW.data?.plan?.id}`)
  const log = (r.data?.items ?? [])[0]
  return log?.status === 'verification_required' ? log : null
})
getDb().run("UPDATE `publish_log` SET `window_expires_at` = ? WHERE `id` = ?", [new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' '), windowLog.id])
await sweepPublishLogs()
const manualPending = await api('GET', `/publish-logs/${windowLog.id}`)
check('窗口超时 → manual_pending（sweep 兜底）', manualPending.data?.status === 'manual_pending', manualPending.raw)
const badMark = await api('POST', `/publish-logs/${windowLog.id}/manual-result`, { published: false })
check('标记失败缺原因 400', badMark.status === 400, badMark.raw)
const marked = await api('POST', `/publish-logs/${windowLog.id}/manual-result`, { published: true, videoUrl: 'https://manual.example/v/1' })
check('人工标记已发布', marked.status === 200, marked.raw)

/* ── 5. 取消 / 补录 / 每日上限 ── */
console.log('\n[5] 取消、补录与频率控制')
const planC = await api('POST', '/publish-plans', { copyId, videoJobId: jobId, items: [{ platform: 'douyin', accountId }] })
const cancelled = await api('POST', `/publish-plans/${planC.data?.plan?.id}/cancel`)
check('draft 计划取消 → cancelled', cancelled.status === 200 && cancelled.data?.status === 'cancelled', cancelled.raw)

const manual = await api('POST', '/publish-logs', { platform: 'douyin', accountId, title: '手工发布的视频', videoUrl: 'https://www.douyin.com/video/manual1' })
check('补录 source=manual + published', manual.status === 200 && manual.data?.source === 'manual' && manual.data?.status === 'published', manual.raw)

// 每日上限（=6）用独立账号验证，避免污染主账号额度
const acct2 = await api('POST', '/platform-accounts', { platform: 'douyin', line: 'kos', displayName: '频率测试号' })
const accountId2 = acct2.data?.account?.id
await waitFor('账号2 登录确认', 60_000, 500, async () => {
  const due = await sweepDueSessions()
  for (const sid of due) await pollLoginSession(sid)
  const r = await api('GET', `/platform-accounts/${accountId2}`)
  return r.data?.loginStatus === 'active' ? r.data : null
})
let rateLimited: any = null
for (let i = 0; i < 7 && !rateLimited; i++) {
  const p = await api('POST', '/publish-plans', { copyId, videoJobId: jobId, items: [{ platform: 'douyin', accountId: accountId2 }] })
  if (p.status === 409) {
    rateLimited = p
    break
  }
  await api('POST', `/publish-plans/${p.data?.plan?.id}/execute-now`)
  await waitFor(`第 ${i + 1} 单发布完成`, 30_000, 800, async () => {
    const r = await api('GET', `/publish-logs?planId=${p.data?.plan?.id}`)
    const log = (r.data?.items ?? [])[0]
    return ['published', 'failed', 'failed_final'].includes(log?.status) ? log : null
  })
}
check('每日上限 → PUBLISH_RATE_LIMITED', rateLimited?.status === 409 && rateLimited?.code === 'PUBLISH_RATE_LIMITED', rateLimited?.raw)

// 删除守卫：被绑定/进行中引用 409；Q10 删除仅 admin
const delAsOps = await api('DELETE', `/platform-accounts/${accountId2}`, undefined, {}, 'ops')
check('ops 删除账号 403（Q10：删除仅管理员）', delAsOps.status === 403, delAsOps.raw)
const delAsAdmin = await api('DELETE', `/platform-accounts/${accountId2}`, undefined, {}, 'admin')
check('admin 删除账号（记录均终态 → 软删成功）', delAsAdmin.status === 200, delAsAdmin.raw)
const delGone = await api('GET', `/platform-accounts/${accountId2}`)
check('删除后不可见', delGone.status === 404, delGone.raw)

console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===\n`)
await env.shutdown()
if (failed > 0) process.exitCode = 1
