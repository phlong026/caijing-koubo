import axios from 'axios'
import { createHash } from 'node:crypto'
import { logger } from '../../log.js'
import { config, hasFinStep, hasSaturnNews } from '../../config.js'
import { runReAct } from '../../integrations/finstep/client.js'
import { mapAlphaMorning, mapHotTopic } from '../../integrations/finstep/extract.js'
import { searchByKeyword, type SaturnNewsItem } from '../../integrations/saturn-news/client.js'
import { mapSaturnItems } from '../../integrations/saturn-news/extract.js'

export interface NewsDTO {
  externalId: string
  source: string
  title: string
  summary?: string | null
  contentUrl?: string | null
  imageUrl?: string | null
  /** ISO8601 或 Date */
  publishedAt?: Date | string | null
}

export interface NewsProvider {
  name: string
  /** 展示名 */
  label: string
  enabled: boolean
  fetchLatest(): Promise<NewsDTO[]>
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function toDate(v: unknown): Date | null {
  if (!v) return null
  if (v instanceof Date) return v
  const n = Number(v)
  const d = Number.isFinite(n) && n > 1e8 ? new Date(n > 1e12 ? n : n * 1000) : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

/* ── ① 内置示意 Provider（无外部依赖，保证链路可跑通） ───────────────── */
const MOCK_SEEDS: Array<{ title: string; summary: string; cat: string }> = [
  { title: '两市成交额环比回升，红利板块获资金净流入', summary: '盘中资金偏好低波品种，成交结构出现分化。', cat: '市场' },
  { title: '央行公开市场操作净投放，资金面保持平稳', summary: '短端利率小幅回落，跨月资金需求可控。', cat: '政策' },
  { title: '多家基金公司下调旗下产品费率，行业费率改革推进', summary: '费率调整涉及主动权益与部分债基产品。', cat: '基金' },
  { title: '新能源车产业链排产回升，上游材料价格止跌', summary: '排产环比改善，产能利用率有所修复。', cat: '行业' },
  { title: '定投科普：先理解规则，再谈长期坚持', summary: '定期投入并不意味着没有风险，需理解费用与适用边界。', cat: '基金' },
  { title: '市场波动时，如何认识自己的风险承受能力', summary: '波动是常态，了解自身承受能力有助于选择合适的投资方式。', cat: '市场' },
  { title: '监管就信息披露新规征求意见，压实中介机构责任', summary: '新规聚焦披露质量与一致性。', cat: '政策' },
  { title: '半导体设备国产化率提升，交付周期缩短', summary: '产业链协同推进，验证进度加快。', cat: '行业' },
]

class MockProvider implements NewsProvider {
  name = 'mock'
  label = '内置示意源'
  // P1-7：必须受开关控制。此前恒为 true，生产环境每 15 分钟会把假资讯写进正式库。
  //
  // 这里改用独立的 `newsMockSource` 而非 `mockFallback`：后者是 TikHub/百炼/OSS/文案模型
  // 共用的兜底开关，为了让资讯只看真实数据而关掉它，会连带让视频提取和文案生成报错。
  get enabled(): boolean {
    return config.newsMockSource
  }

  async fetchLatest(): Promise<NewsDTO[]> {
    // 以 15 分钟为窗口生成稳定 external_id：窗口内重复采集零增量，跨窗口产生新条目
    const bucket = Math.floor(Date.now() / (15 * 60_000))
    const count = 4 + (bucket % 5)
    const out: NewsDTO[] = []
    for (let i = 0; i < count; i++) {
      const seed = MOCK_SEEDS[(bucket + i) % MOCK_SEEDS.length]
      const published = new Date(bucket * 15 * 60_000 - i * 7 * 60_000)
      out.push({
        externalId: `mock-${bucket}-${i}`,
        source: this.label,
        title: seed.title,
        summary: seed.summary,
        contentUrl: null,
        imageUrl: null,
        publishedAt: published,
      })
    }
    return out
  }
}

/** 极简 RSS 解析（免安装依赖，够用于电报类快讯源） */
export function parseRss(xml: string, source: string, prefix: string): NewsDTO[] {
  const items = Array.from(xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)).map((m) => m[0])
  const pick = (block: string, tag: string): string => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
    if (!m) return ''
    return m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .trim()
  }
  return items.slice(0, 20).map((block, i) => {
    const title = pick(block, 'title')
    const link = pick(block, 'link')
    const desc = pick(block, 'description')
    const pub = pick(block, 'pubDate')
    return {
      externalId: `${prefix}-${link ? createHash('md5').update(link).digest('hex').slice(0, 16) : `${Date.now()}-${i}`}`,
      source,
      title: title.slice(0, 200),
      summary: desc ? desc.slice(0, 500) : null,
      contentUrl: link || null,
      imageUrl: null,
      publishedAt: toDate(pub) ?? new Date(),
    }
  })
}

/**
 * ② 财联社电报（无官方开放 API，走 RSS 通道）。
 * 公开 RSSHub 实例对部分来源有限流，生产建议自建 RSSHub 后通过 CLS_RSS_URL 指定地址。
 */
class ClsProvider implements NewsProvider {
  name = 'cls'
  label = '财联社电报'
  enabled = true

  async fetchLatest(): Promise<NewsDTO[]> {
    const url = process.env.CLS_RSS_URL || 'https://rsshub.app/cls/telegraph'
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      timeout: 12000,
      responseType: 'text',
    })
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    if (!/<item/i.test(body)) throw new Error('RSS 返回内容不包含 item（可能已被限流或需自建 RSSHub）')
    return parseRss(body, this.label, 'cls')
  }
}

/* ── ③ 东方财富快讯 ────────────────────────────────────────────────── */
class EastMoneyProvider implements NewsProvider {
  name = 'eastmoney'
  label = '东方财富快讯'
  enabled = true

  async fetchLatest(): Promise<NewsDTO[]> {
    const url = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList'
    const res = await axios.get(url, {
      params: { client: 'web', biz: 'web_news_col', fastColumn: '102', sortEnd: '', pageSize: 20, req_trace: 1 },
      headers: { 'User-Agent': UA, Referer: 'https://kuaixun.eastmoney.com/' },
      timeout: 12000,
    })
    const data = res.data?.data ?? res.data
    const list: any[] = data?.fastNewsList ?? data?.list ?? []
    return list.slice(0, 20).map((it: any) => {
      const code = it.code ?? it.infoCode ?? it.id
      const images: unknown = it.image
      const imageUrl = Array.isArray(images) && images.length ? String(images[0]) : null
      return {
        externalId: `em-${code}`,
        source: this.label,
        title: String(it.title ?? it.summary ?? '').slice(0, 200),
        summary: it.summary ? String(it.summary).slice(0, 500) : null,
        contentUrl: code ? `https://finance.eastmoney.com/a/${code}.html` : null,
        imageUrl,
        // showTime 为北京时间字符串，按本机时区解析后统一转 UTC 存储
        publishedAt: toDate(it.showTime ?? it.time),
      }
    })
  }
}

/* ── ④ 曙光舆情 MCP（saturn-news） ─────────────────────────────────────
 *
 * 与 FinStep 定位完全不同：这是**纯数据检索**（JSON-RPC over streamableHttp），
 * 单次 0.5~2s，可当主采集源。
 *
 * ── 为什么按「通道 × 关键词」拆开查，而不是一次查四通道 ────────────────
 *
 * 实测该接口在多通道 + `sort_by=time` 时**不做来源混排**：
 * 微信公众号发文最密集，会独占整个 limit。
 *   limit=20  → 微信公众号 20 / 快讯 0 / 网络新闻 0
 *   limit=100 → 微信公众号 100
 *   limit=100 + sort_by=popularity → 网络新闻 61 / 快讯 20 / 微信公众号 19（才有混排）
 * 结果是时效性最强的「快讯」被完全挤掉。所以这里按通道分别请求再合并，
 * 每个通道各自的 limit 有保证，代价是请求数 = 关键词数 × 通道数。
 *
 * 只走 keyword 检索：个股/行业/主题是「按标的深挖」的场景，留给上层按需调用
 * （client 已封装 searchByStock / searchByIndustry / searchByTheme / list*）。
 */
class ShuguangMcpProvider implements NewsProvider {
  name = 'shuguang'
  label = '曙光舆情'
  get enabled(): boolean {
    return hasSaturnNews()
  }

  async fetchLatest(): Promise<NewsDTO[]> {
    const keywords = config.saturnNews.keywords
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!keywords.length) {
      logger.warn('news.shuguang_no_keywords：SATURN_NEWS_KEYWORDS 为空，跳过')
      return []
    }

    const channels = config.saturnNews.channels
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as Array<'weibo_blog' | 'flash' | 'wechat' | 'web_v1'>
    // 留空 = 四通道全开，此时仍然逐个通道查（否则会被单一来源独占）
    const chList: Array<'weibo_blog' | 'flash' | 'wechat' | 'web_v1'> = channels.length
      ? channels
      : ['flash', 'wechat', 'web_v1', 'weibo_blog']

    // 回看窗口：默认 1 天（date_range 形如 2026-10-16~today）
    const days = Math.max(1, config.saturnNews.lookbackDays)
    const from = new Date(Date.now() - days * 24 * 3600 * 1000)
    const dateRange = `${from.toISOString().slice(0, 10)}~today`

    // 关键词 × 通道 笛卡尔积，逐个容错
    const tasks: Array<{ kw: string; ch: string }> = []
    for (const kw of keywords) for (const ch of chList) tasks.push({ kw, ch })

    // 串行执行，不用 Promise.all：
    //   实测并发 9 个请求时，单个耗时从 0.5s 涨到 5~7s（网关排队），
    //   且偶发网络瞬断。串行总耗时约 9×1s ≈ 9s，比并发更快也更稳。
    const merged: SaturnNewsItem[] = []
    const perTask: string[] = []
    for (const t of tasks) {
      try {
        const r = await searchByKeyword({
          query: t.kw,
          dateRange,
          limit: config.saturnNews.limitPerKeyword,
          sortBy: 'time',
          channels: [t.ch as 'flash'],
          fullContent: false,
        })
        const list = r.results ?? []
        merged.push(...list)
        perTask.push(`${t.kw}/${t.ch}:${list.length}`)
      } catch (e) {
        logger.warn({ keyword: t.kw, channel: t.ch, err: (e as Error)?.message }, 'news.shuguang_task_failed')
        perTask.push(`${t.kw}/${t.ch}:ERR`)
      }
    }

    // 跨「关键词 × 通道」合并后统一映射去重（同一条常被多个关键词命中）
    const items = mapSaturnItems(merged, config.saturnNews.summaryMaxChars).map<NewsDTO>((m) => ({
      externalId: m.externalId,
      source: m.source,
      title: m.title,
      summary: m.summary,
      contentUrl: m.contentUrl,
      imageUrl: null,
      publishedAt: m.publishedAt,
    }))

    const srcDist: Record<string, number> = {}
    for (const it of items) srcDist[it.source] = (srcDist[it.source] ?? 0) + 1

    logger.info(
      {
        provider: this.name,
        keywords: keywords.join('|'),
        channels: chList.join('|'),
        raw: merged.length,
        mapped: items.length,
        bySource: srcDist,
        byTask: perTask,
      },
      'news.shuguang',
    )
    return items
  }
}

/* ── ⑤ 财跃 FinStep：市场早参（ReAct 工具 alpha_morning） ──────────────
 *
 * 说明：FinStep 是问答接口而非数据接口，一次调用要跑完整 ReAct 循环（几十秒）。
 * 因此：
 *   - query 写死成最能稳定命中该工具的说法，不交给用户自由输入；
 *   - 只取 tool_result 的结构化数据，丢弃 thinking / answer；
 *   - 无 Key 时 enabled=false，整源静默跳过，不影响其它资讯源。
 */
class FinStepAlphaMorningProvider implements NewsProvider {
  name = 'finstep_alpha_morning'
  label = '财跃早参'
  get enabled(): boolean {
    return hasFinStep() && config.finstep.enabledSources.includes('alpha_morning')
  }

  async fetchLatest(): Promise<NewsDTO[]> {
    const r = await runReAct({
      query: '请给我今天的市场早参',
      wantTools: ['get_alpha_morning'],
      refType: 'news',
      refId: this.name,
    })
    const hit = r.toolResults.find((t) => t.tool_name === 'get_alpha_morning')
    if (!hit || hit.status !== 'success' || !Array.isArray(hit.data)) {
      logger.warn({ tool: 'get_alpha_morning', hit: !!hit, status: hit?.status }, 'news.finstep_no_data')
      return []
    }
    const items: NewsDTO[] = []
    for (const raw of hit.data) {
      const m = mapAlphaMorning(raw, config.finstep.summaryMaxChars)
      if (!m) continue
      items.push({
        externalId: m.externalId,
        source: m.source,
        title: m.title,
        summary: m.summary,
        contentUrl: m.contentUrl,
        imageUrl: null,
        publishedAt: m.publishedAt,
      })
    }
    logger.info({ provider: this.name, raw: hit.data.length, mapped: items.length }, 'news.finstep_alpha')
    return items
  }
}

/* ── ⑥ 财跃 FinStep：市场热门主题（ReAct 工具 hot_topics） ───────────── */
class FinStepHotTopicsProvider implements NewsProvider {
  name = 'finstep_hot_topics'
  label = '市场热门'
  get enabled(): boolean {
    return hasFinStep() && config.finstep.enabledSources.includes('hot_topics')
  }

  async fetchLatest(): Promise<NewsDTO[]> {
    const r = await runReAct({
      query: '今天市场有哪些热门主题和热门话题',
      wantTools: ['get_market_hot_topics'],
      refType: 'news',
      refId: this.name,
    })
    const hit = r.toolResults.find((t) => t.tool_name === 'get_market_hot_topics')
    if (!hit || hit.status !== 'success') {
      logger.warn({ tool: 'get_market_hot_topics', hit: !!hit, status: hit?.status }, 'news.finstep_no_data')
      return []
    }
    // data 形如 { items: [...], total, page, page_size, total_pages }
    const list: unknown[] = Array.isArray(hit.data)
      ? hit.data
      : Array.isArray((hit.data as { items?: unknown[] })?.items)
        ? (hit.data as { items: unknown[] }).items
        : []

    const items: NewsDTO[] = []
    for (const raw of list) {
      const m = mapHotTopic(raw as any)
      if (!m) continue
      items.push({
        externalId: m.externalId,
        source: m.source,
        title: m.title,
        summary: m.summary,
        contentUrl: m.contentUrl,
        imageUrl: null,
        publishedAt: m.publishedAt,
      })
    }
    logger.info({ provider: this.name, raw: list.length, mapped: items.length }, 'news.finstep_hot')
    return items
  }
}

export const providers: NewsProvider[] = [
  new MockProvider(),
  new ClsProvider(),
  new EastMoneyProvider(),
  // 曙光响应快（0.5~2s），排在 FinStep 之前
  new ShuguangMcpProvider(),
  // FinStep 放最后：每次要跑几十秒 ReAct，属于补充源
  new FinStepAlphaMorningProvider(),
  new FinStepHotTopicsProvider(),
]

export function enabledProviders(): NewsProvider[] {
  return providers.filter((p) => p.enabled)
}

/** URL 哈希兜底去重键（P2-1：无 content_url 时用 来源+标题+发布时间 兜底） */
export function hashUrl(source: string, contentUrl: string | null, title: string, publishedAt: Date | null): string {
  const base = contentUrl ? `u:${contentUrl}` : `t:${source}|${title}|${publishedAt?.toISOString() ?? ''}`
  return createHash('md5').update(base).digest('hex')
}
