import { enqueue, QUEUE_NAMES } from '../../queue/index.js'
import { toDb, utcNow } from '../../lib/time.js'
import { logger } from '../../log.js'
import { getDb } from '../../db/index.js'
import { config } from '../../config.js'
import { recordOperation } from '../audit/repo.js'
import { settlePlan } from './plans.js'
import { casLogStatus } from './execute-shared.js'

/**
 * 发布记录 sweep（§3.5，挂在 publishSweep 的 main 职责内，60 秒节流）：
 *  1. scheduled 且到期 → 入 execute 队列（去重键带 attempt）；
 *  2. failed(attempt=1) 且 retry_at 到期 → CAS 回 scheduled 重试一次；
 *  3. verification_required 窗口超时 → manual_pending（真实引擎另需关上下文，PU2 接入）；
 *  4. confirming 卡死超 confirmSweepMs（引擎 15 分钟直落 manual_pending 的兜底）；
 *  5. executing/cancelling 计划的终态收敛与卡死守护。
 */

export async function sweepPublishLogs(): Promise<void> {
  const db = getDb()
  const now = toDb(utcNow())

  // ① 到期记录入队
  const due = await db.all<{ id: string; attempt: number }>(
    "SELECT `id`, `attempt` FROM `publish_log` WHERE `status` = 'scheduled' AND `scheduled_at` IS NOT NULL AND `scheduled_at` <= ? LIMIT 20",
    [now],
  )
  for (const r of due) {
    await enqueue(QUEUE_NAMES.publishExecute, 'execute', { logId: r.id }, {
      deduplication: { id: `pub-execute-${r.id}-${r.attempt}` },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    }).catch((e) => logger.error({ err: (e as Error).message, logId: r.id }, 'publish.sweep.enqueue_failed'))
  }

  // ② 重试到期：failed + retry_at → scheduled（自动重试一次，AC-S1）
  const retries = await db.all<{ id: string; plan_id: string | null }>(
    "SELECT `id`, `plan_id` FROM `publish_log` WHERE `status` = 'failed' AND `retry_at` IS NOT NULL AND `retry_at` <= ? LIMIT 20",
    [now],
  )
  for (const r of retries) {
    const ok = await casLogStatus(r.id, ['failed'], 'scheduled', [['retry_at', null], ['scheduled_at', now]])
    if (ok) {
      await enqueue(QUEUE_NAMES.publishExecute, 'execute', { logId: r.id }, {
        deduplication: { id: `pub-execute-${r.id}-retry-${Date.now()}` },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }).catch((e) => logger.error({ err: (e as Error).message, logId: r.id }, 'publish.sweep.retry_enqueue_failed'))
      logger.info({ logId: r.id, planId: r.plan_id }, 'publish.sweep.auto_retry')
    }
  }

  // ③ 验证窗口超时 → manual_pending
  const windowTimeout = await db.all<{ id: string; plan_id: string | null }>(
    "SELECT `id`, `plan_id` FROM `publish_log` WHERE `status` = 'verification_required' AND `window_expires_at` IS NOT NULL AND `window_expires_at` <= ? LIMIT 20",
    [now],
  )
  for (const r of windowTimeout) {
    const ok = await casLogStatus(r.id, ['verification_required'], 'manual_pending', [
      ['finished_at', now],
      ['error_message', '验证窗口超时，请人工在平台确认发布结果后标记'],
    ])
    if (ok) {
      logger.warn({ logId: r.id, planId: r.plan_id }, 'publish.sweep.window_timeout')
      // PU2：真实引擎接入后在此释放浏览器上下文
    }
  }

  // ④ confirming 卡死兜底（引擎 15 分钟自行落定，此条只兜 worker 崩溃）
  const stuckCutoff = toDb(new Date(Date.now() - config.publish.confirmSweepMs))
  const stuck = await db.all<{ id: string; plan_id: string | null }>(
    "SELECT `id`, `plan_id` FROM `publish_log` WHERE `status` = 'confirming' AND `started_at` IS NOT NULL AND `started_at` <= ? LIMIT 20",
    [stuckCutoff],
  )
  for (const r of stuck) {
    const ok = await casLogStatus(r.id, ['confirming'], 'manual_pending', [
      ['finished_at', now],
      ['error_message', '确认阶段异常中断（服务重启或进程崩溃），请人工确认发布结果'],
    ])
    if (ok) logger.warn({ logId: r.id, planId: r.plan_id }, 'publish.sweep.confirming_stuck')
  }

  // ⑤ 计划收敛：executing/cancelling 且无进行中记录 → 终态；executing 卡死守护
  const plans = await db.all<{ id: string; status: string; updated_at: string }>(
    "SELECT `id`, `status`, `updated_at` FROM `publish_plan` WHERE `status` IN ('executing','cancelling')",
  )
  for (const p of plans) {
    await settlePlan(p.id)
    // 卡死守护：executing 超 planStuckMs 无更新 → 告警（不自动改状态，人工介入）
    if (p.status === 'executing' && p.updated_at <= toDb(new Date(Date.now() - config.publish.planStuckMs))) {
      await recordOperation({
        operator: 'system',
        action: 'publish.plan.stuck',
        targetType: 'publish_plan',
        targetId: p.id,
        detail: { since: p.updated_at },
      })
      logger.error({ planId: p.id, since: p.updated_at }, 'publish.sweep.plan_stuck')
    }
  }

  if (due.length || retries.length || windowTimeout.length || stuck.length) {
    logger.info(
      { due: due.length, retries: retries.length, windowTimeout: windowTimeout.length, stuck: stuck.length },
      'publish.sweep',
    )
  }
}
