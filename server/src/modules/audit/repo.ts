import { getDb } from '../../db/index.js'
import { newId, jenc, parsePaging, pageResult, type PageQuery, type PageResult } from '../../lib/util.js'
import { toDb, utcNow, fromDb } from '../../lib/time.js'

export type OperationAction =
  | 'account.add'
  | 'account.update'
  | 'account.remove'
  | 'account.pause'
  | 'account.resume'
  | 'topic.generate'
  | 'topic.assign'
  | 'topic.send'
  | 'topic.archive'
  | 'template.save'
  | 'template.delete'
  | 'video.extract'
  | 'video.send_copy'
  | 'alert.read'
  | 'news.refresh'
  | 'link.parse'

export interface RecordOperationInput {
  operator: string
  action: OperationAction | string
  targetType?: string
  targetId?: string
  detail?: unknown
}

/** D14：操作日志落库，留存 ≥2 年 */
export async function recordOperation(input: RecordOperationInput): Promise<void> {
  const db = getDb()
  try {
    await db.run(
      'INSERT INTO `operation_log` (`id`, `operator`, `action`, `target_type`, `target_id`, `detail`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        newId('oplog'),
        input.operator || 'ops',
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        jenc(input.detail ?? null),
        toDb(utcNow()),
      ],
    )
  } catch (e) {
    // 审计写入失败不阻断业务，但必须留痕到应用日志
    const { logger } = await import('../../log.js')
    logger.error({ err: (e as Error).message, input }, 'audit.write_failed')
  }
}

export async function listOperations(
  q: Record<string, unknown>,
): Promise<PageResult<Record<string, unknown>>> {
  const db = getDb()
  const p: PageQuery = parsePaging(q, 20, 100)
  const where: string[] = []
  const params: unknown[] = []
  if (q.operator) {
    where.push('`operator` = ?')
    params.push(String(q.operator))
  }
  if (q.targetType) {
    where.push('`target_type` = ?')
    params.push(String(q.targetType))
  }
  if (q.action) {
    where.push('`action` = ?')
    params.push(String(q.action))
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total =
    (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM \`operation_log\` ${whereSql}`, params))?.c ?? 0
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`operation_log\` ${whereSql} ORDER BY \`created_at\` DESC LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  )
  const items = rows.map((r) => ({ ...r, created_at: fromDb(r.created_at) }))
  return pageResult(items, total, p)
}
