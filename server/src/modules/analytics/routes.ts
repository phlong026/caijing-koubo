import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { config } from '../../config.js'
import { fromDb } from '../../lib/time.js'
import { getDb } from '../../db/index.js'
import { CSV_TEMPLATES, WINDOW_LABELS, type MetricWindow } from './types.js'
import { buildTemplateCsv } from './csv.js'
import { importMetricsCsv } from './import.js'
import { buildOverview } from './overview.js'
import { buildFeatures, confirmFeatures, instructionsFromProfile } from './features.js'
import { getActiveProfile } from './preference.js'
import { confirmSuggestion, dismissSuggestion, listSuggestions, refreshSuggestions } from './suggestions.js'
import { raiseBenchmarkPriority } from './benchmark-priority.js'
import { runCollect, schedulerStatus } from './schedule.js'
import { providerStatus } from './provider.js'
import { PUBLISH_PLATFORMS, type Platform } from '../publish/types.js'

/**
 * 数据看板路由（任务书 §6，10 个端点 + 模板下载）。
 * 写操作角色在 auth/guard.ts ROLE_RULES 集中声明（导入 / 确认 / 忽略 / 降档 = ops+admin，手动采集 = admin）。
 */

function operatorOf(req: FastifyRequest): string {
  const u = (req as unknown as { user?: { username?: string; id?: string } }).user
  return u?.username || u?.id || config.defaultOperator
}

function asPlatform(v: unknown): Platform {
  const p = String(v ?? '')
  if (!PUBLISH_PLATFORMS.includes(p as Platform)) {
    throw err.badRequest('platform 取值无效', { allowed: PUBLISH_PLATFORMS })
  }
  return p as Platform
}

function asWindow(v: unknown, fallback: MetricWindow = 't1'): MetricWindow {
  const w = String(v ?? '')
  if (!w) return fallback
  if (w !== 't1' && w !== 't7') throw err.badRequest('window 只能是 t1 / t7', { got: w })
  return w
}

/** 读取 multipart 中的 CSV（≤2MB，直接进内存；不落临时文件） */
async function readCsvMultipart(
  req: FastifyRequest,
): Promise<{ fields: Record<string, string>; text: string; filename: string }> {
  const fields: Record<string, string> = {}
  let text: string | null = null
  let filename = ''
  const maxBytes = config.analytics.csvMaxMb * 1024 * 1024

  const parts = (req as unknown as {
    parts: () => AsyncIterableIterator<{
      type: string
      fieldname?: string
      value?: unknown
      filename?: string
      file?: NodeJS.ReadableStream & { truncated?: boolean }
    }>
  }).parts()

  for await (const part of parts) {
    if (part.type === 'field') {
      if (part.fieldname) fields[part.fieldname] = String(part.value ?? '')
      continue
    }
    if (part.type !== 'file') continue
    if (text !== null) {
      // 多余文件排空，避免背压挂住请求
      if (part.file) for await (const chunk of part.file as AsyncIterable<Buffer>) void chunk
      continue
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of part.file as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > maxBytes) {
        throw err.csvParseFailed(`CSV 超过 ${config.analytics.csvMaxMb}MB 上限`, { maxBytes, size })
      }
      chunks.push(chunk)
    }
    filename = part.filename ?? ''
    const raw = Buffer.concat(chunks)
    // 编码提示：GBK 导出的文件按 UTF-8 解会出现大量替换字符，明确报错而不是导入脏标题
    const utf8 = raw.toString('utf8')
    const badChars = (utf8.match(/\uFFFD/g) ?? []).length
    if (badChars > Math.max(3, utf8.length * 0.005)) {
      throw err.csvParseFailed('CSV 编码无法识别（疑似 GBK），请用 Excel 另存为「CSV UTF-8」后重试', {
        filename,
        badChars,
      })
    }
    text = utf8
  }

  if (text === null) throw err.badRequest('请上传 CSV 文件（字段名 file）')
  return { fields, text, filename }
}

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  /* ── CSV 模板下载（登录即可，供导入弹窗使用） ── */
  app.get('/analytics/csv-template', async (req: FastifyRequest, reply: FastifyReply) => {
    const platform = asPlatform((req.query as Record<string, unknown>)?.platform)
    const tpl = CSV_TEMPLATES[platform]
    if (!tpl) throw err.notFound('该平台暂无导入模板')
    const csv = buildTemplateCsv(platform, tpl)
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="analytics-${platform}.csv"`)
      .send(csv)
  })

  /* ── FR-M1 CSV 导入（ops/admin） ── */
  app.post('/analytics/metrics/import', async (req: FastifyRequest) => {
    const { fields, text, filename } = await readCsvMultipart(req)
    const platform = asPlatform(fields.platform)
    const window = asWindow(fields.window, 't1')
    const result = await importMetricsCsv({
      platform,
      window,
      csvText: text,
      operator: operatorOf(req),
      filename,
    })
    return ok(result)
  })

  /* ── FR-M4 手动触发采集（admin） ── */
  app.post('/analytics/metrics/collect', async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as { window?: string }
    const window = body.window ? asWindow(body.window) : undefined
    const outcome = await runCollect({ window, operator: operatorOf(req) })
    return ok({ ...outcome, scheduler: schedulerStatus() })
  })

  /* ── FR-M5 效果看板 ── */
  app.get('/analytics/overview', async (req: FastifyRequest) => {
    return ok(await buildOverview((req.query ?? {}) as Record<string, unknown>))
  })

  /* ── FR-M6 特征统计 ── */
  app.get('/analytics/features', async (req: FastifyRequest) => {
    return ok(await buildFeatures((req.query ?? {}) as Record<string, unknown>))
  })

  /* ── FR-M7 确认 → 冻结偏好（ops/admin） ── */
  app.post('/analytics/features/confirm', async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as { window?: string; days?: number }
    const r = await confirmFeatures({
      window: body.window,
      days: body.days,
      operator: operatorOf(req),
    })
    return ok({ profile: r.profile, basisText: r.profile.basisText, sampleCount: r.stats.sampleCount })
  })

  /* ── 当前 active 偏好（前端展示 + copy 注入共用口径） ── */
  app.get('/analytics/preference-profile', async () => {
    const profile = await getActiveProfile()
    return ok({ profile, injection: await instructionsFromProfile() })
  })

  /* ── FR-M8 建议列表 / 确认 / 忽略 ── */
  app.get('/analytics/suggestions', async (req: FastifyRequest) => {
    return ok(await listSuggestions((req.query ?? {}) as Record<string, unknown>))
  })

  app.post('/analytics/suggestions/refresh', async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as { window?: string; days?: number }
    const window = asWindow(body.window, 't1')
    const created = await refreshSuggestions({
      window,
      days: body.days,
      operator: operatorOf(req),
    })
    return ok({ created })
  })

  app.post('/analytics/suggestions/:id/confirm', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string }
    const r = await confirmSuggestion(id, operatorOf(req))
    return ok(r)
  })

  app.post('/analytics/suggestions/:id/dismiss', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { reason?: string }
    const r = await dismissSuggestion(id, operatorOf(req), body.reason)
    return ok(r)
  })

  /* ── FR-M9 对标优先级降档（ops/admin） ── */
  app.post('/analytics/benchmark-priority', async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as { benchmarkAccountId?: string; accountId?: string }
    const accountId = body.benchmarkAccountId || body.accountId
    if (!accountId) throw err.badRequest('缺少 benchmarkAccountId')
    return ok(await raiseBenchmarkPriority(accountId, operatorOf(req)))
  })

  /* ── 元信息：窗口 / 平台 / 模板 / Provider 状态（前端一次取全） ── */
  app.get('/analytics/meta', async () => {
    const db = getDb()
    const rows = await db.all<{ window: string; c: number; last: string | null }>(
      'SELECT `window`, COUNT(*) AS c, MAX(`captured_at`) AS last FROM `metric_snapshot` GROUP BY `window`',
    )
    const byWindow = Object.fromEntries(
      rows.map((r) => [r.window, { count: Number(r.c), lastCapturedAt: fromDb(r.last) }]),
    )
    return ok({
      windows: (['t1', 't7'] as MetricWindow[]).map((w) => ({
        key: w,
        label: WINDOW_LABELS[w],
        count: byWindow[w]?.count ?? 0,
        lastCapturedAt: byWindow[w]?.lastCapturedAt ?? null,
      })),
      platforms: PUBLISH_PLATFORMS,
      templates: Object.entries(CSV_TEMPLATES).map(([key, t]) => ({ platform: key, label: t.label, headers: t.headers })),
      provider: providerStatus(),
      scheduler: schedulerStatus(),
    })
  })
}
