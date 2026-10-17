import axios from 'axios'
import { config, hasFinStep } from '../../config.js'
import { logger } from '../../log.js'
import { logApiCall } from '../../modules/metrics/call-log.js'
import { extractToolData } from './extract.js'

/**
 * 财跃 FinStep ReAct 资讯接口客户端。
 *
 * 这是一个 **LLM 问答接口**（SSE 流式），不是纯数据 API：
 * 我们发一句 query，它自己决定调用哪些工具（17 个可选），跑最多 8 轮推理，
 * 最后吐一段自然语言答案。**结构化数据只能从 `tool_result` 事件里取**，
 * 绝不能用 `answer` 的自然语言（那是被模型二次加工过的内容）。
 *
 * 两条铁律（踩坑得来）：
 *   1. 请求体必填 `user_id`（snake_case），写 userId 会返回「用户ID不能为空」；
 *   2. 响应是 `event: xxx\ndata: {...}\n\n` 的 SSE 帧，必须流式消费，
 *      按帧切分而不是按行，避免 JSON 被错误切半。
 */

export interface FinStepToolResult<T = unknown> {
  tool_name: string
  display_name: string
  status: string
  data: T
  summary?: string
  errorMessage?: string | null
}

export interface FinStepRunResult {
  toolResults: FinStepToolResult[]
  answer: string
  traceId: string | null
  error: string | null
}

/** 单帧：把 "event: a\ndata: {...}" 解析成结构 */
interface SseFrame {
  event: string
  data: any
}

function parseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = []
  // SSE 以空行分隔帧；兼容 \r\n
  const parts = buffer.split(/\r?\n\r?\n/)
  const rest = parts.pop() ?? ''
  for (const block of parts) {
    if (!block.trim()) continue
    const event = /^event:\s*(\S+)/m.exec(block)?.[1] ?? 'message'
    const dataLines = [...block.matchAll(/^data:\s?(.*)$/gm)].map((m) => m[1])
    if (!dataLines.length) continue
    const raw = dataLines.join('\n')
    let data: any = raw
    try {
      data = JSON.parse(raw)
    } catch {
      // 非 JSON 的 data 帧原样保留，由上层忽略
    }
    frames.push({ event, data })
  }
  return { frames, rest }
}

/** tool_result 事件 → 统一结构（字段名在不同工具下一致） */
function toToolResult(d: any): FinStepToolResult {
  return {
    tool_name: String(d?.tool_name ?? ''),
    display_name: String(d?.display_name ?? ''),
    status: String(d?.status ?? ''),
    data: d?.result?.data ?? null,
    summary: d?.result?.summary ?? '',
    errorMessage: d?.error_message ?? null,
  }
}

export interface RunOptions {
  query: string
  /** 只需要哪些工具的结果，其余丢弃以省内存 */
  wantTools?: string[]
  refType?: string
  refId?: string
  /** 网络层重试次数（不含首次），默认 2 */
  retries?: number
}

/** 判定是否为「值得重试」的瞬时网络错误（TLS 握手失败、连接被重置等） */
function isTransientNetworkError(msg: string): boolean {
  return /socket disconnected before secure TLS|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|socket hang up|EPIPE|Client network socket/i.test(
    msg,
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 发起一次 ReAct 调用，消费 SSE 流，返回指定工具的结构化数据。
 * 失败抛出带 `hint` 的错误（鉴权/参数/超时各有针对性提示）。
 *
 * 网络层抖动会重试（TLS 握手失败实测三次探测中命中一次）；
 * 业务层错误（401、参数错误、工具无数据）不重试，重试只是浪费配额。
 */
export async function runReAct(opts: RunOptions): Promise<FinStepRunResult> {
  if (!hasFinStep()) throw new Error('FINSTEP_API_KEY 未配置，FinStep 资讯源不可用')

  const maxAttempts = Math.max(1, (opts.retries ?? 2) + 1)
  let lastErr: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runReActOnce(opts)
    } catch (e) {
      const err = e as Error
      lastErr = err
      if (attempt >= maxAttempts || !isTransientNetworkError(err.message)) throw err
      // 指数退避：1s → 3s，抖动通常是几十秒内自愈
      const wait = attempt === 1 ? 1000 : 3000
      logger.warn(
        { attempt, maxAttempts, wait, err: err.message },
        'finstep.retry_transient',
      )
      await sleep(wait)
    }
  }
  throw lastErr ?? new Error('FinStep 调用失败')
}

async function runReActOnce(opts: RunOptions): Promise<FinStepRunResult> {
  const url = `${config.finstep.baseUrl.replace(/\/$/, '')}${config.finstep.completionPath}`
  const started = Date.now()
  const want = opts.wantTools && opts.wantTools.length ? new Set(opts.wantTools) : null

  const toolResults: FinStepToolResult[] = []
  let answer = ''
  let traceId: string | null = null
  let rest = ''
  let httpStatus: number | null = null

  try {
    const res = await axios.post(
      url,
      { user_id: config.finstep.userId, query: opts.query },
      {
        headers: {
          Authorization: `Bearer ${config.finstep.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        responseType: 'stream',
        timeout: config.finstep.timeoutMs,
        // 自行判断状态码，便于把 body 里的业务错误读出来
        validateStatus: () => true,
      },
    )
    httpStatus = res.status

    if (res.status !== 200) {
      // 非 200 时 body 是普通 JSON 错误
      const errBody = await readAll(res.data).catch(() => '')
      let msg = `HTTP ${res.status}`
      try {
        const j = JSON.parse(errBody)
        msg = `${j?.error?.code ?? ''} ${j?.error?.details ?? j?.error?.message ?? msg}`.trim()
      } catch {
        if (errBody) msg = `${msg} ${errBody.slice(0, 200)}`
      }
      throw new Error(`FinStep 调用失败：${msg}`)
    }

    await new Promise<void>((resolve, reject) => {
      const stream = res.data as NodeJS.ReadableStream
      const timer = setTimeout(() => {
        // 超时后主动断开，避免永远挂着
        ;(stream as any).destroy?.()
        reject(new Error(`FinStep 流式响应超时（${config.finstep.timeoutMs}ms）`))
      }, config.finstep.timeoutMs)

      stream.setEncoding?.('utf8')
      stream.on('data', (chunk: string) => {
        rest += chunk
        const { frames, rest: left } = parseFrames(rest)
        rest = left
        for (const f of frames) {
          if (f.event === 'tool_result') {
            const tr = toToolResult(f.data)
            if (!want || want.has(tr.tool_name)) toolResults.push(tr)
          } else if (f.event === 'answer') {
            const c = f.data?.chunk
            if (typeof c === 'string') answer += c
          } else if (f.event === 'status' && f.data?.thread_id && !traceId) {
            traceId = String(f.data.thread_id)
          } else if (f.event === 'done' && f.data?.trace_id) {
            traceId = String(f.data.trace_id)
          }
        }
      })
      stream.on('end', () => {
        clearTimeout(timer)
        resolve()
      })
      stream.on('error', (e: Error) => {
        clearTimeout(timer)
        reject(e)
      })
    })

    // 收尾：最后一段可能没有空行结尾
    if (rest.trim()) {
      const { frames } = parseFrames(`${rest}\n\n`)
      for (const f of frames) {
        if (f.event === 'tool_result') {
          const tr = toToolResult(f.data)
          if (!want || want.has(tr.tool_name)) toolResults.push(tr)
        } else if (f.event === 'answer' && typeof f.data?.chunk === 'string') {
          answer += f.data.chunk
        }
      }
    }

    await logApiCall({
      provider: 'news',
      endpoint: `finstep:${opts.query.slice(0, 40)}`,
      refType: opts.refType ?? null,
      refId: opts.refId ?? null,
      ok: true,
      httpStatus,
      durationMs: Date.now() - started,
      cost: 0,
      requestId: traceId,
    })

    logger.info(
      { tools: toolResults.map((t) => t.tool_name), answerLen: answer.length, ms: Date.now() - started },
      'finstep.react_done',
    )
    return { toolResults, answer, traceId, error: null }
  } catch (e) {
    const msg = (e as Error).message ?? 'FinStep 调用失败'
    await logApiCall({
      provider: 'news',
      endpoint: 'finstep:react',
      ok: false,
      httpStatus,
      durationMs: Date.now() - started,
      error: msg.slice(0, 500),
      cost: 0,
      requestId: traceId,
    })
    logger.error({ err: msg }, 'finstep.react_failed')
    throw new Error(describeError(msg))
  }
}

function describeError(msg: string): string {
  if (/401/.test(msg)) return `${msg}｜检查 FINSTEP_API_KEY 是否有效或已过期`
  if (/用户ID不能为空/.test(msg)) return `${msg}｜请求体字段必须是 user_id（snake_case），不是 userId`
  if (/超时/.test(msg)) return `${msg}｜ReAct 推理较慢，可调大 FINSTEP_TIMEOUT_MS`
  return msg
}

/** 兜底读取整个流（错误响应体用） */
function readAll(stream: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    stream.setEncoding?.('utf8')
    stream.on('data', (c: string) => (buf += c))
    stream.on('end', () => resolve(buf))
    stream.on('error', reject)
  })
}

/** 便捷封装：直接拿某个工具的结构化 data */
export async function fetchToolData<T = unknown>(
  query: string,
  toolName: string,
  refId?: string,
): Promise<T | null> {
  const r = await runReAct({ query, wantTools: [toolName], refType: 'news', refId })
  const hit = r.toolResults.find((t) => t.tool_name === toolName)
  if (!hit) {
    logger.warn({ toolName, got: r.toolResults.map((t) => t.tool_name) }, 'finstep.tool_not_called')
    return null
  }
  if (hit.status !== 'success') {
    logger.warn({ toolName, status: hit.status, err: hit.errorMessage }, 'finstep.tool_failed')
    return null
  }
  return extractToolData<T>(toolName, hit.data)
}
