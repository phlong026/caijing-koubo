import { getDb } from '../../db/index.js'
import { newId, parsePaging, pageResult, type PageResult } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { logger } from '../../log.js'

/**
 * FR-C4 第三方调用记录。
 * provider：tikhub / dashscope / news（资讯源，cost=0，仅供可观测）/ copy_llm（文案二创专用模型）。
 * 列宽 32，新增供应商无需迁移。
 */
export type CallProvider = 'tikhub' | 'dashscope' | 'news' | 'copy_llm'

export interface LogCallInput {
  provider: CallProvider
  endpoint: string
  refType?: string | null
  refId?: string | null
  cost?: number
  ok?: boolean
  httpStatus?: number | null
  durationMs?: number | null
  error?: string | null
  requestId?: string | null
}

export async function logApiCall(input: LogCallInput): Promise<void> {
  try {
    const db = getDb()
    await db.run(
      `INSERT INTO \`api_call_log\`
        (\`id\`, \`provider\`, \`endpoint\`, \`ref_type\`, \`ref_id\`, \`cost_estimate\`, \`ok\`, \`http_status\`, \`duration_ms\`, \`error\`, \`request_id\`, \`created_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('call'),
        input.provider,
        String(input.endpoint).slice(0, 255),
        input.refType ?? null,
        input.refId ?? null,
        input.cost ?? 0,
        input.ok === false ? 0 : 1,
        input.httpStatus ?? null,
        input.durationMs ?? null,
        input.error ? String(input.error).slice(0, 1000) : null,
        input.requestId ?? null,
        toDb(utcNow()),
      ],
    )
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'api_call_log.write_failed')
  }
}

export interface CallSummary {
  total: number
  cost: number
  byProvider: Array<{ provider: string; calls: number; cost: number }>
  byDay: Array<{ day: string; calls: number; cost: number }>
}

export async function summarizeCalls(q: Record<string, unknown>): Promise<CallSummary> {
  const db = getDb()
  const where: string[] = []
  const params: unknown[] = []
  if (q.provider) {
    where.push('`provider` = ?')
    params.push(String(q.provider))
  }
  if (q.from) {
    where.push('`created_at` >= ?')
    params.push(String(q.from).slice(0, 19).replace('T', ' '))
  }
  if (q.to) {
    const to = String(q.to)
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      // 只给日期时按「含当天」处理：< 次日 00:00，否则当天的记录全部被排除
      const next = new Date(`${to}T00:00:00Z`)
      next.setUTCDate(next.getUTCDate() + 1)
      where.push('`created_at` < ?')
      params.push(next.toISOString().slice(0, 10) + ' 00:00:00')
    } else {
      where.push('`created_at` <= ?')
      params.push(to.slice(0, 19).replace('T', ' '))
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const row =
    (await db.get<{ c: number; cost: number }>(
      `SELECT COUNT(*) AS c, COALESCE(SUM(\`cost_estimate\`), 0) AS cost FROM \`api_call_log\` ${whereSql}`,
      params,
    )) ?? { c: 0, cost: 0 }
  const byProvider = await db.all<{ provider: string; calls: number; cost: number }>(
    `SELECT \`provider\`, COUNT(*) AS calls, COALESCE(SUM(\`cost_estimate\`), 0) AS cost
     FROM \`api_call_log\` ${whereSql} GROUP BY \`provider\` ORDER BY cost DESC`,
    params,
  )
  const dayExpr = db.kind === 'mysql' ? "DATE(`created_at`)" : "substr(`created_at`, 1, 10)"
  const byDay = await db.all<{ day: string; calls: number; cost: number }>(
    `SELECT ${dayExpr} AS day, COUNT(*) AS calls, COALESCE(SUM(\`cost_estimate\`), 0) AS cost
     FROM \`api_call_log\` ${whereSql} GROUP BY day ORDER BY day DESC LIMIT 30`,
    params,
  )
  return {
    total: Number(row.c),
    cost: Number(row.cost),
    byProvider: byProvider.map((r) => ({ provider: r.provider, calls: Number(r.calls), cost: Number(r.cost) })),
    byDay: byDay.map((r) => ({ day: r.day, calls: Number(r.calls), cost: Number(r.cost) })),
  }
}

export async function listCalls(q: Record<string, unknown>): Promise<PageResult<Record<string, unknown>>> {
  const db = getDb()
  const p = parsePaging(q, 20, 100)
  const where: string[] = []
  const params: unknown[] = []
  if (q.provider) {
    where.push('`provider` = ?')
    params.push(String(q.provider))
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total =
    (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM \`api_call_log\` ${whereSql}`, params))?.c ?? 0
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`api_call_log\` ${whereSql} ORDER BY \`created_at\` DESC LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  )
  return pageResult(rows as Record<string, unknown>[], total, p)
}
