import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { recordOperation } from '../audit/repo.js'
import { createDraftsFromTopics } from '../copy-contract/service.js'
import { enqueueGeneration } from './jobs.js'
import {
  archiveTopic,
  assignPersonas,
  createTemplate,
  deleteTemplate,
  getBatch,
  listTemplates,
  listTopics,
  updateTemplate,
} from './repo.js'
import { startGeneration } from './service.js'

export function registerTopicRoutes(app: FastifyInstance): void {
  /** FR-N4 生成候选（异步任务，前端可离开页面） */
  app.post('/topics/generate', async (req, reply) => {
    const body = (req.body ?? {}) as {
      newsIds?: string[]
      personaIds?: string[]
      countPer?: number
      templateId?: string
    }
    const newsIds = Array.isArray(body.newsIds) ? body.newsIds : []
    const personaIds = Array.isArray(body.personaIds) ? body.personaIds : []
    if (newsIds.length < 1 || newsIds.length > 10) throw err.badRequest('每次请选择 1~10 条资讯')
    const countPer = Number(body.countPer ?? 3)
    if (!Number.isFinite(countPer) || countPer < 1 || countPer > 10) throw err.badRequest('生成数量需在 1~10 之间')

    const { batchId, expected } = await startGeneration({
      newsIds,
      personaIds,
      countPer,
      templateId: body.templateId ?? null,
      operator: req.operator,
    })
    await enqueueGeneration(batchId)
    return reply.status(202).send(ok({ batchId, expected }))
  })

  /** 批次状态与结果（前端轮询） */
  app.get('/topics/batches/:id', async (req) => {
    const { id } = req.params as { id: string }
    const batch = await getBatch(id)
    if (!batch) throw err.notFound('批次不存在')
    return ok(batch)
  })

  /** FR-N5 候选列表 */
  app.get('/topics', async (req) => ok(await listTopics((req.query ?? {}) as Record<string, unknown>)))

  /** FR-N5 分配人物 / 归档 */
  app.patch('/topics/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { personaIds?: string[]; status?: string }
    if (body.status === 'archived') {
      const t = await archiveTopic(id)
      await recordOperation({ operator: req.operator, action: 'topic.archive', targetType: 'topic', targetId: id })
      return ok(t)
    }
    if (!Array.isArray(body.personaIds)) throw err.badRequest('personaIds 必须是数组')
    const t = await assignPersonas(id, body.personaIds)
    await recordOperation({
      operator: req.operator,
      action: 'topic.assign',
      targetType: 'topic',
      targetId: id,
      detail: { personaIds: body.personaIds },
    })
    return ok(t)
  })

  /** FR-C3 前端唯一入口：候选送入文案工坊 */
  app.post('/topics/send', async (req) => {
    const body = (req.body ?? {}) as { topicIds?: string[] }
    const topicIds = Array.isArray(body.topicIds) ? body.topicIds : []
    if (!topicIds.length) throw err.badRequest('请先勾选候选选题')
    const res = await createDraftsFromTopics({ topicIds, operator: req.operator })
    await recordOperation({
      operator: req.operator,
      action: 'topic.send',
      targetType: 'topic',
      detail: { topicIds, created: res.created },
    })
    return ok(res)
  })

  /* ── FR-C2 提示词模板 CRUD ─────────────────────────────────────── */
  app.get('/topic-templates', async () => ok(await listTemplates()))

  app.post('/topic-templates', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; content?: string; isDefault?: boolean }
    if (!body.name || !body.content) throw err.badRequest('名称与内容必填')
    const t = await createTemplate({
      name: body.name,
      content: body.content,
      isDefault: !!body.isDefault,
      createdBy: req.operator,
    })
    await recordOperation({
      operator: req.operator,
      action: 'template.save',
      targetType: 'template',
      targetId: t.id,
      detail: { name: t.name },
    })
    return reply.status(201).send(ok(t))
  })

  app.put('/topic-templates/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { name?: string; content?: string; isDefault?: boolean }
    const t = await updateTemplate(id, body)
    await recordOperation({
      operator: req.operator,
      action: 'template.save',
      targetType: 'template',
      targetId: id,
      detail: body,
    })
    return ok(t)
  })

  app.delete('/topic-templates/:id', async (req) => {
    const { id } = req.params as { id: string }
    await deleteTemplate(id)
    await recordOperation({ operator: req.operator, action: 'template.delete', targetType: 'template', targetId: id })
    return ok({ ok: true })
  })
}
