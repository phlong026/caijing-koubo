/**
 * 任务中心路由（任务书 §6：两个只读接口，登录即可访问——不在 guard.ROLE_RULES 即默认全角色）。
 */
import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { getTaskDetail, listTasks } from './service.js'

export function registerTaskCenterRoutes(app: FastifyInstance): void {
  app.get('/task-center/tasks', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>
    return ok(
      await listTasks({
        tab: q.tab,
        phase: q.phase,
        status: q.status,
        line: q.line || undefined,
        keyword: q.keyword || undefined,
        page: q.page ? Number(q.page) : undefined,
        pageSize: q.pageSize ? Number(q.pageSize) : undefined,
        operator: req.operator,
      }),
    )
  })

  app.get('/task-center/tasks/:copyId', async (req) => {
    const { copyId } = req.params as { copyId: string }
    return ok(await getTaskDetail(copyId))
  })
}
