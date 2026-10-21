import type { FastifyInstance } from 'fastify'
import { getQueue, QUEUE_NAMES, getQueueBackend, registerWorker } from '../../queue/index.js'
import { memScheduleRepeatable } from '../../queue/memory.js'
import { logger } from '../../log.js'
import { scanAuthExpiry } from './authorizations.js'
import { registerAssetProcessWorker } from './assets/process.js'
import { registerCloneWorker, resumeUncertainSubmissions } from './clone/worker.js'
import { cleanExpiredPreviews } from './clone/voices.js'
import { registerPersonaRoutes } from './routes.js'

/**
 * 人物库模块装配（PL4/PL5）。
 *  - 三个队列的 worker 注册（persona-auth-expiry 单一 worker 兼管扫描与试听清理，
 *    避免内存队列降级时 memRegisterWorker 互相覆盖处理器）；
 *  - 每日 09:00（北京时间 = UTC 01:00）授权到期扫描（FR-U3）；
 *  - 启动时把停留在 submitting 的克隆记录转 uncertain（R9，不重提）。
 */

/** 每日授权到期扫描（北京时间 09:00；BullMQ pattern = UTC 01:00） */
export async function scheduleAuthExpiryScan(): Promise<void> {
  const SCHEDULER_ID = 'persona-auth-expiry-daily'
  if (getQueueBackend() === 'memory') {
    // 内存降级：24 小时周期（启动即跑一次由下面的首次调用保证）
    memScheduleRepeatable(QUEUE_NAMES.personaAuthExpiry, SCHEDULER_ID, 24 * 3600 * 1000, 'scan')
    return
  }
  const q = getQueue(QUEUE_NAMES.personaAuthExpiry)
  const existing = await (q as any)
    .getJobSchedulers()
    .then((list: any[]) => list.find((s) => s.id === SCHEDULER_ID || s.key === SCHEDULER_ID))
    .catch(() => undefined)
  if (existing) {
    logger.info({ schedulerId: SCHEDULER_ID }, 'queue.schedule_kept')
    return
  }
  await (q as any).upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: '0 1 * * *' }, // UTC 01:00 = 北京时间 09:00
    {
      name: 'scan',
      data: {},
      opts: { removeOnComplete: 100, removeOnFail: 200 },
    },
  )
  logger.info({ schedulerId: SCHEDULER_ID, pattern: '0 1 * * *' }, 'queue.scheduled')
}

/** 启动装配：worker + 排期 + submitting 扫描 */
export async function registerPersonaModule(): Promise<void> {
  registerAssetProcessWorker()
  registerCloneWorker()

  // persona-auth-expiry：每日扫描 + 试听缓存清理（同一 worker，按 job.name 分发）
  registerWorker(QUEUE_NAMES.personaAuthExpiry, async (job) => {
    if (job.name === 'scan') {
      const r = await scanAuthExpiry()
      if (r.expiring || r.expired) {
        logger.info({ expiring: r.expiring, expired: r.expired }, 'persona.auth_expiry.scanned')
      }
      return
    }
    if (job.name === 'clean_previews') {
      const n = await cleanExpiredPreviews()
      if (n > 0) logger.info({ removed: n }, 'persona.preview.cleaned')
    }
  })

  await scheduleAuthExpiryScan()
  // 启动即扫描一次（不等首个排期点）；幂等由提醒去重口径保证
  await scanAuthExpiry().catch((e) => logger.error({ err: (e as Error).message }, 'persona.auth_expiry.boot_scan_failed'))
  await resumeUncertainSubmissions()
}

export function registerPersonas(app: FastifyInstance): void {
  registerPersonaRoutes(app)
}
