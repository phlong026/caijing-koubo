import { createHash } from 'node:crypto'
import { getDb } from '../../db/index.js'
import { newId, parsePaging, pageResult, type PageResult } from '../../lib/util.js'
import { toDb, utcNow, fromDb } from '../../lib/time.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { config } from '../../config.js'
import { recordOperation } from '../audit/repo.js'
import { getApprovedCopy } from '../copy/review.js'
import { checkReadiness } from '../personas/readiness.js'
import { mapLog, safeTags } from './records-mapper.js'
import { isPlatformAllowed } from './matrix.js'
import { requireAccount, publishedTodayOf } from './accounts.js'
import { enqueue, QUEUE_NAMES } from '../../queue/index.js'
import type { PersonaLine, Platform, PublishLog, PublishLogView, PublishPlan } from './types.js'

/**
 * 发布计划与分平台记录（FR-C / FR-R / FR-X3，任务书 §3.2 §3.3 §3.6）。
 * 状态机：draft/scheduled → executing → completed/partial/failed/cancelled；
 * needs_review 是 review_state 字段（非状态），拦截 schedule / execute-now。
 * 记录状态迁移一律 CAS；拆分即建 scheduled（无 queued 态），失败重试 = failed + retry_at → sweep。
 */

/* ── 行映射 ── */

function mapPlan(r: Record<string, any>): PublishPlan {
  return {
    id: r.id,
    copyId: r.copy_id,
    copyVersionId: r.copy_version_id ?? null,
    videoJobId: r.video_job_id ?? null,
    baseVideoVersionNo: r.base_video_version_no,
    title: r.title,
    description: r.description ?? null,
    tags: safeTags(r.tags),
    coverObjectKey: r.cover_object_key ?? null,
    coverSource: r.cover_source ?? 'first_frame',
    titleHash: r.title_hash ?? null,
    reviewState: r.review_state ?? 'none',
    reviewBy: r.review_by ?? null,
    reviewAt: fromDb(r.review_at),
    status: r.status,
    scheduledAt: fromDb(r.scheduled_at),
    completedAt: fromDb(r.completed_at),
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}

/* ── 实质修改判定（FR-R1 / §3.6）── */

/** 归一化：去首尾与内部空白、全角字母数字转半角、小写 */
function normalizeTitle(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
}

export function titleHashOf(title: string): string {
  return createHash('sha256').update(normalizeTitle(title)).digest('hex')
}

/* ── 查询 ── */

export async function getPlan(id: string): Promise<PublishPlan | null> {
  const row = await getDb().get<Record<string, any>>('SELECT * FROM `publish_plan` WHERE `id` = ? AND `deleted_at` IS NULL', [id])
  return row ? mapPlan(row) : null
}

export async function requirePlan(id: string): Promise<PublishPlan> {
  const p = await getPlan(id)
  if (!p) throw err.publishPlanNotFound()
  return p
}

export async function getLogs(planId: string): Promise<PublishLog[]> {
  const rows = await getDb().all<Record<string, any>>('SELECT * FROM `publish_log` WHERE `plan_id` = ? ORDER BY `platform` ASC', [planId])
  return rows.map(mapLog)
}

export interface ListPlanFilters {
  status?: string
  copyId?: string
  page?: number
  pageSize?: number
}

export async function listPlans(f: ListPlanFilters): Promise<
  PageResult<PublishPlan & { logs: PublishLogView[]; nextAction: string | null }>
> {
  const db = getDb()
  const where: string[] = ['`deleted_at` IS NULL']
  const params: unknown[] = []
  if (f.status) {
    where.push('`status` = ?')
    params.push(f.status)
  }
  if (f.copyId) {
    where.push('`copy_id` = ?')
    params.push(f.copyId)
  }
  const whereSql = `WHERE ${where.join(' AND ')}`
  const p = parsePaging({ page: f.page, pageSize: f.pageSize }, 20, 100)
  const total = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM \`publish_plan\` ${whereSql}`, params)
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`publish_plan\` ${whereSql} ORDER BY \`created_at\` DESC LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  )
  const items = []
  for (const r of rows) {
    const plan = mapPlan(r)
    items.push({ ...plan, logs: await logViews(plan.id), nextAction: nextActionOf(plan) })
  }
  return pageResult(items, Number(total?.n ?? 0), p)
}

async function logViews(planId: string): Promise<PublishLogView[]> {
  const rows = await getDb().all<Record<string, any>>(
    'SELECT `l`.*, `a`.`display_name` AS `account_name`, `p`.`title` AS `plan_title` FROM `publish_log` `l` ' +
      'LEFT JOIN `platform_account` `a` ON `a`.`id` = `l`.`account_id` ' +
      'LEFT JOIN `publish_plan` `p` ON `p`.`id` = `l`.`plan_id` ' +
      'WHERE `l`.`plan_id` = ? ORDER BY `l`.`platform` ASC',
    [planId],
  )
  return rows.map((r) => ({ ...mapLog(r), accountName: r.account_name ?? null, planTitle: r.plan_title ?? null }))
}

/** FR-X3：任务中心「发布」节点的下一步动作（参数按需收窄，调用方传完整 PublishPlan 兼容） */
export function nextActionOf(plan: Pick<PublishPlan, 'reviewState' | 'status'>): string | null {
  if (plan.reviewState === 'needs_review') return 'wait_review'
  switch (plan.status) {
    case 'draft':
      return 'create_plan'
    case 'scheduled':
      return 'view_logs'
    case 'executing':
    case 'cancelling':
      return 'view_logs'
    case 'partial':
    case 'failed':
      return 'retry'
    case 'completed':
    case 'cancelled':
      return null
    default:
      return null
  }
}

/* ── 创建（FR-C1 / FR-R1 / FR-R3 / PB8 / PB12）── */

export interface PlanItemInput {
  platform: Platform
  accountId: string
  title?: string
  description?: string
  tags?: string[]
}

export interface CreatePlanInput {
  copyId: string
  /** 剪辑模块 PB4 升级（FR-X2）：可选。缺省 = copy 下最新过审成片，回落最新基础视频；显式给出 = 该 job 过审成片优先、回落该 base */
  videoJobId?: string | null
  items: PlanItemInput[]
  scheduledAt?: string | null
  aigcFlag?: boolean
}

export async function createPlan(input: CreatePlanInput, operator: string): Promise<{ plan: PublishPlan; logs: PublishLog[] }> {
  if (!input.items?.length) throw err.badRequest('至少选择一个发布平台与账号')

  // ① 文案已过审（PB12 / FR-X1 数据源）
  const approved = await getApprovedCopy(input.copyId)
  const line = (approved.persona.line || 'persona') as PersonaLine

  // ② FR-R3：人物授权 / 可用性核验（复用人物库 readiness 硬检查）
  if (approved.persona.id) {
    const readiness = await checkReadiness(approved.persona.id, 'copy')
    if (!readiness.pass) {
      const failMsg = readiness.checks.filter((c) => c.level === 'hard' && !c.pass).map((c) => c.message).join('；')
      throw err.personaNotReady(`人物尚未就绪，不能发布：${failMsg}`, { personaId: approved.persona.id, checks: readiness.checks })
    }
  }

  // ③ 发布输入解析（FR-X2 / 剪辑任务书 EC11）：优先过审成片，回落基础视频；base_video_version_no 记实际输入版本号
  const { resolvePublishInput } = await import('../cut/service.js')
  const { getBaseVideo } = await import('../video/base.js')
  const resolved = await resolvePublishInput(input.copyId, input.videoJobId ?? null)
  if (resolved.source === 'base') {
    const base = await getBaseVideo(resolved.videoJobId)
    if (base.copyId !== input.copyId) throw err.badRequest('基础视频与文案不匹配')
  }
  const inputVersionNo = resolved.versionNo

  // ④ 逐项校验：矩阵 / 账号状态 / 每日上限
  const db = getDb()
  const now = new Date()
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw err.badRequest('定时时间格式无效')
  const plannedPerAccount = new Map<string, number>()
  for (const item of input.items) {
    if (!isPlatformAllowed(line, item.platform)) {
      throw err.platformLineForbidden(`${line === 'manager' ? '经理 IP' : line === 'kos' ? '员工 KOS' : '素人矩阵'}不可发布到该平台`, {
        line,
        platform: item.platform,
      })
    }
    const account = await requireAccount(item.accountId)
    if (account.platform !== item.platform) throw err.badRequest('账号与平台不匹配')
    if (!account.enabled) throw err.accountNotActive('账号已停用', { accountId: account.id })
    if (account.loginStatus !== 'active') {
      throw err.accountNotActive(`账号未就绪（${account.loginStatus}），不能用于发布`, { accountId: account.id, loginStatus: account.loginStatus })
    }
    const used = (await publishedTodayOf(account.id)) + (plannedPerAccount.get(account.id) ?? 0)
    if (used >= config.publish.dailyLimitPerAccount) {
      throw err.publishRateLimited(`账号「${account.displayName}」今日发布数已达上限（${config.publish.dailyLimitPerAccount}）`, {
        accountId: account.id,
        used,
      })
    }
    plannedPerAccount.set(account.id, (plannedPerAccount.get(account.id) ?? 0) + 1)
  }

  // ⑤ 实质修改判定（FR-R1）：各 item 标题与文案已通过版本标题比对；封面自定义即视为变更
  const baseTitleHash = titleHashOf(approved.title)
  const perItemReview = input.items.map((item) => {
    const titleChanged = item.title ? titleHashOf(item.title) !== baseTitleHash : false
    const coverChanged = false // 一期 items 不带封面覆盖；封面在计划级（coverSource=custom 即变更）
    return { item, changed: titleChanged || coverChanged }
  })
  const anyChanged = perItemReview.some((x) => x.changed)
  if (scheduledAt && scheduledAt.getTime() < now.getTime() + config.publish.minScheduleAheadMs) {
    throw err.badRequest('定时时间须晚于当前时间 1 分钟以上')
  }

  const planId = newId('pplan')
  const nowDb = toDb(now)
  const reviewState = anyChanged ? 'needs_review' : 'none'
  const planStatus = scheduledAt ? 'scheduled' : 'draft'
  await db.run(
    'INSERT INTO `publish_plan` (`id`, `copy_id`, `copy_version_id`, `video_job_id`, `base_video_version_no`, `title`, `description`, `tags`, `cover_source`, `title_hash`, `review_state`, `status`, `scheduled_at`, `created_by`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      planId,
      input.copyId,
      approved.versionId,
      resolved.videoJobId,
      inputVersionNo,
      String(input.items[0]?.title ?? approved.title).slice(0, 255),
      input.items[0]?.description ?? null,
      JSON.stringify(input.items[0]?.tags ?? []),
      'first_frame',
      baseTitleHash,
      reviewState,
      planStatus,
      scheduledAt ? toDb(scheduledAt) : null,
      operator,
      nowDb,
      nowDb,
    ],
  )

  const logs: PublishLog[] = []
  for (const { item } of perItemReview) {
    const logId = newId('plog')
    await db.run(
      'INSERT INTO `publish_log` (`id`, `plan_id`, `platform`, `account_id`, `source`, `status`, `attempt`, `title`, `description`, `tags`, `scheduled_at`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
      [
        logId,
        planId,
        item.platform,
        item.accountId,
        'auto',
        'scheduled',
        item.title ?? null,
        item.description ?? null,
        JSON.stringify(item.tags ?? []),
        scheduledAt ? toDb(scheduledAt) : null,
        nowDb,
        nowDb,
      ],
    )
    const logRow = await db.get<Record<string, any>>('SELECT * FROM `publish_log` WHERE `id` = ?', [logId])
    if (logRow) logs.push(mapLog(logRow))
  }

  await recordOperation({
    operator,
    action: 'publish.plan.create',
    targetType: 'publish_plan',
    targetId: planId,
    detail: {
      copyId: input.copyId,
      videoJobId: resolved.videoJobId,
      items: input.items.length,
      reviewState,
      scheduled: !!scheduledAt,
    },
  })
  logger.info({ planId, items: input.items.length, reviewState }, 'publish.plan.created')
  return { plan: await requirePlan(planId), logs }
}

/* ── 排期 / 立即执行（FR-C3）── */

async function assertExecutable(plan: PublishPlan): Promise<void> {
  if (plan.reviewState === 'needs_review') throw err.reviewRequired()
  if (!['draft', 'scheduled'].includes(plan.status)) {
    throw err.invalidState(`当前状态（${plan.status}）不可排期执行`)
  }
}

export async function schedulePlan(id: string, scheduledAtIso: string, operator: string): Promise<PublishPlan> {
  const plan = await requirePlan(id)
  await assertExecutable(plan)
  const t = new Date(scheduledAtIso)
  if (Number.isNaN(t.getTime())) throw err.badRequest('定时时间格式无效')
  if (t.getTime() < Date.now() + config.publish.minScheduleAheadMs) throw err.badRequest('定时时间须晚于当前时间 1 分钟以上')
  const db = getDb()
  const nowDb = toDb(utcNow())
  await db.run("UPDATE `publish_plan` SET `status` = 'scheduled', `scheduled_at` = ?, `updated_at` = ? WHERE `id` = ? AND `status` IN ('draft','scheduled')", [
    toDb(t),
    nowDb,
    id,
  ])
  await db.run("UPDATE `publish_log` SET `scheduled_at` = ?, `updated_at` = ? WHERE `plan_id` = ? AND `status` = 'scheduled'", [toDb(t), nowDb, id])
  await recordOperation({ operator, action: 'publish.plan.schedule', targetType: 'publish_plan', targetId: id, detail: { scheduledAt: toDb(t) } })
  return requirePlan(id)
}

export async function executeNow(id: string, operator: string): Promise<PublishPlan> {
  const plan = await requirePlan(id)
  await assertExecutable(plan)
  const db = getDb()
  const nowDb = toDb(utcNow())
  await db.run("UPDATE `publish_plan` SET `status` = 'scheduled', `scheduled_at` = ?, `updated_at` = ? WHERE `id` = ? AND `status` IN ('draft','scheduled')", [
    nowDb,
    nowDb,
    id,
  ])
  await db.run("UPDATE `publish_log` SET `scheduled_at` = ?, `updated_at` = ? WHERE `plan_id` = ? AND `status` = 'scheduled'", [nowDb, nowDb, id])
  // 立即入队（sweep 也会兜底扫描）
  const logs = await getLogs(id)
  for (const log of logs) {
    if (log.status !== 'scheduled') continue
    await enqueue(QUEUE_NAMES.publishExecute, 'execute', { logId: log.id }, {
      deduplication: { id: `pub-execute-${log.id}-${log.attempt}` },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    }).catch((e) => logger.error({ err: (e as Error).message, logId: log.id }, 'publish.execute.enqueue_failed'))
  }
  await recordOperation({ operator, action: 'publish.plan.execute_now', targetType: 'publish_plan', targetId: id })
  return requirePlan(id)
}

/* ── 复审确认（FR-R2）── */

export async function reviewConfirm(id: string, operator: string): Promise<PublishPlan> {
  const plan = await requirePlan(id)
  if (plan.reviewState !== 'needs_review') throw err.invalidState('该计划无需复审确认')
  const db = getDb()
  await db.run("UPDATE `publish_plan` SET `review_state` = 'confirmed', `review_by` = ?, `review_at` = ?, `updated_at` = ? WHERE `id` = ?", [
    operator,
    toDb(utcNow()),
    toDb(utcNow()),
    id,
  ])
  await recordOperation({ operator, action: 'publish.plan.review_confirm', targetType: 'publish_plan', targetId: id, detail: { title: plan.title } })
  return requirePlan(id)
}

/* ── 取消（FR-C4）── */

const ACTIVE_LOG_STATUSES = ['scheduled', 'uploading', 'confirming', 'verification_required']

export async function cancelPlan(id: string, operator: string): Promise<PublishPlan> {
  const plan = await requirePlan(id)
  const db = getDb()
  const nowDb = toDb(utcNow())
  if (['draft', 'scheduled'].includes(plan.status)) {
    await db.run("UPDATE `publish_plan` SET `status` = 'cancelled', `completed_at` = ?, `updated_at` = ? WHERE `id` = ?", [nowDb, nowDb, id])
    await db.run("UPDATE `publish_log` SET `status` = 'cancelled', `finished_at` = ?, `updated_at` = ? WHERE `plan_id` = ? AND `status` IN ('scheduled')", [nowDb, nowDb, id])
    await recordOperation({ operator, action: 'publish.plan.cancel', targetType: 'publish_plan', targetId: id })
    return requirePlan(id)
  }
  if (['executing', 'cancelling'].includes(plan.status)) {
    await db.run("UPDATE `publish_plan` SET `status` = 'cancelling', `updated_at` = ? WHERE `id` = ? AND `status` = 'executing'", [nowDb, id])
    await db.run("UPDATE `publish_log` SET `status` = 'cancelled', `finished_at` = ?, `updated_at` = ? WHERE `plan_id` = ? AND `status` = 'scheduled'", [nowDb, nowDb, id])
    await recordOperation({ operator, action: 'publish.plan.cancel', targetType: 'publish_plan', targetId: id, detail: { phase: 'executing' } })
    await settlePlan(id)
    return requirePlan(id)
  }
  throw err.publishPlanNotCancellable(`当前状态（${plan.status}）不可取消`)
}

/** 终态收敛：全部记录终态时按结果落 completed / partial / failed；cancelling → partial（有 published）| cancelled */
export async function settlePlan(planId: string): Promise<void> {
  const db = getDb()
  const plan = await getPlan(planId)
  if (!plan || ['completed', 'failed', 'cancelled'].includes(plan.status)) return
  const logs = await getLogs(planId)
  if (logs.some((l) => ACTIVE_LOG_STATUSES.includes(l.status))) return
  const nowDb = toDb(utcNow())
  const published = logs.filter((l) => l.status === 'published').length
  let next: 'completed' | 'partial' | 'failed' | 'cancelled'
  if (plan.status === 'cancelling') {
    next = published > 0 ? 'partial' : 'cancelled'
  } else if (published === logs.length && logs.length > 0) {
    next = 'completed'
  } else if (published > 0) {
    next = 'partial'
  } else {
    next = 'failed'
  }
  await db.run('UPDATE `publish_plan` SET `status` = ?, `completed_at` = ?, `updated_at` = ? WHERE `id` = ?', [next, nowDb, nowDb, planId])
  logger.info({ planId, from: plan.status, to: next, published, total: logs.length }, 'publish.plan.settled')
}
