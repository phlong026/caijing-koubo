import { getDb, type Db } from '../../db/index.js'
import { config } from '../../config.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { newId } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { recordOperation } from '../audit/repo.js'
import {
  getCopy,
  getDraft,
  getSubmission,
  getSubmissionByVersion,
  getTemplate,
  getVersion,
  insertVersion,
  requireCopy,
  updateCopy,
  updateGeneration,
  type CopyRow,
  type GateResult,
  type SubmissionRow,
} from './repo.js'
import { contentHash, countSectionsWords, toPlainText } from './text.js'
import { precheck } from './service.js'
import { scanDraftCompliance } from './service.js'
import { GATE_LABELS, WITHDRAWABLE_STATUSES, DEFAULT_RISK_HINT, type Section } from './constants.js'
import { getPersonaById } from './persona-bridge.js'

/**
 * 审核契约实现 + 审核桩（W1 / FR-R4 / FR-R5 / FR-R7 / §5.3）。
 * 审核模块就绪前：提交后异步模拟第 1/2 关通过、第 3 关以模板 riskHint 作为追加话术，
 * 最终进入「待人工复核」；提供 `POST /review/submissions/:id/decision` 供联调与 smoke 裁决。
 * 契约边界：文案工坊只负责 submit / withdraw / onReviewResult，关卡判定不属于本模块。
 */

/* ── 提交（FR-R4 / AC-R4）──────────────────────────────────────────── */

export interface SubmitResult {
  versionId: string
  versionNo: number
  submissionId: string
  reused: boolean
}

/**
 * 提交审核：
 *  1) 预检硬项必须全过，否则 409 COPY_PRECHECK_FAILED（data 带 checks）；
 *  2) 生成锁定版本（origin=submit）；
 *  3) 建审核单（同一版本重复提交返回同一单，幂等）；
 *  4) copy → in_review。
 * 全部在一个事务内完成（AC-R4：锁定版本 + 审核单 + 状态在同一事务）。
 */
export async function submitForReview(
  copyId: string,
  draftId: string,
  rev: number | null,
  operator: string,
): Promise<SubmitResult> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)

  if (copy.status === 'archived') throw err.invalidState('该文案已归档，不可提交')
  if (copy.status === 'in_review') {
    // 幂等：同一当前稿的最新版本重复提交，返回同一审核单
    if (copy.submittedVersionId) {
      const s = await getSubmissionByVersion(copy.submittedVersionId, db)
      const v = await getVersion(copy.submittedVersionId, db)
      if (s && v) return { versionId: v.id, versionNo: v.versionNo, submissionId: s.id, reused: true }
    }
    throw err.copyLocked('该文案已在审核中')
  }
  if (copy.status === 'approved') {
    throw err.invalidState('该文案已审核通过，如需修改请先确认进入修订', { approvedVersionId: copy.approvedVersionId })
  }

  const draft = await getDraft(copyId, draftId, db)
  if (!draft) throw err.notFound('稿不存在')
  if (rev !== null && Number(rev) !== draft.rev) {
    throw err.draftConflict('该稿已在其他页面修改，请载入最新内容后再提交', {
      expectedRev: draft.rev,
      providedRev: rev,
    })
  }

  // 1) 预检
  const check = await precheck(copyId, draftId)
  if (!check.canSubmit) {
    throw err.precheckFailed('提交前检查未通过，请先处理硬性项', {
      checks: check.checks.filter((c) => c.level === 'hard' && !c.pass),
      allChecks: check.checks,
    })
  }

  const hash = contentHash(draft.title, draft.sections)
  const template = await resolveTemplateForCopy(copy, db)

  // 2) 事务：锁定版本 + 审核单 + 状态
  const now = toDb(utcNow())
  const versionId = newId('ver')
  const submissionId = newId('sub')
  let versionNo = 0

  await db.tx(async (t) => {
    const next =
      (await t.get<{ n: number | null }>('SELECT MAX(`version_no`) AS n FROM `copy_version` WHERE `copy_id` = ?', [
        copyId,
      ]))?.n ?? 0
    versionNo = Number(next) + 1

    await t.run(
      `INSERT INTO \`copy_version\`
        (\`id\`, \`copy_id\`, \`draft_id\`, \`version_no\`, \`title\`, \`sections\`, \`plain_text\`, \`word_count\`,
         \`content_hash\`, \`origin\`, \`locked\`, \`compliance_hits\`, \`similarity\`, \`created_by\`, \`created_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submit', 1, ?, ?, ?, ?)`,
      [
        versionId,
        copyId,
        draftId,
        versionNo,
        draft.title,
        JSON.stringify(draft.sections),
        draft.plainText,
        draft.wordCount,
        hash,
        JSON.stringify(check.complianceHits),
        check.similarity?.similarity ?? null,
        operator,
        now,
      ],
    )

    await t.run(
      `INSERT INTO \`review_submission\`
        (\`id\`, \`copy_id\`, \`copy_version_id\`, \`status\`, \`gate_results\`, \`appended_risk_text\`, \`is_stub\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, 'submitted', '[]', NULL, 1, ?, ?)`,
      [submissionId, copyId, versionId, now, now],
    )

    await t.run(
      `UPDATE \`copy\` SET \`status\` = 'in_review', \`submitted_version_id\` = ?, \`review_submission_id\` = ?,
        \`review_gate\` = 'submitted', \`ever_submitted\` = 1, \`reject_reason\` = NULL, \`updated_at\` = ?
       WHERE \`id\` = ?`,
      [versionId, submissionId, now, copyId],
    )

    await t.run('UPDATE `copy_draft` SET `has_submitted` = 1, `latest_version_no` = ? WHERE `id` = ?', [
      versionNo,
      draftId,
    ])
  })

  await recordOperation({
    operator,
    action: 'copy.submit',
    targetType: 'copy',
    targetId: copyId,
    detail: { versionId, versionNo, submissionId, draftId, riskHint: template?.riskHint ?? null },
  })

  // 3) 异步推进审核桩（不阻塞响应）
  void advanceStub(submissionId, template?.riskHint ?? DEFAULT_RISK_HINT).catch((e) => {
    logger.error({ err: (e as Error).message, submissionId }, 'review.stub.advance_failed')
  })

  return { versionId, versionNo, submissionId, reused: false }
}

async function resolveTemplateForCopy(copy: CopyRow, db: Db) {
  const tid = (copy.settings as Record<string, unknown> | null)?.templateId
  if (typeof tid === 'string') {
    const t = await getTemplate(tid, db)
    if (t) return t
  }
  const { listTemplates } = await import('./repo.js')
  const all = await listTemplates(true, db)
  return all[0] ?? null
}

/* ── 审核桩推进（三关模拟）────────────────────────────────────────── */

async function advanceStub(submissionId: string, riskHint: string): Promise<void> {
  const db = getDb()
  const stepMs = Math.max(0, config.copy.reviewStubStepMs)

  const gates: Array<{ gate: string; reason: string }> = [
    { gate: 'gate1', reason: '本地合规扫描与禁用表述检查通过' },
    { gate: 'gate2', reason: '事实与风险点检查通过（未发现无依据数据与收益承诺）' },
    { gate: 'gate3', reason: '已追加风险提示话术' },
  ]

  for (const g of gates) {
    const sub = await getSubmission(submissionId, db)
    // 撤回后立即中止，不再回写（§5.3 撤回语义 / AC-R8）
    if (!sub || sub.status === 'withdrawn' || sub.status === 'rejected' || sub.status === 'approved') return

    if (stepMs) await new Promise((r) => setTimeout(r, stepMs))
    const results = [...sub.gateResults, gateResult(g.gate, 'pass', g.reason)]
    const nextStatus = g.gate === 'gate3' ? 'pending_manual' : g.gate
    await db.run(
      'UPDATE `review_submission` SET `status` = ?, `gate_results` = ?, `appended_risk_text` = ?, `updated_at` = ? WHERE `id` = ?',
      [
        nextStatus,
        JSON.stringify(results),
        g.gate === 'gate3' ? riskHint : sub.appendedRiskText,
        toDb(utcNow()),
        submissionId,
      ],
    )
    await db.run('UPDATE `copy` SET `review_gate` = ?, `updated_at` = ? WHERE `id` = ?', [
      nextStatus,
      toDb(utcNow()),
      sub.copyId,
    ])
    logger.debug({ submissionId, gate: g.gate, nextStatus }, 'review.stub.gate')
  }
}

function gateResult(gate: string, result: 'pass' | 'fail', reason: string, riskPoints?: string[]): GateResult {
  return {
    gate,
    result,
    reason,
    riskPoints: riskPoints ?? null,
    confidence: null,
    at: utcNow().toISOString(),
  }
}

/** 审核进度（步骤条实时关卡） */
export async function onReviewProgress(submissionId: string, gate: string, result: 'pass' | 'fail'): Promise<void> {
  const db = getDb()
  const sub = await getSubmission(submissionId, db)
  if (!sub) throw err.notFound('审核单不存在')
  const results = [...sub.gateResults, gateResult(gate, result, `关卡 ${gate} 结果：${result}`)]
  await db.run(
    'UPDATE `review_submission` SET `status` = ?, `gate_results` = ?, `updated_at` = ? WHERE `id` = ?',
    [gate, JSON.stringify(results), toDb(utcNow()), submissionId],
  )
  await db.run('UPDATE `copy` SET `review_gate` = ?, `updated_at` = ? WHERE `id` = ?', [
    gate,
    toDb(utcNow()),
    sub.copyId,
  ])
}

/* ── 审核结果回写（FR-R5 / AC-R5）────────────────────────────────── */

export interface ReviewResultInput {
  submissionId: string
  copyVersionId?: string | null
  result: 'approved' | 'rejected'
  rejectedGate?: string | null
  reason?: string | null
  riskPoints?: string[] | null
  appendedRiskText?: string | null
  operator?: string
}

export async function onReviewResult(input: ReviewResultInput): Promise<{ copyId: string; status: string }> {
  const db = getDb()
  const sub = await getSubmission(input.submissionId, db)
  if (!sub) throw err.notFound('审核单不存在')
  if (sub.status === 'withdrawn') throw err.invalidState('该审核单已撤回，结果不再回写')

  const now = toDb(utcNow())
  const copy = await getCopy(sub.copyId, db)
  if (!copy) throw err.notFound('文案不存在')

  if (input.result === 'approved') {
    await db.tx(async (t) => {
      await t.run(
        'UPDATE `review_submission` SET `status` = \'approved\', `decided_by` = ?, `appended_risk_text` = COALESCE(?, `appended_risk_text`), `updated_at` = ? WHERE `id` = ?',
        [input.operator ?? 'system', input.appendedRiskText ?? null, now, input.submissionId],
      )
      // 通过：approved_version_id + body 冗余已通过版本纯文本（§4.1）
      await t.run(
        `UPDATE \`copy\` SET \`status\` = 'approved', \`approved_version_id\` = ?, \`review_gate\` = 'approved',
          \`reject_reason\` = NULL, \`body\` = ?, \`updated_at\` = ? WHERE \`id\` = ?`,
        [sub.copyVersionId, await plainTextOfVersion(sub.copyVersionId, t), now, sub.copyId],
      )
    })
    await recordOperation({
      operator: input.operator ?? 'system',
      action: 'copy.approved',
      targetType: 'copy',
      targetId: sub.copyId,
      detail: { submissionId: sub.id, versionId: sub.copyVersionId },
    })
    return { copyId: sub.copyId, status: 'approved' }
  }

  // 退回：status=rejected，解锁可编辑；原因必填（FR-R5）
  const reason = String(input.reason ?? '').trim()
  if (!reason) throw err.badRequest('退回必须填写原因')
  const rejectedGate = input.rejectedGate ?? 'manual'

  await db.tx(async (t) => {
    const results = [
      ...sub.gateResults,
      {
        ...gateResult(rejectedGate, 'fail', reason, input.riskPoints ?? undefined),
      },
    ]
    await t.run(
      `UPDATE \`review_submission\` SET \`status\` = 'rejected', \`rejected_gate\` = ?, \`reason\` = ?,
        \`gate_results\` = ?, \`decided_by\` = ?, \`updated_at\` = ? WHERE \`id\` = ?`,
      [rejectedGate, reason, JSON.stringify(results), input.operator ?? 'system', now, sub.id],
    )
    await t.run(
      `UPDATE \`copy\` SET \`status\` = 'rejected', \`reject_reason\` = ?, \`review_gate\` = ?, \`updated_at\` = ? WHERE \`id\` = ?`,
      [reason, rejectedGate, now, sub.copyId],
    )
  })

  await recordOperation({
    operator: input.operator ?? 'system',
    action: 'copy.rejected',
    targetType: 'copy',
    targetId: sub.copyId,
    detail: { submissionId: sub.id, rejectedGate, reason },
  })
  return { copyId: sub.copyId, status: 'rejected' }
}

async function plainTextOfVersion(versionId: string, db: Db): Promise<string | null> {
  const v = await getVersion(versionId, db)
  if (!v) return null
  return v.plainText || toPlainText(v.title, v.sections)
}

/* ── 撤回（W12 / FR-R7 / AC-R8）───────────────────────────────────── */

export async function withdrawReview(
  copyId: string,
  operator: string,
): Promise<{ submissionId: string; status: string }> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  if (copy.status !== 'in_review' || !copy.reviewSubmissionId) {
    throw err.invalidState('当前文案不在审核中，无需撤回', { status: copy.status })
  }
  const sub = await getSubmission(copy.reviewSubmissionId, db)
  if (!sub) throw err.notFound('审核单不存在')

  if (!WITHDRAWABLE_STATUSES.includes(sub.status as never)) {
    if (sub.status === 'pending_manual') {
      throw err.withdrawNotAllowed('已进入人工复核，无法撤回，请等待审核结果', {
        status: sub.status,
        gate: GATE_LABELS[sub.status],
      })
    }
    throw err.invalidState(`审核单当前状态（${sub.status}）不可撤回`, { status: sub.status })
  }

  const now = toDb(utcNow())
  await db.tx(async (t) => {
    await t.run('UPDATE `review_submission` SET `status` = \'withdrawn\', `decided_by` = ?, `updated_at` = ? WHERE `id` = ?', [
      operator,
      now,
      sub.id,
    ])
    await t.run(
      `UPDATE \`copy\` SET \`status\` = 'draft', \`review_gate\` = 'withdrawn', \`review_submission_id\` = NULL, \`updated_at\` = ? WHERE \`id\` = ?`,
      [now, copyId],
    )
  })

  await recordOperation({
    operator,
    action: 'copy.withdraw',
    targetType: 'copy',
    targetId: copyId,
    detail: { submissionId: sub.id, previousStatus: sub.status },
  })
  return { submissionId: sub.id, status: 'withdrawn' }
}

/* ── 视频创作取稿（FR-X3 / AC-R5）────────────────────────────────── */

export interface ApprovedPayload {
  copyId: string
  versionId: string
  versionNo: number
  title: string
  sections: Section[]
  plainText: string
  riskHint: string
  persona: { id: string; name: string; line: string }
}

export async function getApprovedCopy(copyId: string): Promise<ApprovedPayload> {
  const db = getDb()
  const copy = await requireCopy(copyId, db)
  if (!copy.approvedVersionId) {
    throw err.notApproved('该文案尚无审核通过的版本，不能用于视频创作', {
      status: copy.status,
      submittedVersionId: copy.submittedVersionId,
    })
  }
  const v = await getVersion(copy.approvedVersionId, db)
  if (!v) throw err.notApproved('已通过版本记录丢失，请联系管理员')

  const sub = await getSubmissionByVersion(v.id, db)
  const template = await resolveTemplateForCopy(copy, db)
  const persona = copy.personaId ? await getPersonaById(copy.personaId, true) : null

  return {
    copyId: copy.id,
    versionId: v.id,
    versionNo: v.versionNo,
    title: v.title ?? copy.title ?? '',
    sections: v.sections,
    plainText: v.plainText || toPlainText(v.title, v.sections),
    riskHint: sub?.appendedRiskText || template?.riskHint || DEFAULT_RISK_HINT,
    persona: {
      id: persona?.id ?? '',
      name: persona?.name ?? '',
      line: persona?.line ?? copy.line ?? '',
    },
  }
}

/* ── 审核单查询（步骤条）───────────────────────────────────────────── */

export async function getSubmissionProgress(submissionId: string): Promise<SubmissionRow> {
  const sub = await getSubmission(submissionId)
  if (!sub) throw err.notFound('审核单不存在')
  return sub
}

/** 供 smoke / 联调：注入一次「非法 JSON」故障（AC-G4） */
export async function failGenerationForTest(generationId: string, reason: string): Promise<void> {
  await updateGeneration(generationId, {
    status: 'failed',
    error: reason,
    finished_at: toDb(utcNow()),
  })
}

export { scanDraftCompliance, countSectionsWords }
