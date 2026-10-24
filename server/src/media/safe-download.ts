import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import dns from 'node:dns'
import { config } from '../config.js'

/**
 * 成片下载防 SSRF（FR-P4 / AC-E5；♻ 平移 AI-Studio `provider-runninghub.js` 的
 * blockedAddress / pinnedLookup / openValidatedUrlStream，宿主依赖换成本仓库配置）。
 *
 * 校验链：https + 无凭据 + 443 端口 + 域名白名单 + 域名非 IP/localhost
 * + DNS 解析全部地址非内网/回环 + ≤3 次跳转（每次跳转重新校验）+ 大小上限。
 * 白名单：HIFLY_RESULT_HOSTS + 飞影已知域名后缀（PoC 实测后可在 env 收紧）。
 */

export class SafeDownloadError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'SafeDownloadError'
  }
}

/** 飞影成片已知域名后缀（PoC 记录；HIFLY_RESULT_HOSTS 配置后以配置为准追加） */
const BUILTIN_RESULT_HOST_SUFFIXES = ['.hifly.cc', '.hiflycdn.com']

export function resultHostAllowlist(): string[] {
  return [...new Set([...config.videoResultHosts.map((h) => h.toLowerCase()), ...BUILTIN_RESULT_HOST_SUFFIXES])]
}

function isBlockedAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const parts = address.split('.').map(Number)
    return (
      parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
      parts[0]! >= 224
    )
  }
  const normalized = address.toLowerCase()
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('::ffff:')
  )
}

function hostAllowed(host: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => host === entry || (entry.startsWith('.') && host.endsWith(entry)))
}

interface ResolvedUrl {
  url: URL
  addresses: Array<{ address: string; family: number }>
}

async function resolveValidatedUrl(value: string, allowlist: string[]): Promise<ResolvedUrl> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SafeDownloadError('结果地址无法解析', 'invalid_url')
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new SafeDownloadError('结果地址必须是 https 且不带凭据与非标端口', 'not_https')
  }
  const host = url.hostname.toLowerCase()
  if (net.isIP(host) || host === 'localhost' || host.endsWith('.localhost') || !hostAllowed(host, allowlist)) {
    throw new SafeDownloadError(`结果域名 ${host} 不在白名单内`, 'host_blocked')
  }
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new SafeDownloadError(`结果域名 ${host} 解析失败`, 'dns_failed')
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((a) => !a?.address || isBlockedAddress(a.address))) {
    throw new SafeDownloadError(`结果域名 ${host} 解析到内网或回环地址，已拒绝`, 'private_address')
  }
  return { url, addresses }
}

/** DNS 钉扎：请求只允许连到校验过的地址，防 TOCTOU */
function pinnedLookup(addresses: Array<{ address: string; family: number }>): unknown {
  return (_hostname: string, options: dns.LookupAllOptions | (() => void), callback?: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address?: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void
    if (options && typeof options === 'object' && (options as dns.LookupAllOptions).all) {
      cb(null, addresses.map((a) => ({ address: a.address, family: a.family })))
    } else {
      cb(null, addresses[0]!.address, addresses[0]!.family)
    }
  }
}

export interface SafeDownloadResult {
  bytes: number
  contentType: string
}

/**
 * 校验并下载结果文件到 destPath（流式，带大小上限与 ≤3 次跳转重校验）。
 * 任何校验不过 → SafeDownloadError，调用方映射 VIDEO_RESULT_URL_BLOCKED，不落半截文件（失败时清理）。
 */
export async function downloadValidatedFile(
  url: string,
  destPath: string,
  opts: { maxBytes: number; timeoutMs?: number },
): Promise<SafeDownloadResult> {
  const allowlist = resultHostAllowlist()
  const out = fs.createWriteStream(destPath)
  let bytes = 0
  let done = false
  const fail = (e: unknown): never => {
    out.destroy()
    fs.promises.unlink(destPath).catch(() => undefined)
    throw e
  }

  const get = (target: string, redirects: number): Promise<{ contentType: string }> =>
    new Promise((resolve, reject) => {
      void (async () => {
        let resolved: ResolvedUrl
        try {
          resolved = await resolveValidatedUrl(target, allowlist)
        } catch (e) {
          reject(e)
          return
        }
        const request = https.get(
          resolved.url,
          { timeout: opts.timeoutMs ?? config.hifly.binaryTimeoutMs, lookup: pinnedLookup(resolved.addresses) as never },
          (response) => {
            const status = response.statusCode ?? 0
            if ([301, 302, 303, 307, 308].includes(status)) {
              const location = response.headers.location
              response.resume()
              if (!location || redirects >= 3) {
                reject(new SafeDownloadError('结果地址跳转次数超限或缺少目标', 'too_many_redirects'))
                return
              }
              const next = new URL(location, resolved.url).toString()
              get(next, redirects + 1).then(resolve, reject)
              return
            }
            if (status < 200 || status >= 300) {
              response.resume()
              reject(new SafeDownloadError(`结果地址返回 ${status}`, 'bad_status'))
              return
            }
            const declared = Number(response.headers['content-length'])
            if (Number.isFinite(declared) && declared > opts.maxBytes) {
              response.destroy()
              reject(new SafeDownloadError(`结果文件 ${declared} 字节超出上限`, 'too_large'))
              return
            }
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length
              if (bytes > opts.maxBytes && !done) {
                done = true
                response.destroy()
                request.destroy()
                reject(new SafeDownloadError('结果文件超出大小上限', 'too_large'))
              }
            })
            response.on('error', reject)
            response.pipe(out)
            out.on('finish', () => {
              if (done) return
              done = true
              resolve({ contentType: String(response.headers['content-type'] ?? 'application/octet-stream').split(';')[0] ?? 'application/octet-stream' })
            })
            out.on('error', reject)
          },
        )
        request.on('timeout', () => {
          request.destroy(new SafeDownloadError('结果下载超时', 'timeout'))
        })
        request.on('error', reject)
      })()
    })

  try {
    const r = await get(url, 0)
    return { bytes, contentType: r.contentType }
  } catch (e) {
    return fail(e)
  }
}
