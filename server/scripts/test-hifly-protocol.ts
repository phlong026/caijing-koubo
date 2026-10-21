/**
 * 飞影协议契约测试（R5 平移众墅之家 test_hifly_protocol，AC-H1/H2/H4）。
 * 用本地 node:http 桩服务器驱动真实 HttpHiflyClient，覆盖：
 *  - 请求体字段（title/video_url/aigc_flag、普通话不传 languages、TTS 上限）；
 *  - 信封解析（code 数字/数字字符串/布尔、上传凭证无 code、video_Url 拼写、avatar/avatar_id）；
 *  - 状态码 1/2/3/4 → WAITING/PROCESSING/DONE/FAILED；
 *  - 错误分类（业务码 → HiflyVendorError；创建类网络异常 → HiflySubmissionUncertain；查询类 → HiflyQueryError）；
 *  - mock 客户端确定性与故障注入。
 * 用法：npm run test:hifly:protocol（纳入 npm run check）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HiflyQueryError,
  HiflySubmissionUncertain,
  HiflyVendorError,
  MAX_TTS_CHARS,
  PATHS,
  clipTitle,
  createHttpHiflyClient,
  mapTaskState,
  parseEnvelope,
  vendorErrorOf,
  type HiflyClient,
} from '../src/integrations/hifly/client.js'
import { clearHiflyInjections, getMockHiflyClient, injectHifly } from '../src/integrations/hifly/mock.js'
import { isApiError } from '../src/errors.js'

// 独立临时库：让 api_call_log 落库成功，避免「数据库未初始化」噪音
const temp = mkdtempSync(join(tmpdir(), 'hifly-protocol-'))
Object.assign(process.env, {
  DB_DRIVER: 'sqlite',
  DB_SQLITE_PATH: join(temp, 'test.db'),
  LOG_LEVEL: 'silent',
  MOCK_FALLBACK: 'true',
})
const { initDb, closeAll } = await import('../src/db/index.js')
const { runMigrations } = await import('../src/db/migrate.js')
await initDb()
await runMigrations()

let passed = 0
let failed = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  ✅ ${name}`)
    })
    .catch((e) => {
      failed++
      console.log(`  ❌ ${name}: ${(e as Error).message}`)
    })
}

/** 可控桩服务器：按路径路由返回预置响应 */
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: any) => void,
): Promise<{ baseUrl: string; close: () => Promise<void>; received: Array<{ path: string; body: any }> }> {
  const received: Array<{ path: string; body: any }> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: any = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = { __raw: raw }
      }
      received.push({ path: req.url ?? '', body })
      handler(req, res, body)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(s)
}

async function main(): Promise<void> {
  console.log('\n=== 飞影协议契约测试 ===\n')

  /* ── 1. 请求体字段 ───────────────────────────────────────────── */
  const srv1 = await startServer((req, res) => {
    if (req.url === PATHS.avatarCreateByVideo) {
      return json(res, 200, { code: 0, message: 'ok', data: { task_id: 'task_av_1' } })
    }
    if (req.url === PATHS.voiceCreate) {
      return json(res, 200, { code: 0, message: 'ok', data: { task_id: 'task_vc_1' } })
    }
    if (req.url === PATHS.avatarTask) {
      return json(res, 200, { code: '0', data: { task_id: 'task_av_1', status: 3, avatar_id: 'av_x1' } })
    }
    json(res, 404, { code: 404, message: 'not found' })
  })
  const c1 = createHttpHiflyClient(srv1.baseUrl, 'test-key')

  await check('create_by_video 请求体字段与 aigc_flag=0', async () => {
    const r = await c1.createAvatarByVideo({ title: '测试分身', videoUrl: 'https://example.com/v.mp4', aigcFlag: 0 })
    assert.equal(r.taskId, 'task_av_1')
    const sent = srv1.received.find((x) => x.path === PATHS.avatarCreateByVideo)!
    assert.equal(sent.body.title, '测试分身')
    assert.equal(sent.body.video_url, 'https://example.com/v.mp4')
    assert.equal(sent.body.aigc_flag, 0)
    assert.equal(sent.body.file_id, undefined)
  })

  await check('自上传路径：file_id 入参、不传 video_url', async () => {
    const r = await c1.createAvatarByVideo({ title: '自上传分身', fileId: 'file_abc' })
    assert.equal(r.taskId, 'task_av_1')
    const sent = srv1.received.filter((x) => x.path === PATHS.avatarCreateByVideo).at(-1)!
    assert.equal(sent.body.file_id, 'file_abc')
    assert.equal(sent.body.video_url, undefined)
  })

  await check('标题 ≤20 字截断', () => {
    assert.equal(clipTitle('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十').length, 20)
  })

  await check('普通话不传 languages，方言传白名单代码', async () => {
    await c1.createVoice({ title: '普通话音色', audioUrl: 'https://example.com/a.mp3' })
    await c1.createVoice({ title: '粤语音色', audioUrl: 'https://example.com/b.mp3', languages: 'zh_cantonese' })
    const mandarin = srv1.received.filter((x) => x.path === PATHS.voiceCreate)[0]
    const yue = srv1.received.filter((x) => x.path === PATHS.voiceCreate)[1]
    assert.equal(mandarin.body.languages, undefined)
    assert.equal(yue.body.languages, 'zh_cantonese')
    assert.equal(mandarin.body.voice_type, 8)
  })

  await check('信封解析：code 为数字字符串仍算成功', async () => {
    const r = await c1.avatarTask('task_av_1')
    assert.equal(r.state, 'DONE')
    assert.equal(r.avatarId, 'av_x1')
  })

  await check('TTS 文本 >10000 字客户端直接拒绝', async () => {
    await assert.rejects(
      () => c1.createAudioByTts({ voiceId: 'v1', text: 'x'.repeat(MAX_TTS_CHARS + 1) }),
      (e: unknown) => isApiError(e) && e.code === 'HIFLY_BAD_REQUEST',
    )
  })

  /* ── 2. 状态映射 / 拼写兼容 / 无 code 信封 ───────────────────── */
  const srv2 = await startServer((req, res) => {
    if (req.url === PATHS.avatarTask) {
      const status = Number(new URL(req.url!, 'http://x').searchParams.get('s') ?? '1')
      void status
      return json(res, 200, { code: 0, data: { task_id: 't', status: 1 } })
    }
    if (req.url === PATHS.videoTask) {
      return json(res, 200, { code: 0, data: { task_id: 't', status: 3, video_Url: 'https://example.com/out.mp4' } })
    }
    if (req.url === PATHS.voiceTask) {
      return json(res, 200, { code: true, data: { task_id: 't', status: 'DONE', voiceId: 'vc_1', demo_url: 'https://example.com/demo.mp3' } })
    }
    if (req.url === PATHS.toolCreateUploadUrl) {
      // 上传凭证接口无 code：字段在信封顶层（与众墅之家生产实现一致）
      return json(res, 200, {
        upload_url: 'https://upload.example.com/put',
        content_type: 'video/mp4',
        file_id: 'file_x1',
      })
    }
    if (req.url === PATHS.accountCredit) {
      return json(res, 200, { code: 0, data: { credit: 1234 } })
    }
    json(res, 404, { code: 404 })
  })
  const c2 = createHttpHiflyClient(srv2.baseUrl, 'test-key')

  await check('状态码 1/2/3/4 映射与字符串兼容', () => {
    assert.equal(mapTaskState(1), 'WAITING')
    assert.equal(mapTaskState(2), 'PROCESSING')
    assert.equal(mapTaskState(3), 'DONE')
    assert.equal(mapTaskState(4), 'FAILED')
    assert.equal(mapTaskState('done'), 'DONE')
    assert.equal(mapTaskState('FAILED'), 'FAILED')
    assert.equal(mapTaskState('processing'), 'PROCESSING')
  })

  await check('video_Url 拼写兼容', async () => {
    const r = await c2.videoTask('t')
    assert.equal(r.videoUrl, 'https://example.com/out.mp4')
  })

  await check('voiceId / demo_url 解析与布尔 code', async () => {
    const r = await c2.voiceTask('t')
    assert.equal(r.state, 'DONE')
    assert.equal(r.voiceId, 'vc_1')
    assert.equal(r.demoUrl, 'https://example.com/demo.mp3')
  })

  await check('上传凭证接口无 code：顶层字段即成功', async () => {
    const t = await c2.createUploadUrl({ fileExtension: 'mp4' })
    assert.equal(t.uploadUrl, 'https://upload.example.com/put')
    assert.equal(t.fileId, 'file_x1')
    assert.equal(t.contentType, 'video/mp4')
  })

  await check('account/credit 解析', async () => {
    assert.equal(await c2.credit(), 1234)
  })

  /* ── 3. 错误分类 ─────────────────────────────────────────────── */
  const srv3 = await startServer((req, res, body) => {
    if (req.url === PATHS.avatarCreateByVideo) {
      // title=y 的请求模拟网络异常（掐断），其余返回积分不足业务码
      if (body?.title === 'y') {
        req.socket.destroy()
        return
      }
      return json(res, 200, { code: 1002, message: '积分不足' })
    }
    if (req.url === PATHS.voiceCreate) {
      return json(res, 200, { code: '1009', message: '声音数量达上限' })
    }
    if (req.url === PATHS.avatarTask) {
      return json(res, 200, { code: 1011, message: '素材未过合规校验' })
    }
    // 轮询类其余路径：直接掐断连接（模拟网络异常）
    req.socket.destroy()
  })
  const c3 = createHttpHiflyClient(srv3.baseUrl, 'test-key')

  await check('业务码 → HiflyVendorError 且映射为统一错误码', async () => {
    await assert.rejects(
      () => c3.createAvatarByVideo({ title: 'x', videoUrl: 'https://e.com/v.mp4' }),
      (e: unknown) => {
        assert.ok(e instanceof HiflyVendorError)
        assert.equal(e.vendorCode, 1002)
        const api = vendorErrorOf(e.vendorCode, e.message)
        assert.equal(api.code, 'HIFLY_INSUFFICIENT_CREDIT')
        assert.equal((api.details as { vendorCode?: number }).vendorCode, 1002)
        return true
      },
    )
    await assert.rejects(
      () => c3.createVoice({ title: 'x', fileId: 'file_1' }),
      (e: unknown) => e instanceof HiflyVendorError && e.vendorCode === 1009,
    )
  })

  await check('查询类带业务码 → HiflyVendorError（1011 合规）', async () => {
    await assert.rejects(
      () => c3.avatarTask('t'),
      (e: unknown) => e instanceof HiflyVendorError && e.vendorCode === 1011,
    )
  })

  await check('创建类网络异常 → HiflySubmissionUncertain（L9 不自动重提）', async () => {
    await assert.rejects(
      () => c3.createAvatarByVideo({ title: 'y', videoUrl: 'https://e.com/v2.mp4' }),
      (e: unknown) => e instanceof HiflySubmissionUncertain,
    )
  })

  await check('查询类网络异常 → HiflyQueryError（不判失败）', async () => {
    await assert.rejects(
      () => c3.voiceTask('t'),
      (e: unknown) => e instanceof HiflyQueryError,
    )
  })

  /* ── 4. mock 客户端（AC-H4）──────────────────────────────────── */
  clearHiflyInjections()
  const mock = getMockHiflyClient()

  await check('mock：同素材 hash 返回确定性标识', async () => {
    const a = await mock.createAvatarByVideo({ title: '同标题', videoUrl: 'https://e.com/same.mp4' })
    const b = await mock.createAvatarByVideo({ title: '同标题', videoUrl: 'https://e.com/same.mp4' })
    assert.equal(a.taskId, b.taskId)
    assert.equal(a.raw.avatar_id, b.raw.avatar_id)
  })

  await check('mock：可注入 uncertain', async () => {
    injectHifly('avatar.create', { behavior: 'uncertain' })
    await assert.rejects(
      () => mock.createAvatarByVideo({ title: 'u', videoUrl: 'https://e.com/u.mp4' }),
      (e: unknown) => e instanceof HiflySubmissionUncertain,
    )
  })

  await check('mock：可注入指定业务码', async () => {
    injectHifly('voice.create', { behavior: 'vendor_code', vendorCode: 1002 })
    await assert.rejects(
      () => mock.createVoice({ title: 'u', fileId: 'file_u' }),
      (e: unknown) => e instanceof HiflyVendorError && e.vendorCode === 1002,
    )
  })

  await check('mock：任务轮询走到 DONE 并给标识', async () => {
    clearHiflyInjections()
    const acc = await mock.createVoice({ title: '试听', fileId: 'file_demo' })
    let r = await mock.voiceTask(acc.taskId)
    while (r.state !== 'DONE') r = await mock.voiceTask(acc.taskId)
    assert.ok(r.voiceId)
    assert.ok(r.demoUrl)
  })

  await check('信封解析：无 data 的无 code 响应判失败', () => {
    const env = parseEnvelope({})
    assert.equal(env.hasCode, false)
  })

  await srv1.close()
  await srv2.close()
  await srv3.close()
  clearHiflyInjections()
  await closeAll()

  console.log(`\n=== 契约测试结果：${passed} 通过，${failed} 失败 ===\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('契约测试异常终止：', e)
  process.exit(1)
})
