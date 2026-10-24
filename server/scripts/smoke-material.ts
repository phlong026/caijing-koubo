/**
 * 素材库模块 smoke（任务书 ML5 / §9 验收清单：AC-F1~F5、AC-P1~P4、AC-K1、AC-V1、AC-X1、AC-R1）：
 *
 * 覆盖：
 *  1. 角色口径（A6）：ops 可读、写被拒；管理员可写；
 *  2. 字体上传校验（AC-F1）：扩展名 / magic bytes / 同名不同内容 / 重复上传幂等；
 *  3. 授权门槛与启用集（AC-F2）：other 无出处不可启用 → 补出处后启用 → 出现在启用集；
 *  4. default 与存量扫描（AC-F4/F5）：启用集按文件名排序、bootstrap 幂等；
 *  5. 删除守卫（AC-F3）：被成片字幕样式引用 → 409 FONT_IN_USE；解除后可删且文件同步移除；
 *  6. 素材包（AC-P1/P2/P4）：目录导入 → items 自动打标 → 手动补标 → 启停 → 授权出处；
 *  7. 关键词组（AC-K1）：空关键词 / 非法区间 / 不存在的包被拒，正常 CRUD；
 *  8. 删除守卫（AC-P3）：被启用组引用的包 409，停用组后可删；
 *  9. 上传通道：单个 zip（解压导入）与多文件直传；
 * 10. 声音库（AC-V1）：人物库声音档案按线聚合筛选。
 *
 * 用法：npm run smoke:material
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { bootIsolated } from './lib/isolated-env.js'
import { authHeader, initSmokeAuth, type SmokeRole } from './lib/smoke-auth.js'

const pexec = promisify(execFile)
const TMP = mkdtempSync(join(tmpdir(), 'material-e2e-'))
const FONTS_DIR = join(TMP, 'fonts')

const env = await bootIsolated({ env: { LOG_LEVEL: 'warn', CUT_FONTS_DIR: FONTS_DIR } })
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
  asRole?: SmokeRole,
): Promise<{ status: number; data: T; raw: any; code?: string }> {
  const headers: Record<string, string> = { ...authHeader(method, p, asRole) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw: any = await res.json().catch(() => ({}))
  return { status: res.status, data: raw?.data, raw, code: raw?.error?.code }
}

async function upload(
  p: string,
  files: Array<{ field?: string; buf: Buffer; filename: string; type: string }>,
  fields: Record<string, string> = {},
  asRole?: SmokeRole,
): Promise<{ status: number; data: any; raw: any; code?: string }> {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  for (const f of files) fd.append(f.field ?? 'file', new Blob([f.buf], { type: f.type }), f.filename)
  try {
    const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: authHeader('POST', p, asRole), body: fd })
    const raw: any = await res.json().catch(() => ({}))
    return { status: res.status, data: raw?.data, raw, code: raw?.error?.code }
  } catch (e) {
    // 403 拒绝可能在上传体内写入前断连（EPIPE），按拒绝处理
    return { status: 403, data: null, raw: { ok: false, error: { code: 'forbidden', message: String((e as Error).cause ?? e) } } }
  }
}

/** 合法字体容器（magic bytes 通过校验即可，不参与渲染） */
const fakeFont = (tag: string): Buffer => Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from(`font-${tag}-${Date.now()}`)])
const ottoFont = (tag: string): Buffer => Buffer.concat([Buffer.from('OTTO', 'latin1'), Buffer.from(`otf-${tag}-${Date.now()}`)])

console.log('\n=== 素材库 smoke ===\n')

/* ── 1. 角色口径（A6） ─────────────────────────────────────── */
console.log('[1] 角色口径：ops 只读、admin 可写')
const readFonts = await api('GET', '/fonts', undefined, 'ops')
check('ops 可读字体列表', readFonts.status === 200 && Array.isArray(readFonts.data?.items), readFonts.raw)

const opsUpload = await upload('/fonts', [{ buf: fakeFont('ops'), filename: 'ops.ttf', type: 'font/ttf' }], { licenseType: 'commercial' }, 'ops')
check('ops 上传字体被拒（403）', opsUpload.status === 403, opsUpload.raw)

const opsPatch = await api('PATCH', '/fonts/not-exist', { enabled: true }, 'ops')
check('ops 改字体被拒（403）', opsPatch.status === 403, opsPatch.raw)

/* ── 2. 字体上传校验（AC-F1） ──────────────────────────────── */
console.log('\n[2] 字体上传校验（AC-F1）')
const badExt = await upload('/fonts', [{ buf: fakeFont('ext'), filename: 'font.woff', type: 'font/woff' }], { licenseType: 'ofl' }, 'admin')
check('非白名单扩展名被拒（FONT_FORMAT_INVALID）', badExt.status === 400 && badExt.code === 'FONT_FORMAT_INVALID', badExt.raw)

const fakeMagic = await upload('/fonts', [{ buf: Buffer.from('PK\u0003\u0004pretend-zip'), filename: 'fake.ttf', type: 'font/ttf' }], { licenseType: 'ofl' }, 'admin')
check('伪字体（magic bytes 不符）被拒', fakeMagic.status === 400 && fakeMagic.code === 'FONT_FORMAT_INVALID', fakeMagic.raw)

const fontA = fakeFont('A')
const upA = await upload('/fonts', [{ buf: fontA, filename: 'SmokeFontA.ttf', type: 'font/ttf' }], { licenseType: 'other' }, 'admin')
check('上传 .ttf 成功且默认未启用', upA.status === 200 && upA.data?.enabled === false, upA.raw)
check('未填授权出处时记录 licenseType=other', upA.data?.licenseType === 'other' && !upA.data?.licenseNote, upA.data)

const upADup = await upload('/fonts', [{ buf: fontA, filename: 'SmokeFontA-copy.ttf', type: 'font/ttf' }], { licenseType: 'other' }, 'admin')
check('同内容重复上传幂等（返回既有记录）', upADup.status === 200 && upADup.data?.id === upA.data?.id, upADup.raw)

const upNameClash = await upload('/fonts', [{ buf: fakeFont('A2'), filename: 'SmokeFontA.ttf', type: 'font/ttf' }], { licenseType: 'other' }, 'admin')
check('同名不同内容被拒（409）', upNameClash.status === 409, upNameClash.raw)

const fontsAfterUpload = await api('GET', '/fonts', undefined, 'admin')
check('列表可见新字体且未进启用集', (fontsAfterUpload.data?.items ?? []).some((f: any) => f.id === upA.data.id) && (fontsAfterUpload.data?.enabled ?? []).length === 0, fontsAfterUpload.data)

/* ── 3. 授权门槛与启用（AC-F2） ────────────────────────────── */
console.log('\n[3] 授权门槛与启用（AC-F2）')
const enableNoNote = await api('PATCH', `/fonts/${upA.data.id}`, { enabled: true }, 'admin')
check('other 无授权出处启用被拒（FONT_LICENSE_REQUIRED）', enableNoNote.status === 409 && enableNoNote.code === 'FONT_LICENSE_REQUIRED', enableNoNote.raw)

const fillNote = await api('PATCH', `/fonts/${upA.data.id}`, { licenseNote: '授权书 SMK-001（冒烟）', displayName: '冒烟字体A' }, 'admin')
check('补授权出处成功', fillNote.status === 200 && fillNote.data?.licenseNote?.includes('SMK-001'), fillNote.raw)

const enableOk = await api('PATCH', `/fonts/${upA.data.id}`, { enabled: true }, 'admin')
check('补出处后可启用', enableOk.status === 200 && enableOk.data?.enabled === true, enableOk.raw)

const enabledList = await api('GET', '/fonts', undefined, 'admin')
const enabledNames = (enabledList.data?.enabled ?? []).map((f: any) => f.fileName as string)
check('启用集含该字体', enabledNames.includes('SmokeFontA.ttf'), enabledList.data?.enabled)

/* ── 4. default 语义与 bootstrap 幂等（AC-F4 / AC-F5） ─────── */
console.log('\n[4] default 语义与存量扫描（AC-F4 / AC-F5）')
const upB = await upload('/fonts', [{ buf: ottoFont('B'), filename: 'ASmokeFontB.otf', type: 'font/otf' }], { licenseType: 'commercial' }, 'admin')
check('上传 .otf（OTTO 容器）成功', upB.status === 200, upB.raw)
await api('PATCH', `/fonts/${upB.data.id}`, { enabled: true, displayName: '冒烟字体B' }, 'admin')

const enabledSorted = await api('GET', '/fonts', undefined, 'admin')
const names = (enabledSorted.data?.enabled ?? []).map((f: any) => f.fileName as string)
check('启用集按文件名升序（default = 首个）', JSON.stringify(names) === JSON.stringify([...names].sort()), names)

// 手工放置一个字体文件（模拟存量）→ bootstrap 同步为未启用记录；二次执行幂等
mkdirSync(FONTS_DIR, { recursive: true })
writeFileSync(join(FONTS_DIR, 'HandPlacedFont.ttf'), fakeFont('hand'))
const boot1 = await api('POST', '/fonts/bootstrap', {}, 'admin')
check('bootstrap 扫描手工放置字体（added=1）', boot1.status === 200 && boot1.data?.added === 1, boot1.data)
const boot2 = await api('POST', '/fonts/bootstrap', {}, 'admin')
check('bootstrap 二次执行幂等（added=0 / removed=0）', boot2.data?.added === 0 && boot2.data?.removed === 0, boot2.data)
const handList = await api('GET', '/fonts', undefined, 'admin')
const hand = (handList.data?.items ?? []).find((f: any) => f.fileName === 'HandPlacedFont.ttf')
check('手工字体同步为未启用记录', !!hand && hand.enabled === false, hand)

/* ── 5. 删除守卫（AC-F3） ──────────────────────────────────── */
console.log('\n[5] 删除守卫（AC-F3）')
const { getDb } = await import('../src/db/index.js')
const db = await getDb()
const cutId = `cut-smoke-${Date.now()}`
const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ')
await db.run(
  'INSERT INTO `video_cut` (`id`, `video_job_id`, `version_no`, `status`, `subtitle_style`, `created_at`, `updated_at`) VALUES (?, ?, 1, ?, ?, ?, ?)',
  [cutId, 'vjob-smoke', 'completed', JSON.stringify({ fontName: 'SmokeFontA' }), nowStr, nowStr],
)
const inUse = await api('GET', '/fonts', undefined, 'admin')
const inUseFont = (inUse.data?.items ?? []).find((f: any) => f.fileName === 'SmokeFontA.ttf')
check('引用计数统计到成片引用（inUseCount=1）', inUseFont?.inUseCount === 1, inUseFont)

const delBlocked = await api('DELETE', `/fonts/${upA.data.id}`, undefined, 'admin')
check('被成片引用时删除 409（FONT_IN_USE）', delBlocked.status === 409 && delBlocked.code === 'FONT_IN_USE', delBlocked.raw)

await db.run('DELETE FROM `video_cut` WHERE `id` = ?', [cutId])
const delOk = await api('DELETE', `/fonts/${upA.data.id}`, undefined, 'admin')
check('解除引用后删除成功', delOk.status === 200, delOk.raw)
const fontFileGone = await import('node:fs/promises').then((m) => m.access(join(FONTS_DIR, 'SmokeFontA.ttf')).then(() => false, () => true))
check('删除同时移除字体目录文件', fontFileGone)

/* ── 6. 素材包（AC-P1 / AC-P2 / AC-P4） ───────────────────── */
console.log('\n[6] 素材包导入、补标与启停（AC-P1 / AC-P2 / AC-P4）')
const matDir = join(TMP, 'pack-src')
mkdirSync(matDir, { recursive: true })
const clip = join(matDir, '投教费用片段.mp4')
await pexec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:d=1', '-pix_fmt', 'yuv420p', clip])
const img = join(matDir, '收益图示.png')
await pexec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=320x180', '-frames:v', '1', img])

const packImport = await api('POST', '/material-packs', { name: '冒烟素材包', line: 'kos', licenseNote: '自有拍摄', sourcePath: matDir }, 'admin')
check('目录导入素材包成功', packImport.status === 200 && packImport.data?.itemCount === 2, packImport.raw)
check('包级授权出处已落库', packImport.data?.licenseNote === '自有拍摄', packImport.data)
const packId = packImport.data?.id

const itemsR = await api('GET', `/material-packs/${packId}/items`, undefined, 'admin')
const items = itemsR.data ?? []
check('items 网格返回 2 项', items.length === 2, itemsR.data)
check('自动打标写入 tags（文件名分词）', items.some((it: any) => (it.tags ?? []).some((t: string) => t.includes('投教'))), items.map((i: any) => i.tags))

const firstItem = items[0]
const tagR = await api('PATCH', `/material-packs/${packId}/items/${firstItem.id}`, { tags: ['投教', '费用', '投教'] }, 'admin')
check('item 手动补标去重生效', tagR.status === 200 && JSON.stringify(tagR.data?.tags) === JSON.stringify(['投教', '费用']), tagR.raw)

const longTag = await api('PATCH', `/material-packs/${packId}/items/${firstItem.id}`, { tags: ['x'.repeat(21)] }, 'admin')
check('超长标签被拒（400）', longTag.status === 400, longTag.raw)

const itemsAfterTag = await api('GET', `/material-packs/${packId}/items`, undefined, 'admin')
check('补标结果可读回', (itemsAfterTag.data ?? []).find((i: any) => i.id === firstItem.id)?.tags?.length === 2, itemsAfterTag.data)

const offR = await api('PATCH', `/material-packs/${packId}`, { enabled: false }, 'admin')
check('素材包停用生效', offR.status === 200 && offR.data?.enabled === 0, offR.raw)
const onR = await api('PATCH', `/material-packs/${packId}`, { enabled: true }, 'admin')
check('素材包重新启用', onR.status === 200 && onR.data?.enabled === 1, onR.raw)

/* ── 7. 关键词组（AC-K1） ─────────────────────────────────── */
console.log('\n[7] 关键词组校验与 CRUD（AC-K1）')
const g1 = await api('POST', '/material-keyword-groups', { name: '冒烟组', keywords: [], packIds: [packId] }, 'admin')
check('空关键词被拒（400）', g1.status === 400, g1.raw)

const g2 = await api('POST', '/material-keyword-groups', { name: '冒烟组', keywords: ['费用'], packIds: [packId], durationMinMs: 3000, durationMaxMs: 1000 }, 'admin')
check('非法时长区间被拒（min ≥ max）', g2.status === 400, g2.raw)

const g3 = await api('POST', '/material-keyword-groups', { name: '冒烟组', keywords: ['费用'], packIds: ['mpack-not-exist'] }, 'admin')
check('引用不存在的素材包被拒（400）', g3.status === 400, g3.raw)

const gOk = await api(
  'POST',
  '/material-keyword-groups',
  { name: '冒烟组', keywords: ['费用', '收益'], packIds: [packId], durationMinMs: 500, durationMaxMs: 2000, selectionMode: 'random' },
  'admin',
)
check('创建关键词组成功', gOk.status === 200 && gOk.data?.keywords?.length === 2, gOk.raw)
const groupId = gOk.data?.id

const gPatch = await api('PATCH', `/material-keyword-groups/${groupId}`, { name: '冒烟组（改）', sort: 5 }, 'admin')
check('编辑关键词组成功', gPatch.status === 200 && gPatch.data?.name === '冒烟组（改）', gPatch.raw)

/* ── 8. 素材包删除守卫（AC-P3） ───────────────────────────── */
console.log('\n[8] 素材包删除守卫（AC-P3）')
const packBlocked = await api('DELETE', `/material-packs/${packId}`, undefined, 'admin')
check('被启用关键词组引用时删除 409（MATERIAL_PACK_IN_USE）', packBlocked.status === 409 && packBlocked.code === 'MATERIAL_PACK_IN_USE', packBlocked.raw)

await api('PATCH', `/material-keyword-groups/${groupId}`, { enabled: false }, 'admin')
const groupDel = await api('DELETE', `/material-keyword-groups/${groupId}`, undefined, 'admin')
check('停用后删除关键词组成功', groupDel.status === 200, groupDel.raw)

/* ── 9. 上传通道：zip 与多文件 ────────────────────────────── */
console.log('\n[9] 上传通道：zip 解压导入与多文件直传')
const zipPath = join(TMP, 'pack.zip')
await pexec('zip', ['-r', '-q', zipPath, '.'], { cwd: matDir })
const zipUp = await upload(
  '/material-packs',
  [{ field: 'files', buf: readFileSync(zipPath), filename: 'pack.zip', type: 'application/zip' }],
  { name: '冒烟 zip 包', line: 'manager' },
  'admin',
)
check('单个 zip 上传解压导入成功（2 项）', zipUp.status === 200 && zipUp.data?.itemCount === 2, zipUp.raw)

const multiUp = await upload(
  '/material-packs',
  [
    { field: 'files', buf: readFileSync(clip), filename: '多文件A.mp4', type: 'video/mp4' },
    { field: 'files', buf: readFileSync(img), filename: '多文件B.png', type: 'image/png' },
  ],
  { name: '冒烟多文件包', line: 'kos' },
  'admin',
)
check('多文件直传导入成功（2 项）', multiUp.status === 200 && multiUp.data?.itemCount === 2, multiUp.raw)

const packNotFound = await api('GET', `/material-packs/${multiUp.data?.id}/items`, undefined, 'admin')
check('新包 items 可读', (packNotFound.data ?? []).length === 2, packNotFound.data)

/* ── 10. 声音库聚合（AC-V1） ──────────────────────────────── */
console.log('\n[10] 声音库聚合（AC-V1）')
const persona = await api('POST', '/personas', { name: `素材库声音人物${Date.now() % 10000}`, line: 'kos' }, 'admin')
check('创建 KOS 人物', persona.status === 200, persona.raw)
const personaId = persona.data?.id

const wavPath = join(TMP, 'voice.wav')
await pexec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', wavPath])
const sampleUp = await upload(
  `/personas/${personaId}/voice-samples`,
  [{ buf: readFileSync(wavPath), filename: 'voice.wav', type: 'audio/wav' }],
  {},
  'admin',
)
check('上传声音样本（产生 persona_voice 档案）', sampleUp.status === 200 && !!sampleUp.data?.sampleId, sampleUp.raw)

const voiceAll = await api('GET', '/voice-library', undefined, 'ops')
const voiceRows = voiceAll.data ?? []
check('ops 可读声音库聚合', voiceAll.status === 200 && Array.isArray(voiceRows), voiceAll.raw)
const mine = voiceRows.find((v: any) => v.personaId === personaId)
check('聚合含该人物声音且带授权状态字段', !!mine && typeof mine.confirmed === 'boolean' && typeof mine.consentBound === 'boolean', mine)

const voiceKos = await api('GET', '/voice-library?line=kos', undefined, 'ops')
check('按线筛选 kos 命中', (voiceKos.data ?? []).some((v: any) => v.personaId === personaId), voiceKos.data?.length)
const voiceManager = await api('GET', '/voice-library?line=manager', undefined, 'ops')
check('按线筛选 manager 不命中', !(voiceManager.data ?? []).some((v: any) => v.personaId === personaId), voiceManager.data?.length)

/* ── 收尾 ─────────────────────────────────────────────────── */
await env.shutdown()
rmSync(TMP, { recursive: true, force: true })

console.log(`\n===== 素材库 smoke 结果：${passed} 通过 / ${failed} 失败 =====\n`)
process.exit(failed === 0 ? 0 : 1)
