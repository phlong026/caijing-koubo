const rawBase = import.meta.env.VITE_API_BASE || '/api'
const API_BASE = rawBase.replace(/\/$/, '')

export type PageResult<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export class ApiError extends Error {
  readonly code: string
  readonly status?: number

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

type QueryValue = string | number | boolean | null | undefined

function buildUrl(path: string, query?: Record<string, QueryValue>) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const url = `${API_BASE}${normalizedPath}`
  if (!query) return url

  const params = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  })
  const search = params.toString()
  return search ? `${url}?${search}` : url
}

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return typeof value === 'object' && value !== null && 'ok' in value
}

/** 操作人（D14）；隐私模式等读不到 localStorage 时回落默认值 */
function readOperator(): string {
  try {
    return localStorage.getItem('mw_operator') || 'ops'
  } catch {
    return 'ops'
  }
}

export async function request<T>(path: string, init: RequestInit = {}, query?: Record<string, QueryValue>): Promise<T> {
  const headers = new Headers(init.headers)
  // 无 body 时不能声明 application/json，否则服务端会报 "Body cannot be empty"
  // FormData 也不能设，需由浏览器自动补 multipart 的 boundary
  if (init.body !== undefined && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  headers.set('X-Operator', readOperator())

  let response: Response
  let text: string
  try {
    response = await fetch(buildUrl(path, query), { ...init, headers })
    text = await response.text()
  } catch (cause) {
    throw new ApiError('network_error', cause instanceof Error ? cause.message : '网络请求失败')
  }

  // 解析失败不是网络问题：网关 502/504 常返回 HTML 页面，要按状态码给出可读错误
  let payload: unknown
  try {
    payload = text ? JSON.parse(text) : undefined
  } catch {
    payload = undefined
  }

  if (!response.ok) {
    if (isEnvelope(payload) && !payload.ok) {
      throw new ApiError(payload.error.code, payload.error.message, response.status)
    }
    const hint = response.status >= 500 ? '服务暂时不可用，请稍后重试' : '请求失败'
    throw new ApiError(`http_${response.status}`, `${hint}（${response.status}）`, response.status)
  }

  if (!isEnvelope(payload)) throw new ApiError('invalid_response', '服务端返回格式不正确', response.status)
  if (!payload.ok) throw new ApiError(payload.error.code, payload.error.message, response.status)
  return payload.data as T
}

export function apiGet<T>(path: string, query?: Record<string, QueryValue>) {
  return request<T>(path, { method: 'GET' }, query)
}

/**
 * POST，支持附加自定义请求头。
 * 文案生成的 `Idempotency-Key` 依赖它，保证重复点击不会产生多次生成（AC-G2）。
 */
export function apiPost<T>(path: string, body?: unknown, headers?: Record<string, string>) {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  })
}

/** 上传文件（multipart），不手动设 Content-Type，交给浏览器补 boundary */
export function apiUpload<T>(path: string, form: FormData) {
  return request<T>(path, { method: 'POST', body: form })
}

export function apiPatch<T>(path: string, body?: unknown) {
  return request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) })
}

export function apiPut<T>(path: string, body?: unknown) {
  return request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) })
}

export function apiDel<T>(path: string) {
  return request<T>(path, { method: 'DELETE' })
}
