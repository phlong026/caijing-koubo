import { getDb, type Db } from '../../db/index.js'
import { jdec, jenc, newId, parsePaging, pageResult, type PageResult } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'

export type AlertType = 'new_publish' | 'hot'

export interface AlertOut {
  id: string
  type: AlertType
  accountId: string | null
  videoId: string | null
  payload: Record<string, unknown> | null
  isRead: boolean
  createdAt: string | null
}

export interface CreateAlertInput {
  type: AlertType
  accountId: string | null
  videoId: string | null
  payload?: unknown
}

/** FR-B9 告警；同一视频的同类告警不重复产生 */
export async function createAlert(input: CreateAlertInput, db = getDb()): Promise<AlertOut | null> {
  const dup = await db.get<{ id: string }>(
    'SELECT `id` FROM `benchmark_alert` WHERE `type` = ? AND `video_id` = ? LIMIT 1',
    [input.type, input.videoId],
  )
  if (dup) return null
  const id = newId('alert')
  await db.run(
    'INSERT INTO `benchmark_alert` (`id`, `type`, `account_id`, `video_id`, `payload`, `is_read`, `created_at`) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [id, input.type, input.accountId ?? null, input.videoId ?? null, jenc(input.payload ?? null), toDb(utcNow())],
  )
  return (await getAlert(id, db))!
}

export async function getAlert(id: string, db = getDb()): Promise<AlertOut | null> {
  const r = await db.get<Record<string, any>>('SELECT * FROM `benchmark_alert` WHERE `id` = ?', [id])
  return r ? mapAlert(r) : null
}

function mapAlert(r: Record<string, any>): AlertOut {
  return {
    id: r.id,
    type: r.type,
    accountId: r.account_id ?? null,
    videoId: r.video_id ?? null,
    payload: jdec<Record<string, unknown> | null>(r.payload, null),
    isRead: !!r.is_read,
    createdAt: fromDb(r.created_at),
  }
}

export async function listAlerts(q: Record<string, unknown>): Promise<PageResult<AlertOut>> {
  const db = getDb()
  const p = parsePaging(q, 20, 100)
  const where: string[] = []
  const params: unknown[] = []
  if (q.type) {
    where.push('`type` = ?')
    params.push(String(q.type))
  }
  if (q.isRead === '0' || q.isRead === 'false') {
    where.push('`is_read` = 0')
  } else if (q.isRead === '1' || q.isRead === 'true') {
    where.push('`is_read` = 1')
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM \`benchmark_alert\` ${whereSql}`, params))?.c ?? 0
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`benchmark_alert\` ${whereSql} ORDER BY \`created_at\` DESC LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  )
  return pageResult(rows.map(mapAlert), total, p)
}

export async function unreadCount(): Promise<number> {
  const db = getDb()
  return (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM `benchmark_alert` WHERE `is_read` = 0'))?.c ?? 0
}

export async function markRead(id: string): Promise<void> {
  const db = getDb()
  await db.run('UPDATE `benchmark_alert` SET `is_read` = 1 WHERE `id` = ?', [id])
}

export async function markAllRead(): Promise<number> {
  const db = getDb()
  const res = await db.run('UPDATE `benchmark_alert` SET `is_read` = 1 WHERE `is_read` = 0')
  return res.affectedRows
}
