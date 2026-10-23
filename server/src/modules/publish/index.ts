import { enqueue, getQueueBackend, QUEUE_NAMES, registerWorker, scheduleRepeatable } from '../../queue/index.js'
import { logger } from '../../log.js'
import { registerPublishRoutes } from './routes.js'
import { pollLoginSession, expireStaleSessions, sweepDueSessions } from './login.js'
import { executePublishLog } from './execute.js'
import { sweepPublishLogs } from './sweep.js'
import type { FastifyInstance } from 'fastify'

/**
 * 发布管理模块装配（PU0/PU1：账号域；PU4 扩展 execute worker 与发布 sweep 职责）。
 *
 * ⚠️ memScheduleRepeatable 每队列只支持一个 timer（第二个会 clearInterval 覆盖第一个），
 * 因此 publishSweep 只挂一个 15 秒调度器；60 秒级的 main 职责（会话过期兜底，PU4 起兼管
 * 发布到期 / 重试 / 人工窗口 / 卡死守护）用时间节流在 worker 内分频——与人物库
 * 「单一 worker 兼管扫描与清理」的先例一致。
 */

const SWEEP_MS = 15000
const MAIN_SWEEP_EVERY_MS = 60000
let lastMainSweepAt = 0

async function runLoginSweep(): Promise<void> {
  const due = await sweepDueSessions()
  for (const sessionId of due) {
    await enqueue(QUEUE_NAMES.publishLogin, 'poll', { sessionId }).catch((e) =>
      logger.error({ err: (e as Error).message, sessionId }, 'publish.login.enqueue_failed'),
    )
  }
  const expired = await expireStaleSessions()
  if (due.length || expired) logger.info({ due: due.length, expired }, 'publish.login.sweep')
}

export async function registerPublishModule(app?: FastifyInstance): Promise<void> {
  void app
  registerWorker(QUEUE_NAMES.publishLogin, async (job: { name: string; data: { sessionId?: string } }) => {
    const sessionId = job?.data?.sessionId
    if (!sessionId) return
    await pollLoginSession(sessionId).catch((e) =>
      logger.error({ err: (e as Error).message, sessionId }, 'publish.login.poll_failed'),
    )
  })

  registerWorker(QUEUE_NAMES.publishExecute, async (job: { name: string; data: { logId?: string } }) => {
    const logId = job?.data?.logId
    if (!logId) return
    await executePublishLog(logId).catch((e) =>
      logger.error({ err: (e as Error).message, logId }, 'publish.execute.job_failed'),
    )
  })

  registerWorker(QUEUE_NAMES.publishSweep, async () => {
    await runLoginSweep().catch((e) => logger.error({ err: (e as Error).message }, 'publish.login_sweep_failed'))
    if (Date.now() - lastMainSweepAt >= MAIN_SWEEP_EVERY_MS) {
      lastMainSweepAt = Date.now()
      await expireStaleSessions().catch((e) => logger.error({ err: (e as Error).message }, 'publish.session_sweep_failed'))
      // 发布记录调度：到期入队 / 重试 / 窗口超时 / 卡死兜底 / 计划收敛（§3.5）
      await sweepPublishLogs().catch((e) => logger.error({ err: (e as Error).message }, 'publish.main_sweep_failed'))
    }
  })

  // scheduleRepeatable 内置 memory 降级；「周期一致即保持」幂等由其内部保证
  await scheduleRepeatable(QUEUE_NAMES.publishSweep, 'publish-sweep', SWEEP_MS, 'sweep')
}

export { registerPublishRoutes }
