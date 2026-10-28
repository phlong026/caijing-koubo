import type { Db } from '../../db/index.js'
import { getDb } from '../../db/index.js'
import { newId, jdec, jenc, parsePaging, pageResult } from '../../lib/util.js'
import { toDb, utcNow, fromDb } from '../../lib/time.js'
import { err } from '../../errors.js'
import { config } from '../../config.js'
import { recordOperation } from '../audit/repo.js'
import { createTopic } from '../topics/repo.js'
import { buildFeatures } from './features.js'
import { WINDOW_LABELS, type MetricWindow } from './types.js'

/**
 * 反哺建议（FR-M8 / AC-M8）。
 *
 * 生成规则：对当前窗口的特征统计，若某维度「高表现取值」的爆款占比达到阈值（默认 60%）
 * 且爆款样本数达标，则生成一条 pending 建议。同维度同取值已存在 pending 建议时不重复生成。
 *
 * 确认动作落到选题库：source='data_backfeed'、status='candidate'，走与资讯/手动来源相同的
 * 状态机（candidate → assigned → sent），不复用 benchmark 的「创建即 sent」。
 */

export interface SuggestionRow {
  id: string
  kind: string
  basis: Record<string, unknown>
  payload: Record<string, unknown>
  status: 'pending' | 'confirmed' | 'dismissed'
  topicId: string | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string | null
}

function mapSuggestion(r: Record<string, any>): SuggestionRow {
  return {
    id: r.id,
    kind: r.kind ?? 'topic',
    basis: jdec<Record<string, unknown>>(r.basis, {}),
    payload: jdec<Record<string, unknown>>(r.payload, {}),
    status: (r.status ?? 'pending') as SuggestionRow['status'],
    topicId: r.topic_id ?? null,
    decidedBy: r.decided_by ?? null,
    decidedAt: fromDb(r.decided_at),
    createdAt: fromDb(r.created_at),
  }
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

export async function listSuggestions(
  q: Record<string, unknown>,
  db: Db = getDb(),
): Promise<{ items: SuggestionRow[]; total: number; page: number; pageSize: number }> {
  const p = parsePaging(q, 20, 100)
  const where: string[] = []
  const params: unknown[] = []
  if (q.status) {
    const status = String(q.status)
    if (!['pending', 'confirmed', 'dismissed'].includes(status)) throw err.badRequest('status 取值无效')
    where.push('`status` = ?')
    params.push(status)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total =
    (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM \`backfeed_suggestion\` ${whereSql}`, params))?.c ?? 0
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`backfeed_suggestion\` ${whereSql} ORDER BY \`created_at\` DESC LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  )
  return pageResult(rows.map(mapSuggestion), Number(total), p)
}

/**
 * 刷新建议（导入 / 采集后自动调用，也可手动触发）。
 * 返回本次新增条数。
 */
export async function refreshSuggestions(
  opts: { window?: MetricWindow; days?: number; operator?: string } = {},
  db: Db = getDb(),
): Promise<number> {
  const window: MetricWindow = opts.window ?? 't1'
  const days = opts.days ?? 30
  const stats = await buildFeatures({ window, days }, db)
  if (stats.hotCount < config.analytics.minHotSamplesForSuggest) return 0

  const targets: Array<{ key: 'direction' | 'duration' | 'hook'; title: string; direction: string | null }> = []
  for (const dim of stats.dims) {
    if (!dim.top) continue
    if (dim.top.ratio < config.analytics.directionThreshold) continue
    if (dim.key === 'direction') {
      targets.push({
        key: 'direction',
        title: `【数据反哺】继续做「${dim.top.value}」方向（${WINDOW_LABELS[window]} 爆款占比 ${pct(dim.top.ratio)}）`,
        direction: dim.top.value,
      })
    } else if (dim.key === 'duration') {
      targets.push({
        key: 'duration',
        title: `【数据反哺】时长控制在 ${dim.top.value}（${WINDOW_LABELS[window]} 爆款占比 ${pct(dim.top.ratio)}）`,
        direction: null,
      })
    } else if (dim.key === 'hook') {
      targets.push({
        key: 'hook',
        title: `【数据反哺】开场用「${dim.top.value}」结构（${WINDOW_LABELS[window]} 爆款占比 ${pct(dim.top.ratio)}）`,
        direction: null,
      })
    }
  }
  if (!targets.length) return 0

  let created = 0
  const now = toDb(utcNow())
  // 去重：同维度同取值仍待确认时不再重复生成（pending 数量个位数，读出来比对最准确）
  const pendingRows = await db.all<{ basis: unknown }>(
    "SELECT `basis` FROM `backfeed_suggestion` WHERE `status` = 'pending' AND `kind` = 'topic'",
  )
  const pendingKeys = new Set(
    pendingRows.map((r) => {
      const b = jdec<{ dimension?: string; value?: string }>(r.basis, {})
      return `${b.dimension ?? ''}::${b.value ?? ''}`
    }),
  )

  for (const t of targets) {
    const dim = stats.dims.find((d) => d.key === t.key)!
    const value = dim.top!.value
    if (pendingKeys.has(`${t.key}::${value}`)) continue
    await db.run(
      'INSERT INTO `backfeed_suggestion` (`id`, `kind`, `basis`, `payload`, `status`, `created_at`) VALUES (?, \'topic\', ?, ?, \'pending\', ?)',
      [
        newId('bsug'),
        jenc({
          window,
          days,
          dimension: t.key,
          dimensionLabel: dim.label,
          value,
          ratio: dim.top!.ratio,
          hotRate: dim.top!.hotRate,
          hotCount: dim.top!.hotCount,
          sampleCount: stats.sampleCount,
          hotTotal: stats.hotCount,
        }),
        jenc({ title: t.title, direction: t.direction, basisText: `${dim.label}「${value}」在 ${stats.hotCount} 条爆款中占 ${pct(dim.top!.ratio)}` }),
        now,
      ],
    )
    created += 1
  }

  if (created) {
    await recordOperation({
      operator: opts.operator ?? 'system',
      action: 'analytics.suggestion_create',
      targetType: 'analytics',
      detail: { window, days, created },
    })
  }
  return created
}

/** 确认建议 → 创建 candidate 选题（source=data_backfeed） */
export async function confirmSuggestion(
  id: string,
  operator: string,
  db: Db = getDb(),
): Promise<{ suggestion: SuggestionRow; topicId: string }> {
  const row = await db.get<Record<string, any>>('SELECT * FROM `backfeed_suggestion` WHERE `id` = ?', [id])
  if (!row) throw err.notFound('建议不存在')
  const s = mapSuggestion(row)
  if (s.status !== 'pending') throw err.suggestionAlreadyDecided('该建议已处理', { status: s.status })

  const payload = s.payload as { title?: string; direction?: string | null; basisText?: string }
  const topic = await createTopic(
    {
      source: 'data_backfeed',
      sourceId: id,
      title: String(payload.title ?? '数据反哺选题').slice(0, 480),
      direction: payload.direction ?? null,
      rationale: payload.basisText ?? null,
      status: 'candidate',
      createdBy: operator,
    },
    db,
  )
  const now = toDb(utcNow())
  await db.run(
    "UPDATE `backfeed_suggestion` SET `status` = 'confirmed', `topic_id` = ?, `decided_by` = ?, `decided_at` = ? WHERE `id` = ?",
    [topic.id, operator, now, id],
  )
  await recordOperation({
    operator,
    action: 'analytics.suggestion_confirm',
    targetType: 'topic',
    targetId: topic.id,
    detail: { suggestionId: id, title: topic.title },
  })
  const fresh = await db.get<Record<string, any>>('SELECT * FROM `backfeed_suggestion` WHERE `id` = ?', [id])
  return { suggestion: mapSuggestion(fresh!), topicId: topic.id }
}

export async function dismissSuggestion(
  id: string,
  operator: string,
  reason?: string,
  db: Db = getDb(),
): Promise<SuggestionRow> {
  const row = await db.get<Record<string, any>>('SELECT * FROM `backfeed_suggestion` WHERE `id` = ?', [id])
  if (!row) throw err.notFound('建议不存在')
  const s = mapSuggestion(row)
  if (s.status !== 'pending') throw err.suggestionAlreadyDecided('该建议已处理', { status: s.status })
  const now = toDb(utcNow())
  await db.run(
    "UPDATE `backfeed_suggestion` SET `status` = 'dismissed', `decided_by` = ?, `decided_at` = ? WHERE `id` = ?",
    [operator, now, id],
  )
  await recordOperation({
    operator,
    action: 'analytics.suggestion_dismiss',
    targetType: 'analytics',
    targetId: id,
    detail: { reason: reason ?? null },
  })
  const fresh = await db.get<Record<string, any>>('SELECT * FROM `backfeed_suggestion` WHERE `id` = ?', [id])
  return mapSuggestion(fresh!)
}
