/**
 * 视频剪辑模块 smoke（任务书 CE9 / AC-C、AC-S、AC-R、AC-K、AC-J、AC-V、AC-X、AC-B；隔离环境 mock 渲染引擎全链路）：
 *
 * 前置（复用视频创作链路）：满配 KOS 人物（mock 克隆）→ 文案过审（审核桩）→ 视频任务 completed。
 * 覆盖：配置校验（risk 锁定 / 超长 / 样式白名单）→ 渲染版本（幂等 / BUSY）→ mock 渲染完成
 * （is_mock=1，剪气口照跑）→ 成片复审（三关桩 / 幂等 / 角色限制 / 裁决冻结 hash）→
 * FR-V3 实质修改重置 → 重新渲染复审 → final 契约 → 发布消费切换（缺省与显式 videoJobId）→
 * BGM 上传 / 引用 / 删除守卫 → 取消。
 * 用法：npm run smoke:cut
 */
import { bootIsolated } from './lib/isolated-env.js'
import { authHeader, initSmokeAuth, type SmokeRole } from './lib/smoke-auth.js'

const env = await bootIsolated({ env: { LOG_LEVEL: 'warn', CUT_SWEEP_INTERVAL_MS: '2000' } })
const BASE = env.base
await initSmokeAuth(BASE)

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

async function upload(p: string, fields: Record<string, string>, file: { buf: Buffer; filename: string; type: string }, asRole?: SmokeRole): Promise<any> {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([file.buf], { type: file.type }), file.filename)
  try {
    const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: authHeader('POST', p, asRole), body: fd })
    const raw: any = await res.json().catch(() => ({}))
    return { status: res.status, data: raw?.data, raw }
  } catch (e) {
    // 403 等拒绝会在 body 写入中断连（EPIPE），视为拒绝
    return { status: 403, data: null, raw: { ok: false, error: { code: 'forbidden', message: String((e as Error).cause ?? e) } } }
  }
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-e2e-'))

const pdf = (): Buffer => Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1')
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
let nameSeq = 0
const uniq = (base: string): string => `${base}${String(++nameSeq).padStart(3, '0')}`

console.log('\n=== 视频剪辑 mock 全链路 ===\n')

/* ── 1. 前置：满配 KOS 人物 → 文案过审 → 视频任务 completed ── */
console.log('[1] 前置链路（人物 → 文案过审 → 基础视频）')
const pr = await api('POST', '/personas', { name: uniq('剪辑人物'), line: 'kos' })
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
const av = await api('POST', `/personas/${personaId}/avatars`, { name: uniq('分身'), sourceAssetId: srcUp.data.assetId, consentId: consent1.data.consentId }, { 'Idempotency-Key': `cut-av-${Date.now()}` })
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
const vo = await api('POST', `/personas/${personaId}/voices`, { name: uniq('声音'), sampleId: sample.data.sampleId, consentId: consent2.data.consentId }, { 'Idempotency-Key': `cut-vo-${Date.now()}` })
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
await api('POST', `/copy/${copyId}/submit`, { draftId: draft.data.id, rev: saved.data.rev })
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

const vjob = await api('POST', '/video/jobs', { copyId, mode: 'avatar' }, { 'Idempotency-Key': `cut-vjob-${Date.now()}` })
check('创建视频任务', vjob.status === 200, vjob.raw)
const jobId = vjob.data?.jobId
const { runVideoSweep } = await import('../src/modules/video/worker.js')
const done = await waitFor('视频任务完成', 180_000, 1000, async () => {
  await runVideoSweep().catch(() => undefined)
  const r = await api('GET', `/video/jobs/${jobId}`)
  return ['completed', 'failed', 'save_failed'].includes(r.data?.phase) ? r.data : null
})
check('前置：视频任务 completed', done?.phase === 'completed', { phase: done?.phase })
if (!jobId || done?.phase !== 'completed') {
  console.log('\n前置失败，终止（剪辑链路依赖已过审文案与已完成的基础视频）')
  await env.shutdown()
  process.exit(1)
}

/* ── 2. 配置与草稿（FR-C / FR-S1 / FR-S2）── */
console.log('\n[2] 配置与草稿')
const cfg1 = await api('GET', `/video/jobs/${jobId}/cut-config`)
check('取配置：默认草稿生成', cfg1.status === 200 && cfg1.data?.draft?.versionNo === 0, cfg1.raw)
check('取配置：base 时间轴与 riskText', Array.isArray(cfg1.data?.base?.timeline) && cfg1.data.base.timeline.length > 0 && typeof cfg1.data.base.riskText === 'string', { tl: cfg1.data?.base?.timeline?.length, risk: cfg1.data?.base?.riskText })
check('取配置：引擎能力返回（无 libass 环境 → mock）', cfg1.data?.engine === 'mock', { engine: cfg1.data?.engine })
const baseTimeline = cfg1.data.base.timeline
const riskSeg = baseTimeline.find((t: any) => t.kind === 'risk')
const normalSeg = baseTimeline.find((t: any) => t.kind === 'normal')

const riskEdit = await api('PUT', `/video/jobs/${jobId}/cut-config`, {
  segments: [{ index: riskSeg.index, text: '篡改风险话术' }],
})
check('risk 段编辑被拒 400 CUT_RISK_LOCKED', riskEdit.status === 400 && riskEdit.code === 'CUT_RISK_LOCKED', riskEdit.raw)

const longText = '超'.repeat(201)
const tooLong = await api('PUT', `/video/jobs/${jobId}/cut-config`, { segments: [{ index: normalSeg.index, text: longText }] })
check('单段超长 400 CUT_TEXT_TOO_LONG', tooLong.status === 400 && tooLong.code === 'CUT_TEXT_TOO_LONG', tooLong.raw)

const badStyle = await api('PUT', `/video/jobs/${jobId}/cut-config`, { subtitleStyle: { fontSize: 500 } })
check('样式越界 400 CUT_STYLE_INVALID', badStyle.status === 400 && badStyle.code === 'CUT_STYLE_INVALID', badStyle.raw)

const save1 = await api('PUT', `/video/jobs/${jobId}/cut-config`, {
  segments: [{ index: normalSeg.index, text: '改过的字幕文本' }],
  breatheEnabled: true,
})
check('保存草稿成功（含 normal 编辑 + 开剪气口）', save1.status === 200 && save1.data?.segments.some((s: any) => s.edited), save1.raw)

/* ── 3. 渲染版本（FR-C4 / AC-C4 / FR-J1）── */
console.log('\n[3] 渲染版本与 mock 渲染')
const v1 = await api('POST', `/video/jobs/${jobId}/cut-versions`, {}, { 'Idempotency-Key': `cut-v1-${Date.now()}` })
check('创建渲染版本 v1', v1.status === 200 && v1.data?.cut?.versionNo === 1, v1.raw)
const v1again = await api('POST', `/video/jobs/${jobId}/cut-versions`, {}, { 'Idempotency-Key': `cut-v1-${Date.now()}` })
check('30 秒内重放幂等', v1again.status === 200 && v1again.data?.idempotent === true, v1again.raw)

const { runCutSweep } = await import('../src/modules/cut/worker.js')
const r1 = await waitFor('v1 渲染完成', 240_000, 1500, async () => {
  await runCutSweep().catch(() => undefined)
  const r = await api('GET', `/video/cuts/${v1.data.cut.id}`)
  return ['completed', 'failed'].includes(r.data?.cut?.status) ? r.data.cut : null
})
check('v1 渲染 completed 且 is_mock=1', r1?.status === 'completed' && r1?.isMock === true, { status: r1?.status, err: r1?.errorMessage, mock: r1?.isMock })
check('v1 时间轴与重映射后句数一致', Array.isArray(r1?.timeline) && r1.timeline.length === baseTimeline.length, { tl: r1?.timeline?.length })
check('v1 content_hash 已计算', typeof r1?.contentHash === 'string' && r1.contentHash.length === 64)

/* ── 4. 成片复审（FR-V1 / FR-V2 / AC-V1~V2）── */
console.log('\n[4] 成片复审')
const rev1 = await api('POST', `/video/cuts/${v1.data.cut.id}/review`)
check('提交复审 → 三关桩同步至 pending_manual', rev1.status === 200 && rev1.data?.submission?.status === 'pending_manual' && rev1.data.submission.gates?.length === 3, rev1.raw)
const rev1again = await api('POST', `/video/cuts/${v1.data.cut.id}/review`)
check('进行中重复提交幂等', rev1again.status === 200 && rev1again.data?.idempotent === true, rev1again.raw)

const queue = await api('GET', '/cut-review/queue', undefined, undefined, 'reviewer')
check('复审队列含该成片', queue.status === 200 && (queue.data?.items ?? []).some((i: any) => i.cut.id === v1.data.cut.id), queue.raw)

const opsDecide = await api('POST', `/video/cuts/${v1.data.cut.id}/review/decision`, { result: 'approved' }, {}, 'ops')
check('ops 裁决被 403', opsDecide.status === 403, opsDecide.raw)

const okDecide = await api('POST', `/video/cuts/${v1.data.cut.id}/review/decision`, { result: 'approved' }, {}, 'reviewer')
check('reviewer 通过裁决', okDecide.status === 200 && okDecide.data?.status === 'approved', okDecide.raw)
const afterApprove = await api('GET', `/video/cuts/${v1.data.cut.id}`)
check('过审冻结 approved_content_hash', afterApprove.data?.cut?.reviewStatus === 'approved' && afterApprove.data.cut.approvedContentHash === afterApprove.data.cut.contentHash, afterApprove.data?.cut)

const final1 = await api('GET', `/video/cuts/${v1.data.cut.id}/final`)
check('final 契约放行且字段完整', final1.status === 200 && final1.data?.videoJobId === jobId && final1.data?.versionNo === 1 && final1.data?.reviewStatus === 'approved', final1.raw)

/* ── 5. FR-V3 实质修改重置 + 重新渲染复审（AC-V3 / AC-X1）── */
console.log('\n[5] 实质修改重置与重新渲染')
const edit2 = await api('PUT', `/video/jobs/${jobId}/cut-config`, { segments: [{ index: normalSeg.index, text: '二改字幕' }] })
check('过审后改草稿成功', edit2.status === 200, edit2.raw)
const afterDrift = await api('GET', `/video/cuts/${v1.data.cut.id}`)
check('FR-V3：hash 漂移 → review_status 重置 none', afterDrift.data?.cut?.reviewStatus === 'none' && afterDrift.data.cut.approvedContentHash, afterDrift.data?.cut)
const finalDrift = await api('GET', `/video/cuts/${v1.data.cut.id}/final`)
check('final 拦截：已实质修改 409 FINAL_NOT_READY', finalDrift.status === 409 && finalDrift.code === 'FINAL_NOT_READY', finalDrift.raw)

const v2 = await api('POST', `/video/jobs/${jobId}/cut-versions`)
check('创建渲染版本 v2', v2.status === 200 && v2.data?.cut?.versionNo === 2, v2.raw)
const r2 = await waitFor('v2 渲染完成', 240_000, 1500, async () => {
  await runCutSweep().catch(() => undefined)
  const r = await api('GET', `/video/cuts/${v2.data.cut.id}`)
  return ['completed', 'failed'].includes(r.data?.cut?.status) ? r.data.cut : null
})
check('v2 渲染 completed', r2?.status === 'completed', { status: r2?.status, err: r2?.errorMessage })
await api('POST', `/video/cuts/${v2.data.cut.id}/review`)
const ok2 = await api('POST', `/video/cuts/${v2.data.cut.id}/review/decision`, { result: 'approved' }, {}, 'reviewer')
check('v2 复审通过', ok2.status === 200, ok2.raw)

/* ── 6. 发布消费切换（FR-X2 / EC11）── */
console.log('\n[6] 发布消费切换')
const acct = await api('POST', '/platform-accounts', { platform: 'douyin', line: 'kos', displayName: uniq('剪辑发布号') })
check('创建发布账号（KOS→抖音）', acct.status === 200 && !!acct.data?.account?.id, acct.raw)
const { sweepDueSessions, pollLoginSession } = await import('../src/modules/publish/login.js')
await waitFor('账号自动登录（sweep + mock 轮询）', 60_000, 500, async () => {
  const due = await sweepDueSessions()
  for (const sid of due) await pollLoginSession(sid)
  const r = await api('GET', `/platform-accounts/${acct.data.account.id}`)
  return r.data?.loginStatus === 'active' ? r.data : null
})
const plan1 = await api('POST', '/publish-plans', { copyId, items: [{ platform: 'douyin', accountId: acct.data.account.id, title: '剪辑成片直发' }] })
check('缺省 videoJobId 创建计划 → 优先消费过审成片', plan1.status === 200 && plan1.data?.plan?.baseVideoVersionNo === 2, { status: plan1.status, ver: plan1.data?.plan?.baseVideoVersionNo, raw: plan1.raw })
const plan2 = await api('POST', '/publish-plans', { copyId, videoJobId: jobId, items: [{ platform: 'douyin', accountId: acct.data.account.id, title: '显式指定 job' }] })
check('显式 videoJobId → 该 job 过审成片优先', plan2.status === 200 && plan2.data?.plan?.baseVideoVersionNo === 2, { ver: plan2.data?.plan?.baseVideoVersionNo, raw: plan2.raw })

/* ── 7. BGM（FR-B1~B3）── */
console.log('\n[7] BGM 库')
const bgmP = path.join(TMP, 'bgm.wav')
await pexec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=30', '-ar', '48000', '-ac', '2', bgmP])
const bgmUp = await upload('/cut/bgm', {}, { buf: fs.readFileSync(bgmP), filename: 'bgm.wav', type: 'audio/wav' }, 'admin')
check('上传 BGM（admin）', bgmUp.status === 200 && typeof bgmUp.data?.item?.id === 'string', bgmUp.raw)
const bgmId = bgmUp.data?.item?.id
const bgmUpOps = await upload('/cut/bgm', {}, { buf: fs.readFileSync(bgmP), filename: 'bgm2.wav', type: 'audio/wav' }, 'ops')
check('ops 上传 BGM 被 403', bgmUpOps.status === 403, bgmUpOps.raw)
const bgmList = await api('GET', '/cut/bgm')
check('BGM 列表', bgmList.status === 200 && (bgmList.data?.items ?? []).some((b: any) => b.id === bgmId), bgmList.raw)
const bgmNoAuth = await fetch(`${BASE}/cut/bgm`, { method: 'POST', body: new FormData() })
check('未登录上传 401', bgmNoAuth.status === 401 || bgmNoAuth.status === 403, bgmNoAuth.status)

const save3 = await api('PUT', `/video/jobs/${jobId}/cut-config`, { bgmEnabled: true, bgmId, bgmVolume: 0.3 })
check('草稿启用 BGM', save3.status === 200 && save3.data?.bgmEnabled === true, save3.raw)
const v3 = await api('POST', `/video/jobs/${jobId}/cut-versions`)
const r3 = await waitFor('v3（含 BGM）渲染完成', 240_000, 1500, async () => {
  await runCutSweep().catch(() => undefined)
  const r = await api('GET', `/video/cuts/${v3.data.cut.id}`)
  return ['completed', 'failed'].includes(r.data?.cut?.status) ? r.data.cut : null
})
check('v3 含 BGM 渲染 completed', r3?.status === 'completed', { status: r3?.status, err: r3?.errorMessage })

const bgmDelOps = await api('DELETE', `/cut/bgm/${bgmId}`, undefined, {}, 'ops')
check('ops 删除 BGM 被 403', bgmDelOps.status === 403, bgmDelOps.raw)
const bgmDelUsed = await api('DELETE', `/cut/bgm/${bgmId}`, undefined, {}, 'admin')
check('被引用 BGM 删除 409 BGM_IN_USE', bgmDelUsed.status === 409 && bgmDelUsed.code === 'BGM_IN_USE', bgmDelUsed.raw)

/* ── 8. 取消（FR-C5 / AC-C5）── */
console.log('\n[8] 取消')
await api('PUT', `/video/jobs/${jobId}/cut-config`, { breatheEnabled: false })
const v4 = await api('POST', `/video/jobs/${jobId}/cut-versions`)
const cancel1 = await api('POST', `/video/cuts/${v4.data.cut.id}/cancel`)
check('取消请求受理（queued 即时 / rendering 转 cancelling）', cancel1.status === 200 && ['cancelled', 'cancelling'].includes(cancel1.data?.status), cancel1.raw)
const v4Final = await waitFor('取消收尾', 180_000, 1500, async () => {
  await runCutSweep().catch(() => undefined)
  const r = await api('GET', `/video/cuts/${v4.data.cut.id}`)
  return ['cancelled', 'completed', 'failed'].includes(r.data?.cut?.status) ? r.data.cut : null
})
check('取消有终态（cancelled / 取消未及 completed）', ['cancelled', 'completed'].includes(v4Final?.status ?? ''), v4Final?.status)
const v5 = await api('POST', `/video/jobs/${jobId}/cut-versions`)
const r5 = await waitFor('v5 进入渲染', 60_000, 800, async () => {
  const r = await api('GET', `/video/cuts/${v5.data.cut.id}`)
  return ['rendering', 'completed', 'cancelling', 'failed'].includes(r.data?.cut?.status) ? r.data.cut : null
})
if (r5?.status === 'rendering' || r5?.status === 'cancelling') {
  const cancel2 = await api('POST', `/video/cuts/${v5.data.cut.id}/cancel`)
  const r5b = await waitFor('渲染中取消收尾', 120_000, 1500, async () => {
    await runCutSweep().catch(() => undefined)
    const r = await api('GET', `/video/cuts/${v5.data.cut.id}`)
    return ['cancelled', 'completed', 'failed'].includes(r.data?.cut?.status) ? r.data.cut : null
  })
  check('渲染中取消有终态（cancelled 或取消未及 completed）', cancel2.status === 200 && ['cancelled', 'completed', 'failed'].includes(r5b?.status ?? ''), { cancel: cancel2.status, final: r5b?.status })
} else {
  check('渲染中取消有终态', ['completed', 'failed'].includes(r5?.status ?? ''), { fastFinish: r5?.status })
}

console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===\n`)
await env.shutdown()
process.exitCode = failed ? 1 : 0
process.exit(failed ? 1 : 0)
