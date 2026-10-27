import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { getDb } from '../../db/index.js'
import { err } from '../../errors.js'
import { recordOperation } from '../audit/repo.js'
import { assertPersonasUsable } from '../personas/repo.js'
import { createDraftsFromTopics, createInitialDrafts } from '../copy-contract/service.js'
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
import { getTemplate as getCopyTemplate } from '../copy/repo.js'
import { DEFAULT_COPY_TEMPLATE_ID, personaMethods, unmatchedMixLabels } from './methods.js'
import { getPersonasByIds } from '../personas/repo.js'

/** 选题方法对应的文案模板必须存在且启用，否则送入文案工坊时带不出模板 */
async function assertCopyTemplate(id: string): Promise<string> {
  const t = await getCopyTemplate(id)
  if (!t || !t.enabled) throw err.badRequest('对应的文案模板不存在或已停用，请重新选择', { copyTemplateId: id })
  return id
}

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
    await assertPersonasUsable(body.personaIds.map(String))
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
    // P1-4 补全：原先此处**没有事务**。`createDraftsFromTopics` 内部会先用条件更新
    // 把 topic 置为 sent，再逐条 INSERT copy。若中途某条 INSERT 失败（约束冲突、连接断开），
    // 前面的 topic 已经停在 sent 却没有对应 copy —— 选题在列表里消失，文案工坊里也找不到，
    // 属于不可自愈的数据悬空。包进事务后要么全成，要么全回滚。
    const db = getDb()
    const res = await db.tx(async (t) => createDraftsFromTopics({ topicIds, operator: req.operator, db: t }))
    // P1-10：初始空白稿必须在送入事务提交后创建，且只创建一次
    await createInitialDrafts(res.copyIds, req.operator)
    await recordOperation({
      operator: req.operator,
      action: 'topic.send',
      targetType: 'topic',
      detail: { topicIds, created: res.created },
    })
    return ok(res)
  })

  /**
   * 人物开启的选题方法（选题页下拉、人物页勾选回显共用，规则只在后端 methods.ts 一处）。
   * configured=false 表示人物没勾选，items 为按生产线给的默认可用范围。
   */
  app.get('/topics/persona-methods', async (req) => {
    const raw = String((req.query as { personaIds?: string } | undefined)?.personaIds ?? '')
    const ids = [...new Set(raw.split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 50)
    const [personas, methods] = await Promise.all([getPersonasByIds(ids), listTemplates()])
    const out: Record<string, { configured: boolean; items: Array<{ methodId: string; ratio: number | null }>; unmatched: string[] }> = {}
    for (const p of personas) {
      const mix = p.ipProfile.contentMix ?? []
      const r = personaMethods({ line: p.line, contentMix: mix }, methods)
      out[p.id] = {
        configured: r.configured,
        // 只回显人物真实填写的比例（多个旧标签指向同一方法时已合并）；未填为 null
        items: r.items.map((x) => ({ methodId: x.method.id, ratio: x.ratio ?? null })),
        unmatched: unmatchedMixLabels(mix, methods),
      }
    }
    return ok(out)
  })

  /* ── FR-C2 提示词模板 CRUD ─────────────────────────────────────── */
  app.get('/topic-templates', async () => ok(await listTemplates()))

  app.post('/topic-templates', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; content?: string; isDefault?: boolean; copyTemplateId?: string }
    if (!body.name || !body.content) throw err.badRequest('名称与内容必填')
    const t = await createTemplate({
      name: body.name,
      content: body.content,
      isDefault: !!body.isDefault,
      copyTemplateId: await assertCopyTemplate(body.copyTemplateId || DEFAULT_COPY_TEMPLATE_ID),
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
    const body = (req.body ?? {}) as { name?: string; content?: string; isDefault?: boolean; copyTemplateId?: string }
    if (body.copyTemplateId !== undefined) await assertCopyTemplate(String(body.copyTemplateId))
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
