import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../../db/index.js'
import { newId } from '../../lib/util.js'
import { toDb, utcNow, fromDb } from '../../lib/time.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { config, paths } from '../../config.js'
import { isOssEnabled, putObjectFromFile, signedUrl } from '../../integrations/aliyun-oss/client.js'
import { recordOperation } from '../audit/repo.js'
import { resolvePublishEngine } from './engine.js'
import { confirmLogin, markChecked, markLoginExpired, requireAccount, setLoginStatus } from './accounts.js'
import type { PlatformAccount, PublishLoginSession } from './types.js'

/**
 * 扫码登录会话（FR-L1~L2）。
 * 轮询由 publish-login-sweep 驱动（15 秒节奏，扫码确认不能等 60 秒业务 sweep）：
 *   sweep 扫 next_poll_at 到期的会话 → publish-login 队列 → pollLoginSession。
 * 进程重启后 sweep 会重新捞起未终态会话（复用人物库「扫描补投」模式）。
 */

function mapRow(r: Record<string, any>): PublishLoginSession {
  return {
    id: r.id,
    accountId: r.account_id,
    status: r.status,
    qrObjectKey: r.qr_object_key ?? null,
    nextPollAt: fromDb(r.next_poll_at),
    pollAttempts: r.poll_attempts,
    expiresAt: fromDb(r.expires_at),
    error: r.error ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}

async function getLatestSession(accountId: string): Promise<PublishLoginSession | null> {
  const row = await getDb().get<Record<string, any>>(
    'SELECT * FROM `publish_login_session` WHERE `account_id` = ? ORDER BY `created_at` DESC LIMIT 1',
    [accountId],
  )
  return row ? mapRow(row) : null
}

/** 二维码交付：OSS 启用走签名 URL；否则 base64 data URL 直接内联（mock / 本地联调） */
async function deliverQr(accountId: string, qrPng: Buffer): Promise<{ qrUrl: string | null; qrDataUrl: string | null; objectKey: string | null }> {
  if (isOssEnabled()) {
    const objectKey = `publish-qr/${accountId}/${Date.now()}.png`
    const tmp = path.join(paths.tempDir, `qr_${accountId}_${Date.now()}.png`)
    await fsp.mkdir(path.dirname(tmp), { recursive: true })
    await fsp.writeFile(tmp, qrPng)
    try {
      await putObjectFromFile(tmp, objectKey, '')
    } finally {
      await fsp.unlink(tmp).catch(() => undefined)
    }
    return { qrUrl: await signedUrl(objectKey, 3600), qrDataUrl: null, objectKey }
  }
  return { qrUrl: null, qrDataUrl: `data:image/png;base64,${qrPng.toString('base64')}`, objectKey: null }
}

export interface StartLoginResult {
  session: PublishLoginSession
  qrUrl: string | null
  qrDataUrl: string | null
}

/** 发起（或重发）扫码登录：作废旧会话 → 引擎截二维码 → 建新会话并排首轮轮询 */
export async function startLoginSession(accountId: string, operator: string): Promise<StartLoginResult> {
  const account = await requireAccount(accountId)
  if (account.loginStatus === 'disabled') throw err.invalidState('账号已停用，请先启用再登录')
  const db = getDb()
  const now = toDb(utcNow())

  // 作废该账号未终态的旧会话（一人一会话）
  await db.run(
    "UPDATE `publish_login_session` SET `status` = 'expired', `updated_at` = ? WHERE `account_id` = ? AND `status` IN ('waiting_scan','scanned')",
    [now, accountId],
  )

  const engine = resolvePublishEngine()
  const start = await engine.startLogin(account)
  if (!start.qrPng) {
    const session = await insertSession(accountId, null, now)
    await db.run(
      "UPDATE `publish_login_session` SET `status` = 'failed', `error` = ?, `updated_at` = ? WHERE `id` = ?",
      [start.error ?? '获取二维码失败', now, session.id],
    )
    await setLoginStatus(accountId, 'failed')
    throw err.loginQrFailed(start.error ?? '获取登录二维码失败')
  }

  const delivered = await deliverQr(accountId, start.qrPng)
  const session = await insertSession(accountId, delivered.objectKey, now)
  await setLoginStatus(accountId, 'pending_login')
  await recordOperation({
    operator,
    action: 'publish.account.login_start',
    targetType: 'platform_account',
    targetId: accountId,
    detail: { sessionId: session.id, mock: engine.mock },
  })
  return { session: { ...session, qrObjectKey: delivered.objectKey }, qrUrl: delivered.qrUrl, qrDataUrl: delivered.qrDataUrl }
}

async function insertSession(accountId: string, objectKey: string | null, now: string): Promise<PublishLoginSession> {
  const db = getDb()
  const id = newId('plogin')
  const expires = toDb(new Date(Date.now() + config.publish.loginSessionTimeoutMs))
  const nextPoll = toDb(new Date(Date.now() + config.publish.loginPollIntervalMs))
  await db.run(
    'INSERT INTO `publish_login_session` (`id`, `account_id`, `status`, `qr_object_key`, `next_poll_at`, `poll_attempts`, `expires_at`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
    [id, accountId, 'waiting_scan', objectKey, nextPoll, expires, now, now],
  )
  const row = await db.get<Record<string, any>>('SELECT * FROM `publish_login_session` WHERE `id` = ?', [id])
  return mapRow(row!)
}

/** 单次轮询（publish-login 队列 worker 调用）：confirmed → 回填账号；waiting → 排下次 */
export async function pollLoginSession(sessionId: string): Promise<void> {
  const db = getDb()
  const row = await db.get<Record<string, any>>('SELECT * FROM `publish_login_session` WHERE `id` = ?', [sessionId])
  if (!row) return
  const session = mapRow(row)
  if (!['waiting_scan', 'scanned'].includes(session.status)) return

  const now = Date.now()
  if (session.expiresAt && new Date(session.expiresAt).getTime() < now) {
    await db.run("UPDATE `publish_login_session` SET `status` = 'expired', `updated_at` = ? WHERE `id` = ?", [
      toDb(utcNow()),
      sessionId,
    ])
    await setLoginStatus(session.accountId, 'failed').catch(() => undefined)
    logger.warn({ sessionId, accountId: session.accountId }, 'publish.login.session_expired')
    return
  }

  const account = await requireAccount(session.accountId)
  const engine = resolvePublishEngine()
  const result = await engine.pollLogin(account).catch((e) => ({ status: 'failed' as const, error: (e as Error).message }))
  const nowDb = toDb(utcNow())

  if (result.status === 'confirmed') {
    await db.run("UPDATE `publish_login_session` SET `status` = 'confirmed', `updated_at` = ? WHERE `id` = ?", [nowDb, sessionId])
    await confirmLogin(session.accountId, { nickname: result.nickname, uid: result.uid })
    logger.info({ sessionId, accountId: session.accountId }, 'publish.login.confirmed')
    return
  }

  if (result.status === 'failed') {
    await db.run("UPDATE `publish_login_session` SET `status` = 'failed', `error` = ?, `updated_at` = ? WHERE `id` = ?", [
      result.error ?? '登录失败',
      nowDb,
      sessionId,
    ])
    await setLoginStatus(session.accountId, 'failed')
    return
  }

  // waiting / scanned：推进轮询（next_poll_at + sweep 模式，重启续跑）
  await db.run(
    'UPDATE `publish_login_session` SET `status` = ?, `poll_attempts` = `poll_attempts` + 1, `next_poll_at` = ?, `updated_at` = ? WHERE `id` = ?',
    [result.status === 'scanned' ? 'scanned' : 'waiting_scan', toDb(new Date(now + config.publish.loginPollIntervalMs)), nowDb, sessionId],
  )
}

/** 手动检测登录态（FR-L3）：导航到平台发布页判断；失效 → expired */
export async function checkLoginNow(accountId: string, operator: string): Promise<{ loggedIn: boolean; nickname: string | null }> {
  const account = await requireAccount(accountId)
  if (account.loginStatus === 'disabled') throw err.invalidState('账号已停用')
  const engine = resolvePublishEngine()
  const result = await engine.checkLogin(account)
  await markChecked(accountId)
  if (!result.loggedIn) {
    await markLoginExpired(accountId, '手动检测：登录态失效')
    return { loggedIn: false, nickname: null }
  }
  // 检测到有效但账号仍标 expired（如检测先于轮询完成）→ 恢复 active
  if (account.loginStatus === 'expired') {
    await confirmLogin(accountId, { nickname: result.nickname, uid: result.uid ?? account.uid ?? undefined })
  }
  await recordOperation({ operator, action: 'publish.account.check', targetType: 'platform_account', targetId: accountId, detail: { loggedIn: true } })
  return { loggedIn: true, nickname: result.nickname ?? account.displayName }
}

/** publish-login-sweep：捞起 next_poll_at 到期的未终态会话投递轮询（返回会话 id 列表） */
export async function sweepDueSessions(): Promise<string[]> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    "SELECT `id` FROM `publish_login_session` WHERE `status` IN ('waiting_scan','scanned') AND `next_poll_at` <= ? ORDER BY `next_poll_at` ASC LIMIT 50",
    [toDb(utcNow())],
  )
  return rows.map((r) => String(r.id))
}

/** 会话到期批扫（业务 sweep 兜底）：超时会话转 expired + 账号 failed */
export async function expireStaleSessions(): Promise<number> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    "SELECT `id`, `account_id` FROM `publish_login_session` WHERE `status` IN ('waiting_scan','scanned') AND `expires_at` <= ?",
    [toDb(utcNow())],
  )
  for (const r of rows) {
    await db.run("UPDATE `publish_login_session` SET `status` = 'expired', `updated_at` = ? WHERE `id` = ?", [toDb(utcNow()), String(r.id)])
    await setLoginStatus(String(r.account_id), 'failed').catch(() => undefined)
  }
  return rows.length
}

/** 供矩阵接口使用：账号当前是否有活跃会话（前端提示「登录中」） */
export async function hasActiveSession(accountId: string): Promise<boolean> {
  const row = await getDb().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM `publish_login_session` WHERE `account_id` = ? AND `status` IN ('waiting_scan','scanned')",
    [accountId],
  )
  return Number(row?.n ?? 0) > 0
}

/** 登录会话展示视图：最近一次会话 + 二维码地址。data URL 不持久化（会话还在 waiting 时前端须重新发起取新码） */
export async function latestSessionView(accountId: string): Promise<{
  session: PublishLoginSession | null
  qrUrl: string | null
  qrDataUrl: string | null
}> {
  const session = await getLatestSession(accountId)
  if (!session) return { session: null, qrUrl: null, qrDataUrl: null }
  if (session.qrObjectKey) {
    return { session, qrUrl: await signedUrl(session.qrObjectKey, 3600).catch(() => null), qrDataUrl: null }
  }
  return { session, qrUrl: null, qrDataUrl: null }
}

/** 保留引用（PlatformAccount 用于类型导出一致性检查） */
export type { PlatformAccount }
