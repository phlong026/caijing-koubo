/**
 * 脚本内本地假服务（node:http 桩）的共性处理。
 *
 * 两个坑：
 *  1. 开发机 / 运行环境常带 HTTP(S)_PROXY，axios 会把发往 127.0.0.1 的请求也交给代理；
 *     代理转发时 request-target 是 absolute-form（`http://host:port/api/xxx`），
 *     桩服务按 `req.url === '/api/xxx'` 精确比对就会 404，用例表现为「业务失败」而非「网络失败」。
 *  2. 这类用例只验证协议契约，不该受 ambient 网络配置影响。
 *
 * 用法：脚本顶部（导入客户端之前）调 `disableEnvProxy()`；桩服务里用 `pathOf(req.url)` 取路径。
 */

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']

/** 断掉环境代理：脚本内所有请求都走本机回环，不允许绕代理 */
export function disableEnvProxy(): void {
  for (const k of PROXY_KEYS) delete process.env[k]
  process.env.NO_PROXY = '127.0.0.1,localhost,::1'
  process.env.no_proxy = process.env.NO_PROXY
}

/** request-target 归一成 path（兼容 origin-form 与代理转发的 absolute-form，保留 query） */
export function pathOf(reqUrl?: string | null): string {
  const raw = reqUrl ?? '/'
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      return `${u.pathname}${u.search}`
    } catch {
      return raw
    }
  }
  return raw
}
