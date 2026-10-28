import { logger } from '../../log.js'
import { registerAnalyticsJobs } from './schedule.js'
import { registerAnalyticsRoutes } from './routes.js'

export { registerAnalyticsRoutes }

/**
 * 数据看板模块装配（DB2）：注册 T+1 / T+7 周期采集任务与 worker。
 * 路由在 routes.ts 由 registerRoutes 统一挂载；本入口只负责异步侧。
 */
export async function registerAnalyticsModule(): Promise<void> {
  await registerAnalyticsJobs()
  logger.info('analytics.module.registered：T+1/T+7 采集任务已注册（一期回采为 CSV 导入）')
}
