import { getDb } from '../../db/index.js'
import { toDb, utcNow } from '../../lib/time.js'

/**
 * publish_log 状态 CAS（worker / sweep / 人工操作共用）。
 * 全部状态迁移必须走这里（任务书 §3.3：状态以数据库为准，队列只负责推进）。
 */
export async function casLogStatus(
  logId: string,
  from: string[],
  to: string,
  extraSets: Array<[string, unknown]> = [],
): Promise<boolean> {
  const db = getDb()
  const sets = ['`status` = ?', '`updated_at` = ?']
  const params: unknown[] = [to, toDb(utcNow())]
  for (const [col, val] of extraSets) {
    sets.push(`\`${col}\` = ?`)
    params.push(val)
  }
  const placeholders = from.map(() => '?').join(',')
  const r = await db.run(
    `UPDATE \`publish_log\` SET ${sets.join(', ')} WHERE \`id\` = ? AND \`status\` IN (${placeholders})`,
    [...params, logId, ...from],
  )
  return (r as unknown as { changes?: number })?.changes !== 0
}
