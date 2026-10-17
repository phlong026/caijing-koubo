/**
 * FinStep 工具返回数据 → 业务 DTO 的清洗与映射。
 *
 * 实测发现的数据缺陷（因此这里的清洗不是可选项）：
 *   1. hot_topics 个别条目 subject_name 是字符串 "undefined"、section_2 也是 undefined；
 *   2. content 里混有 HTML（<br/>、<img idx="0"/>），直接入库会污染选题提示词；
 *   3. alpha_morning 的 source 是数字枚举（1/2/4/5），from_source 常为 null。
 */

/** 把 "undefined"/"null"/空串统一当作缺失，返回 null */
export function cleanStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!s) return null
  // 上游会把缺失字段序列化成字面量字符串
  if (s === 'undefined' || s === 'null' || s === 'NaN') return null
  return s
}

/** 去掉 HTML 标签、解码常见实体、压缩空白 */
export function stripHtml(input: string): string {
  const text = input
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  return text
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 截断到指定长度，超出加省略号（不硬切半个句子） */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('；'))
  // 太靠前就不按句号切，避免只剩一句话
  if (lastStop > max * 0.6) return cut.slice(0, lastStop + 1)
  return `${cut}…`
}

/**
 * 早参正文清洗：去掉推广语、栏目小标题等与内容无关的行。
 * 实测发现的问题：
 *   - 华尔街见闻早参会以「2027见闻历预售开启｜超值早鸟价 99元」这类推广开头；
 *   - 体例标题（要闻精选 / 宏观新闻 / 华见早安之声）单独成行，进摘要毫无信息量。
 */
const NOISE_PATTERNS: RegExp[] = [
  // 推广语：预售/早鸟价/订阅/引导下载升级/扫码关注/收听提示
  /预售|早鸟价|订阅|(下载|升级|安装).{0,10}APP|扫码|关注公众号|点击收听|广告/i,
  /^\s*(要闻精选|宏观新闻|行业新闻|公司新闻|市场纵览|投资日历|华见早安之声|早安之声|今日关注|盘前必读|头条)\s*$/,
]

export function normalizeSummary(text: string, title?: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !NOISE_PATTERNS.some((re) => re.test(l)))
  let out = lines.join('\n').trim()
  // 有的源把标题原样放在正文开头
  if (title && out.startsWith(title)) out = out.slice(title.length).trim()
  return out
}

/* ── alpha_morning 市场早参 ──────────────────────────────────────── */

export interface AlphaMorningRaw {
  article_id?: string | number
  source?: number | string
  title?: string
  author?: string
  content?: string
  publish_time?: string
  url?: string
  news_type?: number
  from_source?: string | null
}

/** source 数字枚举 → 可读名称（未知值回落为「财跃早参」） */
const SOURCE_MAP: Record<string, string> = {
  '1': '华尔街见闻',
  '2': '微信公众号',
  '3': '新浪财经',
  '4': '财联社',
  '5': '财联社',
}

export interface AlphaMorningItem {
  externalId: string
  source: string
  title: string
  summary: string
  contentUrl: string | null
  publishedAt: string | null
}

export function mapAlphaMorning(raw: AlphaMorningRaw, summaryMaxChars: number): AlphaMorningItem | null {
  const title = cleanStr(raw?.title)
  const idRaw = cleanStr(raw?.article_id)
  if (!title || !idRaw) return null

  const body = stripHtml(cleanStr(raw?.content) ?? '')
  const srcKey = cleanStr(raw?.source)
  const fromSource = cleanStr(raw?.from_source)
  const source = fromSource ?? (srcKey ? SOURCE_MAP[srcKey] : null) ?? '财跃早参'

  // 早参正文开头通常重复标题（【标题】...），摘要里去掉这段前缀
  let summary = body
  if (summary.startsWith('【')) {
    const close = summary.indexOf('】')
    if (close > 0 && close < 120) summary = summary.slice(close + 1).trim()
  }
  summary = normalizeSummary(summary, title)

  return {
    externalId: `finstep-am-${idRaw}`,
    source,
    title,
    summary: clip(summary, summaryMaxChars),
    contentUrl: cleanStr(raw?.url),
    publishedAt: cleanStr(raw?.publish_time),
  }
}

/* ── hot_topics 市场热门主题 ─────────────────────────────────────── */

export interface HotTopicRaw {
  publish_time?: string
  subject_name?: string
  subject_desc?: string
  url_from?: string
  site_name?: string
  section?: string
  section_1?: string
  section_2?: string
}

export interface HotTopicItem {
  externalId: string
  source: string
  title: string
  summary: string
  contentUrl: string | null
  publishedAt: string | null
}

/**
 * external_id 必须稳定，否则每轮采集都会重复入库。
 * 用 `来源+标题` 哈希：热榜条目没有 id，且同一话题在多个来源重复出现时，
 * 靠 source 前缀区分，避免互相覆盖。
 */
function hashKey(parts: Array<string | null>): string {
  const base = parts.filter(Boolean).join('|')
  let h = 0
  for (let i = 0; i < base.length; i++) {
    h = (h * 31 + base.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

export function mapHotTopic(raw: HotTopicRaw): HotTopicItem | null {
  const title = cleanStr(raw?.subject_name)
  // 实测存在 subject_name === "undefined" 的脏数据，这里已被 cleanStr 拦下
  if (!title) return null

  const desc = stripHtml(cleanStr(raw?.subject_desc) ?? '')
  const site = cleanStr(raw?.site_name) ?? '热门主题'
  const section = [cleanStr(raw?.section), cleanStr(raw?.section_1)].filter(Boolean).join(' · ')

  return {
    externalId: `finstep-ht-${hashKey([site, cleanStr(raw?.url_from), title])}`,
    source: site,
    title,
    summary: normalizeSummary(desc || section),
    // 热榜条目本身不带原文链接，只有 url_from 代码，不伪造 URL
    contentUrl: null,
    publishedAt: cleanStr(raw?.publish_time),
  }
}

/* ── 统一入口：按工具名取列表 ────────────────────────────────────── */

export function extractToolData<T = unknown>(toolName: string, data: unknown): T | null {
  if (data === null || data === undefined) return null
  return data as T
}
