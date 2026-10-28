import axios from 'axios'
import { config } from '../../config.js'
import { logger } from '../../log.js'
import { logApiCall } from '../../modules/metrics/call-log.js'

/**
 * 校对台内容审核平台客户端（docs/jiaoduitai-review-api-v1.3.md）。
 * 本期平台无鉴权，提交人凭 submitter 自证；错误统一为 {"error": "中文描述"}。
 * 机审异步：送审拿到 review_no 即受理成功，进度靠 by-no 查询。
 * 平台只出审核意见不改稿：驳回 / 机审拦截由我方改稿后 resubmit 重审（单号不变、版本 +1）。
 */

export interface SubmitResponse {
  review_no: string
  version: number
  status: string
  status_label: string
}

/** 查询接口只返回最新版本；字段按文档第 2 节核心概念，其余原样保留 */
export interface ReviewByNo {
  review_no: string
  version?: number
  task_no?: string
  status: string
  status_label?: string
  machine_result?: string
  review_path?: string
  [key: string]: unknown
}

export class JiaoduitaiError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码；网络错误 / 超时为 null */
    readonly httpStatus: number | null,
    /** 409 同标题在审时平台给出的已有单号 */
    readonly existingReviewNo: string | null = null,
  ) {
    super(message)
    this.name = 'JiaoduitaiError'
  }

  /** 4xx 是参数或业务冲突，重试也不会成功；网络错误与 5xx 下一轮再试 */
  get permanent(): boolean {
    return this.httpStatus !== null && this.httpStatus >= 400 && this.httpStatus < 500
  }
}

interface Ref {
  type: string
  id: string
}

async function call<T>(method: 'GET' | 'POST', path: string, data: unknown, ref: Ref): Promise<T> {
  const started = Date.now()
  const url = config.jiaoduitai.baseUrl.replace(/\/+$/, '') + path
  try {
    const res = await axios.request({
      method,
      url,
      data,
      timeout: config.jiaoduitai.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    })
    const body = res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : {}
    const ok = res.status >= 200 && res.status < 300
    await logApiCall({
      provider: 'jiaoduitai',
      endpoint: `${method} ${path}`,
      refType: ref.type,
      refId: ref.id,
      ok,
      httpStatus: res.status,
      durationMs: Date.now() - started,
      error: ok ? null : String(body.error ?? res.statusText ?? ''),
    })
    if (!ok) {
      const existing = typeof body.existing_review_no === 'string' ? body.existing_review_no : null
      throw new JiaoduitaiError(String(body.error ?? `校对台返回 HTTP ${res.status}`), res.status, existing)
    }
    return body as T
  } catch (e) {
    if (e instanceof JiaoduitaiError) throw e
    const msg = (e as Error).message
    logger.warn({ path, ref, err: msg }, 'jiaoduitai.network_error')
    await logApiCall({
      provider: 'jiaoduitai',
      endpoint: `${method} ${path}`,
      refType: ref.type,
      refId: ref.id,
      ok: false,
      durationMs: Date.now() - started,
      error: msg,
    })
    throw new JiaoduitaiError(`校对台请求失败：${msg}`, null)
  }
}

/** POST /api/reviews/submit 文本送审 */
export async function submitText(input: { submitter: string; contentText: string }, ref: Ref): Promise<SubmitResponse> {
  const body = await call<Record<string, unknown>>(
    'POST',
    '/api/reviews/submit',
    { submitter: input.submitter, content_text: input.contentText, source: config.jiaoduitai.source },
    ref,
  )
  // 正文已在 toSubmitText 中压掉篇界；仍被拆成多篇说明清洗有漏洞，不能当成单篇处理
  if (body.multiple) throw new JiaoduitaiError('校对台把文案拆成了多篇审核单，请检查正文中的空行与分隔符', 400)
  if (typeof body.review_no !== 'string' || !body.review_no) {
    throw new JiaoduitaiError('校对台送审响应缺少 review_no', null)
  }
  return body as unknown as SubmitResponse
}

/** GET /api/reviews/by-no/{reviewNo} 查询进度（只返回最新版本） */
export async function getReviewByNo(reviewNo: string, ref: Ref): Promise<ReviewByNo> {
  const body = await call<Record<string, unknown>>('GET', `/api/reviews/by-no/${encodeURIComponent(reviewNo)}`, undefined, ref)
  if (typeof body.status !== 'string') throw new JiaoduitaiError('校对台查询响应缺少 status', null)
  return body as ReviewByNo
}

/**
 * POST /api/reviews/by-no/{reviewNo}/resubmit 改稿重审（第 8 节）：
 * 仅平台最新版本为 rejected / pending_revise 时可调；单号锚定不变，版本 +1 重走机审与人工。
 */
export async function resubmitReview(
  reviewNo: string,
  input: { submitter: string; contentText: string },
  ref: Ref,
): Promise<SubmitResponse> {
  const body = await call<Record<string, unknown>>(
    'POST',
    `/api/reviews/by-no/${encodeURIComponent(reviewNo)}/resubmit`,
    { submitter: input.submitter, content_text: input.contentText },
    ref,
  )
  if (typeof body.review_no !== 'string' || !body.review_no) {
    throw new JiaoduitaiError('校对台重审响应缺少 review_no', null)
  }
  return body as unknown as SubmitResponse
}
