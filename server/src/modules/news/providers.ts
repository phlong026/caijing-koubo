import axios from 'axios'
import { createHash } from 'node:crypto'
import { logger } from '../../log.js'
import { config, hasFinStep } from '../../config.js'
import { runReAct } from '../../integrations/finstep/client.js'
import { mapAlphaMorning, mapHotTopic } from '../../integrations/finstep/extract.js'

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

/** 北京时间字符串（如 `2026-10-17 15:30:00`，不带时区）显式按 +08:00 解析，不依赖部署机时区 */
function toDateCst(v: unknown): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(String(v ?? '').trim())
  return m ? toDate(`${m[1]}T${m[2]}+08:00`) : toDate(v)
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
  // P1-7：必须受 MOCK_FALLBACK 控制。此前恒为 true，生产环境每 15 分钟
  // 会把「内置示意源」的假资讯写进正式库。
  get enabled(): boolean {
    return config.mockFallback
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
        // showTime 为北京时间字符串，显式按 +08:00 解析后统一转 UTC 存储（容器多为 UTC 时区）
        publishedAt: toDateCst(it.showTime ?? it.time),
      }
    })
  }
}

/* ── ④ 曙光 MCP（接口文档未到位，预留实现位，不阻塞） ───────────────── */
class ShuguangMcpProvider implements NewsProvider {
  name = 'shuguang'
  label = '曙光 MCP'
  enabled = false // 文档到位后打开

  async fetchLatest(): Promise<NewsDTO[]> {
    logger.info('news.provider_shuguang_skipped: 接口文档未到位，预留实现位')
    return []
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
  // FinStep 两个源放在最后：它们最慢，且属于补充源
  new FinStepAlphaMorningProvider(),
  new FinStepHotTopicsProvider(),
  new ShuguangMcpProvider(),
]

export function enabledProviders(): NewsProvider[] {
  return providers.filter((p) => p.enabled)
}

/** URL 哈希兜底去重键（P2-1：无 content_url 时用 来源+标题+发布时间 兜底） */
export function hashUrl(source: string, contentUrl: string | null, title: string, publishedAt: Date | null): string {
  const base = contentUrl ? `u:${contentUrl}` : `t:${source}|${title}|${publishedAt?.toISOString() ?? ''}`
  return createHash('md5').update(base).digest('hex')
}
