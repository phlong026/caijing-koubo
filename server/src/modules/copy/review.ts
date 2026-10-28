import { getDb, type Db } from '../../db/index.js'
import { config, hasJiaoduitai } from '../../config.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { newId } from '../../lib/util.js'
import { fromDb as fromDbTime, toDb, utcNow } from '../../lib/time.js'
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
  opts: { stubRejectAt?: StubRejectSim | null } = {},
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
  // 接入校对台后新单由校对台审核，审核桩只推进存量桩单
  const useStub = config.copy.reviewStubEnabled && !hasJiaoduitai()
  // 校对台驳回 / 机审拦截后的改稿重提：复用同一审核单（平台单号锚定不变，resubmit 版本 +1，审核历史留痕）
  const reusable =
    hasJiaoduitai() && !useStub
      ? await db.get<{ id: string }>(
          "SELECT `id` FROM `review_submission` WHERE `copy_id` = ? AND `is_stub` = 0 AND `external_review_no` IS NOT NULL" +
            " AND `external_status` IN ('rejected', 'pending_revise') ORDER BY `updated_at` DESC LIMIT 1",
          [copyId],
        )
      : null

  // 2) 事务：锁定版本 + 审核单 + 状态
  const now = toDb(utcNow())
  const versionId = newId('ver')
  const submissionId = newId('sub')
  let versionNo = 0

  await db.tx(async (t) => {
    // P1-9：先用条件更新占位，只有真正把 draft/rejected 改成 in_review 的请求才继续。
    // 之前是无条件 UPDATE，两个并发提交都能通过前面的状态检查，各建一张审核单，
    // 后写入的覆盖 review_submission_id，前一张审核单成为孤儿。
    // 注：db.tx 不可嵌套，样式表与审核单均在同一事务内串行写入。
    const claimed = await t.run(
      `UPDATE \`copy\` SET \`status\` = 'in_review', \`review_gate\` = 'submitted', \`ever_submitted\` = 1,
        \`reject_reason\` = NULL, \`updated_at\` = ?
       WHERE \`id\` = ? AND \`status\` IN ('draft', 'rejected')`,
      [now, copyId],
    )
    if (!claimed.affectedRows) {
      // 并发提交已被另一个请求占位，回滚本次并复用已有审核单
      throw err.invalidState('该文案已被提交审核或状态已变更，请刷新后再试')
    }

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

    if (reusable) {
      // 改稿重审：审核单转身复用（清裁决字段，历史关卡记录保留），指向新锁定版本，待 resubmit
      const w2 = await t.run(
        "UPDATE `review_submission` SET `copy_version_id` = ?, `status` = 'submitted', `external_status` = 'resubmit_pending'," +
          " `rejected_gate` = NULL, `reason` = NULL, `decided_by` = NULL, `updated_at` = ?" +
          " WHERE `id` = ? AND `status` = 'rejected' AND `external_review_no` IS NOT NULL",
        [versionId, now, reusable.id],
      )
      if (!w2.affectedRows) throw err.invalidState('审核单状态已变化，请刷新后再试')
    } else {
      await t.run(
        `INSERT INTO \`review_submission\`
          (\`id\`, \`copy_id\`, \`copy_version_id\`, \`status\`, \`gate_results\`, \`appended_risk_text\`, \`is_stub\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, 'submitted', '[]', NULL, ?, ?, ?)`,
        [submissionId, copyId, versionId, useStub ? 1 : 0, now, now],
      )
    }

    await t.run(
      `UPDATE \`copy\` SET \`submitted_version_id\` = ?, \`review_submission_id\` = ? WHERE \`id\` = ?`,
      [versionId, reusable?.id ?? submissionId, copyId],
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
    detail: { versionId, versionNo, submissionId: reusable?.id ?? submissionId, reusedSubmission: !!reusable, draftId, riskHint: template?.riskHint ?? null },
  })

  // 3) 校对台已接入：立即送审（失败由后台轮询补送）；否则审核桩开启时异步模拟三关（不阻塞响应）
  if (hasJiaoduitai()) {
    const activeSubmissionId = reusable?.id ?? submissionId
    void import('./jiaoduitai-sync.js')
      .then((m) => m.sendSubmission(activeSubmissionId))
      .catch((e) => logger.error({ err: (e as Error).message, submissionId: activeSubmissionId }, 'jiaoduitai.send_failed'))
  } else if (useStub) {
    void advanceStub(submissionId, template?.riskHint ?? DEFAULT_RISK_HINT, opts.stubRejectAt).catch((e) => {
      logger.error({ err: (e as Error).message, submissionId }, 'review.stub.advance_failed')
    })
  }

  return { versionId, versionNo, submissionId: reusable?.id ?? submissionId, reused: false }
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

/** 桩专用接口（人工裁决 / 关卡推进）的入口守卫：桩关闭时一律拒绝 */
export function assertReviewStubEnabled(): void {
  if (!config.copy.reviewStubEnabled) throw err.reviewStubDisabled()
}

/**
 * 启动时续推审核桩（P2-19）：桩在进程内推进，重启会让审核单永久停在 submitted / gate1 / gate2。
 * 只处理 is_stub=1 的单；桩关闭时不续推，交给真实审核模块。
 */
export async function resumeStubSubmissions(): Promise<number> {
  if (!config.copy.reviewStubEnabled) return 0
  const db = getDb()
  const rows = await db.all<{ id: string; copy_id: string }>(
    "SELECT `id`, `copy_id` FROM `review_submission` WHERE `is_stub` = 1 AND `status` IN ('submitted', 'gate1', 'gate2')",
  )
  for (const r of rows) {
    const copy = await getCopy(r.copy_id, db)
    const template = copy ? await resolveTemplateForCopy(copy, db) : null
    void advanceStub(r.id, template?.riskHint ?? DEFAULT_RISK_HINT).catch((e) => {
      logger.error({ err: (e as Error).message, submissionId: r.id }, 'review.stub.resume_failed')
    })
  }
  if (rows.length) logger.info({ count: rows.length }, 'review.stub.resumed')
  return rows.length
}

/** 审核桩联调：在指定关卡模拟自动审核不通过（§9.8 场景 4「第 2 关退回」） */
export interface StubRejectSim {
  gate: 'gate1' | 'gate2' | 'gate3'
  reason?: string | null
}

async function advanceStub(submissionId: string, riskHint: string, rejectAt?: StubRejectSim | null): Promise<void> {
  const db = getDb()
  const stepMs = Math.max(0, config.copy.reviewStubStepMs)

  const gates: Array<{ gate: string; reason: string; entry: string }> = [
    // entry = 进入本关之前审核单应处于的状态，用于 CAS 抢占
    { gate: 'gate1', reason: '本地合规扫描与禁用表述检查通过', entry: 'submitted' },
    { gate: 'gate2', reason: '事实与风险点检查通过（未发现无依据数据与收益承诺）', entry: 'gate1' },
    { gate: 'gate3', reason: '已追加风险提示话术', entry: 'gate2' },
  ]

  for (const g of gates) {
    const sub = await getSubmission(submissionId, db)
    // 撤回后立即中止，不再回写（§5.3 撤回语义 / AC-R8）
    if (!sub || sub.status === 'withdrawn' || sub.status === 'rejected' || sub.status === 'approved') return
    // 已过本关（重启后续推时从中途接上）
    if (sub.status !== g.entry) continue

    if (stepMs) await new Promise((r) => setTimeout(r, stepMs))
    if (rejectAt?.gate === g.gate) {
      // 走与真实审核模块相同的退回回写；期间被撤回则因状态不符被拒，桩就此结束
      await onReviewResult({
        submissionId,
        result: 'rejected',
        rejectedGate: g.gate,
        reason: rejectAt.reason?.trim() || `${GATE_LABELS[g.gate]}未通过（审核桩联调模拟）`,
        operator: 'review-stub',
      }).catch((e) => logger.info({ submissionId, err: (e as Error).message }, 'review.stub.reject_skipped'))
      return
    }
    const results = [...sub.gateResults, gateResult(g.gate, 'pass', g.reason)]
    const nextStatus = g.gate === 'gate3' ? 'pending_manual' : g.gate

    // P1-8②：读取后到写入之间会 sleep，期间用户可能撤回。
    // 用 CAS（WHERE status = 进入本关前的状态）写入，撤回/他人推进后 affectedRows=0，立即中止，
    // 不再把 withdrawn 覆盖成 gate2 / pending_manual。
    const w = await db.run(
      `UPDATE \`review_submission\` SET \`status\` = ?, \`gate_results\` = ?, \`appended_risk_text\` = ?, \`updated_at\` = ?
       WHERE \`id\` = ? AND \`status\` = ?`,
      [
        nextStatus,
        JSON.stringify(results),
        g.gate === 'gate3' ? riskHint : sub.appendedRiskText,
        toDb(utcNow()),
        submissionId,
        g.entry,
      ],
    )
    if (!w.affectedRows) {
      logger.info({ submissionId, gate: g.gate, from: g.entry }, 'review.stub.aborted_by_state_change')
      return
    }
    // copy.review_gate 只在仍是本审核单时同步
    await db.run('UPDATE `copy` SET `review_gate` = ?, `updated_at` = ? WHERE `id` = ? AND `review_submission_id` = ?', [
      nextStatus,
      toDb(utcNow()),
      sub.copyId,
      submissionId,
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

/** 关卡进度回写只接受这几个状态；终态由 onReviewResult / 撤回负责 */
const PROGRESS_GATES = ['gate1', 'gate2', 'gate3', 'pending_manual'] as const

/** 审核进度（步骤条实时关卡） */
export async function onReviewProgress(submissionId: string, gate: string, result: 'pass' | 'fail'): Promise<void> {
  if (!(PROGRESS_GATES as readonly string[]).includes(gate)) {
    throw err.badRequest(`gate 只能是 ${PROGRESS_GATES.join(' / ')}`, { gate })
  }
  const db = getDb()
  const sub = await getSubmission(submissionId, db)
  if (!sub) throw err.notFound('审核单不存在')
  if (['withdrawn', 'rejected', 'approved'].includes(sub.status)) {
    throw err.invalidState(`审核单当前状态（${sub.status}）不接受进度回写`, { status: sub.status })
  }
  const results = [...sub.gateResults, gateResult(gate, result, `关卡 ${gate} 结果：${result}`)]
  // 条件更新：读到之后被撤回 / 裁决的审核单不再被拉回进行中（§5.3 撤回后不再回调）
  const w = await db.run(
    `UPDATE \`review_submission\` SET \`status\` = ?, \`gate_results\` = ?, \`updated_at\` = ?
     WHERE \`id\` = ? AND \`status\` = ?`,
    [gate, JSON.stringify(results), toDb(utcNow()), submissionId, sub.status],
  )
  if (!w.affectedRows) throw err.invalidState('审核单状态已变化，请刷新后重试', { submissionId })
  await db.run('UPDATE `copy` SET `review_gate` = ?, `updated_at` = ? WHERE `id` = ? AND `review_submission_id` = ?', [
    gate,
    toDb(utcNow()),
    sub.copyId,
    submissionId,
  ])
}

/* ── 审核结果回写（FR-R5 / AC-R5）────────────────────────────────── */

/** 进行中的审核单状态：可以被退回 */
const IN_PROGRESS_STATUSES = ['submitted', 'gate1', 'gate2', 'gate3', 'pending_manual']
/** 退回关卡的合法取值（manual = 人工复核退回；external = 校对台驳回 / 拒收） */
const REJECT_GATES = ['gate1', 'gate2', 'gate3', 'manual', 'external']

export interface ReviewResultInput {
  submissionId: string
  copyVersionId?: string | null
  result: 'approved' | 'rejected'
  rejectedGate?: string | null
  reason?: string | null
  riskPoints?: string[] | null
  appendedRiskText?: string | null
  /** 审核方返回了修改后的文案时，通过的是该新版本；缺省为提交版本 */
  approvedVersionId?: string | null
  operator?: string
}

export async function onReviewResult(input: ReviewResultInput): Promise<{ copyId: string; status: string }> {
  const db = getDb()
  const sub = await getSubmission(input.submissionId, db)
  if (!sub) throw err.notFound('审核单不存在')
  if (sub.status === 'withdrawn') throw err.invalidState('该审核单已撤回，结果不再回写')

  // P1-8① 决策（2026-10-17）：
  //  - 「通过」只能在待人工复核时给出，不允许跳过关卡；
  //  - 「退回」可以在任一进行中的关卡给出（第 1~3 关自动审核不通过即退回，§9.8 场景 4）。
  // 且审核单必须是该 copy 当前的审核单，避免旧单把已撤回 / 已修订的 copy 改回 approved。
  if (input.result === 'approved' && sub.status !== 'pending_manual') {
    throw err.invalidState(`审核单当前状态（${sub.status}）不能直接通过，仅「待人工复核」可给出通过结论`, {
      status: sub.status,
      submissionId: sub.id,
    })
  }
  if (input.result === 'rejected' && !IN_PROGRESS_STATUSES.includes(sub.status)) {
    throw err.invalidState(`审核单当前状态（${sub.status}）已结束，不再接受退回`, {
      status: sub.status,
      submissionId: sub.id,
    })
  }
  if (input.copyVersionId && input.copyVersionId !== sub.copyVersionId) {
    throw err.invalidState('回写的版本与审核单锁定的版本不一致', {
      expected: sub.copyVersionId,
      provided: input.copyVersionId,
    })
  }

  const now = toDb(utcNow())
  const copy = await getCopy(sub.copyId, db)
  if (!copy) throw err.notFound('文案不存在')
  if (copy.reviewSubmissionId !== sub.id) {
    throw err.invalidState('该审核单不是当前文案的审核单（可能已撤回或重新提交），结果不再回写', {
      submissionId: sub.id,
      currentSubmissionId: copy.reviewSubmissionId,
    })
  }

  if (input.result === 'approved') {
    const approvedVersionId = input.approvedVersionId ?? sub.copyVersionId
    await db.tx(async (t) => {
      const w = await t.run(
        `UPDATE \`review_submission\` SET \`status\` = 'approved', \`decided_by\` = ?,
          \`appended_risk_text\` = COALESCE(?, \`appended_risk_text\`), \`updated_at\` = ?
         WHERE \`id\` = ? AND \`status\` = 'pending_manual'`,
        [input.operator ?? 'system', input.appendedRiskText ?? null, now, input.submissionId],
      )
      if (!w.affectedRows) throw err.invalidState('审核单状态已变化，裁决未生效')
      // 通过：approved_version_id + body 冗余已通过版本纯文本（§4.1）
      await t.run(
        `UPDATE \`copy\` SET \`status\` = 'approved', \`approved_version_id\` = ?, \`review_gate\` = 'approved',
          \`reject_reason\` = NULL, \`body\` = ?, \`updated_at\` = ? WHERE \`id\` = ?`,
        [approvedVersionId, await plainTextOfVersion(approvedVersionId, t), now, sub.copyId],
      )
    })
    await recordOperation({
      operator: input.operator ?? 'system',
      action: 'copy.approved',
      targetType: 'copy',
      targetId: sub.copyId,
      detail: { submissionId: sub.id, versionId: approvedVersionId, submittedVersionId: sub.copyVersionId },
    })
    return { copyId: sub.copyId, status: 'approved' }
  }

  // 退回：status=rejected，解锁可编辑；原因必填（FR-R5）
  const reason = String(input.reason ?? '').trim()
  if (!reason) throw err.badRequest('退回必须填写原因')
  // 未指明关卡时取审核单当前所处的关卡；待人工复核阶段退回记为 manual
  const rejectedGate =
    input.rejectedGate ?? (sub.status === 'pending_manual' ? 'manual' : sub.status === 'submitted' ? 'gate1' : sub.status)
  if (!REJECT_GATES.includes(rejectedGate)) {
    throw err.badRequest(`rejectedGate 只能是 ${REJECT_GATES.join(' / ')}`, { rejectedGate })
  }

  await db.tx(async (t) => {
    const results = [
      ...sub.gateResults,
      {
        ...gateResult(rejectedGate, 'fail', reason, input.riskPoints ?? undefined),
      },
    ]
    const w = await t.run(
      `UPDATE \`review_submission\` SET \`status\` = 'rejected', \`rejected_gate\` = ?, \`reason\` = ?,
        \`gate_results\` = ?, \`decided_by\` = ?, \`updated_at\` = ?
       WHERE \`id\` = ? AND \`status\` = ?`,
      [rejectedGate, reason, JSON.stringify(results), input.operator ?? 'system', now, sub.id, sub.status],
    )
    if (!w.affectedRows) throw err.invalidState('审核单状态已变化，裁决未生效')
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

/* ── 人工复核（P1-7：真实审核模块就绪前的受保护裁决入口）────────────
 *
 * 生产环境关闭审核桩后，审核单会一直停在「已提交」：自动关卡（内容安全 API / 审核智能体 /
 * 风险提示 Skill）尚未接入。这里给审核员 / 管理员（路由层 ROLE_RULES 限定）一个人工裁决入口：
 *  - 只处理该文案当前的审核单，且状态为「已提交」或「待人工复核」（关卡进行中的不插队）；
 *  - 「已提交」直接转入「待人工复核」并留痕，再走 onReviewResult 的同一套裁决逻辑；
 *  - 四眼原则：提交人不能裁决自己的文案。
 */

const MANUAL_REVIEWABLE = ['submitted', 'pending_manual'] as const

export interface ManualDecisionInput {
  submissionId: string
  result: 'approved' | 'rejected'
  reason?: string | null
  riskPoints?: string[] | null
  appendedRiskText?: string | null
  operator: string
}

export async function manualDecision(input: ManualDecisionInput): Promise<{ copyId: string; status: string }> {
  const db = getDb()
  const sub = await getSubmission(input.submissionId, db)
  if (!sub) throw err.notFound('审核单不存在')
  if (!MANUAL_REVIEWABLE.includes(sub.status as (typeof MANUAL_REVIEWABLE)[number])) {
    throw err.invalidState(`审核单当前状态（${sub.status}）不接受人工裁决`, { status: sub.status })
  }
  // 校对台在审的单以校对台结果为准；仅「已通过但未返回文案」时由人工兜底
  if (sub.externalReviewNo && sub.externalStatus !== 'approved') {
    throw err.invalidState(`该文案正在校对台审核（审核单 ${sub.externalReviewNo}），请在校对台处理`, {
      externalReviewNo: sub.externalReviewNo,
    })
  }
  const version = await getVersion(sub.copyVersionId, db)
  if (version?.createdBy && version.createdBy === input.operator) {
    throw err.forbidden('四眼原则：不能裁决自己提交的文案')
  }
  if (input.result === 'rejected' && !String(input.reason ?? '').trim()) {
    throw err.badRequest('退回必须填写原因')
  }
  if (sub.status === 'submitted') {
    const now = toDb(utcNow())
    const w = await db.run(
      "UPDATE `review_submission` SET `status` = 'pending_manual', `updated_at` = ? WHERE `id` = ? AND `status` = 'submitted'",
      [now, sub.id],
    )
    if (!w.affectedRows) throw err.invalidState('审核单状态已变化，请刷新后重试')
    await db.run("UPDATE `copy` SET `review_gate` = 'pending_manual', `updated_at` = ? WHERE `id` = ? AND `review_submission_id` = ?", [
      now,
      sub.copyId,
      sub.id,
    ])
    await recordOperation({
      operator: input.operator,
      action: 'review.manual_takeover',
      targetType: 'copy',
      targetId: sub.copyId,
      detail: { submissionId: sub.id, note: '自动审核关卡未接入，由人工复核直接裁决' },
    })
  }
  return onReviewResult({
    submissionId: sub.id,
    result: input.result,
    reason: input.reason ?? null,
    rejectedGate: input.result === 'rejected' ? 'manual' : null,
    riskPoints: input.riskPoints ?? null,
    appendedRiskText: input.appendedRiskText ?? null,
    operator: input.operator,
  })
}

export interface ReviewQueueItem {
  submissionId: string
  status: string
  isStub: boolean
  copyId: string
  copyTitle: string | null
  line: string | null
  personaId: string | null
  personaName: string | null
  versionId: string
  versionNo: number | null
  submittedBy: string | null
  submittedAt: string | null
  decidedBy: string | null
  reason: string | null
  rejectedGate: string | null
  updatedAt: string | null
}

/** 审核队列：pending = 当前仍在审的审核单；decided = 最近已裁决（通过 / 退回） */
export async function listReviewQueue(f: { scope?: 'pending' | 'decided'; line?: string } = {}): Promise<ReviewQueueItem[]> {
  const db = getDb()
  const where: string[] = []
  const params: unknown[] = []
  if (f.scope === 'decided') {
    where.push("s.`status` IN ('approved', 'rejected')")
  } else {
    where.push("s.`status` IN ('submitted', 'gate1', 'gate2', 'gate3', 'pending_manual')")
    where.push('c.`review_submission_id` = s.`id`')
  }
  if (f.line) {
    where.push('c.`line` = ?')
    params.push(f.line)
  }
  const rows = await db.all<Record<string, any>>(
    `SELECT s.\`id\` AS sid, s.\`status\`, s.\`is_stub\`, s.\`copy_id\`, s.\`copy_version_id\`, s.\`decided_by\`, s.\`reason\`,
            s.\`rejected_gate\`, s.\`created_at\` AS submitted_at, s.\`updated_at\`,
            c.\`title\`, v.\`title\` AS version_title, c.\`line\`, c.\`persona_id\`, p.\`name\` AS persona_name, v.\`version_no\`, v.\`created_by\` AS submitted_by
       FROM \`review_submission\` s
       JOIN \`copy\` c ON c.\`id\` = s.\`copy_id\`
       LEFT JOIN \`persona\` p ON p.\`id\` = c.\`persona_id\`
       LEFT JOIN \`copy_version\` v ON v.\`id\` = s.\`copy_version_id\`
      WHERE ${where.join(' AND ')}
      ORDER BY s.\`created_at\` ${f.scope === 'decided' ? 'DESC' : 'ASC'}
      LIMIT 200`,
    params,
  )
  return rows.map((r) => ({
    submissionId: r.sid,
    status: r.status,
    isStub: !!Number(r.is_stub),
    copyId: r.copy_id,
    // 列表显示提交版本的标题；版本无标题时退回文案标题
    copyTitle: r.version_title || r.title || null,
    line: r.line ?? null,
    personaId: r.persona_id ?? null,
    personaName: r.persona_name ?? null,
    versionId: r.copy_version_id,
    versionNo: r.version_no === null || r.version_no === undefined ? null : Number(r.version_no),
    submittedBy: r.submitted_by ?? null,
    submittedAt: fromDbTime(r.submitted_at),
    decidedBy: r.decided_by ?? null,
    reason: r.reason ?? null,
    rejectedGate: r.rejected_gate ?? null,
    updatedAt: fromDbTime(r.updated_at),
  }))
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

  if (sub.externalReviewNo) {
    throw err.withdrawNotAllowed('已送校对台审核，平台不支持撤回，请等待审核结果', {
      externalReviewNo: sub.externalReviewNo,
    })
  }
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
    // P1-8③：CAS 撤回。读取状态到这里之间，审核桩可能已把它推进到 pending_manual，
    // 之前是无条件 UPDATE，会把刚进入人工复核的审核单强行撤回。
    const w = await t.run(
      `UPDATE \`review_submission\` SET \`status\` = 'withdrawn', \`decided_by\` = ?, \`updated_at\` = ?
       WHERE \`id\` = ? AND \`status\` = ?`,
      [operator, now, sub.id, sub.status],
    )
    if (!w.affectedRows) {
      throw err.withdrawNotAllowed('审核单状态已变化（可能刚进入人工复核），无法撤回', { status: sub.status })
    }
    await t.run(
      `UPDATE \`copy\` SET \`status\` = 'draft', \`review_gate\` = 'withdrawn', \`review_submission_id\` = NULL, \`updated_at\` = ?
       WHERE \`id\` = ? AND \`review_submission_id\` = ?`,
      [now, copyId, sub.id],
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

  // 校对台审定稿是 origin=review 的新版本，按版本反查不到审核单；此时取该文案最近一张通过的审核单
  // （approved_version_id 随每次通过更新，二者一一对应），才能读到审核方返回的追加话术（决策 D4）
  let sub = await getSubmissionByVersion(v.id, db)
  if (!sub) {
    const last = await db.get<{ id: string }>(
      "SELECT `id` FROM `review_submission` WHERE `copy_id` = ? AND `status` = 'approved' ORDER BY `updated_at` DESC LIMIT 1",
      [copy.id],
    )
    sub = last ? await getSubmission(last.id, db) : null
  }
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
