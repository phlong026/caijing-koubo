import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { config, hasOss, paths } from '../../config.js'
import { logger } from '../../log.js'

export interface OssPutResult {
  key: string
  url: string
  mock: boolean
}

/** 一期基线：OSS 私有桶 + 签名 URL（D11） */
export function isOssEnabled(): boolean {
  return hasOss()
}

type OssClient = any
let dataClient: OssClient | null = null
let signClient: OssClient | null = null

async function makeClient(extra: Record<string, unknown>): Promise<OssClient> {
  const OSS = (await import('ali-oss')).default as any
  return new OSS({
    region: config.oss.region,
    bucket: config.oss.bucket,
    accessKeyId: config.oss.accessKeyId,
    accessKeySecret: config.oss.accessKeySecret,
    secure: true,
    // 单次请求超时：分片上传 / 大文件下载由 ali-oss 内部按分片计时
    timeout: 120_000,
    ...extra,
  })
}

/** 数据面客户端（读写删）：OSS_INTERNAL / OSS_ENDPOINT 只影响它 */
async function getClient(): Promise<OssClient> {
  if (!dataClient) {
    dataClient = await makeClient({
      internal: config.oss.internal,
      ...(config.oss.endpoint ? { endpoint: config.oss.endpoint, cname: config.oss.cname } : {}),
    })
  }
  return dataClient
}

/**
 * 签名客户端：签出的 URL 要交给飞影等外部服务访问，所以永远走公网域名，
 * 不受 OSS_INTERNAL 影响（内网域名签出的 URL 外部根本打不开）。
 * 仅在显式配了 OSS_ENDPOINT 且未配 OSS_SIGN_ENDPOINT 时沿用数据面端点（私有域名 / 仿真场景）。
 */
async function getSignClient(): Promise<OssClient> {
  if (!signClient) {
    const endpoint = config.oss.signEndpoint || config.oss.endpoint
    signClient = await makeClient({
      internal: false,
      ...(endpoint ? { endpoint, cname: config.oss.cname } : {}),
    })
  }
  return signClient
}

/** 测试 / 配置热更新用：丢弃缓存的客户端 */
export function resetOssClients(): void {
  dataClient = null
  signClient = null
}

/** 本地兜底：无 OSS 配置时写入 .data/oss，返回 file:// URL（仅供 mock 链路） */
async function putLocal(filePath: string, key: string): Promise<OssPutResult> {
  const dest = path.join(paths.dataDir, 'oss', key)
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(filePath, dest)
  return { key, url: `file:///${dest.replace(/\\/g, '/')}`, mock: true }
}

/**
 * 上传（R30：前缀按调用传参，不再用固定 OSS_PREFIX）。
 * 传 prefix 时以调用方为准；不传则回退 config.oss.prefix（兼容既有调用方）。
 */
export async function putObjectFromFile(filePath: string, objectKey: string, prefix?: string): Promise<OssPutResult> {
  const base = (prefix ?? config.oss.prefix).replace(/^\/+|\/+$/g, '')
  const key = base ? `${base}/${objectKey}`.replace(/\/{2,}/g, '/') : objectKey
  if (!isOssEnabled()) {
    if (!config.mockFallback) throw new Error('OSS 未配置（OSS_BUCKET / AccessKey）')
    return putLocal(filePath, key)
  }
  const client = await getClient()
  const size = (await fsp.stat(filePath)).size
  let res: any
  if (size > config.oss.multipartThresholdMb * 1024 * 1024) {
    // 大文件（分身素材可达 200MB）走分片：不整体读入内存，单片失败只重传该片
    res = await client.multipartUpload(key, filePath, { partSize: 8 * 1024 * 1024, parallel: 3 })
  } else {
    // 传路径而不是 Buffer：ali-oss 内部按流发送
    res = await client.put(key, filePath)
  }
  // 返回不带查询串的对象地址，避免把任何签名信息落进库 / 日志
  const url = String(res?.url ?? res?.res?.requestUrls?.[0] ?? '').split('?')[0]
  return { key, url, mock: false }
}

/** 签名 URL：有效期覆盖转写耗时；L13 飞影自取需 24 小时有效期 */
export async function signedUrl(key: string, ttlSeconds?: number): Promise<string> {
  const ttl = ttlSeconds ?? config.oss.signedUrlTtl
  if (!isOssEnabled()) {
    const local = path.join(paths.dataDir, 'oss', key)
    return `file:///${local.replace(/\\/g, '/')}`
  }
  const client = await getSignClient()
  return client.signatureUrl(key, { expires: ttl })
}

export async function deleteObject(key: string): Promise<void> {
  if (!isOssEnabled()) {
    try {
      await fsp.unlink(path.join(paths.dataDir, 'oss', key))
    } catch {
      /* 忽略 */
    }
    return
  }
  try {
    const client = await getClient()
    await client.delete(key)
  } catch (e) {
    logger.warn({ key, err: (e as Error).message }, 'oss.delete_failed')
  }
}

export interface ObjectStreamResult {
  stream: NodeJS.ReadableStream
  contentType: string | null
  contentLength: number | null
  contentRange: string | null
  status: number
}

/**
 * 流式读取（FR-A4：/persona-assets/:id/file 经后端代理，不暴露真实路径与长期公网 URL）。
 * 本地兜底：fs 流 + Range 精确切片；OSS：get 透传 Range 头。
 */
export async function getObjectStream(key: string, range?: string): Promise<ObjectStreamResult | null> {
  if (!isOssEnabled()) {
    const local = path.join(paths.dataDir, 'oss', key)
    if (!fs.existsSync(local)) return null
    const stat = await fsp.stat(local)
    const total = stat.size
    let start = 0
    let end = total - 1
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      if (m) {
        if (m[1]) start = Number(m[1])
        if (m[2]) end = Math.min(Number(m[2]), total - 1)
        if (start > end || start >= total) {
          return {
            stream: fs.createReadStream(local, { start: 0, end: 0 }),
            contentType: null,
            contentLength: 0,
            contentRange: null,
            status: 416,
          }
        }
      }
    }
    return {
      stream: fs.createReadStream(local, { start, end }),
      contentType: guessContentType(local),
      contentLength: end - start + 1,
      contentRange: range ? `bytes ${start}-${end}/${total}` : null,
      status: range ? 206 : 200,
    }
  }
  try {
    const client = await getClient()
    // 必须用 getStream：get() 会把整个对象读进 Buffer，res.res 不是可读流
    const res = await client.getStream(key, range ? { headers: { Range: range } } : {})
    const headers = (res.res as any)?.headers ?? {}
    return {
      stream: res.stream as NodeJS.ReadableStream,
      contentType: (headers['content-type'] as string) ?? null,
      contentLength: Number(headers['content-length'] ?? 0) || null,
      contentRange: (headers['content-range'] as string) ?? null,
      status: Number((res.res as any)?.status ?? (res.res as any)?.statusCode ?? 200),
    }
  } catch (e) {
    const code = (e as { code?: string; status?: number }).code
    if (code === 'NoSuchKey' || (e as { status?: number }).status === 404) return null
    if ((e as { status?: number }).status === 416) {
      return { stream: Readable.from([]), contentType: null, contentLength: 0, contentRange: null, status: 416 }
    }
    logger.warn({ key, code, err: (e as Error).message }, 'oss.get_failed')
    return null
  }
}

function guessContentType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
  }
  return map[ext] ?? null
}

/** 健康检查用 */
export async function ossStatus(): Promise<{ enabled: boolean; bucket: string | null; localFiles?: number }> {
  if (!isOssEnabled()) {
    try {
      const dir = path.join(paths.dataDir, 'oss')
      const count = fs.existsSync(dir) ? await countFiles(dir) : 0
      return { enabled: false, bucket: null, localFiles: count }
    } catch {
      return { enabled: false, bucket: null }
    }
  }
  return { enabled: true, bucket: config.oss.bucket }
}

async function countFiles(dir: string): Promise<number> {
  let n = 0
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) n += await countFiles(path.join(dir, e.name))
    else n++
  }
  return n
}
