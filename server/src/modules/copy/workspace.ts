import type { FastifyInstance } from 'fastify'
import { getDb } from '../../db/index.js'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { config } from '../../config.js'
import { toDb, utcNow } from '../../lib/time.js'
import { recordOperation } from '../audit/repo.js'
import { getStyle, getTemplate, requireCopy, updateCopy } from './repo.js'
import { assertWritable } from './service.js'
import { validateDuration } from './generation.js'
import { contentHash, sanitizeText } from './text.js'

/** Workspace data stays with the copy; raw extraction and approved snapshots remain immutable. */
export function registerCopyWorkspaceRoutes(app: FastifyInstance): void {
  app.put('/copy/:id/settings', async req => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as Record<string, unknown>
    const template = await getTemplate(String(b.templateId ?? ''))
    const style = await getStyle(String(b.styleId ?? ''))
    if (!template?.enabled || !style?.enabled) throw err.badRequest('请选择有效的内容模板和表达风格')
    const tier = String(b.durationTier ?? 'medium')
    const seconds = validateDuration(tier, b.durationSeconds)
    const count = Number(b.count)
    if (!Number.isInteger(count) || count < 1 || count > config.copy.maxBatchCount) throw err.badRequest('生成份数超出允许范围')
    const instructions = sanitizeText(b.instructions)
    if (instructions.length > config.copy.maxInstructions) throw err.badRequest('补充要求过长')
    const settings = await getDb().tx(async db => {
      const copy = await requireCopy(id, db)
      assertWritable(copy)
      if (style.line && style.line !== copy.line) throw err.badRequest('表达风格与当前人物生产线不匹配')
      const next = { ...copy.settings, templateId: template.id, styleId: style.id, durationTier: tier, durationSeconds: seconds, count, instructions }
      await updateCopy(id, { settings: JSON.stringify(next), updated_at: toDb(utcNow()) }, db)
      return next
    })
    return ok({ settings })
  })

  app.put('/copy/:id/source-review', async req => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { correctedText?: unknown; note?: unknown; confirmed?: unknown }
    const text = sanitizeText(b.correctedText)
    const note = sanitizeText(b.note)
    if (!text) throw err.badRequest('校对后的素材不能为空')
    if (text.length > 30000 || note.length > 1000) throw err.badRequest('素材或校对备注过长')
    const sourceReview = await getDb().tx(async db => {
      const copy = await requireCopy(id, db)
      assertWritable(copy)
      const review = { correctedText: text, note, confirmed: b.confirmed === true, originalHash: contentHash(copy.sourceText, []), reviewedAt: utcNow(), reviewedBy: req.operator }
      await updateCopy(id, { settings: JSON.stringify({ ...copy.settings, sourceReview: review }), updated_at: toDb(utcNow()) }, db)
      return review
    })
    await recordOperation({ operator: req.operator, action: 'copy.source_review', targetType: 'copy', targetId: id, detail: { confirmed: sourceReview.confirmed } })
    return ok({ sourceReview })
  })

  // 「定稿」已与「提交审核」合并：提交即锁定当前稿为不可变版本，不再单独定稿。
  // 老文案 settings 里残留的 finalSelection 不再参与任何判断。
}
