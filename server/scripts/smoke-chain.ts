/**
 * 跨模块联合测试（联动链路贯通）：让同一条数据从资讯选题一路跑到发布，任务中心作最终验收视图。
 *
 * 链路：人物满配（mock 克隆）→ 资讯 → 生成选题（绑定人物）→ 送文案工坊 → 稿件过审（审核链三关 + 人工）
 *      → 视频创作 completed → 剪辑 v1 渲染 + 成片复审通过 → 发布计划（消费过审成片）→ execute → published
 *      → 任务中心：五节点全绿、任务态 completed、时间线覆盖全链事件。
 *
 * 与各模块垂直冒烟的差异：全程只用这一条数据，逐段验证模块交接契约
 * （选题送入的 source=news 文案能否走通视频创作、发布缺省取过审成片、任务中心聚合正确）。
 * 用法：npm run smoke:chain
 */
import { bootIsolated } from './lib/isolated-env.js'
import { authHeader, initSmokeAuth, type SmokeRole } from './lib/smoke-auth.js'

const env = await bootIsolated({ env: { LOG_LEVEL: 'warn', CUT_SWEEP_INTERVAL_MS: '2000' } })
const BASE = env.base
await initSmokeAuth(BASE)
// bootIsolated 只起 app 不跑 index.ts 启动序列：手动装配发布模块（execute worker / sweep），与 smoke:publish 同理
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

async function upload(p: string, fields: Record<string, string>, file: { buf: Buffer; filename: string; type: string }, asRole?: SmokeRole): Promise<any> {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([file.buf], { type: file.type }), file.filename)
  try {
    const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: authHeader('POST', p, asRole), body: fd })
    const raw: any = await res.json().catch(() => ({}))
    return { status: res.status, data: raw?.data, raw }
  } catch (e) {
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-e2e-'))

const pdf = (): Buffer => Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1')
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
let nameSeq = 0
const uniq = (base: string): string => `${base}${String(++nameSeq).padStart(3, '0')}`

console.log('\n=== 跨模块联合测试：选题 → 文案 → 审核 → 视频 → 剪辑 → 发布 → 任务中心 ===\n')

/* ── 1. 人物满配（mock 克隆）── */
console.log('[1] 人物库：满配 KOS 人物')
const pr = await api('POST', '/personas', { name: uniq('联动人物'), line: 'kos' })
check('创建人物', pr.status === 200, pr.raw)
const personaId = pr.data.id

const authUp = await upload(`/personas/${personaId}/authorizations`, {
  grantorName: '授权人', scopes: 'portrait,voice,share', effectiveFrom: day(-1), expiresAt: day(365),
}, { buf: pdf(), filename: 'auth.pdf', type: 'application/pdf' })
check('上传授权书', authUp.status === 200, authUp.raw)
await api('POST', `/persona-authorizations/${authUp.data.id}/verify`, { decision: 'verified' })

const srcVideo = path.join(TMP, 'src.mp4')
await pexec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-t', '12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', srcVideo])
const srcUp = await upload(`/personas/${personaId}/assets`, { kind: 'avatar_source', backgroundLabel: '白色简洁' }, { buf: fs.readFileSync(srcVideo), filename: 'src.mp4', type: 'video/mp4' })
await waitFor('素材处理', 30_000, 500, async () => ((await api('GET', `/personas/${personaId}/assets`)).data ?? []).some((a: any) => a.id === srcUp.data.assetId && a.status === 'pending_review') || undefined)
await api('POST', `/persona-assets/${srcUp.data.assetId}/review`, { decision: 'approved' })

const consentVersionR = await api('GET', '/personas/options')
const consentTextVersion = consentVersionR.data.consentTextVersion
const consent1 = await api('POST', `/personas/${personaId}/consents`, { authorizationId: authUp.data.id, purpose: 'AVATAR_CLONE', sourceKind: 'avatar_source', sourceId: srcUp.data.assetId, consentTextVersion })
const av = await api('POST', `/personas/${personaId}/avatars`, { name: uniq('分身'), sourceAssetId: srcUp.data.assetId, consentId: consent1.data.consentId }, { 'Idempotency-Key': `chain-av-${Date.now()}` })
const avatarReady = await waitFor('分身 ready', 60_000, 1000, async () => {
  const r = await api('GET', `/persona-avatars/${av.data.avatarId}`)
  if (r.data?.status === 'running') await api('POST', `/persona-avatars/${av.data.avatarId}/refresh`)
  return r.data?.status === 'ready' ? r.data : null
})
check('分身克隆 ready', avatarReady != null, av.raw)
await api('POST', `/persona-avatars/${av.data.avatarId}/set-default`)

const wavP = path.join(TMP, 's.wav')
await pexec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', wavP])
const sample = await upload(`/personas/${personaId}/voice-samples`, {}, { buf: fs.readFileSync(wavP), filename: 's.wav', type: 'audio/wav' })
const consent2 = await api('POST', `/personas/${personaId}/consents`, { authorizationId: authUp.data.id, purpose: 'VOICE_CLONE', sourceKind: 'voice_sample', sourceId: sample.data.sampleId, consentTextVersion })
const vo = await api('POST', `/personas/${personaId}/voices`, { name: uniq('声音'), sampleId: sample.data.sampleId, consentId: consent2.data.consentId }, { 'Idempotency-Key': `chain-vo-${Date.now()}` })
const voiceReady = await waitFor('声音 ready', 60_000, 1000, async () => {
  const r = await api('GET', `/persona-voices/${vo.data.voiceId}`)
  if (r.data?.status === 'running') await api('POST', `/persona-voices/${vo.data.voiceId}/refresh`)
  return r.data?.status === 'ready' ? r.data : null
})
check('声音克隆 ready', voiceReady != null, vo.raw)
await api('POST', `/persona-voices/${vo.data.voiceId}/confirm`)
await api('POST', `/persona-voices/${vo.data.voiceId}/set-default`)

if (!avatarReady || !voiceReady) {
  console.log('\n人物前置失败，终止')
  await env.shutdown()
  process.exit(1)
}

/* ── 2. 选题：资讯 → 生成 → assigned ── */
console.log('\n[2] 爆款选题：资讯 → 生成选题（绑定人物）')
const newsReady = await waitFor('启动采集产出资讯', 30_000, 1000, async () => {
  const r = await api('GET', '/news?pageSize=5')
  return (r.data?.items ?? []).length > 0 ? r.data.items : null
})
check('资讯已入库', newsReady != null)
if (!newsReady) {
  console.log('\n无资讯可用，终止')
  await env.shutdown()
  process.exit(1)
}
const newsIds: string[] = newsReady.slice(0, 1).map((n: any) => n.id)
const gen = await api('POST', '/topics/generate', { newsIds, personaIds: [personaId], countPer: 1 })
check('选题生成批次受理', gen.status === 202 && !!gen.data?.batchId, gen.raw)
const batch = await waitFor('批次生成完成', 120_000, 1500, async () => {
  const r = await api('GET', `/topics/batches/${gen.data.batchId}`)
  return r.data?.status && r.data.status !== 'running' ? r.data : null
})
check('批次 done 且产出候选', batch?.status === 'done' && batch?.produced >= 1, batch)
const topicList = await api('GET', `/topics?batchId=${gen.data.batchId}&pageSize=20`)
const topic = (topicList.data?.items ?? []).find((t: any) => t.status === 'assigned' && t.personaIds?.includes(personaId))
check('候选 assigned 且绑定本人物', topic != null, { count: topicList.data?.items?.length })
if (!topic) {
  console.log('\n无可用候选选题，终止')
  await env.shutdown()
  process.exit(1)
}

/* ── 3. 文案工坊：送入 → 写稿 → 审核链过审 ── */
console.log('\n[3] 文案工坊：送入 → 写稿 → 审核链过审')
const send = await api('POST', '/topics/send', { topicIds: [topic.id] })
check('选题送入文案工坊', send.status === 200 && send.data?.created >= 1, send.raw)
const copies = await api('GET', '/copy?source=news&pageSize=50')
const chainCopy = (copies.data?.items ?? []).find((c: any) => c.topic_id === topic.id)
check('copy 按选题展开并回链 topic_id', chainCopy != null, { items: copies.data?.items?.length })
if (!chainCopy) {
  console.log('\n未找到送入的文案，终止')
  await env.shutdown()
  process.exit(1)
}
const copyId: string = chainCopy.id
check('copy 来源为 news 且带 source_text', chainCopy.source_ref_type === 'news_item' && !!chainCopy.source_text, chainCopy)

const copyDetail = await api('GET', `/copy/${copyId}`)
const draft = copyDetail.data?.currentDraft
check('送入后已有初始稿', draft?.id != null && draft?.rev != null, copyDetail.raw)
const copyTitle: string = `联动测试稿：${topic.title}`
const saved = await api('PUT', `/copy/${copyId}/drafts/${draft.id}`, {
  title: copyTitle,
  sections: [{ label: '正文', text: '大家好，今天聊聊基金定投。先说规则！市场越跌越要坚持定投，越涨越要分批止盈。投资有风险，入市需谨慎。' }],
  rev: draft.rev,
})
check('保存稿件内容', saved.status === 200, saved.raw)
await api('POST', `/copy/${copyId}/submit`, { draftId: draft.id, rev: saved.data.rev })
const submissionId = await waitFor('审核桩推进到人工关', 30_000, 800, async () => {
  const d = await api('GET', `/copy/${copyId}`)
  const sid = d.data?.reviewSubmissionId ?? d.data?.copy?.reviewSubmissionId
  const gate = d.data?.reviewGate ?? d.data?.copy?.reviewGate
  return gate === 'pending_manual' ? sid : null
})
check('审核链三关走完至人工关', submissionId != null, submissionId)
const decided = await api('POST', `/review/submissions/${submissionId}/manual-decision`, { result: 'approved' }, {}, 'reviewer')
check('人工复核通过', decided.status === 200, decided.raw)
const approvedOk = await waitFor('文案过审', 15_000, 500, async () => ((await api('GET', `/copy/${copyId}/approved`)).status === 200 || null))
check('GET /copy/{id}/approved 可用', approvedOk != null)

/* ── 4. 视频创作：口播任务 completed ── */
console.log('\n[4] 视频创作：选题来源文案 → 基础视频 completed')
const vjob = await api('POST', '/video/jobs', { copyId, mode: 'avatar' }, { 'Idempotency-Key': `chain-vjob-${Date.now()}` })
check('创建视频任务', vjob.status === 200, vjob.raw)
const jobId = vjob.data?.jobId
const { runVideoSweep } = await import('../src/modules/video/worker.js')
const done = await waitFor('视频任务完成', 180_000, 1000, async () => {
  await runVideoSweep().catch(() => undefined)
  const r = await api('GET', `/video/jobs/${jobId}`)
  return ['completed', 'failed', 'save_failed'].includes(r.data?.phase) ? r.data : null
})
check('基础视频 completed（选题来源文案可进视频创作）', done?.phase === 'completed', { phase: done?.phase, errorCode: done?.errorCode })
if (done?.phase !== 'completed') {
  console.log('\n视频任务未完成，终止后续链路')
  await env.shutdown()
  process.exit(1)
}

/* ── 5. 视频剪辑：渲染 v1 → 成片复审通过 ── */
console.log('\n[5] 视频剪辑：渲染 v1 + 成片复审通过')
const cfg = await api('GET', `/video/jobs/${jobId}/cut-config`)
check('剪辑配置：默认草稿与 base 时间轴', cfg.status === 200 && cfg.data?.draft?.versionNo === 0 && Array.isArray(cfg.data?.base?.timeline) && cfg.data.base.timeline.length > 0, cfg.raw)
const normalSeg = cfg.data.base.timeline.find((t: any) => t.kind === 'normal')
const saveCut = await api('PUT', `/video/jobs/${jobId}/cut-config`, {
  segments: [{ index: normalSeg.index, text: '联动测试改写的字幕文本' }],
  breatheEnabled: true,
})
check('保存剪辑草稿', saveCut.status === 200 && saveCut.data?.segments?.some((s: any) => s.edited), saveCut.raw)
const v1 = await api('POST', `/video/jobs/${jobId}/cut-versions`, {}, { 'Idempotency-Key': `chain-cut-v1-${Date.now()}` })
check('创建渲染版本 v1', v1.status === 200 && v1.data?.cut?.versionNo === 1, v1.raw)
const { runCutSweep } = await import('../src/modules/cut/worker.js')
const r1 = await waitFor('v1 渲染完成', 240_000, 1500, async () => {
  await runCutSweep().catch(() => undefined)
  const r = await api('GET', `/video/cuts/${v1.data.cut.id}`)
  return ['completed', 'failed'].includes(r.data?.cut?.status) ? r.data.cut : null
})
check('v1 渲染 completed（mock 引擎）', r1?.status === 'completed' && r1?.isMock === true, { status: r1?.status, err: r1?.errorMessage })
if (r1?.status !== 'completed') {
  console.log('\n渲染未完成，终止后续链路')
  await env.shutdown()
  process.exit(1)
}
const review = await api('POST', `/video/cuts/${v1.data.cut.id}/review`)
check('提交成片复审', review.status === 200 && review.data?.submission?.status === 'pending_manual', review.raw)
const cutOk = await api('POST', `/video/cuts/${v1.data.cut.id}/review/decision`, { result: 'approved' }, {}, 'reviewer')
check('成片复审通过', cutOk.status === 200 && cutOk.data?.status === 'approved', cutOk.raw)
const final = await api('GET', `/video/cuts/${v1.data.cut.id}/final`)
check('final 契约放行', final.status === 200 && final.data?.videoJobId === jobId && final.data?.versionNo === 1 && final.data?.reviewStatus === 'approved', final.raw)

/* ── 6. 发布管理：消费过审成片 → published ── */
console.log('\n[6] 发布管理：账号 → 发布计划（消费过审成片）→ published')
const acct = await api('POST', '/platform-accounts', { platform: 'douyin', line: 'kos', displayName: uniq('联动发布号') })
check('创建发布账号', acct.status === 200 && !!acct.data?.account?.id, acct.raw)
const { sweepDueSessions, pollLoginSession } = await import('../src/modules/publish/login.js')
await waitFor('账号自动登录', 60_000, 500, async () => {
  const due = await sweepDueSessions()
  for (const sid of due) await pollLoginSession(sid)
  const r = await api('GET', `/platform-accounts/${acct.data.account.id}`)
  return r.data?.loginStatus === 'active' ? r.data : null
})
const plan = await api('POST', '/publish-plans', { copyId, items: [{ platform: 'douyin', accountId: acct.data.account.id }] })
check('创建发布计划 → 消费过审成片 v1（baseVideoVersionNo=1）', plan.status === 200 && plan.data?.plan?.baseVideoVersionNo === 1, { ver: plan.data?.plan?.baseVideoVersionNo, raw: plan.raw })
check('计划无实质修改（reviewState=none）', plan.data?.plan?.reviewState === 'none', plan.raw)
const planId = plan.data?.plan?.id
const execNow = await api('POST', `/publish-plans/${planId}/execute-now`)
check('立即发布受理', execNow.status === 200 && execNow.data?.status === 'scheduled', execNow.raw)
const publishedLog = await waitFor('发布成功', 30_000, 800, async () => {
  const r = await api('GET', `/publish-logs?planId=${planId}`)
  const log = (r.data?.items ?? [])[0]
  return log?.status === 'published' ? log : null
})
check('发布记录 published + video_url', publishedLog?.status === 'published' && typeof publishedLog?.videoUrl === 'string', publishedLog)
const planAfter = await api('GET', `/publish-plans/${planId}`)
check('发布计划收敛 completed', planAfter.data?.status === 'completed', planAfter.raw)

/* ── 7. 任务中心：全链路聚合验收 ── */
console.log('\n[7] 任务中心：五节点全绿验收')
const taskList = await api('GET', '/task-center/tasks?pageSize=100')
const task = (taskList.data?.items ?? []).find((t: any) => t.copyId === copyId)
check('任务树找到本条数据', task != null, { total: taskList.data?.total })
if (task) {
  const nodeOf = (k: string) => task.nodes.find((n: any) => n.key === k)
  check('节点：选题 done（已进入创作）', nodeOf('topic')?.statusKey === 'done', nodeOf('topic'))
  check('节点：稿件 approved', nodeOf('copy')?.statusKey === 'approved', nodeOf('copy'))
  check('节点：基础视频 completed', nodeOf('base_video')?.statusKey === 'completed', nodeOf('base_video'))
  check('节点：剪辑成片过审 cut_approved', nodeOf('edit')?.statusKey === 'cut_approved', nodeOf('edit'))
  check('节点：发布 published', nodeOf('publish')?.statusKey === 'published', nodeOf('publish'))
  check('任务级状态 completed', task.status === 'completed', { status: task.status })
  check('无需处理（needAttention=false）', task.needAttention === false, task.needAttention)
  check('当前阶段收敛到发布（stage=publish）', task.stage?.key === 'publish', task.stage)
  check('任务标题回链文案/选题', (task.title ?? '').length > 0, task.title)
}
const detail = await api('GET', `/task-center/tasks/${copyId}`)
check('任务详情可用', detail.status === 200, detail.raw)
const tl = (detail.data?.timeline ?? []).map((t: any) => `${t.node}:${t.title}`)
check('时间线：任务创建', tl.some((s: string) => s.includes('任务创建')), tl.slice(0, 6))
check('时间线：审核通过', tl.some((s: string) => s.includes('审核通过')), tl)
check('时间线：基础视频生成完成', tl.some((s: string) => s.startsWith('base_video:') && s.includes('生成完成')), tl)
check('时间线：成片渲染与复审通过', tl.some((s: string) => s.startsWith('edit:') && s.includes('渲染')) && tl.some((s: string) => s.startsWith('edit:') && s.includes('复审通过')), tl)
check('时间线：发布成功', tl.some((s: string) => s.startsWith('publish:') && s.includes('发布成功')), tl)
check('详情 chips 含四段（稿件/基础视频/成片/发布单）', (detail.data?.chips ?? []).length >= 4, detail.data?.chips)

console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===\n`)
await env.shutdown()
process.exit(failed ? 1 : 0)
