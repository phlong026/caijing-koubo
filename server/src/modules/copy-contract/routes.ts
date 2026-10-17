import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { createDraftsFromTopics } from './service.js'

/**
 * FR-C3 出口契约：暴露给文案工坊联调，本模块前端不调用
 * （前端唯一入口为 POST /topics/send 与 POST /benchmark/videos/:id/send-to-copy）
 *
 * §12 说明：`GET /copy` 的列表联调接口已**并入文案工坊模块**（`modules/copy/routes.ts`）并扩展筛选，
 * 此处只保留 D12 冻结的送入契约，避免同名路由二义性。
 */
export function registerCopyRoutes(app: FastifyInstance): void {
  app.post('/copy/from-topic', async (req) => {
    const body = (req.body ?? {}) as { topicIds?: string[]; personaIds?: string[] }
    const topicIds = Array.isArray(body.topicIds) ? body.topicIds : []
    if (!topicIds.length) throw err.badRequest('topicIds 必填')
    return ok(await createDraftsFromTopics({ topicIds, personaIds: body.personaIds, operator: req.operator }))
  })
}
