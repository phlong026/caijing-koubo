import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
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

export async function putObjectFromFile(filePath: string, objectKey: string): Promise<OssPutResult> {
  const key = `${config.oss.prefix}${objectKey}`.replace(/\/{2,}/g, '/')
  if (!isOssEnabled()) {
    if (!config.mockFallback) throw new Error('OSS 未配置（OSS_BUCKET / AccessKey）')
    return putLocal(filePath, key)
  }
  const client = await getClient()
  const buffer = await fsp.readFile(filePath)
  const res = await client.put(key, buffer)
  return { key, url: res?.url ?? '', mock: false }
}

/** 签名 URL：有效期覆盖转写耗时 */
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
