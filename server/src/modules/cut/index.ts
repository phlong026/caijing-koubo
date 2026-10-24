import { logger } from '../../log.js'
import { registerCutRoutes } from './routes.js'
import { registerCutWorker, scheduleCutSweep, reconcileCuts } from './worker.js'
import { detectMediaEnv } from './engine.js'
import type { FastifyInstance } from 'fastify'

/**
 * 视频剪辑模块装配（任务书 CE0~CE4）。
 * 路由在 routes.ts 的 registerRoutes 统一注册；此处装配异步链路：
 *  - video-cut worker（渲染流水线，并发 = CUT_WORKER_CONCURRENCY）；
 *  - video-cut-sweep（超时兜底 / cancelling 收尾 / queued 重投）；
 *  - 启动 reconcile（FR-J3：queued 重投续跑）；
 *  - 媒体环境探测（AC-0.2：缺 libass/drawtext 时 warn 并降级 mock）。
 */
export async function registerCutModule(app?: FastifyInstance): Promise<void> {
  registerCutWorker()
  await scheduleCutSweep()
  await reconcileCuts().catch((e) => logger.error({ err: (e as Error).message }, 'cut.reconcile_failed'))
  void detectMediaEnv().catch(() => undefined)
  void app
}

export { registerCutRoutes }
