import axios from 'axios'
import { config, hasDashScope } from '../../config.js'
import { logger } from '../../log.js'
import { logApiCall } from '../../modules/metrics/call-log.js'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface LlmResult {
  content: string
  cost: number
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  mock?: boolean
}

const PRICE_PER_1K = config.dashscope.llmUnitPrice

/** 百炼兼容 OpenAI 接口（DASHSCOPE_BASE_URL 可配） */
export async function chat(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<LlmResult> {
  const started = Date.now()
  if (!hasDashScope()) {
    if (!config.mockFallback) throw new Error('DASHSCOPE_API_KEY 未配置')
    const content = mockChat(messages)
    await logApiCall({
      provider: 'dashscope',
      endpoint: 'chat/completions(mock)',
      ok: true,
      durationMs: Date.now() - started,
      cost: 0,
    })
    return { content, cost: 0, mock: true }
  }

  try {
    const res = await axios.post(
      `${config.dashscope.baseUrl}/chat/completions`,
      {
        model: config.dashscope.llmModel,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 4000,
        response_format: { type: 'json_object' },
      },
      {
        headers: { Authorization: `Bearer ${config.dashscope.apiKey}`, 'Content-Type': 'application/json' },
        timeout: config.dashscope.timeoutMs,
      },
    )
    const content: string = res.data?.choices?.[0]?.message?.content ?? ''
    const usage = res.data?.usage
    const cost = usage?.total_tokens ? (usage.total_tokens / 1000) * PRICE_PER_1K : 0
    await logApiCall({
      provider: 'dashscope',
      endpoint: 'chat/completions',
      ok: true,
      httpStatus: res.status,
      durationMs: Date.now() - started,
      cost,
      requestId: res.headers?.['x-request-id'] ? String(res.headers['x-request-id']) : null,
    })
    return { content, cost, usage, mock: false }
  } catch (e: any) {
    const status = e?.response?.status
    const msg = e?.response?.data?.error?.message ?? e?.response?.data?.message ?? e?.message ?? 'LLM 调用失败'
    await logApiCall({
      provider: 'dashscope',
      endpoint: 'chat/completions',
      ok: false,
      httpStatus: status ?? null,
      durationMs: Date.now() - started,
      error: msg,
    })
    logger.error({ err: msg, status }, 'llm.failed')
    throw new Error(`LLM 调用失败：${msg}`)
  }
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
