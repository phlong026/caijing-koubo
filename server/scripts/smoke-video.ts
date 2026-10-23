/**
 * 视频创作模块 smoke（任务书 V9 / AC-J1~J5、AC-T2/T3、AC-X1；复用验收基建隔离启动）：
 *
 * 链路：隔离环境 → 满配 KOS 人物（mock 克隆）→ 文案过审（审核桩）→
 * 口播：precheck → 创建（幂等/互斥）→ sweep 推进 → mock 出片 → 归档规范化 → mock ASR 对齐 → completed（AC-J5/T2/X1）；
 * 混剪：素材包/关键词组 → 匹配预览（FR-M2）→ 创建 → tts → 对齐 → 合成 → completed（AC-M1~M3）。
 * 用法：npm run smoke:video
 */
import assert from 'node:assert/strict'
import { bootIsolated } from './lib/isolated-env.js'
import { authHeader, initSmokeAuth } from './lib/smoke-auth.js'

const env = await bootIsolated({ env: { LOG_LEVEL: 'warn' } })
const BASE = env.base
await initSmokeAuth(BASE)

const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')
const pexec = promisify(execFile)
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'video-e2e-'))

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

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T; raw: any; code?: string }> {
  const h: Record<string, string> = { ...authHeader(method, p), ...headers }
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

async function ffmpeg(args: string[]): Promise<void> {
  await pexec('ffmpeg', ['-y', '-v', 'error', ...args])
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

const pdf = (): Buffer => Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1')
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
let nameSeq = 0
const uniq = (base: string): string => `${base}${String(++nameSeq).padStart(3, '0')}`

console.log('\n=== 视频创作 mock 全链路 ===\n')

/* ── 1. 满配 KOS 人物 ─────────────────────────────────────────── */
const pr = await api('POST', '/personas', { name: uniq('视频人物'), line: 'kos' })
check('创建人物', pr.status === 200, pr.raw)
const personaId = pr.data.id

const auth = await upload(`/personas/${personaId}/authorizations`, {
  grantorName: '授权人', scopes: 'portrait,voice,share', effectiveFrom: day(-1), expiresAt: day(365),
}, { buf: pdf(), filename: 'auth.pdf', type: 'application/pdf' })
check('上传授权', auth.status === 200, auth.raw)
const vr0 = await api('POST', `/persona-authorizations/${auth.data.id}/verify`, { decision: 'verified' })
check('核验授权', vr0.status === 200, vr0.raw)

const srcVideo = path.join(TMP, 'src.mp4')
await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-t', '12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', srcVideo])
const srcUp = await upload(`/personas/${personaId}/assets`, { kind: 'avatar_source', backgroundLabel: '白色简洁' }, { buf: fs.readFileSync(srcVideo), filename: 'src.mp4', type: 'video/mp4' })
check('上传分身素材', srcUp.status === 200, srcUp.raw)
await waitFor('素材处理', 30_000, 500, async () => ((await api('GET', `/personas/${personaId}/assets`)).data ?? []).some((a: any) => a.id === srcUp.data.assetId && a.status === 'pending_review') || undefined)
const rv = await api('POST', `/persona-assets/${srcUp.data.assetId}/review`, { decision: 'approved' })
check('审核分身素材', rv.status === 200, rv.raw)

const consentVersionR = await api('GET', '/personas/options')
const consentTextVersion = consentVersionR.data.consentTextVersion
const consent1 = await api('POST', `/personas/${personaId}/consents`, { authorizationId: auth.data.id, purpose: 'AVATAR_CLONE', sourceKind: 'avatar_source', sourceId: srcUp.data.assetId, consentTextVersion })
check('创建肖像 consent', consent1.status === 200, consent1.raw)
const av = await api('POST', `/personas/${personaId}/avatars`, { name: uniq('分身'), sourceAssetId: srcUp.data.assetId, consentId: consent1.data.consentId }, { 'Idempotency-Key': `e2e-av-${Date.now()}` })
check('创建分身', av.status === 200, av.raw)
const avatarReady = await waitFor('分身 ready', 60_000, 1000, async () => {
  const r = await api('GET', `/persona-avatars/${av.data.avatarId}`)
  if (r.data?.status === 'running') await api('POST', `/persona-avatars/${av.data.avatarId}/refresh`)
  return r.data?.status === 'ready' ? r.data : null
})
check('分身就绪（mock 克隆）', avatarReady?.status === 'ready', avatarReady)
await api('POST', `/persona-avatars/${av.data.avatarId}/set-default`)

const wavBuf = await (async () => {
  const p = path.join(TMP, 'sample.wav')
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', p])
  return fs.readFileSync(p)
})()
const sample = await upload(`/personas/${personaId}/voice-samples`, {}, { buf: wavBuf, filename: 's.wav', type: 'audio/wav' })
check('上传声音样本', sample.status === 200, sample.raw)
const consent2 = await api('POST', `/personas/${personaId}/consents`, { authorizationId: auth.data.id, purpose: 'VOICE_CLONE', sourceKind: 'voice_sample', sourceId: sample.data.sampleId, consentTextVersion })
const vo = await api('POST', `/personas/${personaId}/voices`, { name: uniq('声音'), sampleId: sample.data.sampleId, consentId: consent2.data.consentId }, { 'Idempotency-Key': `e2e-vo-${Date.now()}` })
check('创建声音', vo.status === 200, vo.raw)
const voiceReady = await waitFor('声音 ready', 60_000, 1000, async () => {
  const r = await api('GET', `/persona-voices/${vo.data.voiceId}`)
  if (r.data?.status === 'running') await api('POST', `/persona-voices/${vo.data.voiceId}/refresh`)
  return r.data?.status === 'ready' ? r.data : null
})
check('声音就绪', voiceReady?.status === 'ready', voiceReady)
const cf = await api('POST', `/persona-voices/${vo.data.voiceId}/confirm`)
check('确认声音', cf.status === 200, cf.raw)
const sd = await api('POST', `/persona-voices/${vo.data.voiceId}/set-default`)
check('设默认声音', sd.status === 200, sd.raw)

/* ── 2. 文案过审（审核桩自动三关）────────────────────────────── */
const cr = await api('POST', '/copy', { source: 'manual', title: '费率对收益的影响', personaIds: [personaId], sourceText: '大家好，今天聊一个很多人忽略的问题。费用到底有多重要？先看规则！长期来看，费率每高一个百分点，收益差距会越拉越大。' })
check('创建文案', cr.status === 200 && cr.data?.copyIds?.length === 1, cr.raw)
const copyId = cr.data.copyIds[0]
const draft = await api('POST', `/copy/${copyId}/drafts`)
check('新建稿', draft.status === 200 && !!draft.data?.id, draft.raw)
const draftId = draft.data.id
const saved = await api('PUT', `/copy/${copyId}/drafts/${draftId}`, { title: '费率对收益的影响', sections: [{ label: '正文', text: '大家好，今天聊一个很多人忽略的问题。费用到底有多重要？先看规则！\n长期来看，费率每高一个百分点，收益差距会越拉越大。' }], rev: draft.data.rev })
check('保存稿', saved.status === 200, saved.raw)
const submit = await api('POST', `/copy/${copyId}/submit`, { draftId, rev: saved.data.rev })
check('提交审核', submit.status === 200, submit.raw)
// 审核桩推进三关后停在人工裁决关，须审核员（或管理员）manual-decision 通过
const decided = await waitFor('审核桩到人工关', 30_000, 800, async () => {
  const d = await api('GET', `/copy/${copyId}`)
  const sid = d.data?.reviewSubmissionId ?? d.data?.copy?.reviewSubmissionId
  if (!sid) return null
  const gate = d.data?.reviewGate ?? d.data?.copy?.reviewGate
  return gate === 'pending_manual' ? sid : null
})
check('审核单到人工关', !!decided, decided)
const { authHeader: ah } = await import('./lib/smoke-auth.js')
const decide = await fetch(`${BASE}/review/submissions/${decided}/manual-decision`, {
  method: 'POST',
  headers: { ...ah('POST', '/', 'reviewer'), 'Content-Type': 'application/json' },
  body: JSON.stringify({ result: 'approved' }),
})
const decideRaw: any = await decide.json().catch(() => ({}))
check('人工通过', decide.status === 200, decideRaw)
const approved = await waitFor('文案过审', 15_000, 500, async () => {
  const r = await api('GET', `/copy/${copyId}/approved`)
  return r.status === 200 ? r.data : null
})
check('文案过审（版本号）', !!approved?.versionNo, approved)

/* ── 3. 配置检查与创建任务 ───────────────────────────────────── */
const pc = await api('POST', '/video/precheck', { copyId, mode: 'avatar' })
check('precheck 硬项全过', pc.status === 200 && (pc.data?.checks ?? []).every((c: any) => c.level === 'soft' || c.pass), (pc.data?.checks ?? []).filter((c: any) => c.level === 'hard' && !c.pass))
check('precheck 人物项带 persona. 前缀', (pc.data?.checks ?? []).some((c: any) => String(c.key).startsWith('persona.')), pc.data?.checks)

const idemKey = `e2e-vjob-${Date.now()}`
const create1 = await api('POST', '/video/jobs', { copyId, mode: 'avatar' }, { 'Idempotency-Key': idemKey })
check('创建视频任务', create1.status === 200, create1.raw)
const create2 = await api('POST', '/video/jobs', { copyId, mode: 'avatar' }, { 'Idempotency-Key': idemKey })
check('幂等重放（replayed=true）', create2.status === 200 && create2.data?.replayed === true && create2.data?.jobId === create1.data?.jobId, create2.raw)
const create3 = await api('POST', '/video/jobs', { copyId, mode: 'avatar', display: 'pip' } as never, { 'Idempotency-Key': idemKey })
check('同键不同请求 → IDEMPOTENCY_CONFLICT', create3.status === 409 && create3.code === 'IDEMPOTENCY_CONFLICT', create3.raw)
const create4 = await api('POST', '/video/jobs', { copyId, mode: 'avatar' }, { 'Idempotency-Key': `e2e-vjob-2-${Date.now()}` })
check('非终态互斥 → VIDEO_JOB_ACTIVE', create4.status === 409 && create4.code === 'VIDEO_JOB_ACTIVE', create4.raw)

const jobId = create1.data?.jobId

/* ── 4. sweep 推进到完成 ─────────────────────────────────────── */
const { runVideoSweep } = await import('../src/modules/video/worker.js')
let lastPhase = ''
let lastMix = ''
const done = await waitFor('任务完成', 180_000, 1000, async () => {
  await runVideoSweep().catch((e) => console.log('sweep error:', (e as Error).message))
  const r = await api('GET', `/video/jobs/${jobId}`)
  const phase = r.data?.phase
  if (phase !== lastPhase) {
    console.log(`  … phase: ${lastPhase || '(init)'} → ${phase} (${r.data?.message ?? ''})`)
    lastPhase = phase
  }
  if (phase === 'completed' || phase === 'failed' || phase === 'save_failed' || phase === 'submission_unknown') return r.data
  return null
})
check('任务 completed', done?.phase === 'completed', { phase: done?.phase, errorCode: done?.errorCode, message: done?.message, detail: done?.errorDetail })
check('时间轴 aligned', done?.timelineSource === 'aligned', { source: done?.timelineSource, score: done?.alignScore })
check('时间轴非空且文本为原文', (done?.timeline ?? []).length > 0 && done.timeline.every((t: any) => typeof t.text === 'string' && t.text.length > 0), done?.timeline)
check('进度 100', done?.progress === 100)
check('下一步动作含 continue_edit', (done?.nextActions ?? []).includes('continue_edit'), done?.nextActions)

/* ── 5. FR-X1 base 契约 ─────────────────────────────────────── */
const base = await api('GET', `/video/jobs/${jobId}/base`)
check('base 返回', base.status === 200, base.raw)
check('base 字段齐全', !!(base.data?.url && base.data?.durationMs > 0 && base.data?.width === 1080 && base.data?.height === 1920 && Array.isArray(base.data?.timeline)), {
  url: base.data?.url?.slice(0, 60),
  durationMs: base.data?.durationMs,
  width: base.data?.width,
  height: base.data?.height,
})
check('base isMock 标记', base.data?.isMock === true)

/* ── 6. 素材混剪全链路（FR-M / AC-M1~M3）────────────────────── */
console.log('\n[6] 素材混剪')
const matDir = path.join(TMP, 'materials')
fs.mkdirSync(matDir, { recursive: true })
for (let i = 1; i <= 2; i++) {
  await ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=720x1280:rate=30`, '-t', '5', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', path.join(matDir, `mat${i}.mp4`)])
}
await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=1', '-t', '1', '-frames:v', '1', '-q:v', '3', path.join(matDir, 'mat3.jpg')])
const packImp = await api('POST', '/material-packs', { name: 'e2e 素材包', sourcePath: matDir })
check('导入素材包（2 视频 + 1 图片）', packImp.status === 200 && packImp.data?.itemCount === 3, packImp.raw)
const packId = packImp.data?.id
const packItems = await api('GET', `/material-packs/${packId}/items`)
check('素材条目探测（时长/图片识别）', (packItems.data ?? []).length === 3 && (packItems.data ?? []).filter((x: any) => x.isImage).length === 1, packItems.data)
const kg = await api('POST', '/material-keyword-groups', { name: 'e2e 关键词组', keywords: ['费用', '收益', '费率'], packIds: [packId], durationMinMs: 500, durationMaxMs: 2000 })
check('创建关键词组', kg.status === 200, kg.raw)

const preview = await api('POST', '/video/mixcut/preview', { copyId, keywordGroupIds: [kg.data.id] })
check('匹配预览（纯计算命中）', preview.status === 200 && (preview.data?.matches ?? []).length >= 2, preview.data?.matches)
check('预览不含风险段覆盖', (preview.data?.matches ?? []).every((m: any) => m.keyword !== '风险'), preview.data?.matches)

const mj = await api('POST', '/video/jobs', { copyId, mode: 'mixcut', mixcutPackIds: [packId], mixcutKeywordGroupIds: [kg.data.id] }, { 'Idempotency-Key': `e2e-mix-${Date.now()}` })
check('创建混剪任务', mj.status === 200, mj.raw)
const mixJobId = mj.data?.jobId
const mixDone = await waitFor('混剪完成', 240_000, 1000, async () => {
  await runVideoSweep().catch(() => undefined)
  const r = await api('GET', `/video/jobs/${mixJobId}`)
  const ph = r.data?.phase
  if (ph !== lastMix) {
    console.log(`  … mixcut phase: ${lastMix || '(init)'} → ${ph} (${r.data?.message ?? ''})`)
    lastMix = ph
  }
  if (['completed', 'failed', 'save_failed'].includes(ph)) return r.data
  return null
})
check('混剪 completed', mixDone?.phase === 'completed', { phase: mixDone?.phase, errorCode: mixDone?.errorCode, detail: mixDone?.errorDetail })
if (mixDone?.phase !== 'completed') {
  const ev = await api('GET', `/video/jobs/${mixJobId}`)
  console.log('  ⚠️ 事件流水:', JSON.stringify((ev.data?.events ?? []).map((e: any) => ({ to: e.toPhase, code: e.errorCode, detail: e.detail }))).slice(0, 1500))
}
check('replacements 落库', (mixDone?.replacements ?? []).length >= 2, mixDone?.replacements)
check('混剪规格 1080×1920', mixDone?.width === 1080 && mixDone?.height === 1920)
const mixBase = await api('GET', `/video/jobs/${mixJobId}/base`)
check('混剪 base 取用', mixBase.status === 200 && mixBase.data?.durationMs > 0, mixBase.raw)

/* ── 8. 异常态与容错（AC-J7/J8/J9/J10/J11）────────────────────── */
console.log('\n[8] 异常态与容错')
const { injectHifly, clearHiflyInjections, getMockHiflyClient } = await import('../src/integrations/hifly/mock.js')
const { getDb: getDbNow } = await import('../src/db/index.js')
const { reconcileVideoJobs, runVideoSweep: sweep } = await import('../src/modules/video/worker.js')
const svcDb = getDbNow()

/** 该任务的飞影视频创建调用次数（AC-J7：save_failed 恢复不得新增） */
async function vendorCreateCount(jobId: string): Promise<number> {
  const row = await svcDb.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM `api_call_log` WHERE `ref_type` = 'video_job' AND `endpoint` LIKE '%video/create_by_tts%' AND `ref_id` = ?",
    [jobId],
  )
  return Number(row?.n ?? 0)
}

async function newJob(tag: string): Promise<{ id: string; versionNo: number }> {
  const r = await api('POST', '/video/jobs', { copyId, mode: 'avatar' }, { 'Idempotency-Key': `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` })
  if (r.status !== 200) throw new Error(`创建任务失败：${JSON.stringify(r.raw).slice(0, 200)}`)
  return { id: r.data.jobId, versionNo: r.data.versionNo }
}

async function waitForPhase(desc: string, jobId: string, phases: string[], timeoutMs = 180_000, driveSweep = true): Promise<any> {
  return waitFor(desc, timeoutMs, 1000, async () => {
    if (driveSweep) await sweep().catch(() => undefined)
    const r = await api('GET', `/video/jobs/${jobId}`)
    return phases.includes(r.data?.phase) ? r.data : null
  })
}

// 8.1 保存失败只重下载（AC-J7 / 全局场景 3）
console.log('\n[8.1] save_failed → 重试下载')
injectHifly('download', { behavior: 'failed' })
const j7 = await newJob('j7')
const j7Failed = await waitForPhase('save_failed', j7.id, ['save_failed', 'failed'])
check('下载注入 → save_failed', j7Failed?.phase === 'save_failed', { phase: j7Failed?.phase, code: j7Failed?.errorCode })
check('保留远端任务号', !!j7Failed?.remoteTaskId)
const j7Count = await vendorCreateCount(j7.id)
clearHiflyInjections()
const j7Retry = await api('POST', `/video/jobs/${j7.id}/retry-download`)
check('重试下载受理', j7Retry.status === 200, j7Retry.raw)
const j7Done = await waitForPhase('save_failed 恢复', j7.id, ['completed', 'save_failed'])
check('重试下载后 completed', j7Done?.phase === 'completed', { phase: j7Done?.phase, detail: j7Done?.errorDetail })
check('未新增飞影创建调用', (await vendorCreateCount(j7.id)) === j7Count, { before: j7Count, after: await vendorCreateCount(j7.id) })
check('远端任务号不变', j7Done?.remoteTaskId === j7Failed?.remoteTaskId)

// 8.2 提交不确定态（AC-J9 / 全局场景 4）
console.log('\n[8.2] submission_unknown → 补录任务号恢复')
injectHifly('video.create', { behavior: 'uncertain' })
const j9 = await newJob('j9')
const j9Unknown = await waitForPhase('submission_unknown', j9.id, ['submission_unknown'])
check('提交注入 → submission_unknown', j9Unknown?.phase === 'submission_unknown' && j9Unknown?.errorCode === 'VIDEO_SUBMISSION_UNKNOWN', j9Unknown?.errorCode)
const j9NoConfirm = await api('POST', `/video/jobs/${j9.id}/confirm-resubmit`, {})
check('重提缺二次确认 → 400', j9NoConfirm.status === 400, j9NoConfirm.raw)
clearHiflyInjections()
// 用一个真实存在的 mock 任务号补录（提交"其实已被受理"的语义）
const realTask = await getMockHiflyClient().createVideoByTts({ title: 'bind-remote-e2e', avatarId: 'av_x', voiceId: 'vc_x', text: '补录用模拟任务' })
const j9Bind = await api('POST', `/video/jobs/${j9.id}/bind-remote`, { remoteTaskId: realTask.taskId })
check('补录任务号受理', j9Bind.status === 200, j9Bind.raw)
const j9Done = await waitForPhase('bind 后完成', j9.id, ['completed', 'failed', 'submission_unknown'])
check('补录后完成', j9Done?.phase === 'completed', { phase: j9Done?.phase, detail: j9Done?.errorDetail })

// 8.3 轮询超窗转人工（AC-J11，虚拟时钟：把 submitted_at 拨回 3 小时前）
console.log('\n[8.3] 轮询超窗 → 查询原任务')
const j11 = await newJob('j11')
const j11Gen = await waitForPhase('生成中', j11.id, ['generating', 'recovering'])
check('进入生成中', !!j11Gen, j11Gen?.phase)
await svcDb.run("UPDATE `video_job` SET `submitted_at` = datetime('now', '-3 hours') WHERE `id` = ?", [j11.id])
const j11Timeout = await waitForPhase('超窗转人工', j11.id, ['submission_unknown'])
check('超窗 → submission_unknown(VIDEO_POLL_TIMEOUT)', j11Timeout?.errorCode === 'VIDEO_POLL_TIMEOUT', j11Timeout?.errorCode)
check('超窗保留任务号', !!j11Timeout?.remoteTaskId && j11Timeout.remoteTaskId === j11Gen?.remoteTaskId)
const j11Query = await api('POST', `/video/jobs/${j11.id}/query-original`)
check('查询原任务受理', j11Query.status === 200, j11Query.raw)
const j11Done = await waitForPhase('查询后完成', j11.id, ['completed', 'failed', 'submission_unknown'])
check('查询原任务后完成', j11Done?.phase === 'completed', { phase: j11Done?.phase })

// 8.4 取消 / 停止等待 / 继续查询（AC-J10）
console.log('\n[8.4] 取消与停止等待')
// 周期 sweep（registerVideoModule 的 repeatable job）可能在「创建 → 取消」之间把 waiting
// 抢先推进到 submitting，run-smoke-all 高负载下尤甚；这里重试拿一个仍处于 waiting 的任务
// 再取消，保证断言确定性。不驱动 sweep：waiting → preparing 只发生在 sweep。
let j10aCancel: Awaited<ReturnType<typeof api>> | null = null
for (let i = 0; i < 6 && !j10aCancel; i++) {
  const cand = await newJob(`j10a-${i}`)
  const row = await api('GET', `/video/jobs/${cand.id}`)
  if (row.data?.phase !== 'waiting') continue
  const c = await api('POST', `/video/jobs/${cand.id}/cancel`)
  if (c.status === 200) j10aCancel = c
}
check('排队中取消 → cancelled', j10aCancel?.status === 200 && j10aCancel?.data?.phase === 'cancelled', j10aCancel?.raw)
const j10b = await newJob('j10b')
const j10bGen = await waitForPhase('生成中', j10b.id, ['generating', 'recovering'])
const j10bPause = await api('POST', `/video/jobs/${j10b.id}/cancel`)
check('生成中停止等待 → paused', j10bPause.status === 200 && j10bPause.data?.phase === 'paused', j10bPause.raw)
const j10bResume = await api('POST', `/video/jobs/${j10b.id}/resume`)
check('继续查询 → recovering', j10bResume.status === 200, j10bResume.raw)
const j10bDone = await waitForPhase('恢复后完成', j10b.id, ['completed', 'failed'])
check('继续查询后完成', j10bDone?.phase === 'completed', { phase: j10bDone?.phase })

// 8.5 重启续跑（AC-J8 / FR-P6：reconcile 分支）
console.log('\n[8.5] 重启续跑 reconcile')
// preparing → waiting（未调用飞影，重新排队）
const j8a = await newJob('j8a')
await waitForPhase('进入执行前', j8a.id, ['waiting', 'preparing'], 15_000, false)
await svcDb.run("UPDATE `video_job` SET `phase` = 'preparing' WHERE `id` = ?", [j8a.id])
await reconcileVideoJobs()
const j8aAfter = await api('GET', `/video/jobs/${j8a.id}`)
check('reconcile：preparing → waiting', j8aAfter.data?.phase === 'waiting', j8aAfter.data?.phase)
const j8aDone = await waitForPhase('重新排队后完成', j8a.id, ['completed', 'failed'])
check('重新排队后完成', j8aDone?.phase === 'completed', { phase: j8aDone?.phase })
// submitting 无任务号 → submission_unknown
const j8b = await newJob('j8b')
await waitForPhase('进入执行前', j8b.id, ['waiting', 'preparing', 'submitting'], 15_000, false)
await svcDb.run("UPDATE `video_job` SET `phase` = 'submitting' WHERE `id` = ? AND `remote_task_id` IS NULL", [j8b.id])
await reconcileVideoJobs()
const j8bAfter = await api('GET', `/video/jobs/${j8b.id}`)
check('reconcile：submitting 无任务号 → submission_unknown', j8bAfter.data?.phase === 'submission_unknown', j8bAfter.data?.phase)
clearHiflyInjections()
const j8bConfirm = await api('POST', `/video/jobs/${j8b.id}/confirm-resubmit`, { confirm: true })
check('确认重提受理', j8bConfirm.status === 200, j8bConfirm.raw)
const j8bDone = await waitForPhase('确认重提后完成', j8b.id, ['completed', 'failed'])
check('确认重提后完成', j8bDone?.phase === 'completed', { phase: j8bDone?.phase })
// generating 中断 → 续查（不产生新创建调用）
const j8c = await newJob('j8c')
const j8cGen = await waitForPhase('生成中', j8c.id, ['generating', 'recovering'])
const j8cCount = await vendorCreateCount(j8c.id)
await svcDb.run("UPDATE `video_job` SET `next_poll_at` = datetime(0, 'unixepoch') WHERE `id` = ?", [j8c.id])
await reconcileVideoJobs()
const j8cDone = await waitForPhase('续查后完成', j8c.id, ['completed', 'failed'])
check('reconcile：generating 续查后完成', j8cDone?.phase === 'completed', { phase: j8cDone?.phase })
check('续查无新增创建调用', (await vendorCreateCount(j8c.id)) === j8cCount)
// downloading 中断 → 重新下载（归档中断，Z8 改造点）
const j8d = j7 // 复用 8.1 已完成任务
await svcDb.run("UPDATE `video_job` SET `phase` = 'downloading' WHERE `id` = ?", [j8d.id])
await reconcileVideoJobs()
const j8dDone = await waitForPhase('重新下载后完成', j8d.id, ['completed', 'save_failed'])
check('reconcile：downloading 重新下载后完成', j8dDone?.phase === 'completed', { phase: j8dDone?.phase, detail: j8dDone?.errorDetail })
check('重新下载无新增创建调用', (await vendorCreateCount(j8d.id)) === j7Count)

// 8.6 版本单调（AC-J3 部分）：同 copy 连续生成的 version_no 严格递增且旧版本保留
console.log('\n[8.6] 版本与列表')
const ctxFinal = await api('GET', `/video/copies/${copyId}/context`)
const versions = (ctxFinal.data?.jobs ?? []).map((j: any) => j.versionNo)
check('版本号严格递增', versions.every((v: number, i: number) => i === 0 || v < versions[i - 1]!), versions)
check('旧版本全部保留', ctxFinal.data?.jobs.length >= 8, ctxFinal.data?.jobs.length)

console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===\n`)
await env.shutdown()
if (failed > 0) process.exitCode = 1

