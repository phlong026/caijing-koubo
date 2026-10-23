import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ok } from '../../app.js'
import { config } from '../../config.js'
import { err } from '../../errors.js'
import { recordOperation } from '../audit/repo.js'
import { invalidateUserCache } from './guard.js'
import {
  createUser,
  getUserById,
  getUserForLogin,
  listUsers,
  ROLE_LABELS,
  touchLogin,
  updateUser,
  type AppUser,
} from './repo.js'
import { signToken, verifyPassword } from './tokens.js'

/** 登录失败节流：同一「账号 + IP」连续失败后锁定一段时间，防止口令爆破 */
const failures = new Map<string, { count: number; lockedUntil: number }>()

function throttleKey(req: FastifyRequest, username: string): string {
  return `${username.toLowerCase()}|${req.ip}`
}

function publicUser(u: AppUser) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role],
    enabled: u.enabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  }
}

function setTokenCookie(reply: FastifyReply, token: string, maxAgeSec: number): void {
  const secure = config.env === 'production' ? '; Secure' : ''
  reply.header(
    'Set-Cookie',
    `${config.auth.cookieName}=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`,
  )
}

function requireUser(req: FastifyRequest): AppUser {
  if (!req.user) throw err.unauthorized()
  return req.user
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string }
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    if (!username || !password) throw err.badRequest('请输入账号和密码')

    const key = throttleKey(req, username)
    const state = failures.get(key)
    if (state && state.lockedUntil > Date.now()) {
      const minutes = Math.ceil((state.lockedUntil - Date.now()) / 60_000)
      throw err.forbidden(`登录失败次数过多，请 ${minutes} 分钟后再试`)
    }

    const user = await getUserForLogin(username)
    if (!user || !user.enabled || !verifyPassword(password, user.passwordHash)) {
      const count = (state?.count ?? 0) + 1
      const locked = count >= config.auth.maxLoginFailures
      failures.set(key, { count: locked ? 0 : count, lockedUntil: locked ? Date.now() + config.auth.lockMinutes * 60_000 : 0 })
      await recordOperation({ operator: username, action: 'auth.login_failed', targetType: 'user', targetId: user?.id, detail: { ip: req.ip } })
      throw err.unauthorized(user && !user.enabled ? '账号已停用' : '账号或密码不正确')
    }
    failures.delete(key)
    await touchLogin(user.id)
    const { token, expiresAt } = signToken({ sub: user.id, u: user.username, r: user.role, tv: user.tokenVersion })
    setTokenCookie(reply, token, Math.floor((expiresAt - Date.now()) / 1000))
    await recordOperation({ operator: user.username, action: 'auth.login', targetType: 'user', targetId: user.id, detail: { ip: req.ip } })
    return ok({ token, expiresAt: new Date(expiresAt).toISOString(), user: publicUser(user) })
  })

  app.post('/auth/logout', async (_req, reply) => {
    setTokenCookie(reply, '', 0)
    return ok({ ok: true })
  })

  app.get('/auth/me', async (req) => ok(publicUser(requireUser(req))))

  /** 修改自己的密码：需校验原密码；成功后旧令牌全部失效，返回新令牌 */
  app.post('/auth/password', async (req, reply) => {
    const me = requireUser(req)
    const body = (req.body ?? {}) as { oldPassword?: string; newPassword?: string }
    const full = await getUserForLogin(me.username)
    if (!full || !verifyPassword(String(body.oldPassword ?? ''), full.passwordHash)) {
      throw err.badRequest('原密码不正确')
    }
    const updated = await updateUser(me.id, { password: body.newPassword }, me)
    invalidateUserCache(me.id)
    await recordOperation({ operator: me.username, action: 'auth.password_change', targetType: 'user', targetId: me.id })
    const { token, expiresAt } = signToken({ sub: updated.id, u: updated.username, r: updated.role, tv: updated.tokenVersion })
    setTokenCookie(reply, token, Math.floor((expiresAt - Date.now()) / 1000))
    return ok({ token, expiresAt: new Date(expiresAt).toISOString(), user: publicUser(updated) })
  })

  /* ── 账号管理（仅管理员，见 guard.ROLE_RULES）──────────────────── */

  app.get('/users', async () => ok({ items: (await listUsers()).map(publicUser), roleLabels: ROLE_LABELS }))

  app.post('/users', async (req) => {
    const body = (req.body ?? {}) as { username?: string; displayName?: string; role?: string; password?: string }
    const user = await createUser({
      username: body.username,
      displayName: body.displayName,
      role: body.role,
      password: body.password,
      operator: req.operator,
    })
    await recordOperation({
      operator: req.operator,
      action: 'user.create',
      targetType: 'user',
      targetId: user.id,
      detail: { username: user.username, role: user.role },
    })
    return ok(publicUser(user))
  })

  app.patch('/users/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { displayName?: string; role?: string; enabled?: boolean; password?: string }
    const before = await getUserById(id)
    const user = await updateUser(id, body, requireUser(req))
    invalidateUserCache(id)
    await recordOperation({
      operator: req.operator,
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      detail: {
        fields: Object.keys(body).filter((k) => k !== 'password'),
        passwordReset: body.password !== undefined,
        role: before?.role === user.role ? undefined : { from: before?.role, to: user.role },
        enabled: before?.enabled === user.enabled ? undefined : user.enabled,
      },
    })
    return ok(publicUser(user))
  })
}
