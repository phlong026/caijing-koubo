import { createHash } from 'node:crypto'
import { cleanStr, clip, normalizeSummary, stripHtml } from '../finstep/extract.js'
import type { SaturnNewsItem } from './client.js'

/**
 * 曙光舆情 → NewsDTO 的字段清洗与映射。
 *
 * 与 FinStep 共用同一套清洗原语（cleanStr / stripHtml / clip / normalizeSummary），
 * 保证两个源入库后的数据形态一致，前端不用为来源分叉。
 */

export interface MappedSaturnNews {
  externalId: string
  source: string
  title: string
  summary: string | null
  contentUrl: string | null
  publishedAt: Date | null
}

/**
 * 来源名归一。
 * 实测四通道返回的 source 是中文通道名（网络新闻 / 快讯 / 微信公众号），
 * 而微博通道可能返回博主名。统一加「曙光」前缀，便于前端按来源筛选时区分
 * 同名的第三方源（比如别家也有「微信公众号」）。
 */
const SOURCE_PREFIX = '曙光'

function normalizeSource(raw: unknown): string {
  const s = cleanStr(raw)
  if (!s) return `${SOURCE_PREFIX}舆情`
  // 已经是前缀格式就不再叠加，保证幂等
  if (s.startsWith(SOURCE_PREFIX)) return s
  return `${SOURCE_PREFIX}·${s}`
}

/**
 * 解析 `YYYY-MM-DD HH:mm:ss`（北京时区）。
 *
 * 不能用 `new Date(str)` —— 带空格的格式在部分运行时会按本地时区解析，
 * 而容器里 TZ 未必是 Asia/Shanghai，会导致时间整体偏移 8 小时。
 * 这里显式按 +08:00 构造。
 */
export function parseBeijingTime(v: unknown): Date | null {
  const s = cleanStr(v)
  if (!s) return null
  // 已是 ISO 带时区的，直接交给 Date
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s)
  if (!m) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const [, y, mo, d, h, mi, se] = m
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se ?? '00'}+08:00`
  const out = new Date(iso)
  return Number.isNaN(out.getTime()) ? null : out
}

/** 单条映射。title 为空或 id 缺失时返回 null（丢弃脏数据） */
export function mapSaturnItem(raw: SaturnNewsItem, summaryMaxChars: number): MappedSaturnNews | null {
  const id = cleanStr(raw?.id)
  const rawTitle = stripHtml(cleanStr(raw?.title) ?? '')
  const snippet = stripHtml(cleanStr(raw?.snippet) ?? '')

  // 标题缺失时用正文首句兜底；两者都空则丢弃
  const fallbackTitle = snippet ? clip(snippet, 60) : null
  const title = cleanStr(rawTitle) ?? fallbackTitle
  if (!title) return null

  // externalId 优先用服务端 id（稳定、跨次采集不变）；
  // 缺失时用 url/title 哈希兜底，保证不产生重复入库
  const externalId = id
    ? `saturn-${id}`
    : `saturn-h-${createHash('sha1').update(`${raw?.url ?? ''}|${title}`).digest('hex').slice(0, 16)}`

  const url = cleanStr(raw?.url)
  // 只接受 http(s)，避免 javascript: 之类进到前端
  const contentUrl = url && /^https?:\/\//i.test(url) ? url : null

  const summaryRaw = normalizeSummary(snippet, title)
  const summary = summaryRaw ? clip(summaryRaw, summaryMaxChars) : null

  return {
    externalId,
    source: normalizeSource(raw?.source),
    title,
    summary,
    contentUrl,
    publishedAt: parseBeijingTime(raw?.date),
  }
}

/** 批量映射 + 批内去重（同一 id 多次出现只留第一条） */
export function mapSaturnItems(items: SaturnNewsItem[], summaryMaxChars: number): MappedSaturnNews[] {
  const out: MappedSaturnNews[] = []
  const seen = new Set<string>()
  for (const raw of items ?? []) {
    const m = mapSaturnItem(raw, summaryMaxChars)
    if (!m) continue
    if (seen.has(m.externalId)) continue
    seen.add(m.externalId)
    out.push(m)
  }
  return out
}
