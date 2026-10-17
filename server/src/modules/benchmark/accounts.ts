import { getDb, type Db } from '../../db/index.js'
import { config } from '../../config.js'
import { newId } from '../../lib/util.js'
import { addDays, addHours, fromDb, jitter, toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { fetchUserInfo, isMockMode } from '../../integrations/tikhub/client.js'
import { parseUserOrVideoLink } from './link.js'
import { recordOperation } from '../audit/repo.js'
import { logger } from '../../log.js'

export interface AccountRow {
  id: string
  platform: string
  platformUid: string
  secUid: string | null
  nickname: string | null
  fansCount: number
  sourceUrl: string | null
  monitorStatus: 'on' | 'paused'
  monitorIntervalHours: number
  nextCheckAt: string | null
  lastCheckedAt: string | null
  consecutiveFailures: number
  lastError: string | null
  abnormalAt: string | null
  userInfoRefreshedAt: string | null
  removedAt: string | null
  addedBy: string | null
  createdAt: string | null
}

function mapAccount(r: Record<string, any>): AccountRow {
  return {
    id: r.id,
    platform: r.platform,
    platformUid: r.platform_uid,
    secUid: r.sec_uid ?? null,
    nickname: r.nickname ?? null,
    fansCount: Number(r.fans_count ?? 0),
    sourceUrl: r.source_url ?? null,
    monitorStatus: r.monitor_status,
    monitorIntervalHours: Number(r.monitor_interval_hours ?? 24),
    nextCheckAt: fromDb(r.next_check_at),
    lastCheckedAt: fromDb(r.last_checked_at),
    consecutiveFailures: Number(r.consecutive_failures ?? 0),
    lastError: r.last_error ?? null,
    abnormalAt: fromDb(r.abnormal_at),
    userInfoRefreshedAt: fromDb(r.user_info_refreshed_at),
    removedAt: fromDb(r.removed_at),
    addedBy: r.added_by ?? null,
    createdAt: fromDb(r.created_at),
  }
}

export async function getAccount(id: string): Promise<AccountRow | null> {
  const db = getDb()
  const r = await db.get<Record<string, any>>('SELECT * FROM `benchmark_account` WHERE `id` = ?', [id])
  return r ? mapAccount(r) : null
}

/** 含软删记录：用于重复添加即"恢复"（P2-2） */
export async function findAccountBySecUid(secUid: string): Promise<AccountRow | null> {
  const db = getDb()
  const r = await db.get<Record<string, any>>('SELECT * FROM `benchmark_account` WHERE `sec_uid` = ?', [secUid])
  return r ? mapAccount(r) : null
}

export async function listAccounts(includeRemoved = false): Promise<AccountRow[]> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`benchmark_account\` ${includeRemoved ? '' : 'WHERE `removed_at` IS NULL'} ORDER BY \`created_at\` DESC`,
  )
  return rows.map(mapAccount)
}

/** FR-B1 解析预览：白名单校验 → sec_uid → TikHub 用户信息 */
export async function previewAccount(rawUrl: string): Promise<{
  secUid: string
  nickname: string | null
  fansCount: number
  exists: boolean
  existingId: string | null
  mock: boolean
  finalUrl: string
}> {
  const parsed = await parseUserOrVideoLink(rawUrl)
  if (!parsed.secUid) {
    throw err.badRequest('未能从链接中解析出主页地址，请粘贴抖音主页链接或分享链接')
  }
  const user = await fetchUserInfo(parsed.secUid)
  const existing = await findAccountBySecUid(parsed.secUid)
  return {
    secUid: parsed.secUid,
    nickname: user.nickname || null,
    fansCount: user.fansCount,
    exists: !!existing && !existing.removedAt,
    existingId: existing?.id ?? null,
    mock: isMockMode(),
    finalUrl: parsed.finalUrl,
  }
}

export function normalizeInterval(v: unknown): number {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n < 1) throw err.badRequest('监控周期至少为 1 小时')
  return Math.min(720, n)
}

export function computeNextCheck(intervalHours: number, from: Date = utcNow()): Date {
  return addHours(from, intervalHours)
}

export interface AddAccountInput {
  url: string
  intervalHours?: number
  operator?: string
  /** 解析预览已确认过的 secUid，避免重复解析 */
  knownSecUid?: string
}

/** FR-B1 添加账号：解析 → 回填信息 → 入库（周期可配） */
export async function addAccount(input: AddAccountInput): Promise<{ account: AccountRow; restored: boolean }> {
  const db = getDb()
  const parsed = input.knownSecUid
    ? { secUid: input.knownSecUid, finalUrl: input.url }
    : await parseUserOrVideoLink(input.url)
  if (!parsed.secUid) throw err.badRequest('未能解析出主页 sec_uid')

  const intervalHours = normalizeInterval(input.intervalHours ?? 24)
  const existing = await findAccountBySecUid(parsed.secUid)

  if (existing && !existing.removedAt) {
    throw err.conflict('该账号已在监控列表中，可直接修改监控周期', { id: existing.id })
  }

  const user = await fetchUserInfo(parsed.secUid)
  const now = utcNow()

  if (existing && existing.removedAt) {
    // P2-2：软删账号再添加即恢复，视频历史延续
    await db.run(
      `UPDATE \`benchmark_account\` SET \`removed_at\` = NULL, \`monitor_status\` = 'on',
        \`monitor_interval_hours\` = ?, \`nickname\` = ?, \`fans_count\` = ?,
        \`next_check_at\` = ?, \`consecutive_failures\` = 0, \`last_error\` = NULL, \`abnormal_at\` = NULL
       WHERE \`id\` = ?`,
      [intervalHours, user.nickname, user.fansCount, toDb(computeNextCheck(intervalHours, now)), existing.id],
    )
    const acc = (await getAccount(existing.id))!
    await recordOperation({
      operator: input.operator ?? config.defaultOperator,
      action: 'account.add',
      targetType: 'account',
      targetId: acc.id,
      detail: { url: input.url, intervalHours, restored: true },
    })
    return { account: acc, restored: true }
  }

  const id = newId('bacct')
  await db.run(
    `INSERT INTO \`benchmark_account\` (\`id\`, \`platform\`, \`platform_uid\`, \`sec_uid\`, \`nickname\`, \`fans_count\`, \`source_url\`,
      \`monitor_status\`, \`monitor_interval_hours\`, \`next_check_at\`, \`last_checked_at\`, \`consecutive_failures\`,
      \`user_info_refreshed_at\`, \`added_by\`, \`created_at\`)
     VALUES (?, 'douyin', ?, ?, ?, ?, ?, 'on', ?, ?, NULL, 0, ?, ?, ?)`,
    [
      id,
      user.uid || parsed.secUid,
      parsed.secUid,
      user.nickname,
      user.fansCount,
      input.url,
      intervalHours,
      toDb(computeNextCheck(intervalHours, now)),
      toDb(now),
      input.operator ?? config.defaultOperator,
      toDb(now),
    ],
  )
  await recordOperation({
    operator: input.operator ?? config.defaultOperator,
    action: 'account.add',
    targetType: 'account',
    targetId: id,
    detail: { url: input.url, intervalHours },
  })
  return { account: (await getAccount(id))!, restored: false }
}

export async function updateAccount(
  id: string,
  patch: { intervalHours?: number; monitorStatus?: 'on' | 'paused' },
  operator?: string,
): Promise<AccountRow> {
  const db = getDb()
  const acc = await getAccount(id)
  if (!acc || acc.removedAt) throw err.notFound('账号不存在')
  if (patch.intervalHours !== undefined) {
    const h = normalizeInterval(patch.intervalHours)
    // FR-B2：保存后 next_check_at 立即重算
    await db.run('UPDATE `benchmark_account` SET `monitor_interval_hours` = ?, `next_check_at` = ? WHERE `id` = ?', [
      h,
      toDb(computeNextCheck(h)),
      id,
    ])
  }
  if (patch.monitorStatus) {
    if (!['on', 'paused'].includes(patch.monitorStatus)) throw err.badRequest('monitorStatus 只能是 on / paused')
    await db.run('UPDATE `benchmark_account` SET `monitor_status` = ? WHERE `id` = ?', [patch.monitorStatus, id])
  }
  await recordOperation({
    operator: operator ?? config.defaultOperator,
    action: 'account.update',
    targetType: 'account',
    targetId: id,
    detail: patch,
  })
  return (await getAccount(id))!
}

/** FR-B2 软删：账号移出列表，其视频数据保留 */
export async function removeAccount(id: string, operator?: string): Promise<void> {
  const db = getDb()
  const acc = await getAccount(id)
  if (!acc) throw err.notFound('账号不存在')
  await db.run('UPDATE `benchmark_account` SET `removed_at` = ?, `monitor_status` = ? WHERE `id` = ?', [
    toDb(utcNow()),
    'paused',
    id,
  ])
  await recordOperation({
    operator: operator ?? config.defaultOperator,
    action: 'account.remove',
    targetType: 'account',
    targetId: id,
  })
}

/** FR-B3 抓取结果回写：成功清零，失败计数 + 退避（上限 24h） */
export async function markFetchResult(
  id: string,
  result: { ok: boolean; error?: string | null },
  db: Db = getDb(),
): Promise<void> {
  const acc = await getAccount(id)
  if (!acc) return
  const now = utcNow()
  if (result.ok) {
    // FR-B3：抓完按 完成时间 + 周期 ± 抖动(0~10%) 重算
    const base = computeNextCheck(acc.monitorIntervalHours, now)
    const jitterMs = Math.round(acc.monitorIntervalHours * 3600_000 * jitter(config.sweep.jitterRatio))
    const withJitter = new Date(base.getTime() + jitterMs)
    await db.run(
      `UPDATE \`benchmark_account\` SET \`last_checked_at\` = ?, \`next_check_at\` = ?, \`consecutive_failures\` = 0,
        \`last_error\` = NULL, \`abnormal_at\` = NULL WHERE \`id\` = ?`,
      [toDb(now), toDb(withJitter), id],
    )
    return
  }
  const failures = acc.consecutiveFailures + 1
  let interval = acc.monitorIntervalHours
  if (failures >= 3) {
    const backoffPow = Math.min(10, failures - 3)
    interval = Math.min(24, acc.monitorIntervalHours * Math.pow(2, backoffPow))
  }
  await db.run(
    `UPDATE \`benchmark_account\` SET \`last_checked_at\` = ?, \`next_check_at\` = ?, \`consecutive_failures\` = ?,
      \`last_error\` = ?, \`abnormal_at\` = ? WHERE \`id\` = ?`,
    [
      toDb(now),
      toDb(computeNextCheck(interval, now)),
      failures,
      result.error ? String(result.error).slice(0, 1000) : null,
      failures >= 3 ? toDb(now) : acc.abnormalAt ? toDb(new Date(acc.abnormalAt)) : null,
      id,
    ],
  )
  logger.warn({ accountId: id, failures, nextInterval: interval }, 'account.fetch_failed')
}

/** 每日首次抓取刷新用户信息（粉丝数） */
export async function markUserInfoRefreshed(id: string, fansCount: number, db: Db = getDb()): Promise<void> {
  await db.run('UPDATE `benchmark_account` SET `fans_count` = ?, `user_info_refreshed_at` = ? WHERE `id` = ?', [
    fansCount,
    toDb(utcNow()),
    id,
  ])
}

export async function needsUserInfoRefresh(acc: AccountRow): Promise<boolean> {
  if (!acc.userInfoRefreshedAt) return true
  return new Date(acc.userInfoRefreshedAt).getTime() < addDays(utcNow(), -1).getTime()
}

/** FR-B2 / FR-B3 预计日调用量与估算费用 */
export async function dailyQuota(): Promise<{
  accounts: number
  dailyCalls: number
  estimatedCost: number
  currency: 'CNY'
  unitPrice: { postList: number; userInfo: number; videoDetail: number }
  breakdown: { postPages: number; userInfoRefresh: number; videoDetail: number }
  pagesPerFetch: number
}> {
  const db = getDb()
  const accounts = (await listAccounts()).filter((a) => a.monitorStatus === 'on')
  const pagesPerFetch = 1.2 // p=平均翻页数，默认按 1.2 估
  const postPages = accounts.reduce((sum, a) => sum + Math.ceil(24 / Math.max(1, a.monitorIntervalHours)) * pagesPerFetch, 0)
  const userInfoRefresh = accounts.length * 1
  const today = toDb(utcNow()).slice(0, 10)
  const videoDetail =
    (await db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM `api_call_log` WHERE `provider` = 'tikhub' AND `endpoint` LIKE ? AND `created_at` >= ?",
      ['%detail%', today],
    ))?.c ?? 0
  const dailyCalls = Math.round(postPages + userInfoRefresh + videoDetail)
  const unitPrice = {
    postList: config.tikhub.unitPrice,
    userInfo: config.tikhub.unitPrice,
    videoDetail: config.tikhub.unitPrice,
  }
  return {
    accounts: accounts.length,
    dailyCalls,
    estimatedCost: Number((dailyCalls * config.tikhub.unitPrice).toFixed(4)),
    currency: 'CNY',
    unitPrice,
    breakdown: {
      postPages: Number(postPages.toFixed(2)),
      userInfoRefresh,
      videoDetail,
    },
    pagesPerFetch,
  }
}

/** sweep 目标：monitor_status=on 且 next_check_at<=now（FR-B3） */
export async function listDueAccounts(limit = 50): Promise<AccountRow[]> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`benchmark_account\`
     WHERE \`removed_at\` IS NULL AND \`monitor_status\` = 'on' AND (\`next_check_at\` IS NULL OR \`next_check_at\` <= ?)
     ORDER BY \`next_check_at\` LIMIT ?`,
    [toDb(utcNow()), limit],
  )
  return rows.map(mapAccount)
}

