/**
 * 飞影真实账号探活（任务书 PL4a / AC-H5）。
 *
 * 默认（不消耗积分）：
 *   1. 余额查询（account/credit）
 *   2. 上传凭证（tool/create_upload_url）——验证鉴权与上传通道
 *   3. 声音 / 分身列表（voice/list、avatar/list）——验证只读接口与分页字段
 *
 * 追加 --spend（会真实消耗积分，务必先与负责人确认）：
 *   4. 用 tmp 下生成的 8 秒正弦样本克隆一条声音，记录各阶段耗时与积分变化；
 *   5. 带 --avatar <本地视频路径> 时再制作一个分身（素材须自备，须有肖像授权）。
 *
 * 结论请回写到《人物库任务书》§10 / §11，并存入 docs/（耗时、积分消耗、素材要求与默认值的差异）。
 *
 * 用法：
 *   HIFLY_API_KEY=... npm run test:hifly
 *   HIFLY_API_KEY=... npm run test:hifly -- --spend
 *   HIFLY_API_KEY=... npm run test:hifly -- --spend --avatar /path/to/avatar.mp4
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const pexec = promisify(execFile)
const spend = process.argv.includes('--spend')
const avatarPath = process.argv.includes('--avatar') ? process.argv[process.argv.indexOf('--avatar') + 1] : ''

const { config, hasHifly } = await import('../src/config.js')
const { createHttpHiflyClient } = await import('../src/integrations/hifly/client.js')

const lines: string[] = []
function log(msg: string): void {
  console.log(msg)
  lines.push(msg)
}
async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now()
  const value = await fn()
  const ms = Date.now() - t0
  log(`  ⏱  ${label}：${ms}ms`)
  return { value, ms }
}

console.log('=== 飞影真实账号探活 ===')
if (!hasHifly()) {
  console.log('  ℹ️ 未配置 HIFLY_API_KEY，跳过（配置后重跑 npm run test:hifly；不会消耗积分，除非追加 --spend）')
  process.exit(0)
}
log(`  base=${config.hifly.baseUrl}（密钥已配置，不回显）`)

const client = createHttpHiflyClient()
let failed = 0
const fail = (m: string, e: unknown): void => {
  failed++
  log(`  ❌ ${m}：${(e as Error).message}`)
}

let credit0: number | null = null
try {
  const { value } = await timed('account/credit', () => client.credit())
  credit0 = value
  log(`  ✅ 余额 ${value}`)
} catch (e) {
  fail('余额查询', e)
}

try {
  const { value } = await timed('tool/create_upload_url', () => client.createUploadUrl({ fileExtension: 'mp3' }))
  log(`  ✅ 上传凭证 fileId=${String(value.fileId).slice(0, 8)}…（地址不回显）`)
} catch (e) {
  fail('上传凭证', e)
}

try {
  const { value } = await timed('voice/list', () => client.voiceList({ page: 1, pageSize: 20 }))
  log(`  ✅ 声音列表 ${value.length} 条，示例字段：${JSON.stringify(Object.keys(value[0]?.raw ?? {})).slice(0, 120)}`)
} catch (e) {
  fail('声音列表', e)
}
try {
  const { value } = await timed('avatar/list', () => client.avatarList({ page: 1, pageSize: 20, kind: 2 }))
  log(`  ✅ 分身列表 ${value.length} 条`)
} catch (e) {
  fail('分身列表', e)
}

if (spend) {
  log('\n  ⚠️ --spend：以下步骤会真实消耗积分')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hifly-probe-'))
  try {
    const wav = path.join(tmp, 'probe.wav')
    await pexec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', wav])
    const ticket = (await timed('create_upload_url(wav)', () => client.createUploadUrl({ fileExtension: 'wav' }))).value
    await timed('PUT 样本', () => client.uploadFile(ticket, wav))
    const accept = (await timed('voice/create', () => client.createVoice({ title: `探活-${Date.now() % 100000}`, fileId: ticket.fileId, voiceType: 8 }))).value
    log(`  ✅ 声音任务已受理 task=${accept.taskId}`)
    const started = Date.now()
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      const snap = await client.voiceTask(accept.taskId)
      if (snap.state === 'DONE' || snap.state === 'FAILED') {
        log(`  ✅ 声音克隆 ${snap.state}，耗时 ${Math.round((Date.now() - started) / 1000)}s，voice=${snap.voiceId ?? '—'}，试听=${snap.demoUrl ? '有' : '无'}${snap.failReason ? `，原因：${snap.failReason}` : ''}`)
        break
      }
    }
    if (avatarPath) {
      const ext = path.extname(avatarPath).slice(1) || 'mp4'
      const t = (await timed('create_upload_url(video)', () => client.createUploadUrl({ fileExtension: ext }))).value
      await timed('PUT 分身素材', () => client.uploadFile(t, avatarPath))
      const acc = (await timed('avatar/create_by_video', () => client.createAvatarByVideo({ title: `探活-${Date.now() % 100000}`, fileId: t.fileId, aigcFlag: config.hifly.aigcFlag }))).value
      const t1 = Date.now()
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 10_000))
        const snap = await client.avatarTask(acc.taskId)
        if (snap.state === 'DONE' || snap.state === 'FAILED') {
          log(`  ✅ 分身制作 ${snap.state}，耗时 ${Math.round((Date.now() - t1) / 1000)}s，avatar=${snap.avatarId ?? '—'}${snap.failReason ? `，原因：${snap.failReason}` : ''}`)
          break
        }
      }
    }
    if (credit0 !== null) {
      const after = await client.credit()
      log(`  💰 积分消耗：${credit0 - after}（${credit0} → ${after}）`)
    }
  } catch (e) {
    fail('--spend 步骤', e)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
} else {
  log('\n  ℹ️ 未追加 --spend，没有创建任何克隆任务（零积分消耗）')
}

console.log(`\n=== 探活结束：${failed ? `${failed} 项失败` : '全部通过'} ===`)
console.log('请把上面的耗时 / 积分 / 字段差异回写到《人物库任务书》§10 / §11 与 docs/。')
process.exit(failed ? 1 : 0)
