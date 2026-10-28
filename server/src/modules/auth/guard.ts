import type { FastifyInstance, FastifyRequest } from 'fastify'
import { config } from '../../config.js'
import { err } from '../../errors.js'
import { getUserById, type AppUser } from './repo.js'
import { verifyToken, type Role } from './tokens.js'
import { pruneBuckets, takeToken, type RateRule } from '../../lib/rate-limit.js'

/**
 * 鉴权与角色守卫（P0-1）。
 *
 * - 除健康检查与登录外，所有接口都要求登录；
 * - 令牌优先取 `Authorization: Bearer`；`<img>/<video>/<audio>` 无法带请求头，
 *   因此 **仅 GET/HEAD** 额外接受 HttpOnly Cookie（写操作不认 Cookie，杜绝跨站请求伪造）；
 * - 角色按「方法 + 路由模板」集中声明，未列出的接口任何已登录角色都可访问。
 */

const PUBLIC_ROUTES = new Set(['GET /health', 'GET /api/health', 'POST /api/auth/login'])

const REVIEWERS: Role[] = ['reviewer', 'admin']
const ADMINS: Role[] = ['admin']
const OPERATORS: Role[] = ['ops', 'admin'] // 发布管理：运营 / 管理员可写（审核无发布权，A3）

/** 方法 + Fastify 路由模板（含 /api 前缀）→ 允许的角色 */
export const ROLE_RULES: Record<string, Role[]> = {
  // 系统设置：含各服务密钥（脱敏回显），仅管理员可看可改
  'GET /api/settings': ADMINS,
  'PUT /api/settings': ADMINS,
  // 人物库：授权核验 / 撤销、素材审核（审核员职责，四眼原则在服务层再校验）
  'POST /api/persona-authorizations/:id/verify': REVIEWERS,
  'POST /api/persona-authorizations/:id/revoke': REVIEWERS,
  'POST /api/persona-assets/:id/review': REVIEWERS,
  // 文案工坊：审核裁决 / 关卡推进（桩与人工复核）
  'POST /api/review/submissions/:id/decision': REVIEWERS,
  'POST /api/review/submissions/:id/progress': REVIEWERS,
  'GET /api/review/queue': REVIEWERS,
  'POST /api/review/submissions/:id/manual-decision': REVIEWERS,
  // 合规词库、模板、风格：影响生成合规口径
  'POST /api/compliance-words': REVIEWERS,
  'PUT /api/compliance-words/:id': REVIEWERS,
  'DELETE /api/compliance-words/:id': REVIEWERS,
  'POST /api/copy-templates': REVIEWERS,
  'PUT /api/copy-templates/:id': REVIEWERS,
  'DELETE /api/copy-templates/:id': REVIEWERS,
  'POST /api/copy-styles': REVIEWERS,
  'PUT /api/copy-styles/:id': REVIEWERS,
  'DELETE /api/copy-styles/:id': REVIEWERS,
  // 管理员：账号、审计日志、资讯分类规则、模型连通性自测（计费）
  'GET /api/users': ADMINS,
  'POST /api/users': ADMINS,
  'PATCH /api/users/:id': ADMINS,
  'GET /api/operations': ADMINS,
  'POST /api/news/rules': ADMINS,
  'DELETE /api/news/rules/:id': ADMINS,
  'POST /api/copy/llm/ping': ADMINS,
  // 发布管理（任务书 §6）：运营 / 管理员可写；审核角色只读；删除仅管理员（Q10）
  'POST /api/platform-accounts': OPERATORS,
  'PATCH /api/platform-accounts/:id': OPERATORS,
  'DELETE /api/platform-accounts/:id': ADMINS,
  'POST /api/platform-accounts/:id/login-sessions': OPERATORS,
  'POST /api/platform-accounts/:id/check-login': OPERATORS,
  'POST /api/publish-plans': OPERATORS,
  'POST /api/publish-plans/:id/schedule': OPERATORS,
  'POST /api/publish-plans/:id/execute-now': OPERATORS,
  'POST /api/publish-plans/:id/review-confirm': REVIEWERS,
  'POST /api/publish-plans/:id/cancel': OPERATORS,
  'POST /api/publish-logs': OPERATORS,
  'POST /api/publish-logs/:id/retry': OPERATORS,
  'POST /api/publish-logs/:id/recheck': OPERATORS,
  'POST /api/publish-logs/:id/manual-result': OPERATORS,
  // 视频剪辑（任务书 §4.2 / CE0）：配置与渲染写限运营/管理员；成片复审裁决限审核/管理员（Q8）
  'PUT /api/video/jobs/:id/cut-config': OPERATORS,
  'POST /api/video/jobs/:id/cut-versions': OPERATORS,
  'POST /api/video/cuts/:id/cancel': OPERATORS,
  'POST /api/video/cuts/:id/retry-render': OPERATORS,
  'POST /api/video/cuts/:id/review': OPERATORS,
  'POST /api/video/cuts/:id/review/decision': REVIEWERS,
  'POST /api/cut/bgm': ADMINS,
  'DELETE /api/cut/bgm/:id': ADMINS,
  // 素材库（任务书 A6 / Q6）：上传与管理仅管理员，读接口登录即可
  'POST /api/fonts': ADMINS,
  'PATCH /api/fonts/:id': ADMINS,
  'DELETE /api/fonts/:id': ADMINS,
  'POST /api/fonts/bootstrap': ADMINS,
  'POST /api/material-packs': ADMINS,
  'PATCH /api/material-packs/:id': ADMINS,
  'DELETE /api/material-packs/:id': ADMINS,
  'PATCH /api/material-packs/:id/items/:itemId': ADMINS,
  'POST /api/material-keyword-groups': ADMINS,
  'PATCH /api/material-keyword-groups/:id': ADMINS,
  'DELETE /api/material-keyword-groups/:id': ADMINS,
  // 数据看板（任务书 §6）：导入回采数据 / 确认特征偏好 / 处理建议 / 对标降档 = 运营+管理员；
  // 手动触发采集只给管理员（会打外部 Provider，一期虽未启用也按高成本接口管理）
  'POST /api/analytics/metrics/import': OPERATORS,
  'POST /api/analytics/metrics/collect': ADMINS,
  'POST /api/analytics/features/confirm': OPERATORS,
  'POST /api/analytics/suggestions/refresh': OPERATORS,
  'POST /api/analytics/suggestions/:id/confirm': OPERATORS,
  'POST /api/analytics/suggestions/:id/dismiss': OPERATORS,
  'POST /api/analytics/benchmark-priority': OPERATORS,
}

/**
 * P2-12：计费 / 高成本接口按「接口 + 操作人」限流（每分钟次数，允许短时突发）。
 * 模型生成、视频提取、TikHub 解析、飞影试听与克隆、资讯刷新、文件上传。
 */
export const RATE_RULES: Record<string, RateRule> = {
  'POST /api/copy/:id/generate': { perMinute: 6 },
  'POST /api/copy/:id/drafts/:draftId/variants': { perMinute: 10 },
  'POST /api/copy/:id/prompt-preview': { perMinute: 30 },
  'POST /api/copy/:id/structure': { perMinute: 6 },
  'POST /api/copy/:id/similarity': { perMinute: 120 },
  'POST /api/copy/llm/ping': { perMinute: 3 },
  'POST /api/topics/generate': { perMinute: 6 },
  'POST /api/benchmark/videos/:id/extract': { perMinute: 10 },
  'POST /api/benchmark/parse-link': { perMinute: 20 },
  'POST /api/benchmark/accounts/preview': { perMinute: 20 },
  'POST /api/benchmark/accounts/:id/fetch-now': { perMinute: 10 },
  'GET /api/benchmark/videos/:id/playback': { perMinute: 30 },
  'POST /api/news/refresh': { perMinute: 4 },
  'POST /api/articles': { perMinute: 20 },
  'POST /api/persona-voices/:id/preview': { perMinute: 10 },
  'POST /api/personas/:id/avatars': { perMinute: 10 },
  'POST /api/personas/:id/voices': { perMinute: 10 },
  'POST /api/personas/:id/assets': { perMinute: 60 },
}

let lastPrune = 0

function routeKey(req: FastifyRequest): string {
  const url = req.routeOptions?.url ?? req.url.split('?')[0]
  return `${req.method} ${url}`
}

function bearerOf(req: FastifyRequest): string | null {
  const raw = req.headers.authorization
  if (raw && /^Bearer\s+/i.test(raw)) return raw.replace(/^Bearer\s+/i, '').trim() || null
  return null
}

export function cookieTokenOf(req: FastifyRequest): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === config.auth.cookieName) {
      return decodeURIComponent(part.slice(idx + 1).trim()) || null
    }
  }
  return null
}

/** 短缓存：每个请求都回库确认账号仍启用、令牌版本未变，但避免高频轮询打满数据库 */
const userCache = new Map<string, { user: AppUser | null; at: number }>()
const USER_CACHE_MS = 10_000

export function invalidateUserCache(id?: string): void {
  if (id) userCache.delete(id)
  else userCache.clear()
}

async function loadUser(id: string): Promise<AppUser | null> {
  const hit = userCache.get(id)
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit.user
  const user = await getUserById(id)
  userCache.set(id, { user, at: Date.now() })
  return user
}

export async function authenticate(req: FastifyRequest): Promise<AppUser | null> {
  const isRead = req.method === 'GET' || req.method === 'HEAD'
  const token = bearerOf(req) ?? (isRead ? cookieTokenOf(req) : null)
  if (!token) return null
  const claims = verifyToken(token)
  if (!claims) return null
  const user = await loadUser(claims.sub)
  if (!user || !user.enabled || user.tokenVersion !== claims.tv) return null
  return user
}

export function hasRole(user: AppUser | null | undefined, roles: Role[]): boolean {
  return !!user && roles.includes(user.role)
}

export function registerAuthGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    req.user = null
    req.operator = 'anonymous'
    if (req.method === 'OPTIONS') return
    const key = routeKey(req)
    const user = await authenticate(req)
    if (user) {
      req.user = user
      req.operator = user.username
    }
    if (PUBLIC_ROUTES.has(key)) return
    // 桌面/单端口部署的前端静态资源（GET 非 /api）：匿名可加载，数据仍由各 API 的登录校验保护
    if (config.staticDir && req.method === 'GET' && !req.url.startsWith('/api')) return
    if (!user) throw err.unauthorized()
    const roles = ROLE_RULES[key]
    if (roles && !roles.includes(user.role)) {
      throw err.forbidden(`当前角色（${user.role}）无权执行该操作`)
    }
    const rule = config.rateLimit.enabled ? RATE_RULES[key] : undefined
    if (rule) {
      if (Date.now() - lastPrune > 60_000) {
        lastPrune = Date.now()
        pruneBuckets()
      }
      const perMinute = Math.max(1, Math.round(rule.perMinute * config.rateLimit.scale))
      const r = takeToken(`${key}|${user.id}`, { perMinute })
      if (!r.ok) {
        reply.header('Retry-After', String(r.retryAfterSec))
        throw err.rateLimited(`操作过于频繁，请 ${r.retryAfterSec} 秒后再试`, { retryAfterSec: r.retryAfterSec, perMinute })
      }
    }
  })
}
