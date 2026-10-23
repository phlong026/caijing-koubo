import fs from 'node:fs'
import path from 'node:path'
import { getDb, isDuplicateKey } from '../../db/index.js'
import { newId, parsePaging, pageResult, type PageResult } from '../../lib/util.js'
import { toDb, utcNow, fromDb } from '../../lib/time.js'
import { err } from '../../errors.js'
import { recordOperation } from '../audit/repo.js'
import { paths } from '../../config.js'
import { isPlatformAllowed, PLATFORM_LINE_MATRIX } from './matrix.js'
import { PLATFORM_LABELS } from '../personas/types.js'
import type { AccountLoginStatus, PersonaLine, Platform, PlatformAccount } from './types.js'
import { PUBLISH_PLATFORMS } from './types.js'

/**
 * 平台账号（FR-A1~A5，PB1 矩阵 / PB3 凭证目录 / PB13 共享池）。
 * 状态机（§3.1）：pending_login → active ⇄ expired；failed → 重新发起登录；
 * disabled 由启停控制；删除 = 软删（admin，无引用时）。
 */

function mapRow(r: Record<string, any>): PlatformAccount {
  return {
    id: r.id,
    platform: r.platform,
    line: r.line,
    displayName: r.display_name,
    uid: r.uid ?? null,
    avatarUrl: r.avatar_url ?? null,
    loginStatus: r.login_status,
    lastCheckedAt: fromDb(r.last_checked_at),
    loginExpiresAt: fromDb(r.login_expires_at),
    ownerId: r.owner_id ?? null,
    dataDir: r.data_dir ?? null,
    enabled: !!r.enabled,
    remark: r.remark ?? null,
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}

/** 持久化浏览器上下文目录（PB3：每账号一目录，登录态留存目录内不入库） */
function accountDataDir(platform: Platform, accountId: string): string {
  return path.join(paths.browserData, 'publish', `${platform}_${accountId}`)
}

export async function getAccount(id: string): Promise<PlatformAccount | null> {
  const row = await getDb().get<Record<string, any>>(
    'SELECT * FROM `platform_account` WHERE `id` = ? AND `deleted_at` IS NULL',
    [id],
  )
  return row ? mapRow(row) : null
}

export async function requireAccount(id: string): Promise<PlatformAccount> {
  const a = await getAccount(id)
  if (!a) throw err.accountNotFound()
  return a
}

export interface ListAccountFilters {
  platform?: string
  line?: string
  loginStatus?: string
  enabled?: string
  page?: number
  pageSize?: number
}

export async function listAccounts(f: ListAccountFilters): Promise<PageResult<PlatformAccount & { bindingCount: number }>> {
  const db = getDb()
  const where: string[] = ['`a`.`deleted_at` IS NULL']
  const params: unknown[] = []
  if (f.platform && PUBLISH_PLATFORMS.includes(f.platform as Platform)) {
    where.push('`a`.`platform` = ?')
    params.push(f.platform)
  }
  if (f.line) {
    where.push('`a`.`line` = ?')
    params.push(f.line)
  }
  if (f.loginStatus) {
    where.push('`a`.`login_status` = ?')
    params.push(f.loginStatus)
  }
  if (f.enabled === '1' || f.enabled === 'true') where.push('`a`.`enabled` = 1')
  if (f.enabled === '0' || f.enabled === 'false') where.push('`a`.`enabled` = 0')
  const whereSql = `WHERE ${where.join(' AND ')}`
  const p = parsePaging({ page: f.page, pageSize: f.pageSize }, 50, 100)
  const total = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM \`platform_account\` \`a\` ${whereSql}`,
    params,
  )
  const rows = await db.all<Record<string, any>>(
    `SELECT \`a\`.*, (SELECT COUNT(*) FROM \`persona_account_binding\` \`b\`
      WHERE \`b\`.\`platform_account_id\` = \`a\`.\`id\` AND \`b\`.\`released_at\` IS NULL) AS \`binding_count\`
     FROM \`platform_account\` \`a\` ${whereSql} ORDER BY \`a\`.\`created_at\` DESC LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  )
  return pageResult(
    rows.map((r) => ({ ...mapRow(r), bindingCount: Number(r.binding_count ?? 0) })),
    Number(total?.n ?? 0),
    p,
  )
}

export interface CreateAccountInput {
  platform: Platform
  line: PersonaLine
  displayName: string
  remark?: string
}

export async function createAccount(input: CreateAccountInput, operator: string): Promise<PlatformAccount> {
  if (!PUBLISH_PLATFORMS.includes(input.platform)) {
    throw err.badRequest(`不支持的平台：${input.platform}`, { allowed: PUBLISH_PLATFORMS })
  }
  const displayName = String(input.displayName ?? '').trim()
  if (!displayName) throw err.badRequest('账号显示名不能为空')
  if (displayName.length > 60) throw err.badRequest('显示名不能超过 60 字')
  if (!isPlatformAllowed(input.line, input.platform)) {
    throw err.platformLineForbidden(
      `${input.line === 'manager' ? '经理 IP' : input.line === 'kos' ? '员工 KOS' : '素人矩阵'}不可发布到${PLATFORM_LABELS[input.platform]}`,
      { line: input.line, platform: input.platform, matrix: PLATFORM_LINE_MATRIX },
    )
  }
  const db = getDb()
  const id = newId('pacct')
  const now = toDb(utcNow())
  const dataDir = accountDataDir(input.platform, id)
  try {
    await db.run(
      'INSERT INTO `platform_account` (`id`, `platform`, `line`, `display_name`, `login_status`, `owner_id`, `data_dir`, `enabled`, `remark`, `created_by`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
      [id, input.platform, input.line, displayName, 'pending_login', operator, dataDir, input.remark ?? null, operator, now, now],
    )
  } catch (e) {
    if (isDuplicateKey(e)) throw err.conflict('同名账号已存在')
    throw e
  }
  await recordOperation({ operator, action: 'publish.account.create', targetType: 'platform_account', targetId: id, detail: { platform: input.platform, line: input.line } })
  const account = await requireAccount(id)
  // 创建即发起登录（FR-A1）：登录会话由调用方（路由层）创建，保证 OSS/引擎异常能回 5xx
  return account
}

export async function patchAccount(
  id: string,
  body: { enabled?: boolean; remark?: string },
  operator: string,
): Promise<PlatformAccount> {
  const account = await requireAccount(id)
  const db = getDb()
  const sets: string[] = ['`updated_at` = ?']
  const params: unknown[] = [toDb(utcNow())]
  let paused = false
  if (body.enabled !== undefined) {
    const enabled = body.enabled === true
    sets.push('`enabled` = ?')
    params.push(enabled ? 1 : 0)
    if (!enabled && account.loginStatus !== 'disabled') {
      // 停用即冻结登录态入口（§3.1：disabled 须先启用才可重新登录）
      sets.push('`login_status` = ?')
      params.push('disabled')
      paused = true
    }
    if (enabled && account.loginStatus === 'disabled') {
      sets.push('`login_status` = ?')
      params.push('expired') // 启用后须重新检测/登录
    }
  }
  if (body.remark !== undefined) {
    sets.push('`remark` = ?')
    params.push(String(body.remark ?? '').slice(0, 255) || null)
  }
  await db.run(`UPDATE \`platform_account\` SET ${sets.join(', ')} WHERE \`id\` = ?`, [...params, id])
  await recordOperation({
    operator,
    action: paused ? 'publish.account.pause' : 'publish.account.update',
    targetType: 'platform_account',
    targetId: id,
    detail: body,
  })
  return requireAccount(id)
}

/** FR-A4：软删（admin）；有进行中发布或被人物绑定引用时 409 */
export async function deleteAccount(id: string, operator: string): Promise<void> {
  await requireAccount(id)
  const db = getDb()
  const activeLog = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM `publish_log` WHERE `account_id` = ? AND `status` IN ('scheduled','uploading','confirming','verification_required')",
    [id],
  )
  if (Number(activeLog?.n ?? 0) > 0) throw err.accountInUse('账号有进行中的发布记录，无法删除')
  const binding = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM `persona_account_binding` WHERE `platform_account_id` = ? AND `released_at` IS NULL',
    [id],
  )
  if (Number(binding?.n ?? 0) > 0) throw err.accountInUse('账号仍被人物绑定引用，请先解除绑定')
  await db.run('UPDATE `platform_account` SET `deleted_at` = ?, `updated_at` = ? WHERE `id` = ?', [
    toDb(utcNow()),
    toDb(utcNow()),
    id,
  ])
  await recordOperation({ operator, action: 'publish.account.remove', targetType: 'platform_account', targetId: id })
}

/** 登录确认回执（FR-L2）：回填昵称 / uid → active；uid 撞唯一约束时给可读错误 */
export async function confirmLogin(
  id: string,
  info: { nickname?: string; uid?: string },
): Promise<PlatformAccount> {
  const db = getDb()
  const account = await requireAccount(id)
  const now = toDb(utcNow())
  const uid = info.uid ?? `unknown_${id.slice(-8)}`
  try {
    await db.run(
      'UPDATE `platform_account` SET `login_status` = ?, `uid` = ?, `display_name` = COALESCE(NULLIF(?, \'\'), `display_name`), `updated_at` = ? WHERE `id` = ?',
      ['active', uid, String(info.nickname ?? '').slice(0, 60), now, id],
    )
  } catch (e) {
    if (isDuplicateKey(e)) {
      throw err.conflict('该平台账号（uid）已被另一条账号记录占用，请删除旧记录后重试', { platform: account.platform, uid })
    }
    throw e
  }
  await recordOperation({
    operator: 'system',
    action: 'publish.account.login_confirmed',
    targetType: 'platform_account',
    targetId: id,
    detail: { uid, nickname: info.nickname ?? null },
  })
  return requireAccount(id)
}

/** 登录态失效（FR-L3：检测未登录）→ expired */
export async function markLoginExpired(id: string, reason: string): Promise<void> {
  const db = getDb()
  await db.run(
    'UPDATE `platform_account` SET `login_status` = ?, `last_checked_at` = ?, `updated_at` = ? WHERE `id` = ? AND `deleted_at` IS NULL',
    ['expired', toDb(utcNow()), toDb(utcNow()), id],
  )
  await recordOperation({ operator: 'system', action: 'publish.account.expired', targetType: 'platform_account', targetId: id, detail: { reason } })
}

export async function markChecked(id: string): Promise<void> {
  await getDb().run('UPDATE `platform_account` SET `last_checked_at` = ?, `updated_at` = ? WHERE `id` = ?', [
    toDb(utcNow()),
    toDb(utcNow()),
    id,
  ])
}

/** PB8 口径：某账号今日已发布（published）条数（自动发布；UTC 日近似，每日上限为软约束） */
export async function publishedTodayOf(accountId: string): Promise<number> {
  const since = toDb(new Date(Math.floor(Date.now() / 86400000) * 86400000))
  const row = await getDb().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM `publish_log` WHERE `account_id` = ? AND `status` = 'published' AND `finished_at` >= ? AND `source` = 'auto'",
    [accountId, since],
  )
  return Number(row?.n ?? 0)
}

/** 状态流转（FR-A5 / AC-L）：登录会话失败落 failed；重新发起登录回 pending_login */
export async function setLoginStatus(id: string, status: AccountLoginStatus): Promise<void> {
  await getDb().run('UPDATE `platform_account` SET `login_status` = ?, `updated_at` = ? WHERE `id` = ?', [
    status,
    toDb(utcNow()),
    id,
  ])
}

/** 确保持久化目录存在（PB3）：创建账号与首次登录时调用 */
export async function ensureDataDir(account: PlatformAccount): Promise<string> {
  const dir = account.dataDir ?? accountDataDir(account.platform, account.id)
  await fs.promises.mkdir(dir, { recursive: true }).catch(() => undefined)
  return dir
}
