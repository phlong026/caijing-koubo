import fs from 'node:fs'
import { config } from '../../../config.js'
import { logger } from '../../../log.js'
import { err } from '../../../errors.js'
import { isOssEnabled, signedUrl } from '../../../integrations/aliyun-oss/client.js'
import type { HiflyClient, HiflyUploadTicket } from '../../../integrations/hifly/client.js'

/**
 * 素材交付给飞影（L13，平移众墅之家 _vendor_fetchable_url / _transfer_material_to_vendor）。
 *
 * 优先「飞影自取」：OSS 签发 24 小时签名 URL，传 video_url / audio_url，
 * 大素材不消耗服务器出口带宽（2026-10-11 事故：38.6MB 4K 自上传 60s 超时）。
 * 无公网可达 URL（本地兜底存储 / mock）时回落「自上传」：
 * tool/create_upload_url + PUT 原始字节，只对超时重试 2 次、每次换新凭证
 * （非超时错误——业务码 / 鉴权 / 凭证不完整——立即抛出，重试无意义）。
 */

/** 签名 URL 有效期：覆盖飞影拉取与任务排队耗时 */
const SIGNED_URL_TTL_SECONDS = 24 * 3600
/** 自上传重试次数（含首次） */
const UPLOAD_ATTEMPTS = 3
/** 自上传重试间隔 */
const UPLOAD_RETRY_DELAY_MS = 2000

export type MaterialHandover =
  | { kind: 'url'; url: string; mode: 'signed' | 'mock' }
  | { kind: 'file'; fileId: string; mode: 'upload' }

function isTimeoutError(e: unknown): boolean {
  const err = e as { code?: string; message?: string }
  return err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || /timeout/i.test(err?.message ?? '')
}

/** OSS 公网可达的签名 URL；本地兜底 / 签名失败返回 null（回落自上传） */
async function vendorFetchableUrl(storageKey: string): Promise<string | null> {
  if (!isOssEnabled()) return null
  try {
    const url = await signedUrl(storageKey, SIGNED_URL_TTL_SECONDS)
    return url.startsWith('https://') ? url : null
  } catch (e) {
    logger.warn({ err: (e as Error).message, storageKey }, 'hifly.transfer.presign_failed')
    return null
  }
}

/** 自上传：换新凭证重试（仅超时） */
async function uploadWithRetry(
  client: HiflyClient,
  localPath: string,
  fileExtension: string,
): Promise<HiflyUploadTicket> {
  let lastTimeout: unknown = null
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const ticket = await client.createUploadUrl({ fileExtension })
      await client.uploadFile(ticket, localPath)
      return ticket
    } catch (e) {
      if (!isTimeoutError(e)) throw e
      lastTimeout = e
      logger.warn(
        { attempt, max: UPLOAD_ATTEMPTS, localPath },
        'hifly.transfer.upload_timeout',
      )
      if (attempt < UPLOAD_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, UPLOAD_RETRY_DELAY_MS))
      }
    }
  }
  throw lastTimeout instanceof Error ? lastTimeout : new Error('素材上传飞影超时')
}

/**
 * 交付素材并返回「传给 create_* 的引用」。
 * @param client 飞影客户端（mock 客户端直接走 mock:// 交付）
 * @param storageKey 私有存储 key（OSS 自取用；本地兜底时配 localPath）
 * @param localPath 本地文件路径（自上传 / mock 兜底用）
 * @param fileExtension 自上传时的扩展名（不带点）
 * @param mockSeed mock 模式下的确定性种子
 */
export async function deliverMaterial(
  client: HiflyClient,
  input: {
    storageKey?: string
    localPath?: string | null
    fileExtension: string
    mockSeed: string
  },
): Promise<MaterialHandover> {
  if (client.mock) {
    return { kind: 'url', url: `mock://material/${input.mockSeed}`, mode: 'mock' }
  }
  if (input.storageKey) {
    const url = await vendorFetchableUrl(input.storageKey)
    if (url) return { kind: 'url', url, mode: 'signed' }
  }
  if (!input.localPath || !fs.existsSync(input.localPath)) {
    throw err.hiflyUnavailable('素材文件不存在，无法交付给飞影', { storageKey: input.storageKey ?? null })
  }
  const ticket = await uploadWithRetry(client, input.localPath, input.fileExtension)
  return { kind: 'file', fileId: ticket.fileId, mode: 'upload' }
}

/** 下载 URL 的 https 校验（与客户端 download 口径一致） */
export function assertHttpsUrl(url: string): void {
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`飞影结果地址必须为 https（当前 ${url.slice(0, 32)}…）`)
  }
}

export const HIFLY_BINARY_TIMEOUT_MS = config.hifly.binaryTimeoutMs
