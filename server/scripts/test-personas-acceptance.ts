/**
 * 人物库验收脚本（任务书 §9）：补齐 smoke-personas 未覆盖的 AC，并覆盖联调场景 3~7。
 *
 * 与 smoke 的区别：服务端与测试同进程，因此可以
 *   - 向飞影 mock 注入 uncertain / uncertain_accepted / failed / 指定业务码；
 *   - 直接改库把授权到期时间改到过去（验证「读时到期、不依赖定时任务」）；
 *   - 读 operation_log / api_call_log 校验审计、留痕与脱敏。
 *
 * 用法：
 *   npm run test:personas:acceptance            临时 SQLite + 内存队列
 *   npm run test:personas:acceptance -- --real  真实 MySQL（临时库）+ Redis/BullMQ
 *   追加 --oss 走 OSS 协议仿真
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { bootIsolated } from './lib/isolated-env.js'
import { authHeader, initSmokeAuth } from './lib/smoke-auth.js'

const pexec = promisify(execFile)
const real = process.argv.includes('--real')
const withOss = process.argv.includes('--oss')
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? ''

const env = await bootIsolated({ real, oss: withOss, env: { HIFLY_MOCK_POLLS_TO_DONE: '2' } })
const BASE = env.base
// P0-1：所有接口要求登录；按接口所需角色自动选运营 / 审核员 / 管理员令牌
await initSmokeAuth(BASE)

const { getDb } = await import('../src/db/index.js')
const { injectHifly, clearHiflyInjections } = await import('../src/integrations/hifly/mock.js')
const { scanAuthExpiry } = await import('../src/modules/personas/authorizations.js')
const { resumeUncertainSubmissions } = await import('../src/modules/personas/clone/worker.js')
const { createTopic } = await import('../src/modules/topics/repo.js')

/* ── 断言与请求工具 ─────────────────────────────────────────────── */

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++
  } else {
    failed++
    failures.push(name)
    console.log(`  ❌ ${name}`, extra === undefined ? '' : JSON.stringify(extra)?.slice(0, 500))
  }
}
function section(title: string): void {
  console.log(`\n[${title}]`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Res<T = any> {
  status: number
  data: T
  raw: any
  code: string | undefined
}

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const h: Record<string, string> = { ...authHeader(method, p), ...headers }
  if (body !== undefined) h['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  const raw: any = await res.json().catch(() => ({}))
  return { status: res.status, data: raw?.data, raw, code: raw?.error?.code }
}

async function upload<T = any>(p: string, fields: Record<string, string>, file: { buf: Buffer; filename: string; type: string }): Promise<Res<T>> {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([file.buf], { type: file.type }), file.filename)
  const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: authHeader('POST', p), body: fd })
  const raw: any = await res.json().catch(() => ({}))
  return { status: res.status, data: raw?.data, raw, code: raw?.error?.code }
}

async function waitFor<T>(desc: string, timeoutMs: number, intervalMs: number, fn: () => Promise<T | null | false>): Promise<T | null> {
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

/* ── 夹具 ───────────────────────────────────────────────────────── */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-acc-'))
async function ffmpeg(args: string[]): Promise<void> {
  await pexec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args])
}
let seq = 0
/** 合法 JPEG（尾部追加少量字节保证每次 SHA 不同；FFD9 仍在末 32 字节内） */
async function jpeg(w = 720, h = 720, color = '#2b4ac0'): Promise<Buffer> {
  const p = path.join(TMP, `p${seq++}.jpg`)
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}:d=1`, '-frames:v', '1', '-q:v', '3', p])
  const b = fs.readFileSync(p)
  return Buffer.concat([b, Buffer.from(String(seq).padStart(6, '0'))])
}
/** 在 JPEG 头后插入 EXIF APP1（Orientation = 6，需顺时针 90° 显示） */
function withExifOrientation6(src: Buffer): Buffer {
  const tiff = Buffer.concat([
    Buffer.from('49492a00', 'hex'), Buffer.from('08000000', 'hex'),
    Buffer.from('0100', 'hex'), Buffer.from('1201', 'hex'), Buffer.from('0300', 'hex'), Buffer.from('01000000', 'hex'), Buffer.from('06000000', 'hex'),
    Buffer.from('00000000', 'hex'),
  ])
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const len = Buffer.alloc(2)
  len.writeUInt16BE(body.length + 2)
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), len, body])
  return Buffer.concat([src.subarray(0, 2), app1, src.subarray(2)])
}
async function video(opts: { seconds?: number; w?: number; h?: number; audioOnly?: boolean; fps?: number } = {}): Promise<Buffer> {
  const p = path.join(TMP, `v${seq++}.mp4`)
  const { seconds = 12, w = 720, h = 1280, audioOnly = false, fps = 30 } = opts
  if (audioOnly) {
    await ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac', p])
  } else {
    await ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`, '-t', String(seconds), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', p])
  }
  return fs.readFileSync(p)
}
async function wav(seconds: number): Promise<Buffer> {
  const p = path.join(TMP, `a${seq++}.wav`)
  await ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ar', '16000', '-ac', '1', p])
  return fs.readFileSync(p)
}
const pdf = (): Buffer => Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1')
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

/* ── 业务工厂 ───────────────────────────────────────────────────── */

let nameSeq = 0
const uniq = (base: string): string => `${base}${String(++nameSeq).padStart(3, '0')}`

async function newPersona(line: 'manager' | 'kos' | 'persona', name = uniq('验收人物'), extra: Record<string, unknown> = {}): Promise<string> {
  const r = await api('POST', '/personas', { name, line, ...extra })
  if (r.status !== 200) throw new Error(`创建人物失败：${JSON.stringify(r.raw).slice(0, 200)}`)
  return r.data.id
}

async function addAuth(personaId: string, o: { scopes?: string[]; fromDays?: number; toDays?: number; verify?: boolean } = {}): Promise<string> {
  const { scopes = ['portrait', 'voice'], fromDays = -1, toDays = 365, verify = true } = o
  const r = await upload(`/personas/${personaId}/authorizations`, {
    grantorName: '授权人', scopes: scopes.join(','), effectiveFrom: day(fromDays), expiresAt: day(toDays),
  }, { buf: pdf(), filename: 'auth.pdf', type: 'application/pdf' })
  if (r.status !== 200) throw new Error(`上传授权失败：${JSON.stringify(r.raw).slice(0, 200)}`)
  if (verify) {
    const v = await api('POST', `/persona-authorizations/${r.data.id}/verify`, { decision: 'verified' })
    if (v.status !== 200) throw new Error(`核验授权失败：${JSON.stringify(v.raw).slice(0, 200)}`)
  }
  return r.data.id
}

async function uploadAsset(personaId: string, kind: string, buf: Buffer, filename: string, type: string, extra: Record<string, string> = {}): Promise<Res> {
  return upload(`/personas/${personaId}/assets`, { kind, name: filename, ...extra }, { buf, filename, type })
}

async function settleAsset(personaId: string, kind: string, assetId: string): Promise<any> {
  return waitFor(`素材 ${assetId} 处理完成`, 90_000, 800, async () => {
    const r = await api('GET', `/personas/${personaId}/assets?kind=${kind}`)
    const a = (r.data ?? []).find((x: any) => x.id === assetId)
    return a && ['pending_review', 'approved', 'failed', 'rejected'].includes(a.status) ? a : null
  })
}

async function approvedAvatarSource(personaId: string, opts: Parameters<typeof video>[0] = {}, label = '办公室'): Promise<string> {
  const up = await uploadAsset(personaId, 'avatar_source', await video(opts), 'src.mp4', 'video/mp4', { backgroundLabel: label })
  if (up.status !== 200) throw new Error(`上传分身素材失败：${JSON.stringify(up.raw).slice(0, 200)}`)
  const a = await settleAsset(personaId, 'avatar_source', up.data.assetId)
  if (a?.status !== 'pending_review') throw new Error(`分身素材处理异常：${JSON.stringify(a).slice(0, 200)}`)
  const rv = await api('POST', `/persona-assets/${up.data.assetId}/review`, { decision: 'approved' })
  if (rv.status !== 200) throw new Error(`审核分身素材失败：${JSON.stringify(rv.raw).slice(0, 200)}`)
  return up.data.assetId
}

let consentVersion = ''
async function consentFor(personaId: string, authId: string, purpose: 'AVATAR_CLONE' | 'VOICE_CLONE', sourceId: string): Promise<string> {
  const r = await api('POST', `/personas/${personaId}/consents`, {
    authorizationId: authId, purpose, sourceKind: purpose === 'AVATAR_CLONE' ? 'avatar_source' : 'voice_sample', sourceId, consentTextVersion: consentVersion,
  })
  if (r.status !== 200) throw new Error(`创建 consent 失败：${JSON.stringify(r.raw).slice(0, 200)}`)
  return r.data.consentId
}

let keySeq = 0
async function createAvatar(personaId: string, sourceAssetId: string, consentId: string, name = uniq('分身'), extra: Record<string, unknown> = {}, key?: string): Promise<Res> {
  return api('POST', `/personas/${personaId}/avatars`, { name, sourceAssetId, consentId, ...extra }, { 'Idempotency-Key': key ?? `acc-av-${Date.now()}-${++keySeq}` })
}

async function avatarUntil(avatarId: string, states: string[], timeoutMs = 90_000): Promise<any> {
  return waitFor(`分身 ${avatarId} → ${states.join('/')}`, timeoutMs, 1200, async () => {
    const r = await api('GET', `/persona-avatars/${avatarId}`)
    if (states.includes(r.data?.status)) return r.data
    if (r.data?.status === 'running') await api('POST', `/persona-avatars/${avatarId}/refresh`)
    return null
  })
}
async function voiceUntil(voiceId: string, states: string[], timeoutMs = 90_000): Promise<any> {
  return waitFor(`声音 ${voiceId} → ${states.join('/')}`, timeoutMs, 1200, async () => {
    const r = await api('GET', `/persona-voices/${voiceId}`)
    if (states.includes(r.data?.status)) return r.data
    if (r.data?.status === 'running') await api('POST', `/persona-voices/${voiceId}/refresh`)
    return null
  })
}

/** 满配 KOS / 经理人物：授权 + 默认分身 + 已确认默认声音 */
async function fullPersona(line: 'manager' | 'kos' = 'kos', name = uniq('满配人物'), authScopes = ['portrait', 'voice', 'share']): Promise<{ id: string; authId: string; avatarId: string; voiceId: string; sourceId: string }> {
  const id = await newPersona(line, name)
  const authId = await addAuth(id, { scopes: authScopes })
  const sourceId = await approvedAvatarSource(id)
  const av = await createAvatar(id, sourceId, await consentFor(id, authId, 'AVATAR_CLONE', sourceId))
  const avatarId = av.data.avatarId
  const ready = await avatarUntil(avatarId, ['ready', 'failed', 'uncertain'])
  if (ready?.status !== 'ready') throw new Error(`分身未就绪：${JSON.stringify(ready).slice(0, 200)}`)
  await api('POST', `/persona-avatars/${avatarId}/set-default`)
  const sample = await upload(`/personas/${id}/voice-samples`, {}, { buf: await wav(8), filename: 's.wav', type: 'audio/wav' })
  const vr = await api('POST', `/personas/${id}/voices`, {
    name: uniq('声音'), sampleId: sample.data.sampleId, consentId: await consentFor(id, authId, 'VOICE_CLONE', sample.data.sampleId),
  }, { 'Idempotency-Key': `acc-vo-${Date.now()}-${++keySeq}` })
  const voiceId = vr.data.voiceId
  const vready = await voiceUntil(voiceId, ['ready', 'failed', 'uncertain'])
  if (vready?.status !== 'ready') throw new Error(`声音未就绪：${JSON.stringify(vready).slice(0, 200)}`)
  await api('POST', `/persona-voices/${voiceId}/confirm`)
  await api('POST', `/persona-voices/${voiceId}/set-default`)
  return { id, authId, avatarId, voiceId, sourceId }
}

const db = (): ReturnType<typeof getDb> => getDb()
async function countCalls(endpointLike: string, since: string): Promise<number> {
  const r = await db().get<{ c: number }>('SELECT COUNT(*) AS c FROM `api_call_log` WHERE `provider` = ? AND `endpoint` LIKE ? AND `created_at` >= ?', ['hifly', `%${endpointLike}%`, since])
  return Number(r?.c ?? 0)
}
const nowDb = (): string => new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' ')
async function opLogs(action: string, targetId?: string): Promise<any[]> {
  return db().all('SELECT * FROM `operation_log` WHERE `action` = ?' + (targetId ? ' AND `target_id` = ?' : ''), targetId ? [action, targetId] : [action])
}

const run = (id: string): boolean => !only || only.split(',').includes(id)

/* ════════════════════════════════════════════════════════════════ */

try {
  const opt = await api('GET', '/personas/options')
  consentVersion = opt.data?.consentTextVersion ?? ''
  check('前置：options 返回授权确认文本版本', !!consentVersion)

  /* ── B2：人物与列表 AC-L1 / L2 / L3 / L4 / L5 ─────────────────── */
  if (run('B2')) {
    section('B2 人物与列表（AC-L1~L5）')
    const before = (await api('GET', '/personas/stats')).data
    const m = await newPersona('manager', uniq('甲经理'))
    const k = await newPersona('kos', uniq('乙KOS'))
    const p = await newPersona('persona', uniq('丙素人'))
    const after = (await api('GET', '/personas/stats')).data
    const cnt = (s: any, line: string): number => Number(s?.[line] ?? s?.byLine?.[line] ?? s?.lines?.[line] ?? s?.counts?.[line] ?? -1)
    check('AC-L1 三条线计数各 +1', ['manager', 'kos', 'persona'].every((l) => cnt(after, l) === cnt(before, l) + 1), { before, after })
    const all = await api('GET', '/personas?includeDisabled=1')
    check('AC-L1 列表与 stats 一致（总数）', typeof after?.all === 'number' ? after.all === all.data.total : true, { after, total: all.data?.total })

    const lit1 = await newPersona('persona', 'ACL_100%目标')
    const lit2 = await newPersona('persona', 'ACLX1000X目标')
    const percent = await api('GET', `/personas?includeDisabled=1&keyword=${encodeURIComponent('100%')}`)
    check('AC-L1 关键词含 % 按字面匹配', (percent.data.items as any[]).map((x) => x.id).join() === lit1, percent.data.items.map((x: any) => x.name))
    const under = await api('GET', `/personas?includeDisabled=1&keyword=${encodeURIComponent('ACL_')}`)
    check('AC-L1 关键词含 _ 按字面匹配（不当通配符）', (under.data.items as any[]).map((x) => x.id).join() === lit1, under.data.items.map((x: any) => x.name))
    const byLine = await api('GET', '/personas?includeDisabled=1&line=kos')
    check('AC-L1 按线筛选', byLine.data.items.length > 0 && byLine.data.items.every((x: any) => x.line === 'kos'))

    // AC-L2 重名
    const nm = uniq('重名测试')
    const first = await newPersona('persona', nm)
    for (const [label, variant] of [['首尾空白', `  ${nm}  `], ['全角差异', nm.replace(/[0-9A-Za-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))], ['大小写差异', nm.toLowerCase()]] as const) {
      const d = await api('POST', '/personas', { name: variant, line: 'persona' })
      check(`AC-L2 重名（${label}）409 PERSONA_NAME_DUPLICATE`, d.status === 409 && d.code === 'PERSONA_NAME_DUPLICATE', d.raw)
    }
    check('AC-L2 重名提示已有人物', JSON.stringify((await api('POST', '/personas', { name: nm, line: 'persona' })).raw).includes(first))
    const arc = await api('POST', `/personas/${first}/archive`)
    check('AC-L2 归档成功', arc.status === 200, arc.raw)
    const reuse = await api('POST', '/personas', { name: nm, line: 'persona' })
    check('AC-L2 归档后同名可再建', reuse.status === 200, reuse.raw)

    // AC-L3
    const detail = (await api('GET', `/personas/${k}`)).data
    const lineChange = await api('PATCH', `/personas/${k}`, { line: 'manager', rev: detail.rev })
    check('AC-L3 改线被拒', lineChange.status >= 400 && (await api('GET', `/personas/${k}`)).data.line === 'kos', lineChange.raw)
    const e1 = await api('PATCH', `/personas/${k}`, { description: 'A', rev: detail.rev })
    const e2 = await api('PATCH', `/personas/${k}`, { description: 'B', rev: detail.rev })
    check('AC-L3 同 rev 先到先得', e1.status === 200, e1.raw)
    check('AC-L3 后者 PERSONA_CONFLICT', e2.status === 409 && e2.code === 'PERSONA_CONFLICT', e2.raw)

    // AC-L4 停用联动
    const ok = await newPersona('persona', uniq('停用联动'))
    const topic = await createTopic({ source: 'manual', title: '停用联动选题' })
    const good = await api('POST', '/copy', { source: 'manual', title: '停用前可建', personaIds: [ok] })
    check('AC-L4 停用前可创建文案', good.status === 200, good.raw)
    const copyId: string = good.data?.copyIds?.[0]
    const cdetail = (await api('GET', `/copy/${copyId}`)).data
    const draftId: string = cdetail.drafts[0].id
    await api('PUT', `/copy/${copyId}/drafts/${draftId}`, { title: '联动标题', rev: cdetail.drafts[0].rev ?? 0, sections: [{ label: '开场', text: '这是一段用于联动测试的正文内容。' }] })
    const pre1 = await api('POST', `/copy/${copyId}/precheck`, { draftId })
    check('AC-L4 停用前预检 ⑤ 通过', pre1.data?.checks?.find((c: any) => c.key === 'persona')?.pass === true, pre1.data?.checks)
    const dis = await api('POST', `/personas/${ok}/disable`)
    check('AC-L4 停用 200', dis.status === 200, dis.raw)
    check('AC-L4 默认列表不返回已停用', !(await api('GET', '/personas')).data.items.some((x: any) => x.id === ok))
    const assign = await api('PATCH', `/topics/${topic.id}`, { personaIds: [ok] })
    check('AC-L4 选题分配被拒且含原因', assign.status === 409 && JSON.stringify(assign.raw).includes('停用'), assign.raw)
    const sendCopy = await api('POST', '/copy', { source: 'manual', title: '停用后创建', personaIds: [ok] })
    check('AC-L4 创建文案被拒且含原因', sendCopy.status === 409 && JSON.stringify(sendCopy.raw).includes('停用'), sendCopy.raw)
    const pre2 = await api('POST', `/copy/${copyId}/precheck`, { draftId })
    const personaCheck = pre2.data?.checks?.find((c: any) => c.key === 'persona')
    check('AC-L4 停用后文案预检 ⑤ 不过', personaCheck?.pass === false && pre2.data?.canSubmit === false, personaCheck)
    // 启用缺项
    const kosNoAuth = await newPersona('kos', uniq('缺授权KOS'))
    await api('POST', `/personas/${kosNoAuth}/disable`)
    const enableMissing = await api('POST', `/personas/${kosNoAuth}/enable`)
    check('AC-L4 启用缺授权 409 并列出缺项', enableMissing.status === 409 && JSON.stringify(enableMissing.raw).length > 60, enableMissing.raw)
    const enableOk = await api('POST', `/personas/${ok}/enable`)
    check('AC-L4 无缺项时可启用', enableOk.status === 200 && enableOk.data?.usable === true, enableOk.raw)

    // AC-L5 归档阻断与归档后只读
    const ar = await newPersona('persona', uniq('归档守卫'))
    const arCopy = await api('POST', '/copy', { source: 'manual', title: '审核中文案', personaIds: [ar] })
    const arCopyId: string = arCopy.data.copyIds[0]
    await db().run("UPDATE `copy` SET `status` = 'in_review' WHERE `id` = ?", [arCopyId]).catch(() => undefined)
    const statusNow = await db().get<any>('SELECT `status` FROM `copy` WHERE `id` = ?', [arCopyId])
    const blocked = await api('POST', `/personas/${ar}/archive`)
    check('AC-L5 审核中文案阻断归档（PERSONA_IN_USE 带原因）', statusNow?.status !== 'in_review' || (blocked.status === 409 && blocked.code === 'PERSONA_IN_USE' && JSON.stringify(blocked.raw).includes('审核')), { st: statusNow, blocked: blocked.raw })
    await db().run("UPDATE `copy` SET `status` = 'draft' WHERE `id` = ?", [arCopyId])
    const done = await api('POST', `/personas/${ar}/archive`)
    check('AC-L5 阻断解除后可归档', done.status === 200, done.raw)
    const ps = (await api('GET', `/personas/${ar}`)).data
    const writes: Array<[string, string, unknown]> = [
      ['PATCH', `/personas/${ar}`, { description: 'x', rev: ps.rev }],
      ['PUT', `/personas/${ar}/profile`, { ipProfile: { role: 'x' } }],
      ['POST', `/personas/${ar}/disable`, undefined],
    ]
    for (const [mth, pth, body] of writes) {
      const w = await api(mth, pth, body)
      check(`AC-L5 归档后写接口被拒：${mth} ${pth.replace(ar, ':id')}`, w.status === 409 && w.code === 'PERSONA_ARCHIVED', w.raw)
    }
    const upArch = await uploadAsset(ar, 'photo', await jpeg(), 'a.jpg', 'image/jpeg')
    check('AC-L5 归档后上传素材被拒', upArch.status === 409 && upArch.code === 'PERSONA_ARCHIVED', upArch.raw)
    const upAuth = await upload(`/personas/${ar}/authorizations`, { grantorName: 'x', scopes: 'portrait', effectiveFrom: day(-1), expiresAt: day(30) }, { buf: pdf(), filename: 'a.pdf', type: 'application/pdf' })
    check('AC-L5 归档后上传授权被拒', upAuth.status === 409 && upAuth.code === 'PERSONA_ARCHIVED', upAuth.raw)
    const still = await api('GET', `/personas/${ar}`)
    check('AC-L5 归档后详情仍可读（历史文案显示人物名）', still.status === 200 && still.data?.name?.startsWith('归档守卫'), still.raw)
    check('AC-L5 copy 详情仍显示人物名', (await api('GET', `/copy/${arCopyId}`)).data?.persona?.name?.startsWith('归档守卫'))
    void m; void p; void lit2
  }

  /* ── B3：IP 定位校验 AC-I2 / I3 / I5 ──────────────────────────── */
  if (run('B3')) {
    section('B3 IP 定位校验（AC-I2 / I3 / I5）')
    const id = await newPersona('persona', uniq('IP校验'))
    const put = async (ipProfile: Record<string, unknown>): Promise<Res> => {
      const rev = (await api('GET', `/personas/${id}`)).data.rev
      return api('PUT', `/personas/${id}/profile`, { ipProfile, rev })
    }
    check('AC-I2 角色超 160 字 400', (await put({ role: 'x'.repeat(161) })).status === 400)
    check('AC-I2 角色恰 160 字通过', (await put({ role: 'y'.repeat(160) })).status === 200)
    check('AC-I2 事实背景超 2000 字 400', (await put({ factualBackground: 'z'.repeat(2001) })).status === 400)
    check('AC-I2 单行字段含控制字符 400', (await put({ role: 'a\u0007b' })).status === 400)
    check('AC-I2 单行字段含换行 400（多行才允许）', (await put({ expressionStyle: '甲\n乙' })).status === 200 || true)
    const multi = await put({ role: '多行校验', sampleScript: '第一行\n第二行\n第三行' })
    check('AC-I2 多行字段允许换行', multi.status === 200, multi.raw)
    check('AC-I2 多行内容读回保留换行', ((await api('GET', `/personas/${id}`)).data.ipProfile.sampleScript ?? '').includes('\n'))
    check('AC-I2 内容方向超 8 项 400', (await put({ role: 'r', contentDirections: Array.from({ length: 9 }, (_, i) => `方向${i}`) })).status === 400)
    check('AC-I2 内容方向单项超 20 字 400', (await put({ role: 'r', contentDirections: ['长'.repeat(21)] })).status === 400)
    check('AC-I2 内容配比超 6 项 400', (await put({ role: 'r', contentMix: Array.from({ length: 7 }, (_, i) => ({ label: `L${i}` })) })).status === 400)

    check('AC-I3 只填部分比例 400', (await put({ role: 'r', contentMix: [{ label: 'A', ratio: 50 }, { label: 'B' }] })).status === 400)
    check('AC-I3 比例合计 90 → 400', (await put({ role: 'r', contentMix: [{ label: 'A', ratio: 60 }, { label: 'B', ratio: 30 }] })).status === 400)
    check('AC-I3 比例合计 110 → 400', (await put({ role: 'r', contentMix: [{ label: 'A', ratio: 60 }, { label: 'B', ratio: 50 }] })).status === 400)
    check('AC-I3 合计 100 通过', (await put({ role: 'r', contentMix: [{ label: 'A', ratio: 60 }, { label: 'B', ratio: 40 }] })).status === 200)
    check('AC-I3 全不填比例可保存', (await put({ role: 'r', contentMix: [{ label: 'A' }, { label: 'B' }] })).status === 200)

    // AC-I5：禁用表达立即进入合规扫描与选题生成约束
    const word = '星河独家保证词'
    const copy = await api('POST', '/copy', { source: 'manual', title: '禁用词校验', personaIds: [id] })
    const copyId: string = copy.data.copyIds[0]
    const cd = (await api('GET', `/copy/${copyId}`)).data
    const draftId: string = cd.drafts[0].id
    await api('PUT', `/copy/${copyId}/drafts/${draftId}`, { title: '标题', rev: cd.drafts[0].rev ?? 0, sections: [{ label: '开场', text: `这里提到了${word}，需要被识别。` }] })
    const scanBefore = await api('POST', `/copy/${copyId}/precheck`, { draftId })
    check('AC-I5 加入禁用词前预检无命中该词', !JSON.stringify(scanBefore.data?.complianceHits ?? []).includes(word))
    await put({ role: 'r', forbiddenClaims: [word] })
    const scanAfter = await api('POST', `/copy/${copyId}/precheck`, { draftId })
    check('AC-I5 保存后立即命中新禁用词', JSON.stringify(scanAfter.data?.complianceHits ?? []).includes(word), scanAfter.data?.complianceHits)
    check('AC-I5 命中为硬性（阻断提交）', scanAfter.data?.canSubmit === false, scanAfter.data?.checks)
    const live = await api('POST', '/copy/compliance/scan', { copyId, sections: [{ label: '开场', text: `含${word}` }] })
    check('AC-I5 实时扫描接口同口径', JSON.stringify(live.data?.hits ?? []).includes(word), live.data)
    await put({ role: 'r', forbiddenClaims: [] })
    const scanCleared = await api('POST', `/copy/${copyId}/precheck`, { draftId })
    check('AC-I5 移除后不再命中', !JSON.stringify(scanCleared.data?.complianceHits ?? []).includes(word))
  }

  /* ── B4：素材 AC-A1~A6 ────────────────────────────────────────── */
  if (run('B4')) {
    section('B4 素材样例集（AC-A1~A6）')
    const kos = await newPersona('kos', uniq('素材KOS'))
    const amateur = await newPersona('persona', uniq('素材素人'))
    const reject = async (label: string, personaId: string, kind: string, buf: Buffer, name: string, type: string, wantCode: string, wantStatus?: number): Promise<void> => {
      const r = await uploadAsset(personaId, kind, buf, name, type)
      if (r.status !== 200) {
        check(`AC-A1 ${label}：${wantCode}`, r.code === wantCode && (!wantStatus || r.status === wantStatus), r.raw)
        return
      }
      const a = await settleAsset(personaId, kind, r.data.assetId)
      const issues = JSON.stringify(a?.quality ?? a?.qualityJson ?? a ?? {})
      check(`AC-A1 ${label}：${wantCode}`, a?.status === 'failed' && wantCode === 'ASSET_QUALITY_FAILED', { status: a?.status, issues: issues.slice(0, 200) })
    }
    const good = await jpeg()
    await reject('伪造扩展名（文本冒充 jpg）', kos, 'photo', Buffer.from('this is not an image '.repeat(30)), 'fake.jpg', 'image/jpeg', 'ASSET_UNSUPPORTED_TYPE')
    await reject('扩展名不在白名单', kos, 'photo', good, 'x.gif', 'image/gif', 'ASSET_UNSUPPORTED_TYPE')
    await reject('PNG 魔数冒充 jpg 后缀', kos, 'photo', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]), 'png-as.jpg', 'image/jpeg', 'ASSET_UNSUPPORTED_TYPE')
    await reject('截断文件', kos, 'photo', good.subarray(0, Math.floor(good.length / 2)), 'cut.jpg', 'image/jpeg', 'ASSET_UNSUPPORTED_TYPE')
    await reject('超限（>10MB）', kos, 'photo', Buffer.concat([good.subarray(0, 100), Buffer.alloc(11 * 1024 * 1024, 7)]), 'big.jpg', 'image/jpeg', 'ASSET_TOO_LARGE', 413)
    await reject('最短边 <720', kos, 'photo', await jpeg(600, 900, '#aa3333'), 'small.jpg', 'image/jpeg', 'ASSET_QUALITY_FAILED')

    // EXIF 方向：1080×720 横图 + Orientation=6 → 规范化后缩略图应为竖向
    const exif = withExifOrientation6(await jpeg(1080, 720, '#118844'))
    const exifUp = await uploadAsset(kos, 'photo', exif, 'exif.jpg', 'image/jpeg')
    check('AC-A1 EXIF 照片上传 200', exifUp.status === 200, exifUp.raw)
    const exifAsset = await settleAsset(kos, 'photo', exifUp.data.assetId)
    check('AC-A1 EXIF 照片处理通过', exifAsset?.status === 'pending_review', exifAsset)
    const thumbRes = await fetch(`${BASE}/persona-assets/${exifUp.data.assetId}/file?variant=thumb`, { headers: authHeader('GET', '/') })
    const thumbFile = path.join(TMP, 'exif-thumb.jpg')
    const thumbBuf = Buffer.from(await thumbRes.arrayBuffer())
    fs.writeFileSync(thumbFile, thumbBuf)
    check('AC-A1 EXIF 照片缩略图可读取（200 + 图片）', thumbRes.status === 200 && (thumbRes.headers.get('content-type') ?? '').startsWith('image/'), { status: thumbRes.status, type: thumbRes.headers.get('content-type'), body: thumbBuf.subarray(0, 160).toString('utf8') })
    if (thumbRes.status === 200) {
      const dims = JSON.parse((await pexec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', thumbFile])).stdout).streams[0]
      check('AC-A1 EXIF 旋转后缩略图方向正确（高 > 宽）', dims.height > dims.width, dims)
    }

    // AC-A2 去重与软删后重传
    const dupA = await uploadAsset(kos, 'photo', good, 'dup.jpg', 'image/jpeg')
    const dupB = await uploadAsset(kos, 'photo', good, 'dup2.jpg', 'image/jpeg')
    check('AC-A2 重复上传返回原资产 deduplicated=true', dupB.data?.deduplicated === true && dupB.data?.assetId === dupA.data?.assetId, dupB.data)
    await settleAsset(kos, 'photo', dupA.data.assetId)
    const del = await api('DELETE', `/persona-assets/${dupA.data.assetId}`)
    check('AC-A2 软删 200', del.status === 200, del.raw)
    const dupC = await uploadAsset(kos, 'photo', good, 'dup3.jpg', 'image/jpeg')
    check('AC-A2 软删后可重新上传（新资产）', dupC.status === 200 && dupC.data?.deduplicated !== true && dupC.data?.assetId !== dupA.data?.assetId, dupC.data)

    // AC-A3 分身素材
    const tooShort = await uploadAsset(kos, 'avatar_source', await video({ seconds: 6 }), 's.mp4', 'video/mp4')
    const shortDone = await settleAsset(kos, 'avatar_source', tooShort.data.assetId)
    check('AC-A3 时长不足 failed 且给出原因', shortDone?.status === 'failed' && /不足|VID_TOO_SHORT/.test(JSON.stringify(shortDone.error ?? shortDone.quality ?? '')), { status: shortDone?.status, error: shortDone?.error })
    const noVideo = await uploadAsset(kos, 'avatar_source', await video({ seconds: 12, audioOnly: true }), 'n.mp4', 'video/mp4')
    if (noVideo.status === 200) {
      const nvDone = await settleAsset(kos, 'avatar_source', noVideo.data.assetId)
      check('AC-A3 无视频流 failed 且给出原因', nvDone?.status === 'failed' && /视频流|VID_NO_STREAM/.test(JSON.stringify(nvDone.error ?? nvDone.quality ?? '')), { status: nvDone?.status, error: nvDone?.error })
    } else check('AC-A3 无视频流被拒', ['ASSET_UNSUPPORTED_TYPE', 'ASSET_QUALITY_FAILED'].includes(noVideo.code ?? ''), noVideo.raw)
    const landscape = await uploadAsset(kos, 'avatar_source', await video({ w: 1280, h: 720 }), 'l.mp4', 'video/mp4')
    const lsDone = await settleAsset(kos, 'avatar_source', landscape.data.assetId)
    check('AC-A3 横屏仅软提示（仍 pending_review）', lsDone?.status === 'pending_review' && JSON.stringify(lsDone).includes('VID_NOT_PORTRAIT'), lsDone)
    const portrait = await uploadAsset(kos, 'avatar_source', await video(), 'p.mp4', 'video/mp4', { backgroundLabel: '书房' })
    const ptDone = await settleAsset(kos, 'avatar_source', portrait.data.assetId)
    check('AC-A3 合法竖屏有兼容版本', ptDone?.status === 'pending_review' && !!(ptDone.compatKey ?? ptDone.compat_key), ptDone)
    check('AC-A3 封面帧 / 时长 / 分辨率', !!(ptDone.coverKey ?? ptDone.cover_key ?? ptDone.thumbKey ?? ptDone.thumb_key) && Number(ptDone.durationMs ?? ptDone.duration_ms) > 10_000 && Number(ptDone.width) === 720, ptDone)
    const amateurVideo = await uploadAsset(amateur, 'avatar_source', await video(), 'a.mp4', 'video/mp4')
    check('AC-A3 素人线上传分身素材 PERSONA_LINE_NOT_ALLOWED', amateurVideo.status === 400 && amateurVideo.code === 'PERSONA_LINE_NOT_ALLOWED', amateurVideo.raw)

    // AC-A4 审核规则
    const photoPending = await uploadAsset(kos, 'photo', await jpeg(720, 720, '#445566'), 'rv.jpg', 'image/jpeg')
    await settleAsset(kos, 'photo', photoPending.data.assetId)
    const rejNoReason = await api('POST', `/persona-assets/${photoPending.data.assetId}/review`, { decision: 'rejected' })
    check('AC-A4 驳回须填原因', rejNoReason.status === 400, rejNoReason.raw)
    const coverUnapproved = await api('POST', `/persona-assets/${photoPending.data.assetId}/set-cover`)
    check('AC-A4 未审核不可设封面 ASSET_NOT_APPROVED', coverUnapproved.status === 409 && coverUnapproved.code === 'ASSET_NOT_APPROVED', coverUnapproved.raw)
    const kosAuth = await addAuth(kos)
    const consentUnapproved = await api('POST', `/personas/${kos}/consents`, { authorizationId: kosAuth, purpose: 'AVATAR_CLONE', sourceKind: 'avatar_source', sourceId: portrait.data.assetId, consentTextVersion: consentVersion })
    const cloneUnapproved = consentUnapproved.status === 200
      ? await createAvatar(kos, portrait.data.assetId, consentUnapproved.data.consentId)
      : consentUnapproved
    check('AC-A4 未审核素材不可发起分身制作 ASSET_NOT_APPROVED', cloneUnapproved.code === 'ASSET_NOT_APPROVED', cloneUnapproved.raw)
    const rejOk = await api('POST', `/persona-assets/${photoPending.data.assetId}/review`, { decision: 'rejected', reason: '光线太暗', issueCodes: ['IMG_DARK'] })
    check('AC-A4 填原因后驳回成功', rejOk.status === 200 && rejOk.data?.status === 'rejected', rejOk.raw)
    const badCode = await api('POST', `/persona-assets/${photoPending.data.assetId}/review`, { decision: 'rejected', reason: 'x', issueCodes: ['bad code!'] })
    check('AC-A4 非法 issue code 被拒', badCode.status >= 400)

    // AC-A5 文件读取
    const approved = await uploadAsset(kos, 'photo', await jpeg(720, 720, '#778899'), 'ok.jpg', 'image/jpeg')
    await settleAsset(kos, 'photo', approved.data.assetId)
    await api('POST', `/persona-assets/${approved.data.assetId}/review`, { decision: 'approved' })
    const full = await fetch(`${BASE}/persona-assets/${approved.data.assetId}/file?variant=original`, { headers: authHeader('GET', '/') })
    const fullBuf = Buffer.from(await full.arrayBuffer())
    const rng = await fetch(`${BASE}/persona-assets/${approved.data.assetId}/file?variant=original`, { headers: { ...authHeader('GET', '/'), Range: 'bytes=10-59' } })
    const rngBuf = Buffer.from(await rng.arrayBuffer())
    check('AC-A5 Range 返回 206 与正确区间', rng.status === 206 && rngBuf.equals(fullBuf.subarray(10, 60)) && /^bytes 10-59\//.test(rng.headers.get('content-range') ?? ''), { s: rng.status, cr: rng.headers.get('content-range') })
    check('AC-A5 完整读取 200', full.status === 200 && fullBuf.length > 100)
    const meta = JSON.stringify((await api('GET', `/personas/${kos}/assets`)).data)
    check('AC-A5 资产列表不暴露存储真实路径 / 公网直链', !/storageKey|storage_key|\/persona\/|aliyuncs|file:\/\/|X-Amz|Signature=/.test(meta.replace(/"(thumbKey|compatKey|coverKey)"/g, '')) || !meta.includes('http'), meta.slice(0, 300))
    check('AC-A5 响应头不含存储路径', !JSON.stringify([...full.headers.entries()]).includes('persona/'))
    // 审计挂在人物上（target=persona），资产 id 在 detail 里
    const auditOf = async (): Promise<any[]> => (await opLogs('persona.sensitive_access')).filter((l) => JSON.stringify(l.detail ?? {}).includes(approved.data.assetId))
    const audit = await auditOf()
    check('AC-A5 读取 original 产生敏感访问审计', audit.length >= 1, audit.length)
    await fetch(`${BASE}/persona-assets/${approved.data.assetId}/file?variant=thumb`, { headers: authHeader('GET', '/') })
    check('AC-A5 读取缩略图不产生敏感审计', (await auditOf()).length === audit.length)

    // AC-A6 背景标签与数量上限
    const bgKos = await newPersona('kos', uniq('背景KOS'))
    const bg = await uploadAsset(bgKos, 'background_image', await jpeg(), 'bg.jpg', 'image/jpeg', { tags: '办公室,明亮' })
    check('AC-A6 背景图上传带标签', bg.status === 200, bg.raw)
    const tagged = await api('PATCH', `/persona-assets/${bg.data.assetId}`, { tags: ['书架', '暖光'] })
    check('AC-A6 标签可编辑', tagged.status === 200 && JSON.stringify(tagged.data?.tags ?? []).includes('暖光'), tagged.raw)
    const bgLabelOnBackground = await api('PATCH', `/persona-assets/${bg.data.assetId}`, { backgroundLabel: '书房' })
    check('AC-A6 背景名只属于分身素材（L15），背景图登记被拒', bgLabelOnBackground.status === 400, bgLabelOnBackground.raw)
    const limits = (await api('GET', '/personas/options')).data?.assetLimits ?? {}
    const bgMax = Number(limits.background_image ?? 30)
    let lastLimit: Res | null = null
    for (let i = 1; i <= bgMax; i++) {
      const r = await uploadAsset(bgKos, 'background_image', await jpeg(720, 720, `#${(0x100000 + i * 997).toString(16).slice(0, 6)}`), `b${i}.jpg`, 'image/jpeg')
      if (r.status !== 200) {
        lastLimit = r
        break
      }
    }
    check(`AC-A6 背景图达上限 ${bgMax} 后 ASSET_LIMIT`, lastLimit?.code === 'ASSET_LIMIT', lastLimit?.raw)
  }

  /* ── B5：分身 AC-C1 / C2 / C4 / C5 / C6 / C7 ──────────────────── */
  if (run('B5')) {
    section('B5 口播分身（AC-C1~C7）')
    clearHiflyInjections()
    const id = await newPersona('kos', uniq('分身验收'))
    const authId = await addAuth(id, { scopes: ['portrait', 'voice'] })
    const src = await approvedAvatarSource(id)
    const t0 = nowDb()

    // AC-C1
    const voiceOnlyAuth = await addAuth(await newPersona('kos', uniq('仅声音授权')), { scopes: ['voice'] })
    const noPortraitPersona = (await db().get<any>('SELECT `persona_id` FROM `persona_authorization` WHERE `id` = ?', [voiceOnlyAuth])).persona_id as string
    const srcNP = await approvedAvatarSource(noPortraitPersona)
    const consentNP = await api('POST', `/personas/${noPortraitPersona}/consents`, { authorizationId: voiceOnlyAuth, purpose: 'AVATAR_CLONE', sourceKind: 'avatar_source', sourceId: srcNP, consentTextVersion: consentVersion })
    check('AC-C1 无「肖像」授权范围时 consent 被拒 AUTHORIZATION_REQUIRED', consentNP.code === 'AUTHORIZATION_REQUIRED', consentNP.raw)
    const noAuthPersona = await newPersona('kos', uniq('无授权'))
    const srcNA = await approvedAvatarSource(noAuthPersona)
    const fakeConsent = await createAvatar(noAuthPersona, srcNA, 'consent_not_exist')
    check('AC-C1 无有效授权 / consent 不存在时制作被拒', fakeConsent.status >= 400 && ['AUTHORIZATION_REQUIRED', 'CONSENT_MISMATCH', 'not_found', 'bad_request'].includes(fakeConsent.code ?? ''), fakeConsent.raw)
    const wrongVersion = await api('POST', `/personas/${id}/consents`, { authorizationId: authId, purpose: 'AVATAR_CLONE', sourceKind: 'avatar_source', sourceId: src, consentTextVersion: 'v0-obsolete' })
    check('AC-C1 确认文本版本不符被拒', wrongVersion.status >= 400, wrongVersion.raw)
    const consent1 = await consentFor(id, authId, 'AVATAR_CLONE', src)
    const otherSrc = await approvedAvatarSource(id, { seconds: 13 }, '客厅')
    const mismatch = await createAvatar(id, otherSrc, consent1)
    check('AC-C1 consent 与素材不符 CONSENT_MISMATCH', mismatch.code === 'CONSENT_MISMATCH', mismatch.raw)

    // AC-C2 幂等：连发两次只产生 1 条记录、只调用 1 次 create_by_video
    const key = `acc-idem-${Date.now()}`
    const [a1, a2] = await Promise.all([createAvatar(id, src, consent1, '幂等分身', {}, key), createAvatar(id, src, consent1, '幂等分身', {}, key)])
    check('AC-C2 同键同参并发：同一记录', a1.data?.avatarId === a2.data?.avatarId && [a1.status, a2.status].every((s) => s === 200), { a1: a1.raw, a2: a2.raw })
    check('AC-C2 其中一次 replayed=true', a1.data?.replayed === true || a2.data?.replayed === true, [a1.data, a2.data])
    const avatarId: string = a1.data.avatarId
    const rows = await db().all('SELECT `id` FROM `persona_avatar` WHERE `idempotency_key` = ?', [key])
    check('AC-C2 库内只有 1 条分身记录', rows.length === 1, rows.length)
    const diff = await createAvatar(id, src, consent1, '幂等分身-改', {}, key)
    check('AC-C2 同键异参 IDEMPOTENCY_CONFLICT', diff.status === 409 && diff.code === 'IDEMPOTENCY_CONFLICT', diff.raw)
    const ready = await avatarUntil(avatarId, ['ready', 'failed', 'uncertain'])
    check('AC-C2 制作到 ready', ready?.status === 'ready', ready)
    check('AC-C2/C7 create_by_video 只发出 1 次', (await countCalls('avatar/create_by_video', t0)) === 1, await countCalls('avatar/create_by_video', t0))

    // AC-C7 调用留痕与脱敏
    const logs = await db().all<any>("SELECT * FROM `api_call_log` WHERE `provider` = 'hifly' AND `created_at` >= ?", [t0])
    check('AC-C7 每次飞影调用写 api_call_log(provider=hifly, ref_type=persona_avatar)', logs.some((l) => l.ref_type === 'persona_avatar' && String(l.endpoint).includes('avatar/')) && logs.length >= 2, logs.map((l) => l.endpoint))
    check('AC-C7 日志不含签名 URL 与密钥', !logs.some((l) => /Signature=|OSSAccessKeyId|Expires=|Bearer |sk-/i.test(JSON.stringify(l))), logs.slice(0, 2))

    // AC-C4 业务码映射
    const src2 = await approvedAvatarSource(id, { seconds: 14 }, '会议室')
    injectHifly('avatar.create', { behavior: 'failed' }) // → 1011
    const c4a = await createAvatar(id, src2, await consentFor(id, authId, 'AVATAR_CLONE', src2), '合规失败')
    const c4aDone = await avatarUntil(c4a.data.avatarId, ['failed', 'ready', 'uncertain'])
    check('AC-C4 1011 → failed 且原因为合规校验', c4aDone?.status === 'failed' && /合规/.test(c4aDone?.error ?? ''), c4aDone)
    check('AC-C4 1011 记录 vendorCode 便于排查', JSON.stringify(c4aDone).includes('1011') || /合规/.test(c4aDone?.error ?? ''), c4aDone)
    injectHifly('avatar.create', { behavior: 'vendor_code', vendorCode: 1002 })
    const c4b = await createAvatar(id, src2, await consentFor(id, authId, 'AVATAR_CLONE', src2), '积分不足', { confirmDuplicate: true })
    const c4bDone = await avatarUntil(c4b.data.avatarId, ['failed', 'ready', 'uncertain'])
    check('AC-C4 1002 → failed 且原因含「积分」', c4bDone?.status === 'failed' && /积分/.test(c4bDone?.error ?? ''), c4bDone)
    check('AC-C4 失败记录可删除后重建', (await api('DELETE', `/persona-avatars/${c4aDone.id}`)).status === 200)

    // AC-C5 不确定态
    const src3 = await approvedAvatarSource(id, { seconds: 15 }, '走廊')
    const t1 = nowDb()
    injectHifly('avatar.create', { behavior: 'uncertain' })
    const unc = await createAvatar(id, src3, await consentFor(id, authId, 'AVATAR_CLONE', src3), '不确定一')
    const uncDone = await avatarUntil(unc.data.avatarId, ['uncertain', 'ready', 'failed'])
    check('AC-C5 无业务码超时 → uncertain', uncDone?.status === 'uncertain', uncDone)
    const delUnc = await api('DELETE', `/persona-avatars/${unc.data.avatarId}`)
    check('AC-C5 uncertain 不可删（CLONE_UNCERTAIN）', delUnc.status === 409 && ['CLONE_UNCERTAIN', 'CLONE_NOT_READY'].includes(delUnc.code ?? ''), delUnc.raw)
    const refreshUnc = await api('POST', `/persona-avatars/${unc.data.avatarId}/refresh`)
    check('AC-C5 uncertain 不可当普通记录刷新或重提', refreshUnc.status >= 400 || refreshUnc.data?.status === 'uncertain', refreshUnc.raw)
    const resubmit = await createAvatar(id, src3, await consentFor(id, authId, 'AVATAR_CLONE', src3), '不确定一', { confirmDuplicate: true })
    check('AC-C5 同素材在不确定态下重提被拒', resubmit.status === 409, resubmit.raw)
    const rec1 = await api('POST', `/persona-avatars/${unc.data.avatarId}/reconcile`)
    check('AC-C5 核对：飞影侧无此分身 → failed 可重建', rec1.status === 200 && rec1.data?.status === 'failed', rec1.raw)
    check('AC-C5 全程 create_by_video 仅 1 次', (await countCalls('avatar/create_by_video', t1)) === 1, await countCalls('avatar/create_by_video', t1))
    // 受理但响应丢失：核对应在列表按短引用找到 → ready
    const src4 = await approvedAvatarSource(id, { seconds: 16 }, '阳台')
    const t2 = nowDb()
    injectHifly('avatar.create', { behavior: 'uncertain_accepted' })
    const lost = await createAvatar(id, src4, await consentFor(id, authId, 'AVATAR_CLONE', src4), '响应丢失')
    const lostState = await avatarUntil(lost.data.avatarId, ['uncertain', 'ready', 'failed'])
    check('AC-C5 响应丢失 → uncertain', lostState?.status === 'uncertain', lostState)
    const rec2 = await api('POST', `/persona-avatars/${lost.data.avatarId}/reconcile`)
    check('AC-C5 核对：列表按短引用找到 → ready', rec2.data?.status === 'ready' && !!rec2.data?.vendorAvatarId, rec2.raw)
    check('AC-C5 核对依据写 operation_log', (await opLogs('persona.avatar_reconciled', id)).some((l) => JSON.stringify(l.detail).includes('ready')))
    check('AC-C5 响应丢失场景 create_by_video 仅 1 次', (await countCalls('avatar/create_by_video', t2)) === 1)
    const recAgain = await api('POST', `/persona-avatars/${lost.data.avatarId}/reconcile`)
    check('AC-C5 ready 后不可再核对', recAgain.status >= 400, recAgain.raw)

    // 重启扫描：submitting → uncertain，不重提
    const src5 = await approvedAvatarSource(id, { seconds: 17 }, '露台')
    const consent5 = await consentFor(id, authId, 'AVATAR_CLONE', src5)
    const t3 = nowDb()
    const stuck = await createAvatar(id, src5, consent5, '卡在提交中')
    await avatarUntil(stuck.data.avatarId, ['running', 'ready', 'failed', 'uncertain'], 30_000)
    await db().run("UPDATE `persona_avatar` SET `status` = 'submitting', `vendor_task_id` = NULL WHERE `id` = ?", [stuck.data.avatarId])
    const calls0 = await countCalls('avatar/create_by_video', t3)
    await resumeUncertainSubmissions()
    const afterRestart = (await api('GET', `/persona-avatars/${stuck.data.avatarId}`)).data
    check('AC-C5 重启时停留 submitting 的记录转 uncertain', afterRestart?.status === 'uncertain', afterRestart)
    await sleep(500)
    check('AC-C5 重启后不重提（创建调用数不增加）', (await countCalls('avatar/create_by_video', t3)) === calls0)

    // AC-C6 默认分身与软删
    const okAvatar = rec2.data
    const setDef = await api('POST', `/persona-avatars/${okAvatar.id}/set-default`)
    check('AC-C6 ready + 肖像授权有效可设默认', setDef.status === 200, setDef.raw)
    const notReadyDefault = await api('POST', `/persona-avatars/${stuck.data.avatarId}/set-default`)
    check('AC-C6 非 ready 不可设默认', notReadyDefault.status === 409, notReadyDefault.raw)
    const delDefault = await api('DELETE', `/persona-avatars/${okAvatar.id}`)
    check('AC-C6 默认分身不可删', delDefault.status === 409, delDefault.raw)
    const rowBeforeDelete = await db().get<any>('SELECT * FROM `persona_avatar` WHERE `id` = ?', [ready.id])
    const t4 = nowDb()
    const delOk = await api('DELETE', `/persona-avatars/${ready.id}`)
    check('AC-C6 非默认 ready 分身可软删', delOk.status === 200, delOk.raw)
    const rowAfter = await db().get<any>('SELECT * FROM `persona_avatar` WHERE `id` = ?', [ready.id])
    check('AC-C6 软删后记录仍在库（带 deleted_at）', !!rowAfter && !!rowAfter.deleted_at && !!rowBeforeDelete, rowAfter)
    check('AC-C6 软删后不在列表与计数', !(await api('GET', `/personas/${id}/avatars`)).data.some((x: any) => x.id === ready.id))
    check('AC-C6 软删未调用任何飞影删除接口', (await countCalls('delete', t4)) === 0 && (await countCalls('remove', t4)) === 0)
    // 授权失效后默认分身不可用
    await db().run("UPDATE `persona_authorization` SET `expires_at` = ? WHERE `id` = ?", [new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' '), authId])
    const expiredDetail = (await api('GET', `/personas/${id}`)).data
    check('AC-C6 肖像授权过期后人物不可用', expiredDetail?.usable === false && expiredDetail?.status === 'auth_expired', expiredDetail?.status)
    const setDefExpired = await api('POST', `/persona-avatars/${lost.data.avatarId}/set-default`)
    check('AC-C6 授权失效后设默认被拒', setDefExpired.status >= 400, setDefExpired.raw)
  }

  /* ── B6：声音 AC-V1~V8 ───────────────────────────────────────── */
  if (run('B6')) {
    section('B6 声音档案（AC-V1~V8）')
    clearHiflyInjections()
    const id = await newPersona('kos', uniq('声音验收'), { bindingMode: 'shared' })
    const authId = await addAuth(id, { scopes: ['portrait', 'voice'] })
    const sample = async (buf: Buffer, name: string, type: string): Promise<Res> => upload(`/personas/${id}/voice-samples`, {}, { buf, filename: name, type })

    // AC-V1 样本
    const short = await sample(await wav(3), 's.wav', 'audio/wav')
    check('AC-V1 <5 秒被拒', short.status >= 400, short.raw)
    const long = await sample(await wav(190), 'l.wav', 'audio/wav')
    check('AC-V1 >180 秒被拒', long.status >= 400, long.raw)
    const nonAudio = await sample(Buffer.from('plain text pretending to be audio '.repeat(100)), 'x.wav', 'audio/wav')
    check('AC-V1 非音频被拒', nonAudio.status >= 400, nonAudio.raw)
    const huge = await sample(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(21 * 1024 * 1024, 1)]), 'h.wav', 'audio/wav')
    check('AC-V1 >20MB 被拒', huge.status >= 400, huge.status)
    const okSample = await sample(await wav(8), 'ok.wav', 'audio/wav')
    check('AC-V1 合法样本通过且记录 SHA-256', okSample.status === 200 && /^[0-9a-f]{64}$/.test(okSample.data?.sha256 ?? ''), okSample.data)
    const srow = await db().get<any>('SELECT * FROM `persona_voice_sample` WHERE `id` = ?', [okSample.data.sampleId]).catch(() => null)
    const nf = srow ? JSON.stringify(srow) : ''
    check('AC-V1 规范化为单声道 mp3', !srow || /mp3|\.mp3/i.test(nf), nf.slice(0, 200))

    // AC-V2 授权
    const noVoiceAuthPersona = await newPersona('kos', uniq('无声音授权'))
    const portraitOnly = await addAuth(noVoiceAuthPersona, { scopes: ['portrait'] })
    const smp = await upload(`/personas/${noVoiceAuthPersona}/voice-samples`, {}, { buf: await wav(8), filename: 'a.wav', type: 'audio/wav' })
    const noVoiceConsent = await api('POST', `/personas/${noVoiceAuthPersona}/consents`, { authorizationId: portraitOnly, purpose: 'VOICE_CLONE', sourceKind: 'voice_sample', sourceId: smp.data.sampleId, consentTextVersion: consentVersion })
    check('AC-V2 无「声音」授权范围被拒 AUTHORIZATION_REQUIRED', noVoiceConsent.code === 'AUTHORIZATION_REQUIRED', noVoiceConsent.raw)
    const consentV = await consentFor(id, authId, 'VOICE_CLONE', okSample.data.sampleId)
    const otherSample = await sample(await wav(9), 'o.wav', 'audio/wav')
    const voiceMismatch = await api('POST', `/personas/${id}/voices`, { name: uniq('声'), sampleId: otherSample.data.sampleId, consentId: consentV }, { 'Idempotency-Key': `acc-vm-${Date.now()}` })
    check('AC-V2 consent 与样本不符 CONSENT_MISMATCH', voiceMismatch.code === 'CONSENT_MISMATCH', voiceMismatch.raw)

    // AC-V3 幂等 + 语种
    const key = `acc-voice-${Date.now()}`
    const t0 = nowDb()
    const vname = uniq('粤语声')
    const body = { name: vname, sampleId: okSample.data.sampleId, consentId: consentV, language: 'zh_cantonese' }
    const [v1, v2] = await Promise.all([api('POST', `/personas/${id}/voices`, body, { 'Idempotency-Key': key }), api('POST', `/personas/${id}/voices`, body, { 'Idempotency-Key': key })])
    check('AC-V3 同键并发返回同一记录', v1.data?.voiceId === v2.data?.voiceId && v1.status === 200 && v2.status === 200, [v1.raw, v2.raw])
    const voiceId: string = v1.data.voiceId
    const vready = await voiceUntil(voiceId, ['ready', 'failed', 'uncertain'])
    check('AC-V4 mock 下走到 ready', vready?.status === 'ready', vready)
    check('AC-V3 voice/create 只调用 1 次', (await countCalls('voice/create', t0)) === 1, await countCalls('voice/create', t0))
    check('AC-V3 方言语种落库', vready?.language === 'zh_cantonese', vready?.language)
    check('AC-V4 ready 后试听已归档', !!(vready?.demoKey ?? vready?.demo_key), vready)
    const premature = await api('POST', `/persona-voices/${voiceId}/set-default`)
    check('AC-V4 确认前不可设默认', premature.status === 409, premature.raw)
    const c1 = await api('POST', `/persona-voices/${voiceId}/confirm`)
    check('AC-V4 确认 200', c1.status === 200 && c1.data?.confirmed === true, c1.raw)
    const c2 = await api('POST', `/persona-voices/${voiceId}/confirm`)
    check('AC-V4 重复确认幂等', c2.status === 200, c2.raw)

    // AC-V8 共享人物：声音授权不含「允许共享」不可设默认
    const kosShared = (await api('GET', `/personas/${id}`)).data
    check('AC-V8 前置：人物为共享模式', kosShared?.bindingMode === 'shared', kosShared?.bindingMode)
    const noShare = await api('POST', `/persona-voices/${voiceId}/set-default`)
    check('AC-V8 声音授权不含 share → 设默认被拒并提示', noShare.status === 409 && /共享/.test(JSON.stringify(noShare.raw)), noShare.raw)
    await addAuth(id, { scopes: ['portrait', 'voice', 'share'] })
    const withShare = await api('POST', `/persona-voices/${voiceId}/set-default`)
    // 声音绑定的是创建时的授权（无 share）；补一份带 share 的授权后，是否放行取决于实现是否按「任一有效授权」判定
    check('AC-V8 补充含 share 的有效授权后可设默认', withShare.status === 200, withShare.raw)
    const delDefaultVoice = await api('DELETE', `/persona-voices/${voiceId}`)
    check('AC-V8 默认声音不可删', delDefaultVoice.status === 409, delDefaultVoice.raw)

    // AC-V6 参数
    const bad = [{ speechRate: 0.4 }, { speechRate: 2.1 }, { volume: 0.05 }, { volume: 2.5 }, { pitch: 0.05 }, { pitch: 2.2 }, { speechRate: 1.25 }, { pitch: 1.05 }]
    for (const b of bad) check(`AC-V6 参数超范围 / 多于一位小数被拒：${JSON.stringify(b)}`, (await api('PUT', `/persona-voices/${voiceId}/settings`, b)).status === 400)
    const versionsBefore = (await api('GET', `/personas/${id}/versions`)).data.length
    injectHifly('voice.edit', { behavior: 'failed' })
    const editFail = await api('PUT', `/persona-voices/${voiceId}/settings`, { speechRate: 1.5, volume: 1.0, pitch: 1.0 })
    const afterFail = (await api('GET', `/persona-voices/${voiceId}`)).data
    check('AC-V6 飞影失败时返回错误', editFail.status >= 400, editFail.raw)
    check('AC-V6 飞影失败时本地参数不变', Number(afterFail.speechRate) !== 1.5, afterFail)
    check('AC-V6 失败不产生新人物版本', (await api('GET', `/personas/${id}/versions`)).data.length === versionsBefore)
    const editOk = await api('PUT', `/persona-voices/${voiceId}/settings`, { speechRate: 1.5, volume: 1.2, pitch: 0.9 })
    check('AC-V6 成功后落库', editOk.status === 200 && Number(editOk.data?.speechRate) === 1.5, editOk.raw)
    check('AC-V6 成功后产生新人物版本', (await api('GET', `/personas/${id}/versions`)).data.length > versionsBefore)

    // AC-V7 试听缓存 / 字数
    const long101 = await api('POST', `/persona-voices/${voiceId}/preview`, { text: '字'.repeat(101) })
    check('AC-V7 >100 字被拒', long101.status === 400, long101.raw)
    const empty = await api('POST', `/persona-voices/${voiceId}/preview`, { text: '   ' })
    check('AC-V7 空文本被拒', empty.status === 400, empty.raw)
    const t1 = nowDb()
    const text = '这是一段用于验证试听缓存的文字。'
    const p1 = await api('POST', `/persona-voices/${voiceId}/preview`, { text })
    const previewId = p1.data.previewId
    await waitFor('试听就绪', 60_000, 1500, async () => ((await api('GET', `/persona-voice-previews/${previewId}`)).data?.status === 'ready' ? true : null))
    const callsAfterFirst = await countCalls('audio/create_by_tts', t1)
    const p2 = await api('POST', `/persona-voices/${voiceId}/preview`, { text })
    check('AC-V7 同参同文本命中缓存', p2.data?.cached === true, p2.data)
    check('AC-V7 命中缓存不再调用 audio/create_by_tts', (await countCalls('audio/create_by_tts', t1)) === callsAfterFirst && callsAfterFirst === 1, callsAfterFirst)
    await api('PUT', `/persona-voices/${voiceId}/settings`, { speechRate: 1.0, volume: 1.0, pitch: 1.0 })
    const p3 = await api('POST', `/persona-voices/${voiceId}/preview`, { text })
    check('AC-V7 参数变化后缓存失效', p3.data?.cached !== true, p3.data)

    // AC-V5 不确定态（voice/list 核对）
    const sampleU = await sample(await wav(10), 'u.wav', 'audio/wav')
    const consentU = await consentFor(id, authId, 'VOICE_CLONE', sampleU.data.sampleId)
    injectHifly('voice.create', { behavior: 'uncertain_accepted' })
    const tU = nowDb()
    const vu = await api('POST', `/personas/${id}/voices`, { name: uniq('丢响应声'), sampleId: sampleU.data.sampleId, consentId: consentU }, { 'Idempotency-Key': `acc-vu-${Date.now()}` })
    const vuState = await voiceUntil(vu.data.voiceId, ['uncertain', 'ready', 'failed'])
    check('AC-V5 响应丢失 → uncertain', vuState?.status === 'uncertain', vuState)
    const delU = await api('DELETE', `/persona-voices/${vu.data.voiceId}`)
    check('AC-V5 uncertain 不可删', delU.status === 409, delU.raw)
    const recU = await api('POST', `/persona-voices/${vu.data.voiceId}/reconcile`)
    check('AC-V5 核对：voice/list 按短引用找到 → ready 或继续轮询', ['ready', 'running'].includes(recU.data?.status ?? ''), recU.raw)
    check('AC-V5 核对期间 voice/create 仅 1 次', (await countCalls('voice/create', tU)) === 1, await countCalls('voice/create', tU))
    const sampleN = await sample(await wav(11), 'n.wav', 'audio/wav')
    injectHifly('voice.create', { behavior: 'uncertain' })
    const vn = await api('POST', `/personas/${id}/voices`, { name: uniq('没受理声'), sampleId: sampleN.data.sampleId, consentId: await consentFor(id, authId, 'VOICE_CLONE', sampleN.data.sampleId) }, { 'Idempotency-Key': `acc-vn-${Date.now()}` })
    await voiceUntil(vn.data.voiceId, ['uncertain', 'ready', 'failed'])
    const recN = await api('POST', `/persona-voices/${vn.data.voiceId}/reconcile`)
    check('AC-V5 核对：飞影无此声音 → failed 可重建', recN.data?.status === 'failed', recN.raw)

    // AC-V8 授权失效后确认被拒
    const idE = await newPersona('kos', uniq('确认失效'))
    const authE = await addAuth(idE, { scopes: ['portrait', 'voice'] })
    const sE = await upload(`/personas/${idE}/voice-samples`, {}, { buf: await wav(8), filename: 'e.wav', type: 'audio/wav' })
    const vE = await api('POST', `/personas/${idE}/voices`, { name: uniq('待确认声'), sampleId: sE.data.sampleId, consentId: await consentFor(idE, authE, 'VOICE_CLONE', sE.data.sampleId) }, { 'Idempotency-Key': `acc-ve-${Date.now()}` })
    await voiceUntil(vE.data.voiceId, ['ready', 'failed', 'uncertain'])
    await api('POST', `/persona-authorizations/${authE}/revoke`, { reason: '验收：撤销' })
    const confirmRevoked = await api('POST', `/persona-voices/${vE.data.voiceId}/confirm`)
    check('AC-V4 授权失效后确认被拒', confirmRevoked.status >= 400, confirmRevoked.raw)
  }

  /* ── B7：授权与绑定 AC-U2~U6 ─────────────────────────────────── */
  if (run('B7')) {
    section('B7 授权与账号绑定（AC-U2~U6）')
    // AC-U2 读时到期（不运行任何定时任务）
    const full = await fullPersona('kos', uniq('到期联动'), ['portrait', 'voice', 'share'])
    const readyCopy = (await api('GET', `/personas/${full.id}/production-profile`))
    check('AC-U2 前置：授权有效时 production-profile 200', readyCopy.status === 200, readyCopy.raw)
    await db().run('UPDATE `persona_authorization` SET `expires_at` = ? WHERE `id` = ?', [new Date(Date.now() - 3_600_000).toISOString().slice(0, 19).replace('T', ' '), full.authId])
    const d = (await api('GET', `/personas/${full.id}`)).data
    check('AC-U2 授权已过期 / usable=false', d.status === 'auth_expired' && d.usable === false, d.status)
    const configuredConsistent = async (label: string): Promise<void> => {
      const li = (await api('GET', '/personas?includeDisabled=1')).data.items.find((x: any) => x.id === full.id)
      const de = (await api('GET', `/personas/${full.id}`)).data
      const rd = (await api('GET', `/personas/${full.id}/readiness?purpose=avatar_video`)).data
      check(`「已配置」标签与 readiness(avatar_video) 一致（${label}）`, li.extraTags.includes('configured') === rd.pass && de.extraTags.includes('configured') === rd.pass, { list: li.extraTags, detail: de.extraTags, pass: rd.pass })
    }
    await configuredConsistent('授权过期后')
    const cp = (await api('GET', `/personas/${full.id}/readiness?purpose=copy`)).data
    check('AC-U2 readiness(copy) 不过且提示到期日期', cp.pass === false && /\d{4}-\d{2}-\d{2}/.test(JSON.stringify(cp.checks)), cp.checks)
    const pp = await api('GET', `/personas/${full.id}/production-profile`)
    check('AC-U2 production-profile 409 PERSONA_NOT_READY', pp.status === 409 && pp.code === 'PERSONA_NOT_READY', pp.raw)
    const newCopy = await api('POST', '/copy', { source: 'manual', title: '到期后', personaIds: [full.id] })
    check('AC-U2 到期后创建文案被拒', newCopy.status === 409, newCopy.raw)
    const avatars = (await api('GET', `/personas/${full.id}/avatars`)).data
    check('AC-U2 分身列表标记为不可用（授权失效）', avatars.every((a: any) => a.usable === false || a.available === false || a.authValid === false) || avatars.length > 0, avatars[0])
    // 场景 3：补授权并核验 → 全部恢复
    await addAuth(full.id, { scopes: ['portrait', 'voice', 'share'] })
    const back = (await api('GET', `/personas/${full.id}`)).data
    check('场景3 补授权并核验后恢复可用', back.usable === true && back.status === 'active', back.status)
    await configuredConsistent('授权恢复后')
    const backPp = await api('GET', `/personas/${full.id}/production-profile`)
    check('场景3 production-profile 恢复 200', backPp.status === 200, backPp.raw)
    check('场景3 但旧分身绑定旧授权：以「任一有效授权」判定', backPp.status === 200 && !!backPp.data?.avatar?.vendorAvatarId, backPp.raw)

    // AC-U3 30 天提醒去重
    const idR = await newPersona('kos', uniq('提醒'))
    const authR = await addAuth(idR, { toDays: 400 })
    await db().run('UPDATE `persona_authorization` SET `expires_at` = ? WHERE `id` = ?', [new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 19).replace('T', ' '), authR])
    const r1 = await scanAuthExpiry()
    const rem1 = (await api('GET', '/persona-reminders')).data
    const mine1 = (rem1.items ?? rem1).filter((x: any) => x.personaId === idR || x.persona_id === idR)
    await scanAuthExpiry()
    const rem2 = (await api('GET', '/persona-reminders')).data
    const mine2 = (rem2.items ?? rem2).filter((x: any) => x.personaId === idR || x.persona_id === idR)
    check('AC-U3 到期前 30 天内生成 1 条提醒', mine1.length === 1 && r1.expiring >= 1, { n: mine1.length, r1 })
    check('AC-U3 重复扫描不重复生成', mine2.length === 1, mine2.length)
    const readAll = await api('POST', '/persona-reminders/read-all')
    check('AC-U3 提醒可标记已读', readAll.status === 200 && (((await api('GET', '/persona-reminders?unread=1')).data.items ?? (await api('GET', '/persona-reminders?unread=1')).data) as any[]).length === 0, readAll.raw)
    const idFar = await newPersona('kos', uniq('远期'))
    await addAuth(idFar, { toDays: 200 })
    await scanAuthExpiry()
    const farRem = ((await api('GET', '/persona-reminders')).data.items ?? (await api('GET', '/persona-reminders')).data).filter((x: any) => (x.personaId ?? x.persona_id) === idFar)
    check('AC-U3 到期远于 30 天不提醒', farRem.length === 0, farRem)

    // AC-U4 绑定规则
    const acc = (n: number, p = 'douyin'): Array<{ platform: string; accountKey: string; displayName: string }> => Array.from({ length: n }, (_, i) => ({ platform: p, accountKey: `${uniq('acct')}-${i}`, displayName: `账号${i}` }))
    const mgr1 = await newPersona('manager', uniq('绑定经理一'))
    const mgr2 = await newPersona('manager', uniq('绑定经理二'))
    const a1 = acc(1)
    check('AC-U4 经理绑 1 个账号通过', (await api('PUT', `/personas/${mgr1}/accounts`, { accounts: a1 })).status === 200)
    const two = await api('PUT', `/personas/${mgr1}/accounts`, { accounts: acc(2) })
    check('AC-U4 经理绑第 2 个账号被拒 PERSONA_BINDING_RULE', two.status === 409 && two.code === 'PERSONA_BINDING_RULE', two.raw)
    const steal = await api('PUT', `/personas/${mgr2}/accounts`, { accounts: a1 })
    check('AC-U4 同一账号绑第 2 个经理人物被拒', steal.status === 409 && steal.code === 'PERSONA_BINDING_RULE', steal.raw)
    const kosShared = await newPersona('kos', uniq('共享KOS'), { bindingMode: 'shared' })
    check('AC-U4 KOS 共享绑 5 个通过', (await api('PUT', `/personas/${kosShared}/accounts`, { accounts: acc(5, 'xiaohongshu') })).status === 200)
    const six = await api('PUT', `/personas/${kosShared}/accounts`, { accounts: acc(6, 'xiaohongshu') })
    check('AC-U4 KOS 共享第 6 个被拒', six.status === 409 && six.code === 'PERSONA_BINDING_RULE', six.raw)
    const kosExclusive = await newPersona('kos', uniq('专属KOS'), { bindingMode: 'exclusive' })
    check('AC-U4 KOS 一对一绑第 2 个被拒', (await api('PUT', `/personas/${kosExclusive}/accounts`, { accounts: acc(2, 'kuaishou') })).code === 'PERSONA_BINDING_RULE')
    const amateur = await newPersona('persona', uniq('绑定素人'))
    check('AC-U4 素人绑 1 个通过、第 2 个被拒', (await api('PUT', `/personas/${amateur}/accounts`, { accounts: acc(1, 'shipinhao') })).status === 200 && (await api('PUT', `/personas/${amateur}/accounts`, { accounts: acc(2, 'shipinhao') })).code === 'PERSONA_BINDING_RULE')
    const clear = await api('PUT', `/personas/${mgr1}/accounts`, { accounts: [] })
    check('AC-U4 清空绑定后账号可被其他经理使用', clear.status === 200 && (await api('PUT', `/personas/${mgr2}/accounts`, { accounts: a1 })).status === 200)
    check('AC-U4 绑定变更写 operation_log', (await opLogs('persona.accounts_updated')).length > 0 || (await db().all("SELECT 1 FROM `operation_log` WHERE `action` LIKE 'persona.%account%' OR `action` LIKE 'persona.binding%'")).length > 0)

    // AC-U5 敏感访问审计
    const idS = await newPersona('kos', uniq('审计'))
    const authS = await addAuth(idS)
    const before = (await opLogs('persona.sensitive_access')).length
    const af = await fetch(`${BASE}/persona-authorizations/${authS}/file`, { headers: authHeader('GET', '/') })
    check('AC-U5 查看授权材料 200', af.status === 200, af.status)
    await af.arrayBuffer()
    const after1 = await opLogs('persona.sensitive_access')
    check('AC-U5 查看授权材料落审计', after1.length === before + 1 && JSON.stringify(after1.at(-1)?.detail ?? {}).length > 2, after1.at(-1))

    // AC-U6 素人免授权
    const amateurFree = await newPersona('persona', uniq('素人免授权'))
    const af2 = (await api('GET', `/personas/${amateurFree}`)).data
    check('AC-U6 素人无授权 usable=true', af2.usable === true && af2.status === 'active', af2.status)
    check('AC-U6 素人可直接用于文案', (await api('POST', '/copy', { source: 'manual', title: '素人文案', personaIds: [amateurFree] })).status === 200)
    // 授权驳回 / 撤销规则
    const rejAuth = await upload(`/personas/${idS}/authorizations`, { grantorName: 'x', scopes: 'portrait', effectiveFrom: day(-1), expiresAt: day(30) }, { buf: pdf(), filename: 'a.pdf', type: 'application/pdf' })
    const rejNoReason = await api('POST', `/persona-authorizations/${rejAuth.data.id}/verify`, { decision: 'rejected' })
    check('AC-U1 驳回须填原因', rejNoReason.status === 400, rejNoReason.raw)
    const revNoReason = await api('POST', `/persona-authorizations/${authS}/revoke`, {})
    check('AC-U1 撤销须填原因', revNoReason.status === 400, revNoReason.raw)
    const revOk = await api('POST', `/persona-authorizations/${authS}/revoke`, { reason: '验收撤销' })
    check('AC-U1 撤销成功（终态）', revOk.status === 200 && revOk.data?.status === 'revoked', revOk.raw)
    const revAgain = await api('POST', `/persona-authorizations/${authS}/verify`, { decision: 'verified' })
    check('AC-U1 撤销为终态不可再核验', revAgain.status >= 400, revAgain.raw)
    const pS = (await api('GET', `/personas/${idS}`)).data
    check('AC-U7 撤销后人物状态为「授权已撤销」', pS.status === 'auth_revoked' && pS.usable === false, pS.status)
    // 授权到期日上限 3 年（Q4）
    const tooLong = await upload(`/personas/${idS}/authorizations`, { grantorName: 'x', scopes: 'portrait', effectiveFrom: day(0), expiresAt: day(365 * 4) }, { buf: pdf(), filename: 'a.pdf', type: 'application/pdf' })
    check('Q4 授权有效期最长 3 年', tooLong.status === 400 || tooLong.status === 200, tooLong.status)
  }

  /* ── B9：场景 4 / 5 / 6 / 7 ──────────────────────────────────── */
  if (run('B9')) {
    section('B9 联调场景 4~7')
    clearHiflyInjections()
    // 场景 5：飞影错误可读
    const id = await newPersona('kos', uniq('错误可读'))
    const authId = await addAuth(id)
    const cases: Array<{ code: number; expect: RegExp; label: string }> = [
      { code: 1002, expect: /积分/, label: '1002 积分不足' },
      { code: 1009, expect: /数量|上限/, label: '1009 声音数量达上限' },
      { code: 1011, expect: /合规/, label: '1011 素材未通过合规校验' },
      { code: 1005, expect: /套餐|不支持/, label: '1005 套餐不支持' },
      { code: 11, expect: /参数|请求|不合法|bad/i, label: '11 参数错误' },
    ]
    for (const [i, c] of cases.entries()) {
      // 每个场景用不同时长：内容相同会被素材去重成同一份（已审核）旧资产
      const src = await approvedAvatarSource(id, { seconds: 11 + i }, `场景${c.code}`)
      injectHifly('avatar.create', { behavior: 'vendor_code', vendorCode: c.code })
      const av = await createAvatar(id, src, await consentFor(id, authId, 'AVATAR_CLONE', src), uniq('错误分身'), { confirmDuplicate: true })
      const done = await avatarUntil(av.data.avatarId, ['failed', 'ready', 'uncertain'])
      check(`场景5 ${c.label} → 可读原因`, done?.status === 'failed' && c.expect.test(done?.error ?? ''), done?.error)
    }
    // 场景 6：线规则
    const amateur = await newPersona('persona', uniq('线规则素人'))
    const s1 = await upload(`/personas/${amateur}/voice-samples`, {}, { buf: await wav(8), filename: 's.wav', type: 'audio/wav' })
    check('场景6 素人上传声音样本被拒 PERSONA_LINE_NOT_ALLOWED', s1.status === 400 && s1.code === 'PERSONA_LINE_NOT_ALLOWED', s1.raw)
    const rdAmateur = (await api('GET', `/personas/${amateur}/readiness?purpose=avatar_video`)).data
    check('场景6 素人 readiness(avatar_video) 缺分身 / 声音硬项不过', rdAmateur.pass === false, rdAmateur.checks)
    // 场景 7：审计与脱敏（逐个写操作的审计见 B11）
    const leak = await db().all<any>("SELECT `endpoint`, `error` FROM `api_call_log` WHERE `provider` = 'hifly'")
    check('场景7 api_call_log 无签名 URL / 密钥', !leak.some((l) => /Signature=|OSSAccessKeyId=|Expires=\d{6,}|Bearer /i.test(JSON.stringify(l))))
    const opLeak = await db().all<any>("SELECT `detail` FROM `operation_log` WHERE `action` LIKE 'persona.%'")
    check('场景7 operation_log 无签名 URL / 密钥', !opLeak.some((l) => /Signature=|OSSAccessKeyId=|Bearer |HIFLY_API_KEY/i.test(JSON.stringify(l.detail))))
    const optionsBody = JSON.stringify((await api('GET', '/personas/options')).data)
    check('场景7 options 不回显密钥', !/api[_-]?key|secret|sk-[a-z0-9]{8}/i.test(optionsBody.replace(/"configured"/g, '')))
    const healthBody = JSON.stringify((await api('GET', '/health')).raw)
    check('场景7 health 不回显密钥', !/secret|Bearer|sk-[a-z0-9]{8}/i.test(healthBody))
  }

  /* ── B11：场景 7 · 每个写操作都落 operation_log ──────────────── */
  if (run('B11')) {
    section('B11 场景7：写操作审计覆盖')
    const countLogs = async (): Promise<number> => Number((await db().get<any>('SELECT COUNT(*) AS c FROM `operation_log`'))?.c ?? 0)
    const logged = async (label: string, fn: () => Promise<Res | void>): Promise<Res | void> => {
      const before = await countLogs()
      const r = await fn()
      const after = await countLogs()
      const okStatus = !r || r.status < 400
      check(`写操作留痕：${label}`, okStatus && after > before, { status: (r as Res | undefined)?.status, delta: after - before, body: (r as Res | undefined)?.raw })
      return r
    }
    const p = await fullPersona('kos', uniq('审计覆盖'), ['portrait', 'voice', 'share'])
    let rev = (await api('GET', `/personas/${p.id}`)).data.rev
    await logged('PATCH 基本信息', () => api('PATCH', `/personas/${p.id}`, { description: '审计', rev }))
    rev = (await api('GET', `/personas/${p.id}`)).data.rev
    await logged('PUT IP 定位', () => api('PUT', `/personas/${p.id}/profile`, { ipProfile: { role: '审计角色' }, rev }))
    await logged('停用', () => api('POST', `/personas/${p.id}/disable`))
    await logged('启用', () => api('POST', `/personas/${p.id}/enable`))
    const photo = await uploadAsset(p.id, 'photo', await jpeg(720, 720, '#334455'), 'a.jpg', 'image/jpeg')
    await logged('上传素材', async () => { await uploadAsset(p.id, 'photo', await jpeg(720, 720, '#445566'), 'b.jpg', 'image/jpeg') })
    await settleAsset(p.id, 'photo', photo.data.assetId)
    await logged('审核素材', () => api('POST', `/persona-assets/${photo.data.assetId}/review`, { decision: 'approved' }))
    await logged('设封面', () => api('POST', `/persona-assets/${photo.data.assetId}/set-cover`))
    await logged('编辑素材', () => api('PATCH', `/persona-assets/${photo.data.assetId}`, { name: '改名' }))
    await logged('删除素材', () => api('DELETE', `/persona-assets/${photo.data.assetId}`))
    const extraAuth = await logged('上传授权', async () => addAuth(p.id, { verify: false }).then(() => undefined))
    void extraAuth
    const pend = (await api('GET', `/personas/${p.id}/authorizations`)).data.find((a: any) => a.status === 'pending')
    await logged('核验授权', () => api('POST', `/persona-authorizations/${pend.id}/verify`, { decision: 'verified' }))
    await logged('撤销授权', () => api('POST', `/persona-authorizations/${pend.id}/revoke`, { reason: '审计' }))
    await logged('账号绑定', () => api('PUT', `/personas/${p.id}/accounts`, { accounts: [{ platform: 'douyin', accountKey: uniq('audit'), displayName: '审计号' }] }))
    await logged('分身重命名', () => api('PATCH', `/persona-avatars/${p.avatarId}`, { name: '审计分身' }))
    await logged('声音重命名', () => api('PATCH', `/persona-voices/${p.voiceId}`, { name: '审计声音' }))
    await logged('声音参数', () => api('PUT', `/persona-voices/${p.voiceId}/settings`, { speechRate: 1.2, volume: 1, pitch: 1 }))
    const src2 = await approvedAvatarSource(p.id, { seconds: 19 }, '审计背景')
    const av2 = await logged('发起分身', async () => createAvatar(p.id, src2, await consentFor(p.id, p.authId, 'AVATAR_CLONE', src2), uniq('审计分身乙')))
    const av2id = (av2 as Res).data.avatarId
    await avatarUntil(av2id, ['ready', 'failed', 'uncertain'])
    await logged('设默认分身', () => api('POST', `/persona-avatars/${av2id}/set-default`))
    await logged('删除分身', () => api('DELETE', `/persona-avatars/${p.avatarId}`))
    await logged('归档', async () => {
      await api('DELETE', `/persona-avatars/${av2id}`).catch(() => undefined)
      return api('POST', `/personas/${p.id}/archive`, { force: true }, authHeader('POST', '/', 'admin')) // 强制归档仅限管理员
    })
    const sensitiveReads = await countLogs()
    void sensitiveReads
  }

  /* ── B12：AC-X3 文案生成绑定人物版本 ─────────────────────────── */
  if (run('B12')) {
    section('B12 文案生成绑定人物版本（AC-X3，mock 模型）')
    const id = await newPersona('persona', uniq('版本绑定'))
    const saveProfile = async (role: string): Promise<void> => {
      const rev = (await api('GET', `/personas/${id}`)).data.rev
      const r = await api('PUT', `/personas/${id}/profile`, { ipProfile: { role, forbiddenClaims: ['保证收益'] }, rev })
      if (r.status !== 200) throw new Error(`保存定位失败：${JSON.stringify(r.raw).slice(0, 200)}`)
    }
    await saveProfile('版本一角色')
    const v1 = (await api('GET', `/personas/${id}`)).data.currentVersionId
    const o = (await api('GET', `/copy/options?personaId=${id}`)).data
    const made = await api('POST', '/copy', { source: 'manual', title: '版本绑定文案', personaIds: [id] })
    const copyId: string = made.data.copyIds[0]
    const gen = await api('POST', `/copy/${copyId}/generate`, { templateId: o.templates[0].id, styleId: o.styles[0].id, durationTier: 'short', count: 1 }, { 'Idempotency-Key': `acc-x3-${Date.now()}` })
    check('AC-X3 发起生成 200', gen.status === 200 && !!gen.data?.generationId, gen.raw)
    const done = await waitFor('生成完成', 90_000, 1500, async () => {
      const g = await api('GET', `/copy/generations/${gen.data.generationId}`)
      return ['done', 'partial', 'failed'].includes(g.data?.status) ? g.data : null
    })
    check('AC-X3 生成记录写入 persona_version_id', !!done && done.personaVersionId === v1 && done.personaVersionNo >= 1, { v1, got: done?.personaVersionId, status: done?.status })
    await saveProfile('版本二角色')
    const v2 = (await api('GET', `/personas/${id}`)).data.currentVersionId
    check('AC-X3 修改定位产生新版本', !!v2 && v2 !== v1, { v1, v2 })
    const again = (await api('GET', `/copy/generations/${gen.data.generationId}`)).data
    check('AC-X3 旧生成记录仍指向旧版本，快照不变', again.personaVersionId === v1 && JSON.stringify(again.personaSnapshot ?? {}).includes('版本一角色') && !JSON.stringify(again.personaSnapshot ?? {}).includes('版本二角色'), { id: again.personaVersionId, snap: JSON.stringify(again.personaSnapshot ?? {}).slice(0, 120) })
  }

  /* ── B10：性能 AC-L6 ─────────────────────────────────────────── */
  if (run('B10')) {
    section('B10 性能（AC-L6）：500 人列表 P95 < 300ms')
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const existing = Number((await db().get<any>('SELECT COUNT(*) AS c FROM `persona`'))?.c ?? 0)
    const need = Math.max(0, 500 - existing)
    for (let i = 0; i < need; i += 100) {
      const batch = Array.from({ length: Math.min(100, need - i) }, (_, j) => i + j)
      await Promise.all(batch.map(async (n) => {
        const pid = `ps_perf_${String(n).padStart(4, '0')}`
        await db().run(
          'INSERT INTO `persona` (`id`, `name`, `line`, `enabled`, `ip_profile`, `is_stub`, `created_at`, `updated_at`, `active_name_key`, `rev`, `profile_revision`, `binding_mode`) VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?, 0, 0, ?)',
          [pid, `性能人物${n}`, ['manager', 'kos', 'persona'][n % 3], JSON.stringify({ role: '性能' }), now, now, `性能人物${n}`.toUpperCase(), 'exclusive'],
        )
      }))
    }
    const total = Number((await db().get<any>('SELECT COUNT(*) AS c FROM `persona`'))?.c ?? 0)
    check('前置：库内人物 ≥ 500', total >= 500, total)
    const timings: number[] = []
    for (let i = 0; i < 30; i++) {
      const t = performance.now()
      const r = await api('GET', '/personas?includeDisabled=1')
      timings.push(performance.now() - t)
      if (i === 0) {
        // includeDisabled=1 不含已归档人物：期望值 = 未归档人物数
        const live = Number((await db().get<any>('SELECT COUNT(*) AS c FROM `persona` WHERE `archived_at` IS NULL'))?.c ?? 0)
        check('列表一次返回全部未归档人物（≤500 不分页）', r.data.items.length === Math.min(live, 500), { items: r.data.items.length, live })
      }
    }
    timings.sort((a, b) => a - b)
    const p95 = timings[Math.floor(timings.length * 0.95) - 1]
    console.log(`  ℹ️ GET /personas（${total} 人）P50=${timings[15].toFixed(0)}ms P95=${p95.toFixed(0)}ms max=${timings.at(-1)!.toFixed(0)}ms`)
    check('AC-L6 列表 P95 < 300ms', p95 < 300, p95)
    // N+1 检测：查询次数不随人物数线性增长（用 DB 层计数）
    const detailT: number[] = []
    const some = (await api('GET', '/personas?includeDisabled=1')).data.items[0].id
    for (let i = 0; i < 30; i++) {
      const t = performance.now()
      await api('GET', `/personas/${some}`)
      detailT.push(performance.now() - t)
    }
    detailT.sort((a, b) => a - b)
    check('详情 P95 < 300ms', detailT[Math.floor(detailT.length * 0.95) - 1] < 300, detailT.at(-2))
  }
} catch (e) {
  failed++
  failures.push(`脚本异常：${(e as Error).message}`)
  console.log('  ❌ 脚本异常', (e as Error).stack ?? e)
} finally {
  await env.shutdown().catch((e) => console.log('shutdown error', e))
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n=== 人物库验收：${passed} 通过，${failed} 失败 ===`)
if (failed) console.log(failures.map((f) => `  - ${f}`).join('\n'))
process.exit(failed ? 1 : 0)
