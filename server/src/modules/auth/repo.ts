import { getDb, isDuplicateKey } from '../../db/index.js'
import { newId } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { config } from '../../config.js'
import { logger } from '../../log.js'
import { hashPassword, passwordProblem, type Role } from './tokens.js'

export const ROLES: Role[] = ['ops', 'reviewer', 'admin']
export const ROLE_LABELS: Record<Role, string> = { ops: '运营', reviewer: '审核', admin: '管理员' }

export interface AppUser {
  id: string
  username: string
  displayName: string
  role: Role
  enabled: boolean
  tokenVersion: number
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
  lastLoginAt: string | null
}

export function mapUser(r: Record<string, any>): AppUser {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    enabled: !!Number(r.enabled),
    tokenVersion: Number(r.token_version ?? 0),
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
    lastLoginAt: fromDb(r.last_login_at),
  }
}

export async function getUserById(id: string): Promise<AppUser | null> {
  const r = await getDb().get<Record<string, any>>('SELECT * FROM `app_user` WHERE `id` = ?', [id])
  return r ? mapUser(r) : null
}

/** 登录用：连同口令哈希一起取 */
export async function getUserForLogin(username: string): Promise<(AppUser & { passwordHash: string }) | null> {
  const r = await getDb().get<Record<string, any>>('SELECT * FROM `app_user` WHERE `username` = ?', [username])
  return r ? { ...mapUser(r), passwordHash: r.password_hash } : null
}

export async function listUsers(): Promise<AppUser[]> {
  const rows = await getDb().all<Record<string, any>>('SELECT * FROM `app_user` ORDER BY `created_at` ASC')
  return rows.map(mapUser)
}

function normalizeUsername(raw: unknown): string {
  const username = String(raw ?? '').trim()
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw err.badRequest('账号需为 3–32 位字母、数字、下划线、点或短横线')
  }
  return username
}

function normalizeRole(raw: unknown): Role {
  const role = String(raw ?? '') as Role
  if (!ROLES.includes(role)) throw err.badRequest('角色仅支持 ops / reviewer / admin', { allowed: ROLES })
  return role
}

export async function createUser(input: {
  username: unknown
  displayName?: unknown
  role: unknown
  password: unknown
  operator: string
}): Promise<AppUser> {
  const username = normalizeUsername(input.username)
  const role = normalizeRole(input.role)
  const password = String(input.password ?? '')
  const problem = passwordProblem(password)
  if (problem) throw err.badRequest(problem)
  const displayName = String(input.displayName ?? '').trim().slice(0, 64) || username
  const id = newId('usr')
  const now = toDb(utcNow())
  try {
    await getDb().run(
      `INSERT INTO \`app_user\` (\`id\`, \`username\`, \`display_name\`, \`password_hash\`, \`role\`, \`enabled\`, \`token_version\`, \`created_by\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      [id, username, displayName, hashPassword(password), role, input.operator, now, now],
    )
  } catch (e) {
    if (isDuplicateKey(e)) throw err.conflict('账号已存在', { username })
    throw e
  }
  return (await getUserById(id))!
}

async function countEnabledAdmins(): Promise<number> {
  const r = await getDb().get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM `app_user` WHERE `role` = 'admin' AND `enabled` = 1",
  )
  return Number(r?.c ?? 0)
}

export async function updateUser(
  id: string,
  patch: { displayName?: unknown; role?: unknown; enabled?: unknown; password?: unknown },
  actor: AppUser,
): Promise<AppUser> {
  const user = await getUserById(id)
  if (!user) throw err.notFound('账号不存在')
  const sets: string[] = []
  const params: unknown[] = []
  let bumpToken = false

  if (patch.displayName !== undefined) {
    const v = String(patch.displayName).trim().slice(0, 64)
    if (!v) throw err.badRequest('显示名不能为空')
    sets.push('`display_name` = ?')
    params.push(v)
  }
  const nextRole = patch.role !== undefined ? normalizeRole(patch.role) : user.role
  const nextEnabled = patch.enabled !== undefined ? !!patch.enabled : user.enabled
  // 不能让系统失去最后一个可用管理员（含管理员给自己降级 / 停用）
  if (user.role === 'admin' && user.enabled && (nextRole !== 'admin' || !nextEnabled)) {
    if ((await countEnabledAdmins()) <= 1) throw err.invalidState('至少保留一个启用的管理员')
  }
  if (id === actor.id && !nextEnabled) throw err.invalidState('不能停用自己的账号')
  if (nextRole !== user.role) {
    sets.push('`role` = ?')
    params.push(nextRole)
    bumpToken = true
  }
  if (nextEnabled !== user.enabled) {
    sets.push('`enabled` = ?')
    params.push(nextEnabled ? 1 : 0)
    bumpToken = true
  }
  if (patch.password !== undefined) {
    const password = String(patch.password)
    const problem = passwordProblem(password)
    if (problem) throw err.badRequest(problem)
    sets.push('`password_hash` = ?')
    params.push(hashPassword(password))
    bumpToken = true
  }
  if (!sets.length) return user
  if (bumpToken) sets.push('`token_version` = `token_version` + 1')
  sets.push('`updated_at` = ?')
  params.push(toDb(utcNow()), id)
  await getDb().run(`UPDATE \`app_user\` SET ${sets.join(', ')} WHERE \`id\` = ?`, params)
  return (await getUserById(id))!
}

export async function touchLogin(id: string): Promise<void> {
  await getDb().run('UPDATE `app_user` SET `last_login_at` = ? WHERE `id` = ?', [toDb(utcNow()), id])
}

/**
 * 首个管理员（库内没有任何账号时）。
 * 生产必须给出 AUTH_BOOTSTRAP_ADMIN_PASSWORD；开发环境缺省 admin / admin123 并打告警。
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const r = await getDb().get<{ c: number }>('SELECT COUNT(*) AS c FROM `app_user`')
  if (Number(r?.c ?? 0) > 0) return
  let password = config.auth.bootstrapAdminPassword
  if (!password) {
    if (config.env === 'production') {
      logger.error(
        'auth.no_users：库内没有任何账号，且未配置 AUTH_BOOTSTRAP_ADMIN_PASSWORD，当前无人可以登录。' +
          '请配置后重启以创建首个管理员。',
      )
      return
    }
    password = 'admin123'
    logger.warn(
      { username: config.auth.bootstrapAdminUser },
      'auth.bootstrap_admin_default：开发环境已创建默认管理员（密码 admin123），请登录后尽快修改',
    )
  }
  await createUser({
    username: config.auth.bootstrapAdminUser,
    displayName: '管理员',
    role: 'admin',
    password,
    operator: 'system',
  })
  logger.info({ username: config.auth.bootstrapAdminUser }, 'auth.bootstrap_admin_created')
}
