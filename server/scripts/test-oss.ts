/**
 * OSS 接入自检。
 *
 * 默认（hermetic，纳入 npm run check）：启动本地 OSS 协议仿真（scripts/lib/oss-emulator.ts，按 OSS 签名 V1
 * 真实校验），用真实的 ali-oss SDK 与 integrations/aliyun-oss/client.ts 跑 put / 分片 / Range 流式读 /
 * 签名 URL / 删除 / 错误凭证。沙箱访问不到 aliyuncs.com 时也能验证代码路径。
 *
 * --real：用 .env 里的真实 OSS_* 配置探活（put → Range 读 → 公网 https 签名 URL 实取 → delete），
 * 打印各步耗时；未配置时提示并以 0 退出（真实账号到位后在服务器上执行 npm run test:oss:real）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startOssEmulator } from './lib/oss-emulator.js'

const real = process.argv.includes('--real')

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`, extra === undefined ? '' : JSON.stringify(extra)?.slice(0, 400))
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-oss-'))
function tmpFile(name: string, data: Buffer): string {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, data)
  return p
}
const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

async function runReal(): Promise<void> {
  const { config, hasOss, ossConfigIssues } = await import('../src/config.js')
  const oss = await import('../src/integrations/aliyun-oss/client.js')
  console.log('=== OSS 真实账号探活 ===')
  for (const i of ossConfigIssues()) console.log(`  ⚠️ ${i}`)
  if (!hasOss()) {
    console.log('  ℹ️ 未配置 OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET，跳过（配置后重跑 npm run test:oss:real）')
    return
  }
  console.log(`  bucket=${config.oss.bucket} region=${config.oss.region} internal=${config.oss.internal} endpoint=${config.oss.endpoint || '(默认)'}`)
  const body = crypto.randomBytes(256 * 1024)
  const key = `healthcheck/${Date.now()}.bin`
  const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now()
    const r = await fn()
    console.log(`  ⏱  ${label} ${Date.now() - t0}ms`)
    return r
  }
  try {
    const put = await time('put', () => oss.putObjectFromFile(tmpFile('probe.bin', body), key, ''))
    check('put 成功且返回不带签名的地址', !put.mock && !put.url.includes('Signature'), put.url)
    const full = await time('get(full)', () => oss.getObjectStream(key))
    check('流式读取完整对象', !!full && sha(await readAll(full.stream)) === sha(body))
    const part = await time('get(range)', () => oss.getObjectStream(key, 'bytes=10-19'))
    check('Range 返回 206 且 10 字节', part?.status === 206 && (await readAll(part.stream)).equals(body.subarray(10, 20)), part?.status)
    const url = await oss.signedUrl(key, 600)
    check('签名 URL 为 https（飞影自取要求）', url.startsWith('https://'), url.slice(0, 60))
    check('签名 URL 不走内网域名', !/-internal\./.test(url), url.slice(0, 80))
    const fetched = await time('签名 URL 公网实取', () => fetch(url))
    check('签名 URL 公网可取回原内容', fetched.status === 200 && sha(Buffer.from(await fetched.arrayBuffer())) === sha(body), fetched.status)
  } catch (e) {
    check('探活过程无异常', false, (e as Error).message)
  } finally {
    await oss.deleteObject(key).catch(() => {})
  }
  const gone = await oss.getObjectStream(key)
  check('删除后读取返回 null', gone === null)
}

async function runEmulated(): Promise<void> {
  const emu = await startOssEmulator()
  Object.assign(process.env, {
    OSS_BUCKET: emu.bucket,
    OSS_ACCESS_KEY_ID: emu.accessKeyId,
    OSS_ACCESS_KEY_SECRET: emu.accessKeySecret,
    OSS_ENDPOINT: emu.endpoint,
    OSS_CNAME: 'true',
    OSS_SIGN_ENDPOINT: '',
    OSS_INTERNAL: 'false',
    OSS_MULTIPART_THRESHOLD_MB: '1',
    MOCK_FALLBACK: 'false',
  })
  const { config, hasOss, ossConfigIssues } = await import('../src/config.js')
  const oss = await import('../src/integrations/aliyun-oss/client.js')
  console.log('=== OSS 接入自检（本地协议仿真，真实 ali-oss SDK）===')

  try {
    console.log('\n[1] 配置自检')
    check('仿真配置识别为已启用', hasOss() && oss.isOssEnabled())
    check('完整配置无告警', ossConfigIssues().length === 0, ossConfigIssues())
    const saved = { ...config.oss }
    config.oss.accessKeySecret = ''
    check('半配置被识别并提示（回落本地存储）', ossConfigIssues().some((m) => m.includes('不完整')) && !hasOss())
    Object.assign(config.oss, saved)
    config.oss.internal = true
    config.oss.endpoint = ''
    config.oss.signEndpoint = ''
    check('OSS_INTERNAL=true 提示签名走公网', ossConfigIssues().some((m) => m.includes('签名 URL 已强制改用公网域名')))
    config.oss.signEndpoint = 'http://insecure.example.com'
    check('OSS_SIGN_ENDPOINT 非 https 被提示', ossConfigIssues().some((m) => m.includes('必须是 https')))
    Object.assign(config.oss, saved)

    console.log('\n[2] 小文件 put / 完整流式读 / Range / 不存在')
    const small = crypto.randomBytes(64 * 1024)
    const put = await oss.putObjectFromFile(tmpFile('small.bin', small), 'persona/p1/photo/a.bin', '')
    check('put 返回 key 且 mock=false', put.key === 'persona/p1/photo/a.bin' && put.mock === false, put)
    check('返回地址不含签名参数', !put.url.includes('?') && !put.url.includes('Signature'), put.url)
    check('对象确实落到仿真 OSS', emu.objects.get('persona/p1/photo/a.bin')?.body.equals(small) === true)
    check('请求使用请求头签名（Authorization）', emu.requests.some((r) => r.method === 'PUT' && r.auth === 'header' && r.status === 200))

    const full = await oss.getObjectStream('persona/p1/photo/a.bin')
    check('getObjectStream 返回可读流（非已消耗的 Buffer 响应）', !!full && typeof (full.stream as any).on === 'function')
    check('完整读取内容一致', !!full && (await readAll(full.stream)).equals(small))
    check('完整读取状态 200 且带长度', full?.status === 200 && full?.contentLength === small.length, { s: full?.status, l: full?.contentLength })

    const ranged = await oss.getObjectStream('persona/p1/photo/a.bin', 'bytes=100-199')
    check('Range 返回 206', ranged?.status === 206, ranged?.status)
    check('Range 内容与区间一致', !!ranged && (await readAll(ranged.stream)).equals(small.subarray(100, 200)))
    check('Content-Range 头透传', ranged?.contentRange === `bytes 100-199/${small.length}`, ranged?.contentRange)
    check('请求确实携带 Range 头', emu.requests.some((r) => r.method === 'GET' && r.range === 'bytes=100-199'))

    const bad = await oss.getObjectStream('persona/p1/photo/a.bin', 'bytes=99999999-')
    check('越界 Range 返回 416 且流可安全读取', bad?.status === 416 && (await readAll(bad.stream)).length === 0, bad?.status)
    check('不存在的对象返回 null', (await oss.getObjectStream('persona/p1/nope.bin')) === null)

    console.log('\n[3] 大文件分片上传（阈值 1MB，样本 9MB）')
    const big = crypto.randomBytes(9 * 1024 * 1024)
    const before = emu.requests.length
    const bigPut = await oss.putObjectFromFile(tmpFile('big.bin', big), 'persona/p1/avatar_source/big.bin', '')
    const bigReqs = emu.requests.slice(before)
    check('分片上传成功', bigPut.mock === false && bigPut.key.endsWith('big.bin'), bigPut)
    check('走了 Initiate → UploadPart×N → Complete', bigReqs.some((r) => r.method === 'POST' && r.query.includes('uploads'))
      && bigReqs.filter((r) => r.method === 'PUT' && r.query.includes('partNumber')).length >= 2
      && bigReqs.some((r) => r.method === 'POST' && r.query.includes('uploadId')), bigReqs.map((r) => `${r.method}${r.query.slice(0, 30)}`))
    check('合并后内容与源文件一致', emu.objects.get('persona/p1/avatar_source/big.bin')?.body.equals(big) === true)
    const bigRead = await oss.getObjectStream('persona/p1/avatar_source/big.bin', 'bytes=8388600-8388699')
    check('大对象跨分片边界 Range 读取正确', !!bigRead && (await readAll(bigRead.stream)).equals(big.subarray(8388600, 8388700)))

    console.log('\n[4] 签名 URL（交给飞影等外部服务）')
    const url = await oss.signedUrl('persona/p1/photo/a.bin', 600)
    const u = new URL(url)
    check('URL 带 Expires / OSSAccessKeyId / Signature', ['Expires', 'OSSAccessKeyId', 'Signature'].every((k) => u.searchParams.has(k)), u.search)
    const ok = await fetch(url)
    check('签名 URL 无需凭证即可取回内容', ok.status === 200 && Buffer.from(await ok.arrayBuffer()).equals(small), ok.status)
    check('请求被识别为 URL 签名鉴权', emu.requests.some((r) => r.auth === 'query' && r.status === 200))
    const tampered = new URL(url)
    tampered.searchParams.set('Signature', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=')
    check('篡改签名被拒绝（403）', (await fetch(tampered)).status === 403)
    const noSig = new URL(url)
    noSig.searchParams.delete('Signature')
    check('去掉签名被拒绝（403）', (await fetch(noSig)).status === 403)
    const shortLived = await oss.signedUrl('persona/p1/photo/a.bin', 1)
    await new Promise((r) => setTimeout(r, 2200))
    check('过期签名被拒绝（403）', (await fetch(shortLived)).status === 403)
    const dayLong = new URL(await oss.signedUrl('persona/p1/photo/a.bin', 24 * 3600))
    const exp = Number(dayLong.searchParams.get('Expires'))
    check('24 小时签名有效期正确（飞影自取）', Math.abs(exp - (Date.now() / 1000 + 86400)) < 30, exp)

    console.log('\n[5] 公网签名域名：OSS_INTERNAL=true 时仍不得走内网')
    config.oss.endpoint = ''
    config.oss.cname = false
    config.oss.internal = true
    config.oss.signEndpoint = ''
    oss.resetOssClients()
    const internalUrl = await oss.signedUrl('persona/p1/photo/a.bin', 600)
    check('内网模式下签名 URL 使用公网域名', !/-internal\./.test(internalUrl) && /aliyuncs\.com/.test(internalUrl) && internalUrl.startsWith('https://'), internalUrl.slice(0, 90))
    config.oss.signEndpoint = 'https://oss-cn-shanghai.aliyuncs.com'
    oss.resetOssClients()
    const signedPublic = await oss.signedUrl('persona/p1/photo/a.bin', 600)
    check('显式 OSS_SIGN_ENDPOINT 生效且为 https', signedPublic.startsWith('https://') && !/-internal\./.test(signedPublic), signedPublic.slice(0, 90))
    // 换个 Host 访问仿真：签名与 Host 无关，只与 bucket / key / Expires 有关，证明签出的 URL 在真实域名上同样有效
    const sp = new URL(signedPublic)
    const rewritten = `${emu.endpoint}${sp.pathname}${sp.search}`
    check('该签名可被服务端验证通过', (await fetch(rewritten)).status === 200)
    config.oss.endpoint = emu.endpoint
    config.oss.cname = true
    config.oss.internal = false
    config.oss.signEndpoint = ''
    oss.resetOssClients()

    console.log('\n[6] 删除 / 错误凭证')
    await oss.deleteObject('persona/p1/photo/a.bin')
    check('删除后读取返回 null', (await oss.getObjectStream('persona/p1/photo/a.bin')) === null)
    check('仿真端已无该对象', !emu.objects.has('persona/p1/photo/a.bin'))
    await oss.deleteObject('persona/p1/never-existed.bin')
    check('删除不存在的对象不抛错', true)

    config.oss.accessKeySecret = 'wrong-secret'
    oss.resetOssClients()
    let putErr = ''
    await oss.putObjectFromFile(tmpFile('x.bin', Buffer.from('x')), 'persona/p1/x.bin', '').catch((e) => { putErr = String((e as Error).message) })
    check('错误 AccessKeySecret：put 抛出签名错误而非静默成功', /signature|Signature|403/.test(putErr), putErr)
    check('错误凭证下对象未写入', !emu.objects.has('persona/p1/x.bin'))
    check('错误凭证读取返回 null 而不是挂起', (await oss.getObjectStream('persona/p1/photo/a.bin')) === null)
    config.oss.accessKeySecret = emu.accessKeySecret
    oss.resetOssClients()

    console.log('\n[7] 未配置时的本地兜底不受影响')
    const savedBucket = config.oss.bucket
    config.oss.bucket = ''
    config.mockFallback = true
    check('清空配置后 isOssEnabled=false', !oss.isOssEnabled())
    config.oss.bucket = savedBucket
  } finally {
    await emu.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

try {
  if (real) await runReal()
  else await runEmulated()
} catch (e) {
  failed++
  console.log('  ❌ 脚本异常', (e as Error).stack ?? e)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n=== OSS 自检结果：${passed} 通过，${failed} 失败 ===`)
process.exit(failed ? 1 : 0)
