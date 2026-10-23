import fsp from 'node:fs/promises'
import path from 'node:path'
import axios from 'axios'
import { getDb } from '../../db/index.js'
import { toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { config, paths } from '../../config.js'
import { downloadObjectToFile } from '../../integrations/aliyun-oss/client.js'
import { recordOperation } from '../audit/repo.js'
import { resolvePublishEngine, type EnginePublishResult } from './engine.js'
import { casLogStatus } from './execute-shared.js'
import { requireAccount } from './accounts.js'
import { requirePlan, settlePlan } from './plans.js'
import { checkReadiness } from '../personas/readiness.js'
import type { PlatformAccount } from './types.js'

/**
 * 发布执行 worker（FR-E1~E4 / PB9 上下文池 / §3.4）。
 *
 * 单条记录生命周期：CAS scheduled→uploading（attempt+1）→ 引擎 publish（onPhase 回调
 * uploading→confirming）→ 三态落库 → settlePlan。失败 attempt=1 写 retry_at（sweep 到期重试）。
 * 上下文池：全局并发 maxContexts + 同账号互斥（登录会话/检测/发布互斥，防同账号并发触发风控）。
 */

/* ── 上下文池（Semaphore + 账号互斥）── */

class Semaphore {
  private running = 0
  private waiters: Array<() => void> = []
  constructor(private readonly max: number) {}
  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.running < this.max) {
      this.running += 1
      return true
    }
    let releaseFn: (() => void) | undefined
    const granted = new Promise<boolean>((resolve) => {
      releaseFn = () => resolve(true)
      this.waiters.push(releaseFn)
    })
    const ok = await Promise.race([granted, new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))])
    if (!ok) {
      // 超时退出：把自己从队列移除，避免空占名额
      const idx = releaseFn ? this.waiters.indexOf(releaseFn) : -1
      if (idx >= 0) this.waiters.splice(idx, 1)
      return false
    }
    return true // 名额由 release() 直接移交，running 不变
  }
  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next() // 名额直接移交给下一个等待者
      return
    }
    this.running = Math.max(0, this.running - 1)
  }
  get size(): number {
    return this.running
  }
}

const pool = new Semaphore(config.publish.maxContexts)
const accountLocks = new Map<string, Promise<unknown>>()

/** 同账号互斥：串行化同一账号的引擎操作 */
async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(accountId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  accountLocks.set(
    accountId,
    run.catch(() => undefined),
  )
  try {
    return await run
  } finally {
    if (accountLocks.get(accountId) === undefined) accountLocks.delete(accountId)
  }
}

/* ── 基础视频落地（FR-X1 → 本地文件）── */

/** 从 video 模块取 resultKey 并落到临时文件（OSS 直读 / 本地 dataDir/oss 拷贝；mock 产物同路径） */
async function fetchBaseVideoFile(videoJobId: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const { getVideoJob } = await import('../video/repo.js')
  const job = await getVideoJob(videoJobId)
  if (!job?.resultKey) throw err.videoNotReady('基础视频产物不存在或已被清理')
  const ext = path.extname(job.resultKey) || '.mp4'
  const filePath = path.join(paths.tempDir, `publish_${videoJobId}_${Date.now()}${ext}`)
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const { isOssEnabled } = await import('../../integrations/aliyun-oss/client.js')
  if (isOssEnabled()) {
    await downloadObjectToFile(job.resultKey, filePath)
  } else {
    const local = path.join(paths.dataDir, 'oss', job.resultKey)
    await fsp.copyFile(local, filePath)
  }
  const stat = await fsp.stat(filePath)
  if (!stat.size) throw err.mediaEmpty('基础视频文件为空')
  return { filePath, cleanup: () => fsp.unlink(filePath).catch(() => undefined) }
}

/* ── 三态落库（applyEngineResult / failLog 共用 CAS 见 execute-shared）── */

async function failLog(logId: string, code: string, message: string): Promise<void> {
  const attempt = await getAttempt(logId)
  const retryAt = attempt < 2 ? toDb(new Date(Date.now() + config.publish.retryDelayMs)) : null
  const status = attempt < 2 ? 'failed' : 'failed_final'
  await casLogStatus(logId, ['uploading', 'confirming', 'scheduled'], status, [
    ['finished_at', toDb(utcNow())],
    ['error_code', code],
    ['error_message', message.slice(0, 500)],
    ['retry_at', retryAt],
  ])
}

async function getAttempt(logId: string): Promise<number> {
  const row = await getDb().get<{ attempt: number }>('SELECT `attempt` FROM `publish_log` WHERE `id` = ?', [logId])
  return row?.attempt ?? 0
}

/* ── 执行入口（publish-execute worker 调用）── */

export async function executePublishLog(logId: string): Promise<void> {
  const db = getDb()
  const logRow = await db.get<Record<string, any>>('SELECT * FROM `publish_log` WHERE `id` = ?', [logId])
  if (!logRow) return
  const planId = logRow.plan_id as string | null
  const plan = planId ? await requirePlan(planId).catch(() => null) : null

  // 取消标记：计划在 cancelling 时未开跑的记录直接取消
  if (plan && plan.status === 'cancelling') {
    await casLogStatus(logId, ['scheduled'], 'cancelled', [['finished_at', toDb(utcNow())]])
    await settlePlan(planId!)
    return
  }

  // CAS 领取：scheduled → uploading，attempt+1
  const attempt = await getAttempt(logId)
  const claimed = await db.run(
    "UPDATE `publish_log` SET `status` = 'uploading', `attempt` = ?, `started_at` = ?, `updated_at` = ? WHERE `id` = ? AND `status` = 'scheduled'",
    [attempt + 1, toDb(utcNow()), toDb(utcNow()), logId],
  )
  if ((claimed as unknown as { changes?: number })?.changes === 0) return // 并发双跑只成功一次（AC-E1）

  const account = await requireAccount(String(logRow.account_id)).catch(() => null)

  const guarded = await pool.acquire(config.publish.acquireTimeoutMs)
  if (!guarded) {
    // 排队超时回 scheduled 下轮再试（不失败、不计 attempt 浪费——attempt 已 +1，重试时按当前值续）
    await casLogStatus(logId, ['uploading'], 'scheduled', [['started_at', null]])
    logger.warn({ logId }, 'publish.execute.pool_timeout_requeued')
    return
  }

  try {
    if (!account) {
      await failLog(logId, 'ACCOUNT_NOT_FOUND', '发布账号不存在或已删除')
      return
    }
    await withAccountLock(account.id, () => runPublish(logId, account, logRow, plan))
  } finally {
    pool.release()
    if (planId) await settlePlan(planId).catch((e) => logger.error({ err: (e as Error).message, planId }, 'publish.settle_failed'))
  }
}

async function runPublish(
  logId: string,
  account: PlatformAccount,
  logRow: Record<string, any>,
  plan: Awaited<ReturnType<typeof requirePlan>> | null,
): Promise<void> {
  const db = getDb()
  try {
    // ① 登录态复检（FR-L4）
    if (account.loginStatus !== 'active') {
      await failLog(logId, 'LOGIN_EXPIRED', '账号登录态已失效，请重新扫码登录后再发布')
      return
    }
    // ② FR-R3 执行前人物授权复检
    if (plan) {
      const approved = await import('../copy/review.js').then((m) => m.getApprovedCopy(plan.copyId).catch(() => null))
      if (approved?.persona.id) {
        const readiness = await checkReadiness(approved.persona.id, 'copy')
        if (!readiness.pass) {
          const failMsg = readiness.checks.filter((c) => c.level === 'hard' && !c.pass).map((c) => c.message).join('；')
          await failLog(logId, 'PERSONA_NOT_READY', `人物授权或状态失效：${failMsg}`)
          return
        }
      }
    }
    // ③ 基础视频落地
    const videoJobId = plan?.videoJobId
    if (!videoJobId) {
      await failLog(logId, 'VIDEO_NOT_READY', '发布计划缺少基础视频')
      return
    }
    const { filePath, cleanup } = await fetchBaseVideoFile(videoJobId)
    try {
      // ④ 引擎发布（确认窗口内自轮询；onPhase CAS uploading→confirming）
      const engine = resolvePublishEngine()
      const result: EnginePublishResult = await engine.publish(account, {
        videoPath: filePath,
        coverPath: null, // 一期首帧由平台取视频首帧；自定义封面 PU5 接入
        title: String(logRow.title ?? plan?.title ?? ''),
        description: String(logRow.description ?? plan?.description ?? ''),
        tags: safeParseTags(logRow.tags),
        aigcFlag: true, // PB7：AI 内容自标识，平台不支持时引擎内降级
        confirmTimeoutMs: config.publish.confirmTimeoutMs,
        refId: logId,
        onPhase: (phase) => {
          if (phase === 'confirming') {
            void casLogStatus(logId, ['uploading'], 'confirming').catch(() => undefined)
          }
        },
      })
      await applyEngineResult(logId, result)
    } finally {
      await cleanup()
    }
  } catch (e) {
    const msg = (e as Error).message || '发布执行异常'
    logger.error({ err: msg, logId, accountId: account.id }, 'publish.execute.error')
    // 引擎异常（含上下文创建失败）：attempt=1 且可重试 → failed+retry_at；否则 failed_final
    await failLog(logId, 'PUBLISH_ENGINE_ERROR', msg)
  }
}

async function applyEngineResult(logId: string, result: EnginePublishResult): Promise<void> {
  if (result.status === 'published') {
    await casLogStatus(logId, ['uploading', 'confirming'], 'published', [
      ['finished_at', toDb(utcNow())],
      ['video_url', result.videoUrl ?? null],
      ['external_video_id', result.externalVideoId ?? null],
      ['error_code', null],
      ['error_message', null],
    ])
    return
  }
  if (result.status === 'verification_required') {
    const window = toDb(new Date(Date.now() + config.publish.manualWindowMs))
    await casLogStatus(logId, ['uploading', 'confirming'], 'verification_required', [
      ['window_expires_at', window],
      ['error_message', (result.message ?? '').slice(0, 500)],
    ])
    return
  }
  if (result.status === 'manual_pending') {
    await casLogStatus(logId, ['uploading', 'confirming'], 'manual_pending', [
      ['finished_at', toDb(utcNow())],
      ['error_message', (result.message ?? '').slice(0, 500)],
    ])
    return
  }
  // failed：attempt=1 → failed + retry_at；attempt≥2 → failed_final
  const attempt = await getAttempt(logId)
  const retryAt = attempt < 2 ? toDb(new Date(Date.now() + config.publish.retryDelayMs)) : null
  await casLogStatus(logId, ['uploading', 'confirming'], attempt < 2 ? 'failed' : 'failed_final', [
    ['finished_at', toDb(utcNow())],
    ['error_code', result.errorCode ?? 'PUBLISH_FAILED'],
    ['error_message', (result.message ?? '发布失败').slice(0, 500)],
    ['retry_at', retryAt],
  ])
}

function safeParseTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v) {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return []
}

/** PU5：单独重发（FR-S2）——sweep/路由共用 */
export async function retryLog(logId: string, operator: string): Promise<void> {
  const db = getDb()
  const row = await db.get<Record<string, any>>('SELECT * FROM `publish_log` WHERE `id` = ?', [logId])
  if (!row) throw err.publishLogNotFound()
  if (!['failed_final', 'manual_pending', 'cancelled', 'failed'].includes(String(row.status))) {
    throw err.publishLogNotRetryable(`当前状态（${row.status}）不可重发`)
  }
  const attempt = Number(row.attempt ?? 0)
  const ok = await casLogStatus(
    logId,
    ['failed_final', 'manual_pending', 'cancelled', 'failed'],
    'scheduled',
    [['attempt', attempt], ['retry_at', null], ['error_code', null], ['error_message', null], ['finished_at', null]],
  )
  if (!ok) throw err.publishLogNotRetryable()
  // schedule 到下一 sweep 周期（scheduled_at = now）
  await db.run("UPDATE `publish_log` SET `scheduled_at` = ?, `updated_at` = ? WHERE `id` = ?", [toDb(utcNow()), toDb(utcNow()), logId])
  await recordOperation({ operator, action: 'publish.log.retry', targetType: 'publish_log', targetId: logId })
}

/** verification_required 重新检测（FR-S3）：mock/真实引擎复核页面状态；成功 → published，仍在验证 → 延长窗口 */
export async function recheckLog(logId: string, operator: string): Promise<{ status: string }> {
  const db = getDb()
  const row = await db.get<Record<string, any>>('SELECT * FROM `publish_log` WHERE `id` = ?', [logId])
  if (!row) throw err.publishLogNotFound()
  if (row.status !== 'verification_required') throw err.publishLogNotRetryable('仅验证中的记录可重新检测')
  // 重新检测 = 再次走引擎确认逻辑；mock 直接按注入或成功处理
  const result = await resolvePublishEngine().publish(await requireAccount(String(row.account_id)), {
    videoPath: '', // 复检不重新上传：真实引擎实现为「确认页状态检查」，不重传
    coverPath: null,
    title: String(row.title ?? ''),
    description: '',
    tags: [],
    aigcFlag: false,
    confirmTimeoutMs: 30000,
    refId: logId,
  })
  if (result.status === 'published') {
    await applyEngineResult(logId, result)
    await recordOperation({ operator, action: 'publish.log.recheck', targetType: 'publish_log', targetId: logId, detail: { result: 'published' } })
    return { status: 'published' }
  }
  // 仍在验证：延长人工窗口
  await db.run('UPDATE `publish_log` SET `window_expires_at` = ?, `updated_at` = ? WHERE `id` = ?', [
    toDb(new Date(Date.now() + config.publish.manualWindowMs)),
    toDb(utcNow()),
    logId,
  ])
  await recordOperation({ operator, action: 'publish.log.recheck', targetType: 'publish_log', targetId: logId, detail: { result: 'still_verifying' } })
  return { status: 'verification_required' }
}

/** 人工结果标记（FR-S4） */
export async function markManualResult(
  logId: string,
  result: { published: boolean; videoUrl?: string; reason?: string },
  operator: string,
): Promise<void> {
  const db = getDb()
  const row = await db.get<Record<string, any>>('SELECT * FROM `publish_log` WHERE `id` = ?', [logId])
  if (!row) throw err.publishLogNotFound()
  if (row.status !== 'manual_pending' && row.status !== 'verification_required') {
    throw err.publishLogNotRetryable('仅人工待处理 / 验证中的记录可人工标记')
  }
  if (!result.published && !String(result.reason ?? '').trim()) throw err.badRequest('标记失败必须填写原因')
  if (result.published) {
    await casLogStatus(logId, ['manual_pending', 'verification_required'], 'published', [
      ['finished_at', toDb(utcNow())],
      ['video_url', result.videoUrl ?? null],
      ['error_message', null],
    ])
  } else {
    await casLogStatus(logId, ['manual_pending', 'verification_required'], 'failed_final', [
      ['finished_at', toDb(utcNow())],
      ['error_code', 'PUBLISH_MANUAL_FAILED'],
      ['error_message', String(result.reason).slice(0, 500)],
    ])
  }
  await recordOperation({
    operator,
    action: 'publish.log.manual_result',
    targetType: 'publish_log',
    targetId: logId,
    detail: { published: result.published, reason: result.reason ?? null },
  })
  if (row.plan_id) await settlePlan(String(row.plan_id))
}

/** 上下文池观测（/publish/options 扩展用） */
export function poolStats(): { running: number; max: number } {
  return { running: pool.size, max: config.publish.maxContexts }
}
