const rawBase = import.meta.env.VITE_API_BASE || '/api'
const API_BASE = rawBase.replace(/\/$/, '')

/** 拼出可直接给 <img> / <video> / <audio> 使用的绝对接口地址（走同一 API_BASE） */
export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

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

export type QueryValue = string | number | boolean | null | undefined

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

function normalizedLoginPath(path: string): boolean {
  return /^\/?auth\/login/.test(path)
}

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return typeof value === 'object' && value !== null && 'ok' in value
}

/**
 * 登录令牌（P0-1）。操作人由服务端从令牌解析，前端不再自报 X-Operator。
 * 隐私模式等读不到 localStorage 时仍可靠服务端下发的 HttpOnly Cookie 读取媒体文件。
 */
const TOKEN_KEY = 'mw_token'

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 存储不可用：本次会话内仍可用内存中的登录状态 */
  }
}

/** 401 统一出口：由 main.ts 监听后跳转登录页 */
export const UNAUTHORIZED_EVENT = 'mw:unauthorized'

export async function request<T>(path: string, init: RequestInit = {}, query?: Record<string, QueryValue>): Promise<T> {
  const headers = new Headers(init.headers)
  // 无 body 时不能声明 application/json，否则服务端会报 "Body cannot be empty"
  // FormData 也不能设，需由浏览器自动补 multipart 的 boundary
  if (init.body !== undefined && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const token = readToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

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

  if (response.status === 401 && !normalizedLoginPath(path)) {
    writeToken(null)
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
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
