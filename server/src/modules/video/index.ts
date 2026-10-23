import { logger } from '../../log.js'
import { registerVideoWorker, scheduleVideoPollSweep, reconcileVideoJobs } from './worker.js'
import { registerVideoRoutes } from './routes.js'
import type { FastifyInstance } from 'fastify'

/**
 * 视频创作模块装配（任务书 V0~V6）。
 * 路由在 routes.ts 的 registerRoutes 统一注册；此处只装配异步链路：
 *  - video-generate worker（本地阶段：submit / archive / align）；
 *  - video-poll-sweep（waiting 推进 + 生成中轮询，每 VIDEO_POLL_INTERVAL_MS）；
 *  - 启动 reconcile（FR-P6：非终态任务按阶段续跑，绝不重复付费提交）。
 */
export async function registerVideoModule(app?: FastifyInstance): Promise<void> {
  registerVideoWorker()
  await scheduleVideoPollSweep()
  await reconcileVideoJobs().catch((e) => logger.error({ err: (e as Error).message }, 'video.reconcile_failed'))
  void app
}

export { registerVideoRoutes }
