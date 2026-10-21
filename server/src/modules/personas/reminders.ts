import { getDb } from '../../db/index.js'
import { newId } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { recordOperation } from '../../modules/audit/repo.js'
import type { ReminderKind } from './types.js'

/**
 * 站内提醒（FR-U3 / FR-C3 待核对 / 失败通知）。
 * 去重口径：同 (kind, ref_id) 未读期间不重复生成；已读后可再生成。
 */

export interface PersonaReminder {
  id: string
  personaId: string
  kind: ReminderKind
  refId: string | null
  message: string
  readAt: string | null
  createdAt: string | null
}

function mapRow(r: Record<string, any>): PersonaReminder {
  return {
    id: r.id,
    personaId: r.persona_id,
    kind: r.kind,
    refId: r.ref_id ?? null,
    message: r.message,
    readAt: fromDb(r.read_at),
    createdAt: fromDb(r.created_at),
  }
}

export async function listReminders(f: { unread?: boolean; limit?: number } = {}): Promise<PersonaReminder[]> {
  const db = getDb()
  const where = f.unread ? 'WHERE `read_at` IS NULL' : ''
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`persona_reminder\` ${where} ORDER BY \`created_at\` DESC LIMIT ?`,
    [Math.min(200, Math.max(1, f.limit ?? 100))],
  )
  return rows.map(mapRow)
}

export async function countUnread(): Promise<number> {
  const db = getDb()
  const row = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM `persona_reminder` WHERE `read_at` IS NULL')
  return Number(row?.c ?? 0)
}

/** 生成提醒（同 kind + ref 未读则跳过；操作留痕） */
export async function createReminder(input: {
  personaId: string
  kind: ReminderKind
  refId?: string | null
  message: string
  operator?: string
}): Promise<PersonaReminder | null> {
  const db = getDb()
  const existing = await db.get<{ id: string }>(
    'SELECT `id` FROM `persona_reminder` WHERE `kind` = ? AND IFNULL(`ref_id`, \'\') = IFNULL(?, \'\') AND `read_at` IS NULL LIMIT 1',
    [input.kind, input.refId ?? null],
  )
  if (existing) return null
  const id = newId('pr')
  await db.run(
    'INSERT INTO `persona_reminder` (`id`, `persona_id`, `kind`, `ref_id`, `message`, `created_at`) VALUES (?, ?, ?, ?, ?, ?)',
    [id, input.personaId, input.kind, input.refId ?? null, input.message.slice(0, 255), toDb(utcNow())],
  )
  await recordOperation({
    operator: input.operator ?? 'system',
    action: 'persona.reminder_created',
    targetType: 'persona',
    targetId: input.personaId,
    detail: { reminderId: id, kind: input.kind, refId: input.refId ?? null },
  })
  return (await db.get<Record<string, any>>('SELECT * FROM `persona_reminder` WHERE `id` = ?', [id])) as any
}

export async function markAllRead(operator: string): Promise<number> {
  const db = getDb()
  const now = toDb(utcNow())
  const r = await db.run('UPDATE `persona_reminder` SET `read_at` = ? WHERE `read_at` IS NULL', [now])
  await recordOperation({ operator, action: 'persona.reminder_read_all', detail: { count: r.affectedRows } })
  return r.affectedRows
}

/** 单条已读 */
export async function markRead(id: string): Promise<void> {
  const db = getDb()
  const row = await db.get('SELECT `id` FROM `persona_reminder` WHERE `id` = ?', [id])
  if (!row) throw err.notFound('提醒不存在')
  await db.run('UPDATE `persona_reminder` SET `read_at` = ? WHERE `id` = ? AND `read_at` IS NULL', [toDb(utcNow()), id])
}
