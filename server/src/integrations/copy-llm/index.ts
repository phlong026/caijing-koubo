import axios from 'axios'
import { config } from '../../config.js'
import { logger } from '../../log.js'
import { logApiCall, type CallProvider } from '../../modules/metrics/call-log.js'

/**
 * 文案二创专用模型接入（独立于百炼，互不干扰）。
 *
 * 设计要点（FR-G4 / AC-G7）：
 *  - **优先走 COPY_LLM_* 配置**：`COPY_LLM_BASE_URL` + `COPY_LLM_API_KEY` + `COPY_LLM_MODEL`。
 *    未配置时自动回退到百炼（DASHSCOPE_*），保证旧环境与 mock 兜底零改动。
 *  - 自动识别两种协议：
 *      anthropic  → `POST {base}/messages`，头 `x-api-key` + `anthropic-version`，
 *                   system 单独传参（Claude 不接受 system 角色消息）；
 *      openai     → `POST {base}/chat/completions`，头 `Authorization: Bearer`。
 *    `COPY_LLM_PROTOCOL=auto` 时按模型名 / baseurl 关键词猜，猜错也不致命——
 *    调用失败且 `COPY_LLM_AUTO_FALLBACK_PROTOCOL` 开启时会换另一种协议重试一次。
 *  - JSON 输出约束：openai 协议用 `response_format`；anthropic 协议靠提示词（提示词里已要求只输出 JSON）。
 */

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface LlmResult {
  content: string
  cost: number
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  mock?: boolean
  /** 本次实际使用的 provider / model / 协议，便于落库与排查 */
  provider?: string
  model?: string
  protocol?: Protocol
}

export type Protocol = 'openai' | 'anthropic'

/* ── 解析生效的接入配置 ───────────────────────────────────────────── */

export interface ResolvedLlm {
  provider: CallProvider
  baseUrl: string
  apiKey: string
  model: string
  protocol: Protocol
  timeoutMs: number
  unitPrice: number
  /** 是否走了「二创专用」配置（false = 回退百炼） */
  dedicated: boolean
}

const ANTHROPIC_DEFAULT_VERSION = '2023-06-01'

/** 去掉末尾斜杠，并统一去掉重复的 /v1 */
function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function guessProtocol(baseUrl: string, model: string): Protocol {
  const cfg = config.copyLlm
  if (cfg.protocol === 'anthropic' || cfg.protocol === 'openai') return cfg.protocol
  // auto：先看 baseurl，再看模型名
  if (/anthropic|\/messages\b/i.test(baseUrl) && !/compatible-mode/i.test(baseUrl)) return 'anthropic'
  if (/^claude/i.test(model) && /anthropic/i.test(baseUrl)) return 'anthropic'
  if (/^claude[-_]/i.test(model)) return 'anthropic'
  return 'openai'
}

/** 空值视为未配置；占位符（<...>、YOUR_...）也视为未配置，避免把示例值当真实配置 */
function usable(v: string | undefined | null): boolean {
  const s = String(v ?? '').trim()
  return !!s && !/^<.*>$/.test(s) && !/^(your|xxx)/i.test(s)
}

export function resolveLlm(): ResolvedLlm | null {
  const cfg = config.copyLlm
  // P0-4：未获合规批准时不启用第三方中转，直接走下面的百炼回退
  const dedicated = usable(cfg.baseUrl) && usable(cfg.apiKey) && cfg.complianceApproved
  if (dedicated) {
    const model = usable(cfg.model) ? cfg.model : 'claude-sonnet-4-5'
    const baseUrl = normalizeBase(cfg.baseUrl)
    return {
      provider: 'copy_llm',
      baseUrl,
      apiKey: cfg.apiKey,
      model,
      protocol: guessProtocol(baseUrl, model),
      timeoutMs: cfg.timeoutMs,
      unitPrice: cfg.unitPrice,
      dedicated: true,
    }
  }
  // 回退百炼（原有行为不变）
  if (usable(config.dashscope.apiKey)) {
    return {
      provider: 'dashscope',
      baseUrl: normalizeBase(config.dashscope.baseUrl),
      apiKey: config.dashscope.apiKey,
      model: config.dashscope.llmModel,
      protocol: 'openai',
      timeoutMs: config.dashscope.timeoutMs,
      unitPrice: config.dashscope.llmUnitPrice,
      dedicated: false,
    }
  }
  return null
}

export function hasCopyLlm(): boolean {
  return resolveLlm() !== null
}

/** 展示用模型标识：mock 时带 (mock) 后缀，便于区分 */
export function currentModelLabel(): string {
  const r = resolveLlm()
  if (!r) return `${config.copyLlm.model || config.dashscope.llmModel}(mock)`
  return r.dedicated ? r.model : `${r.model}${r.provider === 'dashscope' ? '' : ''}`
}

/* ── 主调用 ──────────────────────────────────────────────────────── */

/**
 * P1-13：记账统一在接入层完成，调用方不要再写 `api_call_log`。
 * `ref` 用于把这次调用归集到具体业务对象（如 copy_generation / generationId）。
 */
export interface LlmCallRef {
  type?: string | null
  id?: string | null
}

export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
  ref: LlmCallRef = {},
): Promise<LlmResult> {
  const started = Date.now()
  const resolved = resolveLlm()
  const refType = ref.type ?? null
  const refId = ref.id ?? null

  if (!resolved) {
    if (!config.mockFallback) throw new Error('未配置文案模型（COPY_LLM_API_KEY / DASHSCOPE_API_KEY 均为空）')
    const content = mockChat(messages)
    await logApiCall({
      provider: 'dashscope',
      endpoint: 'chat/completions(mock)',
      refType,
      refId,
      ok: true,
      durationMs: Date.now() - started,
      cost: 0,
    })
    return { content, cost: 0, mock: true, provider: 'mock', model: `${config.copyLlm.model || 'mock'}(mock)` }
  }

  try {
    const r = await callOnce(resolved, messages, opts)
    await logApiCall({
      provider: r.provider,
      endpoint: r.endpoint,
      refType,
      refId,
      ok: true,
      httpStatus: r.status,
      durationMs: Date.now() - started,
      cost: r.cost,
      requestId: r.requestId,
    })
    return { content: r.content, cost: r.cost, usage: r.usage, mock: false, provider: r.provider, model: resolved.model, protocol: resolved.protocol }
  } catch (e: any) {
    // 场景 A：中转不支持 response_format=json_object（CCG AI 转发 Claude 时会明确报错）。
    //   这是**能力缺失**而非配置错误，去掉该字段重试即可，提示词本身已强约束输出 JSON。
    if (isJsonModeUnsupported(e)) {
      logger.warn({ status: e?.status, model: resolved.model }, 'copy_llm.json_mode_unsupported_retry')
      try {
        const r = await callOnce(resolved, messages, { ...opts, jsonMode: false })
        await logApiCall({
          provider: r.provider,
          endpoint: `${r.endpoint}(no_json_mode)`,
          refType,
          refId,
          ok: true,
          httpStatus: r.status,
          durationMs: Date.now() - started,
          cost: r.cost,
          requestId: r.requestId,
        })
        return {
          content: r.content,
          cost: r.cost,
          usage: r.usage,
          mock: false,
          provider: r.provider,
          model: resolved.model,
          protocol: resolved.protocol,
        }
      } catch (e2: any) {
        await logFailure(resolved, e2, started, ref)
        throw new Error(`LLM 调用失败：${e2?.message ?? '未知错误'}`)
      }
    }

    // 场景 B：协议猜错时换一种再试一次（仅二创专用配置 + 开关打开）
    const canRetry =
      resolved.dedicated &&
      config.copyLlm.autoFallbackProtocol &&
      (e?.status === 404 || e?.status === 400 || e?.status === 405 || e?.status === 415)
    if (canRetry) {
      const alt: Protocol = resolved.protocol === 'anthropic' ? 'openai' : 'anthropic'
      logger.warn({ from: resolved.protocol, to: alt, status: e?.status }, 'copy_llm.protocol_retry')
      try {
        const r = await callOnce({ ...resolved, protocol: alt }, messages, opts)
        await logApiCall({
          provider: r.provider,
          endpoint: `${r.endpoint}(protocol_retry)`,
          refType,
          refId,
          ok: true,
          httpStatus: r.status,
          durationMs: Date.now() - started,
          cost: r.cost,
          requestId: r.requestId,
        })
        return { content: r.content, cost: r.cost, usage: r.usage, mock: false, provider: r.provider, model: resolved.model, protocol: alt }
      } catch (e2: any) {
        // 换协议后若又撞上 json 模式不支持，再降级一次
        if (isJsonModeUnsupported(e2)) {
          try {
            const r = await callOnce({ ...resolved, protocol: alt }, messages, { ...opts, jsonMode: false })
            await logApiCall({
              provider: r.provider,
              endpoint: `${r.endpoint}(protocol_retry,no_json_mode)`,
              refType,
              refId,
              ok: true,
              httpStatus: r.status,
              durationMs: Date.now() - started,
              cost: r.cost,
              requestId: r.requestId,
            })
            return {
              content: r.content,
              cost: r.cost,
              usage: r.usage,
              mock: false,
              provider: r.provider,
              model: resolved.model,
              protocol: alt,
            }
          } catch {
            /* 落到下面的统一失败处理 */
          }
        }
        await logFailure(resolved, e2, started, ref)
        throw new Error(`LLM 调用失败：${e2?.message ?? '未知错误'}`)
      }
    }
    await logFailure(resolved, e, started, ref)
    throw new Error(`LLM 调用失败：${e?.message ?? '未知错误'}`)
  }
}

/** 识别「中转不支持 json_object」类错误（各家措辞不同，用特征词兜住） */
export function isJsonModeUnsupported(e: any): boolean {
  const msg = String(e?.message ?? '')
  if (!msg) return false
  return (
    /json object mode|json_object|response_format/i.test(msg) ||
    /JSON mode .*not support|not support.*JSON mode|compatible .*route/i.test(msg) ||
    // new-api 系中转（如 CCG AI）：请求参数超出所有渠道能力时不报 400 而报
    // 503 no usable channel（code=get_channel_failed）——先按参数问题降级重试；
    // 若真是通道瞬断，这次重试失败后仍会如实报错，无副作用。
    (e?.status === 503 && /no usable channel|get_channel_failed/i.test(msg))
  )
}

async function logFailure(
  resolved: ResolvedLlm,
  e: any,
  started: number,
  ref: LlmCallRef = {},
): Promise<void> {
  const msg = e?.message ?? 'LLM 调用失败'
  await logApiCall({
    refType: ref.type ?? null,
    refId: ref.id ?? null,
    provider: resolved.provider,
    endpoint: resolved.protocol === 'anthropic' ? 'messages' : 'chat/completions',
    ok: false,
    httpStatus: e?.status ?? null,
    durationMs: Date.now() - started,
    error: msg,
  })
  logger.error({ err: msg, status: e?.status, model: resolved.model, protocol: resolved.protocol }, 'llm.failed')
}

interface OnceResult {
  content: string
  cost: number
  usage?: LlmResult['usage']
  provider: CallProvider
  endpoint: string
  status: number
  requestId: string | null
}

async function callOnce(
  r: ResolvedLlm,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
): Promise<OnceResult> {
  const temperature = opts.temperature ?? 0.8
  const maxTokens = opts.maxTokens ?? 4000
  const jsonMode = opts.jsonMode !== false && r.protocol === 'openai'
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const users = messages.filter((m) => m.role !== 'system')

  let url: string
  let headers: Record<string, string>
  let body: unknown

  if (r.protocol === 'anthropic') {
    url = `${r.baseUrl}/messages`
    headers = {
      'x-api-key': r.apiKey,
      'anthropic-version': config.copyLlm.anthropicVersion || ANTHROPIC_DEFAULT_VERSION,
      'content-type': 'application/json',
    }
    body = {
      model: r.model,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: users.map((m) => ({ role: 'user' as const, content: m.content })),
    }
  } else {
    url = `${r.baseUrl}/chat/completions`
    headers = { Authorization: `Bearer ${r.apiKey}`, 'Content-Type': 'application/json' }
    body = {
      model: r.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature,
      max_tokens: maxTokens,
      // JSON 模式：部分中转（如 CCG AI 转发 Claude 时）在 OpenAI 路由上无法保留
      // json_object 语义，会直接 400。此时由上层识别错误并自动去掉该字段重试。
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }
  }

  try {
    const res = await axios.post(url, body, { headers, timeout: r.timeoutMs })
    const endpoint = r.protocol === 'anthropic' ? 'messages' : 'chat/completions'

    if (r.protocol === 'anthropic') {
      // Anthropic 原生返回 content 数组，取全部 text 块拼接
      const blocks = Array.isArray(res.data?.content) ? res.data.content : []
      const content = blocks
        .filter((b: any) => b?.type === 'text' || typeof b?.text === 'string')
        .map((b: any) => String(b.text ?? ''))
        .join('')
      const u = res.data?.usage
      return {
        content,
        cost: estimateCost(r, u?.input_tokens, u?.output_tokens),
        usage: { prompt_tokens: u?.input_tokens, completion_tokens: u?.output_tokens, total_tokens: (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) },
        provider: r.provider,
        endpoint,
        status: res.status,
        requestId: String(res.headers?.['request-id'] ?? res.headers?.['x-request-id'] ?? '') || null,
      }
    }

    const content: string = res.data?.choices?.[0]?.message?.content ?? ''
    const usage = res.data?.usage
    return {
      content,
      // 输入/输出分价必须显式传：早期这里只按 total_tokens × unitPrice 算，
      // 一旦把计价配成「分价模式」（unitPrice=0），成本就会恒为 0。
      cost: estimateCost(r, usage?.prompt_tokens, usage?.completion_tokens),
      usage,
      provider: r.provider,
      endpoint,
      status: res.status,
      requestId: String(res.headers?.['x-request-id'] ?? '') || null,
    }
  } catch (e: any) {
    const status = e?.response?.status
    const data = e?.response?.data
    const msg =
      data?.error?.message ??
      data?.message ??
      (typeof data === 'string' ? data.slice(0, 300) : undefined) ??
      e?.message ??
      'LLM 调用失败'
    const wrapped = new Error(msg) as Error & { status?: number }
    wrapped.status = status
    throw wrapped
  }
}

/** 成本估算：优先用分隔计价，未配置则退化为「总 token × 单价」 */
function estimateCost(r: ResolvedLlm, inputTokens?: number, outputTokens?: number): number {
  const cfg = config.copyLlm
  if (cfg.inputPricePer1k > 0 || cfg.outputPricePer1k > 0) {
    const inCost = ((inputTokens ?? 0) / 1000) * (cfg.inputPricePer1k || cfg.unitPrice)
    const outCost = ((outputTokens ?? 0) / 1000) * (cfg.outputPricePer1k || cfg.unitPrice)
    return Number((inCost + outCost).toFixed(6))
  }
  if (r.unitPrice > 0) return (((inputTokens ?? 0) + (outputTokens ?? 0)) / 1000) * r.unitPrice
  return 0
}

/* ── mock 兜底：结构对齐真实输出，保证链路可跑通 ───────────────────── */
function mockChat(messages: ChatMessage[]): string {
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
  // ── 文案工坊：变体任务（FR-G5）──
  if (/"variants"/.test(user) || /【本次任务】只改写一个段落/.test(user)) return mockVariantChat(user)
  // ── 文案工坊：整稿生成（FR-G4）──
  if (/"sections"/.test(user) && /【输出格式】/.test(user)) return mockCopyChat(user)

  const titles = Array.from(user.matchAll(/标题[:：]\s*(.+)/g)).map((m) => m[1].trim()).slice(0, 10)
  const rawCount = /请生成\s*(\d+)\s*条/.exec(user)
  const count = rawCount ? Math.max(1, Math.min(10, Number(rawCount[1]))) : 3
  const base = titles.length ? titles : ['本期财经热点']
  const out: Array<{ title: string; direction: string; hook: string; rationale: string }> = []
  for (const t of base) {
    for (let i = 0; i < count; i++) {
      out.push({
        title: `${t.slice(0, 18)}｜角度${i + 1}`,
        direction: ['市场解读', '投教科普', '产品推荐', '热点评论'][i % 4],
        hook: `先说结论：${t.slice(0, 24)}这件事，和你的持仓比想象中更相关。`,
        rationale: `该角度基于资讯事实展开，避免承诺收益与绝对化表述，适合口播开场（mock 生成）。`,
      })
      if (out.length >= 20) break
    }
  }
  return JSON.stringify({ topics: out })
}

/**
 * 文案工坊整稿 mock：从提示词里抽字数区间与素材标题，产出结构合法的 JSON。
 * 关键点：**绝不复制来源原文**（保证素人线查重可通过 AC-R2 / 全局场景 2），
 * 也不包含任何硬禁用词，从而让 smoke 在无密钥时全链路可跑通（AC-G7）。
 */
function mockCopyChat(user: string): string {
  const range = /字数区间：(\d+)–(\d+) 字/.exec(user)
  const min = range ? Number(range[1]) : 135
  const target = Math.max(min, 60)
  const topic =
    /给定标题：(.+)/.exec(user)?.[1]?.trim() ||
    /原视频标题：(.+)/.exec(user)?.[1]?.trim() ||
    /模板：(.+)/.exec(user)?.[1]?.trim() ||
    '本期财经话题'
  const short = topic.slice(0, 16)

  const seg = Math.max(24, Math.round(target / 3.2))
  const fill = (head: string, body: string) => {
    let s = `${head}${body}`
    while (s.length < seg) s += '这一点值得慢慢琢磨，不必急着下结论。'
    return s
  }

  const sections = [
    {
      label: '开场',
      text: fill(
        `先说说${short}这件事。`,
        '它跟很多人的日常选择有直接关系，我们把它拆成几层看清楚，再决定要不要调整手上的安排。',
      ),
    },
    {
      label: '01 先把规则说清楚',
      text: fill(
        '第一层是规则层面。',
        '它决定了边界在哪里、成本怎么算、什么情况下会失效。把规则弄清楚，比听任何一句结论都有用。',
      ),
    },
    {
      label: '02 再看影响与代价',
      text: fill(
        '第二层是影响与代价。',
        '同样一件事，对不同处境的人意味着不同的选择。你需要关注的是自己的期限、承受波动的能力和现金安排。',
      ),
    },
    {
      label: '收尾',
      text: fill('最后回到你自己。', '可以留意几个公开可查的指标，观察一段时间再判断，而不是被短期波动牵着走。'),
    },
  ]

  // article 模式要求每段带非递减的 sourceRefs（AC-G3），mock 也按大纲节点数给出，保证无密钥时回归可跑
  if (/每段必须带 sourceRefs/.test(user)) {
    const maxRef = Number(/节点序号\*\*（0 ~ (\d+)）/.exec(user)?.[1] ?? 0)
    sections.forEach((s, i) => Object.assign(s, { sourceRefs: [Math.min(i, maxRef)] }))
  }

  return JSON.stringify({ title: `${short}：把规则和边界先看清楚`.slice(0, 30), sections })
}

/** 文案工坊变体 mock：按请求的类型串返回等量候选 */
function mockVariantChat(user: string): string {
  const kindsLine = /【需要的变体类型】(.+)/.exec(user)?.[1] ?? ''
  const kinds = kindsLine
    .split(/\d\)\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
  const list = kinds.length ? kinds : ['口语化', '专业型']
  const original = /--- 原始段落开始 ---\n([\s\S]*?)\n--- 原始段落结束 ---/.exec(user)?.[1] ?? '这段内容'
  return JSON.stringify({
    variants: list.map((k, i) => ({
      kind: k,
      text:
        i === 0
          ? `换个说法讲讲这件事：${original.slice(0, 40)}……先把话说白，再说透。`
          : `从框架上看，${original.slice(0, 40)}……需要先厘清边界，再讨论取舍。`,
    })),
  })
}
