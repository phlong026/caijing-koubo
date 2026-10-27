import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { getDb } from '../../db/index.js'
import { toDb, utcNow } from '../../lib/time.js'
import { isPlatformAllowed } from './matrix.js'
import { PLATFORM_LABELS, LINE_LABELS } from '../personas/types.js'
import { PUBLISH_PLATFORMS, type PersonaLine, type Platform } from './types.js'
import { PLATFORM_LINE_MATRIX } from './matrix.js'
import {
  createAccount,
  deleteAccount,
  listAccounts,
  patchAccount,
  requireAccount,
  publishedTodayOf,
} from './accounts.js'
import { checkLoginNow, latestSessionView, startLoginSession } from './login.js'
import { publishEngineStatus } from './engine.js'
import {
  cancelPlan,
  createPlan,
  executeNow,
  getLogs,
  listPlans,
  nextActionOf,
  requirePlan,
  reviewConfirm,
  schedulePlan,
} from './plans.js'
import { listLogs, createManualLog } from './records.js'
import { markManualResult, recheckLog, retryLog } from './execute.js'
import { config } from '../../config.js'

/**
 * 发布管理路由（任务书 §6）。
 * 写操作角色限制在 auth/guard.ts ROLE_RULES 集中声明（ops/admin 可写、删除仅 admin）。
 */

function operatorOf(req: FastifyRequest): string {
  const u = (req as unknown as { user?: { username?: string; id?: string } }).user
  return u?.username || u?.id || config.defaultOperator
}

/** FR-C2：线×平台矩阵 + 每格可用账号数（active 且启用，附当日余量） */
async function buildMatrix() {
  const db = getDb()
  const accounts = await db.all<Record<string, any>>(
    "SELECT `platform`, `line`, COUNT(*) AS n FROM `platform_account` WHERE `deleted_at` IS NULL AND `enabled` = 1 AND `login_status` = 'active' GROUP BY `platform`, `line`",
  )
  const countMap = new Map<string, number>()
  for (const r of accounts) countMap.set(`${r.line}:${r.platform}`, Number(r.n))
  const matrix: Record<string, Record<string, { allowed: boolean; activeAccounts: number; dailyLimit: number }>> = {}
  for (const [line, platforms] of Object.entries(PLATFORM_LINE_MATRIX)) {
    matrix[line] = {}
    for (const platform of PUBLISH_PLATFORMS) {
      const allowed = platforms.includes(platform)
      matrix[line][platform] = {
        allowed,
        activeAccounts: countMap.get(`${line}:${platform}`) ?? 0,
        dailyLimit: config.publish.dailyLimitPerAccount,
      }
    }
  }
  return matrix
}

export async function registerPublishRoutes(app: FastifyInstance): Promise<void> {
  /* ── 矩阵与引擎状态 ── */

  app.get('/publish/platform-matrix', async () => {
    return ok({ matrix: await buildMatrix(), platformLabels: PLATFORM_LABELS, lineLabels: LINE_LABELS })
  })

  app.get('/publish/options', async () => {
    const s = publishEngineStatus()
    return ok({
      engine: s,
      // PU2/PU3：真实引擎平移明细（前端可提示「该平台暂走模拟」）
      realEngine: s.realEngine,
      limits: {
        dailyLimitPerAccount: config.publish.dailyLimitPerAccount,
        confirmTimeoutMs: config.publish.confirmTimeoutMs,
        manualWindowMs: config.publish.manualWindowMs,
        maxContexts: config.publish.maxContexts,
      },
    })
  })

  /* ── 平台账号（FR-A1~A5）── */

  app.get('/platform-accounts', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>
    const result = await listAccounts({
      platform: q.platform,
      line: q.line,
      loginStatus: q.loginStatus,
      enabled: q.enabled,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    })
    // 附每日用量（前端展示余量；量小不单独聚合）
    const withUsage = []
    for (const a of result.items) {
      withUsage.push({ ...a, publishedToday: a.loginStatus === 'active' ? await publishedTodayOf(a.id) : 0 })
    }
    return ok({ ...result, items: withUsage })
  })

  app.post('/platform-accounts', async (req) => {
    const body = (req.body ?? {}) as { platform?: string; line?: string; displayName?: string; remark?: string }
    if (!body.platform || !body.line) throw err.badRequest('缺少 platform 或 line')
    const account = await createAccount(
      {
        platform: body.platform as Platform,
        line: body.line as PersonaLine,
        displayName: String(body.displayName ?? ''),
        remark: body.remark,
      },
      operatorOf(req),
    )
    // 创建即发起登录（FR-A1）：mock 引擎下二维码立即可用；真实引擎打开登录页截图
    let login: Awaited<ReturnType<typeof startLoginSession>> | null = null
    try {
      login = await startLoginSession(account.id, operatorOf(req))
    } catch (e) {
      // 二维码失败不回滚建号：账号已落库，前端可在抽屉里重试登录
      req.log.warn({ err: (e as Error).message, accountId: account.id }, 'publish.login.autostart_failed')
    }
    return ok({ account, login })
  })

  app.get('/platform-accounts/:id', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await requireAccount(id))
  })

  app.patch('/platform-accounts/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { enabled?: boolean; remark?: string }
    return ok(await patchAccount(id, body, operatorOf(req)))
  })

  app.delete('/platform-accounts/:id', async (req) => {
    const { id } = req.params as { id: string }
    await deleteAccount(id, operatorOf(req))
    return ok({ deleted: true })
  })

  /* ── 登录会话（FR-L1~L3）── */

  app.post('/platform-accounts/:id/login-sessions', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await startLoginSession(id, operatorOf(req)))
  })

  app.get('/platform-accounts/:id/login-sessions/latest', async (req) => {
    const { id } = req.params as { id: string }
    await requireAccount(id)
    return ok(await latestSessionView(id))
  })

  app.post('/platform-accounts/:id/check-login', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await checkLoginNow(id, operatorOf(req)))
  })

  /* ── 发布计划（FR-C / FR-R / FR-X3）── */

  app.post('/publish-plans', async (req) => {
    const body = (req.body ?? {}) as {
      copyId?: string
      videoJobId?: string
      items?: Array<{ platform?: string; accountId?: string; title?: string; description?: string; tags?: string[] }>
      scheduledAt?: string | null
      aigcFlag?: boolean
    }
    if (!body.copyId) throw err.badRequest('缺少 copyId')
    // FR-X2（剪辑任务书 EC11）：videoJobId 转可选——缺省由 cut.resolvePublishInput 解析（过审成片优先，回落基础视频）
    if (!Array.isArray(body.items) || !body.items.length) throw err.badRequest('至少选择一个发布平台与账号')
    const items = body.items.map((i) => ({
      platform: String(i.platform ?? '') as Platform,
      accountId: String(i.accountId ?? ''),
      title: i.title,
      description: i.description,
      tags: Array.isArray(i.tags) ? i.tags.map(String) : [],
    }))
    return ok(await createPlan({ copyId: body.copyId, videoJobId: body.videoJobId, items, scheduledAt: body.scheduledAt ?? null }, operatorOf(req)))
  })

  app.get('/publish-plans', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>
    return ok(await listPlans({ status: q.status, copyId: q.copyId, page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined }))
  })

  app.get('/publish-plans/:id', async (req) => {
    const { id } = req.params as { id: string }
    const plan = await requirePlan(id)
    return ok({ ...plan, logs: await getLogs(id), nextAction: nextActionOf(plan) })
  })

  app.post('/publish-plans/:id/schedule', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { scheduledAt?: string }
    if (!body.scheduledAt) throw err.badRequest('缺少 scheduledAt')
    return ok(await schedulePlan(id, body.scheduledAt, operatorOf(req)))
  })

  app.post('/publish-plans/:id/execute-now', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await executeNow(id, operatorOf(req)))
  })

  app.post('/publish-plans/:id/review-confirm', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await reviewConfirm(id, operatorOf(req)))
  })

  app.post('/publish-plans/:id/cancel', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await cancelPlan(id, operatorOf(req)))
  })

  /* ── 发布记录（FR-S / PB14）── */

  app.get('/publish-logs', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>
    return ok(await listLogs({ planId: q.planId, platform: q.platform, status: q.status, accountId: q.accountId, page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined }))
  })

  app.get('/publish-logs/:id', async (req) => {
    const { id } = req.params as { id: string }
    const row = await getDb().get<Record<string, any>>('SELECT * FROM `publish_log` WHERE `id` = ?', [id])
    if (!row) throw err.publishLogNotFound()
    return ok(await import('./records-mapper.js').then((m) => m.mapLog(row)))
  })

  app.post('/publish-logs/:id/retry', async (req) => {
    const { id } = req.params as { id: string }
    await retryLog(id, operatorOf(req))
    return ok({ retried: true })
  })

  app.post('/publish-logs/:id/recheck', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await recheckLog(id, operatorOf(req)))
  })

  app.post('/publish-logs/:id/manual-result', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { published?: boolean; videoUrl?: string; reason?: string }
    return ok(await markManualResult(id, { published: body.published === true, videoUrl: body.videoUrl, reason: body.reason }, operatorOf(req)))
  })

  // 手动补录（PB14 / AC-S5）：plan_id 可空、attempt=0、不参与自动重试与每日额度
  app.post('/publish-logs', async (req) => {
    const body = (req.body ?? {}) as { platform?: string; accountId?: string; title?: string; videoUrl?: string; externalVideoId?: string; publishedAt?: string }
    if (!body.platform || !body.accountId) throw err.badRequest('缺少 platform 或 accountId')
    return ok(await createManualLog({
      platform: String(body.platform) as Platform,
      accountId: String(body.accountId),
      title: String(body.title ?? ''),
      videoUrl: body.videoUrl ?? null,
      externalVideoId: body.externalVideoId ?? null,
    }, operatorOf(req)))
  })
}
