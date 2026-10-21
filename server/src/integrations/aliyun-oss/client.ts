import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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

async function getClient(): Promise<any> {
  const OSS = (await import('ali-oss')).default as any
  return new OSS({
    region: config.oss.region,
    bucket: config.oss.bucket,
    accessKeyId: config.oss.accessKeyId,
    accessKeySecret: config.oss.accessKeySecret,
    internal: config.oss.internal,
    secure: true,
  })
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
  // P2-2：传文件路径由 SDK 流式上传；超过 100MB 走分片上传，避免整份读入内存
  const { size } = await fsp.stat(filePath)
  const res =
    size > 100 * 1024 * 1024
      ? await client.multipartUpload(key, filePath, { partSize: 10 * 1024 * 1024 })
      : await client.put(key, filePath)
  return { key, url: res?.url ?? res?.res?.requestUrls?.[0]?.split('?')[0] ?? '', mock: false }
}

/** 把存储对象流式写到本地文件（OSS 或本地兜底） */
export async function downloadObjectToFile(key: string, destPath: string): Promise<void> {
  if (!isOssEnabled()) {
    await fsp.copyFile(path.join(paths.dataDir, 'oss', key), destPath)
    return
  }
  const res = await getObjectStream(key)
  if (!res) throw new Error(`存储对象不存在或读取失败：${key}`)
  await pipeline(res.stream as NodeJS.ReadableStream, fs.createWriteStream(destPath))
}

/** 签名 URL：有效期覆盖转写耗时；L13 飞影自取需 24 小时有效期 */
export async function signedUrl(key: string, ttlSeconds?: number): Promise<string> {
  const ttl = ttlSeconds ?? config.oss.signedUrlTtl
  if (!isOssEnabled()) {
    const local = path.join(paths.dataDir, 'oss', key)
    return `file:///${local.replace(/\\/g, '/')}`
  }
  const client = await getClient()
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
    // P2-4：只认单段范围；支持 bytes=a-b、bytes=a- 与末尾范围 bytes=-N，其余按整份返回
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
    if (m && (m[1] || m[2])) {
      if (!m[1]) {
        start = Math.max(0, total - Number(m[2]))
      } else {
        start = Number(m[1])
        if (m[2]) end = Math.min(Number(m[2]), total - 1)
      }
      if (start > end || start >= total) {
        return {
          stream: Readable.from([]),
          contentType: null,
          contentLength: 0,
          contentRange: `bytes */${total}`,
          status: 416,
        }
      }
    }
    const partial = !!m && (!!m[1] || !!m[2])
    return {
      stream: fs.createReadStream(local, { start, end }),
      contentType: guessContentType(local),
      contentLength: end - start + 1,
      contentRange: partial ? `bytes ${start}-${end}/${total}` : null,
      status: partial ? 206 : 200,
    }
  }
  try {
    const client = await getClient()
    const res = await client.get(key, range ? { headers: { Range: range } } : {})
    const headers = (res.res as any)?.headers ?? {}
    return {
      stream: res.res as unknown as NodeJS.ReadableStream,
      contentType: (headers['content-type'] as string) ?? null,
      contentLength: Number(headers['content-length'] ?? 0) || null,
      contentRange: (headers['content-range'] as string) ?? null,
      status: Number((res.res as any)?.statusCode ?? 200),
    }
  } catch (e) {
    logger.warn({ key, err: (e as Error).message }, 'oss.get_failed')
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
