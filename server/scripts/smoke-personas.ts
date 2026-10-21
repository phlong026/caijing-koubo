/**
 * 人物库模块 · 端到端自检（PL5 交付物 smoke-personas.ts）。
 *
 * 用法：先启动 server（npm run dev），再执行 npm run smoke:personas
 * 环境变量：
 *  - SMOKE_BASE          默认 http://127.0.0.1:8787/api
 *  - SMOKE_KEEP=1        结束后不归档测试人物（便于前端手动检查）
 *  - SMOKE_WITH_LLM=1    追加 AC-X3 文案生成场景（走真实 LLM，约 1 分钟）
 *
 * 覆盖：AC-L1~L5 / AC-I1~I5 / AC-A1~A4 / AC-C1~C6 / AC-V1~V9 / AC-U1~U4 / AC-X1/X2/X4/X5（X3 可选）。
 * 依赖：ffmpeg / ffprobe 在 PATH（素材样例由脚本现场生成）；飞影未配密钥时走 mock（HIFLY_MOCK_POLLS_TO_DONE=2）。
 */
import { authHeader, initSmokeAuth } from './lib/smoke-auth.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pexec = promisify(execFile)
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8787/api'
await initSmokeAuth(BASE)
const KEEP = process.env.SMOKE_KEEP === '1'
const WITH_LLM = process.env.SMOKE_WITH_LLM === '1'

/** 测试人物固定名（脚本启动时会先把历史同名人物归档，保证可重复运行） */
const NAME_A = '冒烟测试人物'
const NAME_B = '冒烟测试人物乙'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ❌ ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))
  }
}

function info(msg: string): void {
  console.log(`  ℹ️ ${msg}`)
}

async function req<T = any>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: T; raw: any }> {
  const h: Record<string, string> = { ...authHeader(method, path), ...headers }
  if (body !== undefined) h['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw: any = await res.json().catch(() => ({}))
  return { status: res.status, data: raw?.data, raw }
}

/** multipart 上传（字段 + 单文件；字段必须位于文件之前，与 readMultipart 的单趟读取约定一致） */
async function reqMultipart<T = any>(
  path: string,
  fields: Record<string, string>,
  file: { buf: Buffer; filename: string; type: string },
): Promise<{ status: number; data: T; raw: any }> {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([file.buf], { type: file.type }), file.filename)
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: authHeader('POST', path), body: fd })
  const raw: any = await res.json().catch(() => ({}))
  return { status: res.status, data: raw?.data, raw }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立（返回 false/null 继续等） */
async function waitFor<T>(
  desc: string,
  timeoutMs: number,
  intervalMs: number,
  fn: () => Promise<T | null | false>,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v !== null && v !== false) return v
    if (Date.now() > deadline) {
      console.log(`  ⏱️ 等待超时：${desc}`)
      return null
    }
    await sleep(intervalMs)
  }
}

/* ── ffmpeg 样例生成 ─────────────────────────────────────────── */

const TMP = path.join(os.tmpdir(), 'smoke-personas')
fs.mkdirSync(TMP, { recursive: true })

async function ffmpeg(args: string[]): Promise<void> {
  await pexec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args])
}

/** 形象照片：720×720 JPEG（满足最短边 ≥720 与 JPEG 结构校验） */
async function fixturePhoto(): Promise<Buffer> {
  const p = path.join(TMP, 'photo.jpg')
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=#2b4ac0:s=720x720:d=1', '-frames:v', '1', '-q:v', '3', p])
  return fs.readFileSync(p)
}

/** 分身素材：12s 720×1280（9:16）H.264 mp4（时长 10–600s、短边 ≥720、帧率 ≥24） */
async function fixtureVideo(): Promise<Buffer> {
  const p = path.join(TMP, 'avatar.mp4')
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-t', '12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', p])
  return fs.readFileSync(p)
}

/** 声音样本：8s 16kHz 单声道 WAV（时长 5–180s） */
async function fixtureWav(): Promise<Buffer> {
  const p = path.join(TMP, 'sample.wav')
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', p])
  return fs.readFileSync(p)
}

/** 授权材料：最小合法 PDF（%PDF 头 + %%EOF 尾） */
function fixturePdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1')
}

/* ── 主流程 ─────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log(`\n=== 人物库模块 · 端到端自检（${BASE}） ===\n`)

  /* [0] 健康检查与 options */
  console.log('[0] 健康检查与 options')
  const health: any = await fetch(`${BASE}/health`).then((r) => r.json())
  check('服务健康（db 可用，队列降级不影响）', health?.ok === true && ['ok', 'degraded'].includes(health?.data?.status), health?.data?.status)
  const opt = await req('GET', '/personas/options')
  check('options 200', opt.status === 200)
  const consentVersion: string = opt.data?.consentTextVersion ?? ''
  check('consentTextVersion 非空', !!consentVersion, consentVersion)
  check(
    'voiceLanguages 使用生产语种码（zh_cantonese 等）',
    Array.isArray(opt.data?.voiceLanguages) &&
      opt.data.voiceLanguages.some((l: any) => (l.code ?? l) === 'zh_cantonese'),
    opt.data?.voiceLanguages,
  )
  info(`飞影态：configured=${opt.data?.hifly?.configured} mock=${opt.data?.hifly?.mock} credit=${opt.data?.hifly?.credit}`)
  check('飞影可用（真实密钥或 mock 降级）', opt.data?.hifly?.configured === true || opt.data?.hifly?.mock === true)

  /* [1] 清理历史测试人物（保证可重复运行） */
  console.log('[1] 清理历史测试人物')
  const stale = await req('GET', '/personas?includeDisabled=1&includeArchived=1&keyword=' + encodeURIComponent('冒烟测试人物'))
  const staleItems: any[] = stale.data?.items ?? []
  for (const p of staleItems) {
    if (p.status !== 'archived') await req('POST', `/personas/${p.id}/archive`, { force: true }, authHeader('POST', '/', 'admin'))
  }
  info(`归档历史测试人物 ${staleItems.length} 个`)

  /* [2] 人物 CRUD 与列表语义（AC-L1 / L2 / L3 / X1） */
  console.log('[2] 人物 CRUD 与列表语义')
  const created = await req('POST', '/personas', { name: NAME_A, line: 'manager', description: '端到端自检创建' })
  check('创建人物 200', created.status === 200, created.raw)
  const idA: string = created.data?.id ?? ''
  check('返回人物 id', !!idA)
  check('新建后状态为「授权待核验」', created.data?.status === 'auth_pending', created.data?.status)
  check('新建后 usable=false', created.data?.usable === false)

  const dup = await req('POST', '/personas', { name: ` ${NAME_A} `, line: 'manager' })
  check('重名 409 PERSONA_NAME_DUPLICATE', dup.status === 409 && dup.raw?.error?.code === 'PERSONA_NAME_DUPLICATE', dup.raw)

  const listDefault = await req('GET', '/personas')
  check('默认列表不含未就绪人物（AC-X1）', !(listDefault.data?.items ?? []).some((p: any) => p.id === idA))
  const listAll = await req('GET', '/personas?includeDisabled=1')
  check('includeDisabled=1 可见', (listAll.data?.items ?? []).some((p: any) => p.id === idA))
  check('列表项带 counts 与 statusReasons', (() => {
    const p = (listAll.data?.items ?? []).find((x: any) => x.id === idA)
    return !!p && typeof p.counts === 'object' && Array.isArray(p.statusReasons)
  })())

  const patched = await req('PATCH', `/personas/${idA}`, { description: '端到端自检创建（改）', rev: created.data?.rev })
  check('PATCH 修改简介 200', patched.status === 200, patched.raw)
  const conflict = await req('PATCH', `/personas/${idA}`, { description: '冲突', rev: (created.data?.rev ?? 1) + 99 })
  check('错误 rev 409 PERSONA_CONFLICT（AC-L3）', conflict.status === 409 && conflict.raw?.error?.code === 'PERSONA_CONFLICT', conflict.raw)

  /* [3] IP 定位与人物版本（AC-I1~I5） */
  console.log('[3] IP 定位与人物版本')
  const profile1 = {
    role: '资深理财顾问',
    serviceScope: '基金配置、家庭资产规划',
    targetAudience: '25-40 岁城市白领',
    expressionStyle: '理性温和，数据说话',
    forbiddenClaims: ['稳赚不赔', '保本高收益'],
    factualBackground: '十年券商从业经验',
    sampleScript: '大家好，今天聊一个存钱误区。',
    contentDirections: ['基金入门', '资产配置'],
    contentMix: [{ label: '知识科普' }, { label: '风险提示' }],
  }
  const saved = await req('PUT', `/personas/${idA}/profile`, { ipProfile: profile1, rev: patched.data?.rev })
  check('保存 IP 定位 200', saved.status === 200, saved.raw)
  check('首次保存 changed=true 且产生版本', saved.data?.changed === true && !!saved.data?.versionId, saved.data)
  const resave = await req('PUT', `/personas/${idA}/profile`, { ipProfile: { ...profile1 } })
  check('规范化内容重复保存 changed=false（AC-I4）', resave.data?.changed === false, resave.data)
  const saved2 = await req('PUT', `/personas/${idA}/profile`, {
    ipProfile: { ...profile1, expressionStyle: '理性温和，数据说话，偶尔幽默' },
    rev: saved.data?.persona?.rev,
  })
  check('修改后再次保存 changed=true', saved2.data?.changed === true, saved2.data)
  const versions = await req('GET', `/personas/${idA}/versions`)
  check('版本历史 ≥2 条', (versions.data?.length ?? 0) >= 2, versions.data?.length)

  /* [4] 授权上传 / 核验 / 读时到期（AC-U1~U4） */
  console.log('[4] 授权上传 / 核验 / 读时到期')
  const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const to = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
  const authUp = await reqMultipart(`/personas/${idA}/authorizations`, {
    grantorName: '张三',
    scopes: 'portrait,voice',
    effectiveFrom: from,
    expiresAt: to,
    note: '端到端自检授权',
  }, { buf: fixturePdf(), filename: 'auth.pdf', type: 'application/pdf' })
  check('上传授权材料 200', authUp.status === 200, authUp.raw)
  const authId: string = authUp.data?.id ?? ''
  check('授权初始 pending', authUp.data?.status === 'pending', authUp.data?.status)

  const readinessBefore = await req('GET', `/personas/${idA}/readiness?purpose=copy`)
  check('授权待核验时 readiness(copy) 不过', readinessBefore.data?.pass === false, readinessBefore.data?.checks)

  // P0-1：运营不能核验授权（角色）；上传人不能核验自己上传的材料（四眼）
  const opsVerify = await req('POST', `/persona-authorizations/${authId}/verify`, { decision: 'verified' }, authHeader('POST', '/', 'ops'))
  check('运营核验授权被拒（403）', opsVerify.status === 403, opsVerify.raw)
  const selfVerify = await req('POST', `/persona-authorizations/${authId}/verify`, { decision: 'verified' }, authHeader('POST', '/', 'admin'))
  check('管理员可核验他人上传的授权（四眼仅限上传人）', selfVerify.status === 200, selfVerify.raw)
  await req('POST', `/persona-authorizations/${authId}/verify`, { decision: 'rejected', reason: '冒烟：重置为驳回后再由审核员核验' }, authHeader('POST', '/', 'admin'))
  const verified = await req('POST', `/persona-authorizations/${authId}/verify`, { decision: 'verified' })
  check('核验授权 200', verified.status === 200, verified.raw)
  const readinessAfter = await req('GET', `/personas/${idA}/readiness?purpose=copy`)
  check('授权有效后 readiness(copy) 全过（AC-X4）', readinessAfter.data?.pass === true, readinessAfter.data?.checks)

  // 读时到期判定：补一份已过期的授权（不影响既有有效授权）
  const authExpired = await reqMultipart(`/personas/${idA}/authorizations`, {
    grantorName: '李四',
    scopes: 'portrait',
    effectiveFrom: new Date(Date.now() - 800 * 86_400_000).toISOString().slice(0, 10),
    expiresAt: yesterday,
  }, { buf: fixturePdf(), filename: 'auth-old.pdf', type: 'application/pdf' })
  check('上传过期授权 200', authExpired.status === 200, authExpired.raw)
  await req('POST', `/persona-authorizations/${authExpired.data?.id}/verify`, { decision: 'verified' })
  const auths = await req('GET', `/personas/${idA}/authorizations`)
  const expiredRow = (auths.data ?? []).find((a: any) => a.id === authExpired.data?.id)
  check('读时判定为 expired（AC-U3）', expiredRow?.status === 'expired', expiredRow?.status)
  const stillActive = await req('GET', `/personas/${idA}`)
  check('并存一份有效授权时仍 active', stillActive.data?.usable === true && stillActive.data?.status === 'active', stillActive.data?.status)

  /* [5] 素材上传与异步处理（AC-A1~A4） */
  console.log('[5] 素材上传与异步处理')
  const photo = await fixturePhoto()
  const photoUp = await reqMultipart(`/personas/${idA}/assets`, { kind: 'photo', name: '冒烟照片' }, {
    buf: photo,
    filename: 'photo.jpg',
    type: 'image/jpeg',
  })
  check('上传形象照片 200', photoUp.status === 200, photoUp.raw)
  const photoId: string = photoUp.data?.assetId ?? ''

  const video = await fixtureVideo()
  const videoUp = await reqMultipart(`/personas/${idA}/assets`, { kind: 'avatar_source', name: '冒烟分身素材', backgroundLabel: '办公室' }, {
    buf: video,
    filename: 'avatar.mp4',
    type: 'video/mp4',
  })
  check('上传分身素材 200', videoUp.status === 200, videoUp.raw)
  const videoId: string = videoUp.data?.assetId ?? ''

  const photoDone = await waitFor('照片处理完成', 60_000, 1500, async () => {
    const r = await req('GET', `/personas/${idA}/assets?kind=photo`)
    const a = (r.data ?? []).find((x: any) => x.id === photoId)
    return a && (a.status === 'pending_review' || a.status === 'approved' || a.status === 'failed') ? a : null
  })
  check('照片处理到 pending_review（AC-A3）', photoDone?.status === 'pending_review', photoDone)
  check('照片生成缩略图', !!photoDone?.thumbKey || !!photoDone?.thumb_key, photoDone)

  const videoDone = await waitFor('分身素材处理完成（含转码）', 120_000, 2000, async () => {
    const r = await req('GET', `/personas/${idA}/assets?kind=avatar_source`)
    const a = (r.data ?? []).find((x: any) => x.id === videoId)
    return a && (a.status === 'pending_review' || a.status === 'approved' || a.status === 'failed') ? a : null
  })
  check('分身素材处理到 pending_review', videoDone?.status === 'pending_review', videoDone)
  check('分身素材生成兼容版本（R20）', !!videoDone?.compatKey || !!videoDone?.compat_key, videoDone)

  const photoReview = await req('POST', `/persona-assets/${photoId}/review`, { decision: 'approved' })
  check('审核通过照片', photoReview.status === 200 && photoReview.data?.status === 'approved', photoReview.raw)
  const videoReview = await req('POST', `/persona-assets/${videoId}/review`, { decision: 'approved' })
  check('审核通过分身素材', videoReview.status === 200 && videoReview.data?.status === 'approved', videoReview.raw)

  const setCover = await req('POST', `/persona-assets/${photoId}/set-cover`)
  check('设置封面 200', setCover.status === 200, setCover.raw)

  const thumb = await fetch(`${BASE}/persona-assets/${photoId}/file?variant=thumb`, { headers: authHeader('GET', '/') })
  check('缩略图可流式读取（200 + 图片类型）', thumb.status === 200 && (thumb.headers.get('content-type') ?? '').startsWith('image/'), thumb.status)

  const dupAsset = await reqMultipart(`/personas/${idA}/assets`, { kind: 'photo' }, {
    buf: photo,
    filename: 'photo.jpg',
    type: 'image/jpeg',
  })
  check('同内容重复上传走幂等去重（AC-A4）', dupAsset.data?.deduplicated === true && dupAsset.data?.assetId === photoId, dupAsset.data)

  /* [6] 分身克隆全链路（AC-C1~C6） */
  console.log('[6] 分身克隆全链路')
  const consentC = await req('POST', `/personas/${idA}/consents`, {
    authorizationId: authId,
    purpose: 'AVATAR_CLONE',
    sourceKind: 'avatar_source',
    sourceId: videoId,
    consentTextVersion: consentVersion,
  })
  check('创建分身授权确认 200', consentC.status === 200, consentC.raw)
  const consentCId: string = consentC.data?.consentId ?? ''

  const idemKey = `smoke-avatar-${Date.now()}`
  const avatarA = await req('POST', `/personas/${idA}/avatars`, {
    name: '冒烟分身甲',
    sourceAssetId: videoId,
    consentId: consentCId,
  }, { 'Idempotency-Key': idemKey })
  check('发起分身制作 200', avatarA.status === 200, avatarA.raw)
  const avatarAId: string = avatarA.data?.avatarId ?? ''
  check('分身初始为 pending/submitting', ['pending', 'submitting'].includes(avatarA.data?.status), avatarA.data?.status)

  const replay = await req('POST', `/personas/${idA}/avatars`, {
    name: '冒烟分身甲',
    sourceAssetId: videoId,
    consentId: consentCId,
  }, { 'Idempotency-Key': idemKey })
  check('同键同参重放 replayed=true（AC-C3）', replay.data?.replayed === true && replay.data?.avatarId === avatarAId, replay.data)
  const replayDiff = await req('POST', `/personas/${idA}/avatars`, {
    name: '冒烟分身甲-改',
    sourceAssetId: videoId,
    consentId: consentCId,
  }, { 'Idempotency-Key': idemKey })
  check('同键异参 409（R13）', replayDiff.status === 409, replayDiff.raw)

  // 等 worker 提交到厂商（pending → running）
  const avatarRunning = await waitFor('分身进入制作中', 60_000, 1000, async () => {
    const r = await req('GET', `/persona-avatars/${avatarAId}`)
    const s = r.data?.status
    return s === 'running' || s === 'ready' ? r.data : null
  })
  check('分身由 worker 提交后进入 running', avatarRunning?.status === 'running' || avatarRunning?.status === 'ready', avatarRunning?.status)
  check('分身带厂商任务号', !!avatarRunning?.vendorTaskId, avatarRunning?.vendorTaskId)
  const titleOk = typeof avatarRunning?.vendorTitle === 'string' && avatarRunning.vendorTitle.length <= 20
  check('厂商标题 = 名称[:13]-短引用（R11）', titleOk, avatarRunning?.vendorTitle)

  // refresh 立即查询（mock 需 2 次查询到 DONE）
  const r1 = await req('POST', `/persona-avatars/${avatarAId}/refresh`)
  check('refresh #1 200', r1.status === 200, r1.raw)
  const avatarReady = await waitFor('分身制作完成', 90_000, 2000, async () => {
    if (r1.data?.status !== 'ready') {
      const rr = await req('POST', `/persona-avatars/${avatarAId}/refresh`)
      if (rr.status !== 200) return null
    }
    const r = await req('GET', `/persona-avatars/${avatarAId}`)
    return r.data?.status === 'ready' ? r.data : null
  })
  check('分身 ready（AC-C4）', avatarReady?.status === 'ready', avatarReady?.status)
  check('分身带厂商标识（mock_avatar_*）', typeof avatarReady?.vendorAvatarId === 'string' && avatarReady.vendorAvatarId.startsWith('mock_avatar'), avatarReady?.vendorAvatarId)

  const setDefaultAvatar = await req('POST', `/persona-avatars/${avatarAId}/set-default`)
  check('设置默认分身 200', setDefaultAvatar.status === 200, setDefaultAvatar.raw)

  const renameAvatar = await req('PATCH', `/persona-avatars/${avatarAId}`, { name: '冒烟分身甲-改名' })
  check('重命名分身 200（R18 只改本地）', renameAvatar.status === 200 && renameAvatar.data?.name === '冒烟分身甲-改名', renameAvatar.raw)
  check('重命名后厂商标题不变', renameAvatar.data?.vendorTitle === avatarRunning?.vendorTitle, renameAvatar.data?.vendorTitle)

  /* [7] 声音克隆全链路（AC-V1~V9） */
  console.log('[7] 声音克隆全链路')
  const wav = await fixtureWav()
  const sampleUp = await reqMultipart(`/personas/${idA}/voice-samples`, {}, {
    buf: wav,
    filename: 'sample.wav',
    type: 'audio/wav',
  })
  check('上传声音样本 200', sampleUp.status === 200, sampleUp.raw)
  const sampleId: string = sampleUp.data?.sampleId ?? ''
  check('样本时长 ≈8s（5–180s 校验）', Math.abs(Number(sampleUp.data?.durationMs ?? 0) - 8000) < 1500, sampleUp.data?.durationMs)

  const consentV = await req('POST', `/personas/${idA}/consents`, {
    authorizationId: authId,
    purpose: 'VOICE_CLONE',
    sourceKind: 'voice_sample',
    sourceId: sampleId,
    consentTextVersion: consentVersion,
  })
  check('创建声音授权确认 200', consentV.status === 200, consentV.raw)
  const consentVId: string = consentV.data?.consentId ?? ''

  const voice = await req('POST', `/personas/${idA}/voices`, {
    name: '冒烟声音甲',
    sampleId,
    consentId: consentVId,
    language: 'zh_cantonese',
  }, { 'Idempotency-Key': `smoke-voice-${Date.now()}` })
  check('发起声音克隆 200（方言码入参）', voice.status === 200, voice.raw)
  const voiceId: string = voice.data?.voiceId ?? ''
  check('克隆语种落库 zh_cantonese', voice.data?.voice?.language === 'zh_cantonese', voice.data?.voice?.language)

  const voiceRunning = await waitFor('声音进入克隆中', 60_000, 1000, async () => {
    const r = await req('GET', `/persona-voices/${voiceId}`)
    const s = r.data?.status
    return s === 'running' || s === 'ready' ? r.data : null
  })
  check('声音由 worker 提交后进入 running', voiceRunning?.status === 'running' || voiceRunning?.status === 'ready', voiceRunning?.status)

  const vr1 = await req('POST', `/persona-voices/${voiceId}/refresh`)
  check('声音 refresh #1 200', vr1.status === 200, vr1.raw)
  const voiceReady = await waitFor('声音克隆完成', 90_000, 2000, async () => {
    if (vr1.data?.status !== 'ready') {
      const rr = await req('POST', `/persona-voices/${voiceId}/refresh`)
      if (rr.status !== 200) return null
    }
    const r = await req('GET', `/persona-voices/${voiceId}`)
    return r.data?.status === 'ready' ? r.data : null
  })
  check('声音 ready（AC-V4）', voiceReady?.status === 'ready', voiceReady?.status)
  check('声音带厂商标识', typeof voiceReady?.vendorVoiceId === 'string' && voiceReady.vendorVoiceId.startsWith('mock_voice'), voiceReady?.vendorVoiceId)
  check('声音带归档试听（demo_key）', !!voiceReady?.demoKey || !!voiceReady?.demo_key, voiceReady?.demoKey)

  const demo = await fetch(`${BASE}/persona-voices/${voiceId}/demo`, { headers: authHeader('GET', '/') })
  check('厂商试听可播放（200 + audio）', demo.status === 200 && (demo.headers.get('content-type') ?? '').startsWith('audio/'), demo.status)

  const confirm = await req('POST', `/persona-voices/${voiceId}/confirm`)
  check('确认声音（FR-V5）200', confirm.status === 200 && confirm.data?.confirmed === true, confirm.raw)

  const settings = await req('PUT', `/persona-voices/${voiceId}/settings`, { speechRate: 1.2, volume: 0.9, pitch: 1.1 })
  check('调整声音参数 200（R17 三段式）', settings.status === 200, settings.raw)
  check('参数落库', settings.data?.speechRate === 1.2 && settings.data?.volume === 0.9 && settings.data?.pitch === 1.1, settings.data)
  const badSettings = await req('PUT', `/persona-voices/${voiceId}/settings`, { speechRate: 9 })
  check('非法参数 400', badSettings.status === 400, badSettings.raw)

  const preview = await req('POST', `/persona-voices/${voiceId}/preview`, { text: '大家好，欢迎来到我的频道，今天聊聊家庭理财。' })
  check('发起任意文本试听 200', preview.status === 200, preview.raw)
  const previewId: string = preview.data?.previewId ?? ''
  const previewReady = await waitFor('试听生成完成', 90_000, 2000, async () => {
    const r = await req('POST', `/persona-voices/${voiceId}/refresh`).catch(() => null)
    void r
    const g = await req('GET', `/persona-voice-previews/${previewId}`)
    return g.data?.status === 'ready' ? g.data : null
  })
  check('试听 ready 且可播放（AC-V7）', previewReady?.status === 'ready' && !!previewReady?.audioKey, previewReady?.status)
  const previewFile = await fetch(`${BASE}/persona-voice-previews/${previewId}/file`, { headers: authHeader('GET', '/') })
  check('试听音频可读取', previewFile.status === 200 && (previewFile.headers.get('content-type') ?? '').startsWith('audio/'), previewFile.status)

  const previewCache = await req('POST', `/persona-voices/${voiceId}/preview`, { text: '大家好，欢迎来到我的频道，今天聊聊家庭理财。' })
  check('同参数同文本试听走缓存（AC-V7）', previewCache.data?.cached === true, previewCache.data)

  const setDefaultVoice = await req('POST', `/persona-voices/${voiceId}/set-default`)
  check('设置默认声音 200', setDefaultVoice.status === 200, setDefaultVoice.raw)

  /* [8] readiness / production-profile（AC-X4 / X5） */
  console.log('[8] readiness 与 production-profile')
  const rdAvatarVideo = await req('GET', `/personas/${idA}/readiness?purpose=avatar_video`)
  check('readiness(avatar_video) 全过', rdAvatarVideo.data?.pass === true, rdAvatarVideo.data?.checks)
  const rdMixcut = await req('GET', `/personas/${idA}/readiness?purpose=mixcut`)
  check('readiness(mixcut) 过（空镜为软项）', rdMixcut.data?.pass === true, rdMixcut.data?.checks)
  const brollCheck = (rdMixcut.data?.checks ?? []).find((c: any) => c.key === 'broll')
  check('空镜软项提示未过', brollCheck?.level === 'soft' && brollCheck?.pass === false, brollCheck)

  const profile = await req('GET', `/personas/${idA}/production-profile`)
  check('production-profile 200（AC-X5）', profile.status === 200, profile.raw)
  check('返回 vendorAvatarId / vendorVoiceId', !!profile.data?.avatar?.vendorAvatarId && !!profile.data?.voice?.vendorVoiceId, profile.data)
  check('返回版本 id 与版本号', !!profile.data?.versionId && typeof profile.data?.versionNo === 'number', profile.data)
  check('返回声音参数', profile.data?.voice?.speechRate === 1.2, profile.data?.voice)
  check('返回试听地址', typeof profile.data?.voice?.demoUrl === 'string' && profile.data.voice.demoUrl.includes('/demo'), profile.data?.voice?.demoUrl)

  // 未就绪人物：PERSONA_NOT_READY
  const personaB = await req('POST', '/personas', { name: NAME_B, line: 'persona', description: '素人（无授权要求）' })
  const idB: string = personaB.data?.id ?? ''
  const rdBCopy = await req('GET', `/personas/${idB}/readiness?purpose=copy`)
  check('素人 readiness(copy) 直接过', rdBCopy.data?.pass === true, rdBCopy.data?.checks)
  const rdBAvatar = await req('GET', `/personas/${idB}/readiness?purpose=avatar_video`)
  const missingAvatar = (rdBAvatar.data?.checks ?? []).find((c: any) => c.key === 'default_avatar')
  check('素人 readiness(avatar_video) 缺默认分身硬项不过', rdBAvatar.data?.pass === false && missingAvatar?.pass === false, rdBAvatar.data?.checks)
  const profileB = await req('GET', `/personas/${idB}/production-profile`)
  check('未就绪人物 production-profile 409 PERSONA_NOT_READY', profileB.status === 409 && profileB.raw?.error?.code === 'PERSONA_NOT_READY', profileB.raw)
  check('409 带 checks 明细', Array.isArray(profileB.raw?.error?.details?.checks), profileB.raw?.error?.details)

  /* [9] 对接文案工坊（AC-X2） */
  console.log('[9] 对接文案工坊（人物校验）')
  const copyOk = await req('POST', '/copy', { source: 'manual', title: '冒烟文案-正常', personaIds: [idB] })
  check('启用人物可创建文案', copyOk.status === 200 && (copyOk.data?.copyIds?.length ?? 0) === 1, copyOk.raw)
  await req('POST', `/personas/${idB}/disable`)
  const copyDisabled = await req('POST', '/copy', { source: 'manual', title: '冒烟文案-停用', personaIds: [idB] })
  check('停用人物创建文案被拒（409）', copyDisabled.status === 409, copyDisabled.raw)
  check('拒绝消息含「已停用」', String(copyDisabled.raw?.error?.message ?? '').includes('已停用'), copyDisabled.raw?.error?.message)
  await req('POST', `/personas/${idB}/enable`)
  await req('POST', `/personas/${idB}/archive`, { force: true }, authHeader('POST', '/', 'admin'))
  const copyArchived = await req('POST', '/copy', { source: 'manual', title: '冒烟文案-归档', personaIds: [idB] })
  check('归档人物创建文案被拒（PERSONA_ARCHIVED）', copyArchived.status === 409 && copyArchived.raw?.error?.code === 'PERSONA_ARCHIVED', copyArchived.raw)
  const missing = await req('POST', '/copy', { source: 'manual', title: '冒烟文案-不存在', personaIds: ['pa_nonexistent'] })
  check('不存在人物创建文案被拒（PERSONA_NOT_FOUND）', missing.status === 404 && missing.raw?.error?.code === 'PERSONA_NOT_FOUND', missing.raw)

  /* [10] 归档守卫（AC-L5） */
  console.log('[10] 归档守卫')
  // 再造一个分身（进入 pending/running）验证「进行中克隆」阻断
  const consentC2 = await req('POST', `/personas/${idA}/consents`, {
    authorizationId: authId,
    purpose: 'AVATAR_CLONE',
    sourceKind: 'avatar_source',
    sourceId: videoId,
    consentTextVersion: consentVersion,
  })
  const dupNoConfirm = await req('POST', `/personas/${idA}/avatars`, {
    name: '冒烟分身乙',
    sourceAssetId: videoId,
    consentId: consentC2.data?.consentId,
  }, { 'Idempotency-Key': `smoke-avatar-b1-${Date.now()}` })
  check('同素材重复制作未确认 409（AC-C5）', dupNoConfirm.status === 409 && dupNoConfirm.raw?.error?.code === 'PERSONA_CONFLICT', dupNoConfirm.raw)
  const avatarB = await req('POST', `/personas/${idA}/avatars`, {
    name: '冒烟分身乙',
    sourceAssetId: videoId,
    consentId: consentC2.data?.consentId,
    confirmDuplicate: true, // 同素材已有 ready 分身，需二次确认（AC-C5）
  }, { 'Idempotency-Key': `smoke-avatar-b2-${Date.now()}` })
  const avatarBId: string = avatarB.data?.avatarId ?? ''
  check('同素材二次制作（确认后）200', avatarB.status === 200, avatarB.raw)
  const blocked = await req('POST', `/personas/${idA}/archive`)
  check('进行中克隆阻断归档 409 PERSONA_IN_USE', blocked.status === 409 && blocked.raw?.error?.code === 'PERSONA_IN_USE', blocked.raw)
  check('阻断原因含「进行中的分身制作」', String(blocked.raw?.error?.message ?? '').includes('分身'), blocked.raw?.error?.message)

  // 推进到终态后允许归档
  await waitFor('分身乙终态', 120_000, 2000, async () => {
    const r = await req('GET', `/persona-avatars/${avatarBId}`)
    const s = r.data?.status
    if (s === 'running') {
      await req('POST', `/persona-avatars/${avatarBId}/refresh`)
      return null
    }
    if (s === 'ready' || s === 'failed' || s === 'uncertain') return r.data
    return false
  })
  // 终态后可能仍非默认，直接删掉再归档（默认分身甲不受影响）
  const avatarB2 = await req('GET', `/persona-avatars/${avatarBId}`)
  if (avatarB2.data?.status === 'ready') await req('DELETE', `/persona-avatars/${avatarBId}`)

  const archiveOk = await req('POST', `/personas/${idA}/archive`)
  check('无阻断后归档 200', archiveOk.status === 200, archiveOk.raw)
  check('归档后 usable=false', archiveOk.data?.usable === false && archiveOk.data?.status === 'archived', archiveOk.data?.status)
  const listArchived = await req('GET', '/personas?includeArchived=1')
  const archivedItem = (listArchived.data?.items ?? []).find((p: any) => p.id === idA)
  check('includeArchived=1 可见归档人物', !!archivedItem, !!archivedItem)
  const listAfter = await req('GET', '/personas')
  check('默认列表不再含归档人物', !(listAfter.data?.items ?? []).some((p: any) => p.id === idA))
  const opsOnArchived = await req('POST', `/personas/${idA}/consents`, {
    authorizationId: authId,
    purpose: 'AVATAR_CLONE',
    sourceKind: 'avatar_source',
    sourceId: videoId,
    consentTextVersion: consentVersion,
  })
  check('归档人物发起授权确认被拒（409 PERSONA_ARCHIVED）', opsOnArchived.status === 409 && opsOnArchived.raw?.error?.code === 'PERSONA_ARCHIVED', opsOnArchived.raw)

  /* [11] 可选：AC-X3 文案生成绑定人物版本（依赖 LLM，默认跳过） */
  if (WITH_LLM) {
    console.log('[11] 文案生成绑定人物版本（AC-X3，LLM）')
    const personaC = await req('POST', '/personas', { name: `${NAME_A}丙`, line: 'persona' })
    const idC: string = personaC.data?.id ?? ''
    const copyOpts = await req('GET', '/copy/options')
    const templateId: string = copyOpts.data?.templates?.[0]?.id ?? ''
    const styleId: string = copyOpts.data?.styles?.[0]?.id ?? ''
    check('可取到模板与风格', !!templateId && !!styleId, { templateId, styleId })
    const copyForGen = await req('POST', '/copy', { source: 'manual', title: '冒烟文案-生成', personaIds: [idC] })
    const copyId: string = copyForGen.data?.copyIds?.[0] ?? ''
    const gen = await req('POST', `/copy/${copyId}/generate`, { templateId, styleId, count: 1 })
    check('发起文案生成 200', gen.status === 200, gen.raw)
    const generationId: string = gen.data?.generationId ?? ''
    const genDone = await waitFor('文案生成完成', 180_000, 3000, async () => {
      const g = await req('GET', `/copy/generations/${generationId}`)
      return ['done', 'partial', 'failed'].includes(g.data?.status) ? g.data : null
    })
    check('文案生成成功', genDone?.status === 'done' || genDone?.status === 'partial', genDone)
    check('生成记录带 personaVersionId（AC-X3）', !!genDone?.personaVersionId, genDone?.personaVersionId)
    check('生成记录回显版本号', typeof genDone?.personaVersionNo === 'number', genDone?.personaVersionNo)
    if (!KEEP) await req('POST', `/personas/${idC}/archive`, { force: true }, authHeader('POST', '/', 'admin'))
  } else {
    info('跳过 AC-X3（SMOKE_WITH_LLM=1 可开启，走真实 LLM 约 1 分钟）')
  }

  /* 汇总 */
  console.log(`\n=== 自检结果：${passed} 通过 / ${failed} 失败 ===`)
  if (failures.length) {
    console.log('失败项：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  if (!KEEP) {
    // 测试数据保留归档态（不物理删除，便于排查）；再次运行会自动清理
    info(`测试人物已归档：${idA} / ${idB}（重跑自动清理）`)
  } else {
    info(`SMOKE_KEEP=1：保留测试人物 ${idA} / ${idB} 供前端检查`)
  }
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('冒烟脚本执行异常：', e)
  process.exit(1)
})
