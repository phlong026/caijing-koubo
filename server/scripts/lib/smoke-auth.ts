/**
 * 冒烟脚本共用的登录（P0-1 起所有接口都要求登录）。
 *
 * 用管理员账号（SMOKE_ADMIN_USER / SMOKE_ADMIN_PASSWORD，缺省为开发环境自动创建的 admin / admin123）
 * 准备两个测试账号：smoke_ops（运营）与 smoke_reviewer（审核），再按接口所需角色自动选令牌：
 *  - 审核员接口（授权核验、素材审核、审核裁决、合规词库 / 模板 / 风格维护）用 smoke_reviewer；
 *  - 管理员接口（账号、审计日志、资讯分类规则、模型自测）用管理员；
 *  - 其余用 smoke_ops。
 * 四眼原则要求「上传人 ≠ 核验人」，所以上传走运营、核验走审核员，天然满足。
 */

const ADMIN_USER = process.env.SMOKE_ADMIN_USER ?? 'admin'
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? 'admin123'
const SMOKE_PASSWORD = process.env.SMOKE_USER_PASSWORD ?? 'Smoke12345'

export type SmokeRole = 'ops' | 'reviewer' | 'admin'

const tokens: Partial<Record<SmokeRole, string>> = {}

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok || !json?.data?.token) {
    throw new Error(`登录失败（${username}）：${res.status} ${JSON.stringify(json?.error ?? json)}`)
  }
  return json.data.token as string
}

async function ensureUser(base: string, admin: string, username: string, role: SmokeRole): Promise<void> {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }
  const created = await fetch(`${base}/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username, role, password: SMOKE_PASSWORD, displayName: username }),
  })
  if (created.ok) return
  // 已存在：重置密码、角色并启用，保证可重复运行
  const list: any = await fetch(`${base}/users`, { headers }).then((r) => r.json())
  const user = (list?.data?.items ?? []).find((u: any) => u.username === username)
  if (!user) throw new Error(`无法创建测试账号 ${username}：${created.status}`)
  await fetch(`${base}/users/${user.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ role, enabled: true, password: SMOKE_PASSWORD }),
  })
}

/** 登录并准备测试账号；脚本开头调用一次 */
export async function initSmokeAuth(base: string): Promise<void> {
  if (tokens.ops) return
  tokens.admin = await login(base, ADMIN_USER, ADMIN_PASSWORD)
  await ensureUser(base, tokens.admin, 'smoke_ops', 'ops')
  await ensureUser(base, tokens.admin, 'smoke_reviewer', 'reviewer')
  tokens.ops = await login(base, 'smoke_ops', SMOKE_PASSWORD)
  tokens.reviewer = await login(base, 'smoke_reviewer', SMOKE_PASSWORD)
}

const REVIEWER_ROUTES: Array<[RegExp, RegExp]> = [
  [/^POST$/, /^\/persona-authorizations\/[^/]+\/(verify|revoke)$/],
  [/^POST$/, /^\/persona-assets\/[^/]+\/review$/],
  [/^POST$/, /^\/review\/submissions\/[^/]+\/(decision|progress|manual-decision)$/],
  [/^GET$/, /^\/review\/queue/],
  [/^(POST|PUT|DELETE)$/, /^\/(compliance-words|copy-templates|copy-styles)(\/|$)/],
]
const ADMIN_ROUTES: Array<[RegExp, RegExp]> = [
  [/.*/, /^\/users(\/|$)/],
  [/^GET$/, /^\/operations/],
  [/^(POST|DELETE)$/, /^\/news\/rules(\/|$)/],
  [/^POST$/, /^\/copy\/llm\/ping$/],
  // 素材库 A6 / Q6：字体与素材包、关键词组的写接口仅管理员
  [/^(POST|PATCH|DELETE)$/, /^\/(fonts|material-packs|material-keyword-groups)(\/|$)/],
]

/** 按接口所需角色选令牌；role 显式指定时优先 */
export function roleFor(method: string, path: string): SmokeRole {
  const p = path.split('?')[0]!
  const m = method.toUpperCase()
  if (ADMIN_ROUTES.some(([mm, pp]) => mm.test(m) && pp.test(p))) return 'admin'
  if (REVIEWER_ROUTES.some(([mm, pp]) => mm.test(m) && pp.test(p))) return 'reviewer'
  return 'ops'
}

export function authHeader(method: string, path: string, role?: SmokeRole): Record<string, string> {
  const r = role ?? roleFor(method, path)
  const token = tokens[r]
  if (!token) throw new Error('冒烟脚本尚未登录：请先调用 initSmokeAuth(BASE)')
  return { Authorization: `Bearer ${token}` }
}

/** 账号名（断言「操作人」时用） */
export const SMOKE_USERS: Record<SmokeRole, string> = { ops: 'smoke_ops', reviewer: 'smoke_reviewer', admin: ADMIN_USER }
