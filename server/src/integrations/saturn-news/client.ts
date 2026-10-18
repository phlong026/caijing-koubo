import { config, hasSaturnNews } from '../../config.js'
import { logger } from '../../log.js'
import { logApiCall } from '../../modules/metrics/call-log.js'

/**
 * 曙光舆情（saturn-news）MCP 客户端。
 *
 * 这是一个 **MCP over streamableHttp** 服务，不是普通 REST：
 * 请求是 JSON-RPC 2.0，响应是 SSE（`event: message\ndata: {...}`）。
 *
 * ── 踩过的坑，改之前先读 ──────────────────────────────────────────
 *
 * 1. **Authorization 头必须直接放 key，不能加 `Bearer ` 前缀**。
 *    加了前缀不会 401，而是返回 `isError:true` + `Output validation error:
 *    outputSchema defined but no structured output returned` —— 极容易被误判成
 *    「服务端 schema 有问题」，实际是凭证格式不对。
 *
 * 2. `tools/call` 的真实数据在 **`result.content[0].text`** 里，而且它自己是
 *    **一个 JSON 字符串**（需要再 `JSON.parse` 一次），不是对象。
 *
 * 3. 工具声明了 `outputSchema`，但**不返回 `structuredContent`**。因此客户端
 *    不能用 MCP SDK 的严格校验，必须手动解 `content[0].text`。
 *
 * 4. MCP 是有会话的：规范上应先 `initialize` 拿 `Mcp-Session-Id`。实测该网关
 *    **无状态也能直接 tools/call**（本客户端按无状态实现，省一次 12s 往返）。
 *    若将来服务端开始强制会话，需要在 `ensureSession()` 里补 initialize。
 */

/** JSON-RPC 单次请求超时。实测 tools/call 约 0.5~2s，留足余量 */
const DEFAULT_TIMEOUT_MS = 30_000

export interface SaturnNewsItem {
  id: string
  title: string
  snippet: string
  /** `YYYY-MM-DD HH:mm:ss`，北京时区 */
  date: string
  source: string
  url: string | null
}

export interface SaturnSearchResult {
  source: string
  count: number
  results: SaturnNewsItem[]
  meta?: { trace_id?: string; elapsed_ms?: number }
}

type Channel = 'weibo_blog' | 'flash' | 'wechat' | 'web_v1'
type SortBy = 'popularity' | 'relevance' | 'time'

export interface KeywordSearchOptions {
  query: string
  /** `YYYY-MM-DD~YYYY-MM-DD` 或 `YYYY-MM-DD~today` */
  dateRange?: string
  limit?: number
  sortBy?: SortBy
  channels?: Channel[]
  fullContent?: boolean
}

export interface StockSearchOptions {
  ticker?: string
  secName?: string
  dateRange?: string
  limit?: number
  sortBy?: SortBy
  channels?: Channel[]
  fullContent?: boolean
}

export interface IndustrySearchOptions {
  industry: string
  industryLevel?: 1 | 2
  dateRange?: string
  limit?: number
  sortBy?: SortBy
  channels?: Channel[]
  fullContent?: boolean
}

export interface ThemeSearchOptions {
  theme: string
  dateRange?: string
  limit?: number
  sortBy?: SortBy
  channels?: Channel[]
  fullContent?: boolean
}

/* ── 底层 JSON-RPC over SSE ─────────────────────────────────────────── */

/** 从 SSE 文本里抽出最后一个 data 帧的 JSON */
function parseSseJson(text: string): any {
  const dataLines = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
  if (!dataLines.length) throw new Error(`saturn-news 返回非 SSE 内容：${text.slice(0, 200)}`)
  return JSON.parse(dataLines[dataLines.length - 1])
}

/**
 * 调用一个 MCP 工具，返回已经解析好的业务对象。
 * 失败时抛出带排查提示的 Error。
 */
async function callTool<T>(tool: string, args: Record<string, unknown>, refId?: string): Promise<T> {
  if (!hasSaturnNews()) throw new Error('SATURN_NEWS_MCP_KEY 未配置，曙光舆情源不可用')

  const url = config.saturnNews.url
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.saturnNews.timeoutMs || DEFAULT_TIMEOUT_MS)

  let httpStatus: number | null = null
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        // ⚠️ 不加 Bearer 前缀，见文件头注释第 1 条
        Authorization: config.saturnNews.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: controller.signal,
    })
    httpStatus = res.status
    const text = await res.text()

    if (!res.ok) {
      throw new Error(`saturn-news HTTP ${res.status}｜${text.slice(0, 300)}`)
    }

    const rpc = parseSseJson(text)
    if (rpc.error) {
      throw new Error(`saturn-news JSON-RPC 错误：${rpc.error.code ?? ''} ${rpc.error.message ?? ''}`)
    }
    const result = rpc.result
    if (result?.isError) {
      const msg = String(result.content?.[0]?.text ?? '')
      throw new Error(`saturn-news 工具 ${tool} 执行失败：${msg}`)
    }

    const raw = result?.content?.[0]?.text
    if (typeof raw !== 'string') {
      throw new Error(`saturn-news 工具 ${tool} 返回结构异常（content[0].text 不是字符串）`)
    }
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`saturn-news 工具 ${tool} 返回的不是 JSON：${raw.slice(0, 200)}`)
    }

    const traceId = parsed?.meta?.trace_id ?? null
    await logApiCall({
      provider: 'news',
      endpoint: `saturn:${tool}`,
      refType: 'news',
      refId: refId ?? null,
      ok: true,
      httpStatus,
      durationMs: Date.now() - started,
      cost: 0,
      requestId: traceId,
    })
    logger.debug(
      { tool, count: parsed?.count, ms: Date.now() - started, traceId, elapsed: parsed?.meta?.elapsed_ms },
      'saturn_news.call_ok',
    )
    return parsed as T
  } catch (e) {
    const err = e as Error
    const msg = err.name === 'AbortError' ? `请求超时（${config.saturnNews.timeoutMs}ms）` : err.message
    await logApiCall({
      provider: 'news',
      endpoint: `saturn:${tool}`,
      ok: false,
      httpStatus,
      durationMs: Date.now() - started,
      error: msg.slice(0, 500),
      cost: 0,
      requestId: null,
    })
    logger.error({ tool, err: msg }, 'saturn_news.call_failed')
    throw new Error(describeError(msg))
  } finally {
    clearTimeout(timer)
  }
}

function describeError(msg: string): string {
  if (/Output validation error/i.test(msg)) {
    return `${msg}｜Authorization 头必须直接放 key，不能加 "Bearer " 前缀`
  }
  if (/401|403|unauthorized|invalid.*key/i.test(msg)) {
    return `${msg}｜检查 SATURN_NEWS_MCP_KEY 是否有效`
  }
  if (/超时/.test(msg)) return `${msg}｜可调大 SATURN_NEWS_TIMEOUT_MS`
  return msg
}

/* ── 业务封装：四个检索工具 + 两个清单工具 ───────────────────────────── */

/** 按关键词搜舆情 */
export function searchByKeyword(opts: KeywordSearchOptions): Promise<SaturnSearchResult> {
  return callTool<SaturnSearchResult>(
    'search_saturn_news_keyword',
    {
      query: opts.query,
      ...(opts.dateRange ? { date_range: opts.dateRange } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.sortBy ? { sort_by: opts.sortBy } : {}),
      ...(opts.channels ? { channels: opts.channels } : {}),
      ...(opts.fullContent !== undefined ? { full_content: opts.fullContent } : {}),
    },
    `kw:${opts.query}`,
  )
}

/** 按个股搜舆情 */
export function searchByStock(opts: StockSearchOptions): Promise<SaturnSearchResult> {
  return callTool<SaturnSearchResult>(
    'search_saturn_news_stock',
    {
      ...(opts.ticker ? { ticker: opts.ticker } : {}),
      ...(opts.secName ? { sec_name: opts.secName } : {}),
      ...(opts.dateRange ? { date_range: opts.dateRange } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.sortBy ? { sort_by: opts.sortBy } : {}),
      ...(opts.channels ? { channels: opts.channels } : {}),
      ...(opts.fullContent !== undefined ? { full_content: opts.fullContent } : {}),
    },
    `stock:${opts.ticker ?? opts.secName ?? ''}`,
  )
}

/** 按行业搜舆情（industry 须来自 listIndustries） */
export function searchByIndustry(opts: IndustrySearchOptions): Promise<SaturnSearchResult> {
  return callTool<SaturnSearchResult>(
    'search_saturn_news_industry',
    {
      industry: opts.industry,
      ...(opts.industryLevel ? { industry_level: opts.industryLevel } : {}),
      ...(opts.dateRange ? { date_range: opts.dateRange } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.sortBy ? { sort_by: opts.sortBy } : {}),
      ...(opts.channels ? { channels: opts.channels } : {}),
      ...(opts.fullContent !== undefined ? { full_content: opts.fullContent } : {}),
    },
    `ind:${opts.industry}`,
  )
}

/** 按主题搜舆情（theme 须来自 listThemes） */
export function searchByTheme(opts: ThemeSearchOptions): Promise<SaturnSearchResult> {
  return callTool<SaturnSearchResult>(
    'search_saturn_news_theme',
    {
      theme: opts.theme,
      ...(opts.dateRange ? { date_range: opts.dateRange } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.sortBy ? { sort_by: opts.sortBy } : {}),
      ...(opts.channels ? { channels: opts.channels } : {}),
      ...(opts.fullContent !== undefined ? { full_content: opts.fullContent } : {}),
    },
    `theme:${opts.theme}`,
  )
}

/** 行业白名单 */
export async function listIndustries(query?: string, level?: 1 | 2, limit = 500): Promise<string[]> {
  const d = await callTool<{ industries?: Array<{ industry_name?: string }> }>('list_saturn_news_industries', {
    ...(query ? { query } : {}),
    ...(level ? { level } : {}),
    limit,
  })
  return (d.industries ?? []).map((x) => String(x.industry_name ?? '')).filter(Boolean)
}

/** 主题清单 */
export async function listThemes(query?: string, limit = 500): Promise<string[]> {
  const d = await callTool<{ themes?: Array<{ theme_name?: string }> }>('list_saturn_news_themes', {
    ...(query ? { query } : {}),
    limit,
  })
  return (d.themes ?? []).map((x) => String(x.theme_name ?? '')).filter(Boolean)
}
