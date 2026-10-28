import dns from 'node:dns/promises'
import axios from 'axios'
import { config } from '../../config.js'
import { err } from '../../errors.js'

/**
 * §2.4 防 SSRF：
 * - 只接受白名单域名（douyin.com / iesdouyin.com 及其子域）
 * - 跟随短链跳转最多 3 次且每一跳都校验域名
 * - 拒绝解析到内网 / 保留地址
 */
const PRIVATE_RANGES = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // P2-14：IPv4 映射地址（::ffff:10.0.0.1 之类）必须按 IPv4 段再判一次
  /^::ffff:(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i,
  /^::1$/,
  /^::$/,
  /^f[cd]/i, // fc00::/7 唯一本地地址（含 fd00::/8）
  /^fe80/i, // 链路本地
]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export function isWhitelisted(host: string): boolean {
  const h = String(host || '').toLowerCase().replace(/\.$/, '')
  return config.linkWhitelist.some((d) => h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`))
}

export async function assertHostSafe(host: string): Promise<void> {
  if (!isWhitelisted(host)) {
    throw err.domainNotAllowed(`链接域名 ${host} 不在白名单内`, { allowed: config.linkWhitelist })
  }
  try {
    const r = await dns.lookup(host, { all: true })
    for (const a of r) {
      if (PRIVATE_RANGES.some((re) => re.test(a.address))) {
        throw err.domainNotAllowed(`链接解析到内网/保留地址，已拒绝：${a.address}`)
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code === 'domain_not_allowed') throw e
    // DNS 解析失败不阻断（离线环境），域名白名单已提供第一道防线
  }
}

export async function assertUrlAllowed(urlStr: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(String(urlStr).trim())
  } catch {
    throw err.badRequest('链接格式不正确')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw err.badRequest('仅支持 http/https 链接')
  }
  await assertHostSafe(u.hostname)
  return u
}

/**
 * 分享输入归一化：运营从手机/浏览器复制出来的往往不是干净 URL——
 * 可能缺 https://（"douyin.com/user/..."）、或是整段分享文案夹着一条短链
 * （"7.92 p@f.XZ ... https://v.douyin.com/xxx/ 复制此链接..."）。
 * 这里只做字符串层面的提取/补协议，不做任何网络请求；域名安全仍由
 * assertUrlAllowed 白名单把守（提取出的 URL 照样要过白名单）。
 */
export function normalizeShareInput(raw: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return s
  const asUrl = /^https?:\/\//.test(s)
  if (asUrl) return s
  // 整段分享文案：取第一处 http(s) 链接，去掉粘在尾部的中英文标点
  const m = /(https?:\/\/[^\s，,。！!！?？;；）)"'”』】]+)/.exec(s)
  if (m) return m[1].replace(/[.,;:)\"'”』】]+$/, '')
  // 抖音官方裸域开头（无协议）：补全 https://
  if (/^(?:[a-z0-9-]+\.)?(?:douyin|iesdouyin)\.com\//i.test(s)) return `https://${s}`
  return s
}

/** 跟随短链跳转，最多 3 跳，每跳都校验域名与内网地址 */
export async function resolveFinalUrl(urlStr: string): Promise<string> {
  let current = String(urlStr).trim()
  for (let hop = 0; hop <= config.maxRedirects; hop++) {
    await assertUrlAllowed(current)
    let location: string | null = null
    try {
      const res = await axios.get(current, {
        maxRedirects: 0,
        validateStatus: () => true,
        timeout: 8000,
        headers: { 'User-Agent': UA },
        responseType: 'text',
      })
      const status = res.status
      if (status >= 300 && status < 400) {
        location = res.headers?.location ? String(res.headers.location) : null
      } else {
        return current
      }
    } catch (e: any) {
      // 网络不可达时保留原链接，由 TikHub 侧解析（域名已校验）
      return current
    }
    if (!location) return current
    current = new URL(location, current).toString()
  }
  throw err.domainNotAllowed('链接跳转次数过多或跳转到非白名单域名')
}

/** 从主页链接解析 sec_uid */
export function extractSecUid(urlStr: string): string | null {
  const s = String(urlStr || '')
  const patterns = [
    /\/user\/(MS4wLjABAAAA[A-Za-z0-9_-]+)/,
    /\/share\/user\/(MS4wLjABAAAA[A-Za-z0-9_-]+)/,
    /sec_uid=(MS4wLjABAAAA[A-Za-z0-9_-]+)/,
    /(MS4wLjABAAAA[A-Za-z0-9_-]{20,})/,
  ]
  for (const re of patterns) {
    const m = re.exec(s)
    if (m) return m[1]
  }
  return null
}

/** 从分享链接/视频链接解析 video_id */
export function extractVideoId(urlStr: string): string | null {
  const s = String(urlStr || '')
  const patterns = [
    /\/video\/(\d{10,25})/,
    /\/share\/video\/(\d{10,25})/,
    /[?&]modal_id=(\d{10,25})/,
    /[?&]aweme_id=(\d{10,25})/,
    /[?&]vid=(\d{10,25})/,
  ]
  for (const re of patterns) {
    const m = re.exec(s)
    if (m) return m[1]
  }
  return null
}

export interface ParsedLink {
  kind: 'user' | 'video' | 'unknown'
  secUid: string | null
  videoId: string | null
  finalUrl: string
}

/** 白名单校验 + 短链解析 + 提取标识（FR-B1 / FR-B8） */
export async function parseUserOrVideoLink(rawUrl: string): Promise<ParsedLink> {
  const finalUrl = await resolveFinalUrl(normalizeShareInput(rawUrl))
  const secUid = extractSecUid(finalUrl)
  const videoId = extractVideoId(finalUrl)
  const kind: ParsedLink['kind'] = videoId ? 'video' : secUid ? 'user' : 'unknown'
  return { kind, secUid, videoId, finalUrl }
}
