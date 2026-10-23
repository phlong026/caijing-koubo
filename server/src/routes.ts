import type { FastifyInstance } from 'fastify'
import { registerNewsRoutes } from './modules/news/routes.js'
import { registerAuthRoutes } from './modules/auth/routes.js'
import { registerPersonaRoutes } from './modules/personas/routes.js'
import { registerTopicRoutes } from './modules/topics/routes.js'
import { registerCopyRoutes } from './modules/copy-contract/routes.js'
import { registerCopyWorkshopRoutes, registerCopyLlmRoutes } from './modules/copy/routes.js'
import { registerBenchmarkRoutes } from './modules/benchmark/routes.js'
import { registerCostRoutes } from './modules/metrics/routes.js'
import { registerVideoRoutes } from './modules/video/routes.js'
import { registerPublishRoutes } from './modules/publish/index.js'
import { listOperations } from './modules/audit/repo.js'
import { ok } from './app.js'

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  registerAuthRoutes(app)
  registerNewsRoutes(app)
  registerPersonaRoutes(app)
  registerTopicRoutes(app)
  // 注意顺序：文案工坊的 `GET /copy` 会覆盖 copy-contract 的同名联调接口（§12 要求「并入并扩展筛选」）。
  // copy-contract 的 `POST /copy/from-topic` 与文案工坊路由不冲突，两者共存。
  registerCopyWorkshopRoutes(app)
  registerCopyLlmRoutes(app)
  registerCopyRoutes(app)
  registerBenchmarkRoutes(app)
  registerCostRoutes(app)
  registerVideoRoutes(app)
  registerPublishRoutes(app)

  /** D14 操作日志查询（合规审计，仅管理员，见 auth/guard.ROLE_RULES） */
  app.get('/operations', async (req) => ok(await listOperations((req.query ?? {}) as Record<string, unknown>)))
}
