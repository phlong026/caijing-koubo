import { config, hasJiaoduitai } from '../../config.js'
import { getDb } from '../../db/index.js'
import { logger } from '../../log.js'
import { toDb, utcNow } from '../../lib/time.js'
import { getReviewByNo, JiaoduitaiError, resubmitReview, submitText, type ReviewByNo } from '../../integrations/jiaoduitai/client.js'
import { getSubmission, getVersion, type GateResult, type SubmissionRow } from './repo.js'
import { extractRiskText, formatFindings, mapExternalStatus, toSubmitText } from './jiaoduitai.js'
import { onReviewResult } from './review.js'

/**
 * 校对台审核同步：送审 → 轮询审核意见 → 驳回/拦截退回我方改稿 → resubmit 重审直至通过。
 * 平台只出审核意见不改稿（2026-10-28 方案，v1.3 文档）：
 *  - 审核单状态对应：机审 → gate1；人工初审/终审 → pending_manual；
 *  - 机审高危拦截（pending_revise）与人工驳回（rejected）都视为审核意见：文案退回可编辑，
 *    findings / 驳回意见写入 reject_reason；改稿重新提交时复用同一审核单走 resubmit（单号不变、版本 +1）；
 *  - 通过：直接锁定我方送审版本（平台不改稿，无返回文案），copy.approved_version_id 指向它；
 *  - 送审 / 重审失败（网络 / 5xx）下一轮重试；平台拒收（4xx）退回并写明原因。
 */

const OPERATOR = 'jiaoduitai'
/** 送审请求已发出但结果未知（超时 / 5xx）：平台上可能已经建了单 */
const SENDING = 'sending'
/** 改稿重审待发：平台单在 rejected / pending_revise，本地新版本待 resubmit */
const RESUBMIT_PENDING = 'resubmit_pending'
/** 平台拒收改稿重审（单号状态不符 / 并发重送）：该平台单已不可再用，改稿重提时改走新单 */
const RESUBMIT_REFUSED = 'resubmit_refused'
const TERMINAL_EXTERNAL = ['approved', 'rejected', RESUBMIT_REFUSED]
const ref = (sub: SubmissionRow) => ({ type: 'review_submission', id: sub.id })

function gateResult(gate: string, result: 'pass' | 'fail', reason: string): GateResult {
  return { gate, result, reason, riskPoints: null, confidence: null, at: utcNow().toISOString() }
}

/** CAS 推进本地状态并追加关卡记录；状态已被他人改动时返回 false */
async function advance(sub: SubmissionRow, status: string, reason: string, external?: string): Promise<boolean> {
  const db = getDb()
  const now = toDb(utcNow())
  const results = [...sub.gateResults, gateResult(status, 'pass', reason)]
  const w = await db.run(
    `UPDATE \`review_submission\` SET \`status\` = ?, \`gate_results\` = ?, \`external_status\` = COALESCE(?, \`external_status\`), \`updated_at\` = ?
     WHERE \`id\` = ? AND \`status\` = ?`,
    [status, JSON.stringify(results), external ?? null, now, sub.id, sub.status],
  )
  if (!w.affectedRows) return false
  await db.run('UPDATE `copy` SET `review_gate` = ?, `updated_at` = ? WHERE `id` = ? AND `review_submission_id` = ?', [
    status,
    now,
    sub.copyId,
    sub.id,
  ])
  return true
}

/** onReviewResult 只接受 pending_manual：先补到待人工复核再回写结果 */
async function ensurePendingManual(sub: SubmissionRow, reason: string): Promise<SubmissionRow | null> {
  if (sub.status !== 'pending_manual' && !(await advance(sub, 'pending_manual', reason))) return null
  return getSubmission(sub.id)
}

async function rejectLocally(sub: SubmissionRow, reason: string, external: string | null): Promise<void> {
  const ready = await ensurePendingManual(sub, '校对台审核结束')
  if (!ready) return
  await onReviewResult({ submissionId: sub.id, result: 'rejected', rejectedGate: 'external', reason, operator: OPERATOR })
  // 终态标记必须在本地裁决落库之后写：裁决失败时不写，下一轮轮询会重试
  if (external) await markExternal(sub.id, external)
}

async function markExternal(submissionId: string, status: string): Promise<void> {
  await getDb().run('UPDATE `review_submission` SET `external_status` = ? WHERE `id` = ?', [status, submissionId])
}

/* ── 送审 ─────────────────────────────────────────────────────────── */

/**
 * 409 时能否接管平台已有单号。平台查询接口无法证明那张单是谁建的，所以只在
 * 本单之前确实发出过送审请求、结果未知时才接管；首次送审就 409 说明是别人（其它系统 / 同名文案）的单。
 */
async function canAdopt(sub: SubmissionRow, title: string | null, reviewNo: string): Promise<boolean> {
  if (sub.externalStatus !== SENDING) return false
  const db = getDb()
  const owner = await db.get<{ id: string }>('SELECT `id` FROM `review_submission` WHERE `external_review_no` = ?', [reviewNo])
  if (owner) return owner.id === sub.id
  const sameTitle = await db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM \`review_submission\` s JOIN \`copy_version\` v ON v.\`id\` = s.\`copy_version_id\`
      WHERE s.\`id\` <> ? AND s.\`status\` = 'submitted' AND s.\`external_review_no\` IS NULL AND v.\`title\` = ?`,
    [sub.id, title ?? ''],
  )
  return !Number(sameTitle?.c ?? 0)
}

export async function sendSubmission(submissionId: string): Promise<void> {
  const sub = await getSubmission(submissionId)
  if (!sub || sub.isStub || sub.status !== 'submitted') return
  const version = await getVersion(sub.copyVersionId)
  if (!version) {
    logger.error({ submissionId, versionId: sub.copyVersionId }, 'jiaoduitai.send_version_missing')
    return
  }

  // 改稿重审：平台单在 rejected / pending_revise，沿用单号 resubmit（版本 +1 重走机审与人工）
  if (sub.externalReviewNo) {
    if (sub.externalStatus !== RESUBMIT_PENDING) return
    let r
    try {
      r = await resubmitReview(
        sub.externalReviewNo,
        { submitter: version.createdBy || config.defaultOperator, contentText: toSubmitText(version.title, version.sections) },
        ref(sub),
      )
    } catch (e) {
      if (e instanceof JiaoduitaiError && e.permanent) {
        logger.warn({ submissionId, reviewNo: sub.externalReviewNo, err: e.message }, 'jiaoduitai.resubmit_refused')
        // 平台单已不可重审：置终态标记，避免改稿重提时误复用这张单号（会撞 409）
        await rejectLocally(sub, `校对台拒收改稿重审：${e.message}`, RESUBMIT_REFUSED)
        return
      }
      logger.warn({ submissionId, reviewNo: sub.externalReviewNo, err: (e as Error).message }, 'jiaoduitai.resubmit_retry_later')
      return
    }
    const db = getDb()
    const now = toDb(utcNow())
    const results = [...sub.gateResults, gateResult('gate1', 'pass', `已重新送校对台（审核单 ${sub.externalReviewNo} 第 ${r.version} 版）：${r.status_label || r.status}`)]
    const w = await db.run(
      "UPDATE `review_submission` SET `status` = 'gate1', `external_status` = ?, `gate_results` = ?, `updated_at` = ? WHERE `id` = ? AND `status` = 'submitted' AND `external_status` = ?",
      [r.status, JSON.stringify(results), now, sub.id, RESUBMIT_PENDING],
    )
    if (!w.affectedRows) return
    await db.run("UPDATE `copy` SET `review_gate` = 'gate1', `updated_at` = ? WHERE `id` = ? AND `review_submission_id` = ?", [
      now,
      sub.copyId,
      sub.id,
    ])
    logger.info({ submissionId, reviewNo: sub.externalReviewNo, version: r.version }, 'jiaoduitai.resubmitted')
    return
  }

  // 先记下「送审已发出」，请求超时 / 5xx 后下一轮遇到 409 才知道平台上那张单可能是本单
  await getDb().run(
    "UPDATE `review_submission` SET `external_status` = ? WHERE `id` = ? AND `status` = 'submitted' AND `external_review_no` IS NULL",
    [SENDING, sub.id],
  )

  let reviewNo: string
  let label: string
  let externalStatus: string | null = null
  try {
    const r = await submitText(
      { submitter: version.createdBy || config.defaultOperator, contentText: toSubmitText(version.title, version.sections) },
      ref(sub),
    )
    reviewNo = r.review_no
    label = r.status_label || r.status
    externalStatus = r.status
  } catch (e) {
    if (!(e instanceof JiaoduitaiError) || !e.permanent) {
      logger.warn({ submissionId, err: (e as Error).message }, 'jiaoduitai.send_retry_later')
      return
    }
    // 409 + 已有单号：可能是上次送审成功但本地未落库（超时 / 重启），条件见 canAdopt
    if (e.httpStatus === 409 && e.existingReviewNo && (await canAdopt(sub, version.title, e.existingReviewNo))) {
      reviewNo = e.existingReviewNo
      label = '沿用校对台已有在审单'
    } else {
      logger.warn({ submissionId, httpStatus: e.httpStatus, err: e.message }, 'jiaoduitai.send_refused')
      const hint = e.httpStatus === 409 ? '（已有同标题文案在审，请修改标题后重新提交）' : ''
      await rejectLocally(sub, `校对台拒收：${e.message}${hint}`, null)
      return
    }
  }

  const db = getDb()
  const now = toDb(utcNow())
  const results = [...sub.gateResults, gateResult('gate1', 'pass', `已送校对台（审核单 ${reviewNo}）：${label}`)]
  const w = await db.run(
    `UPDATE \`review_submission\` SET \`external_review_no\` = ?, \`external_status\` = ?, \`status\` = 'gate1', \`gate_results\` = ?, \`updated_at\` = ?
     WHERE \`id\` = ? AND \`status\` = 'submitted' AND \`external_review_no\` IS NULL`,
    [reviewNo, externalStatus, JSON.stringify(results), now, sub.id],
  )
  if (!w.affectedRows) {
    // 送审期间被撤回或人工接管：平台上的单不会自动取消，留日志便于在校对台处理
    logger.warn({ submissionId, reviewNo }, 'jiaoduitai.send_orphaned')
    return
  }
  await db.run("UPDATE `copy` SET `review_gate` = 'gate1', `updated_at` = ? WHERE `id` = ? AND `review_submission_id` = ?", [
    now,
    sub.copyId,
    sub.id,
  ])
  logger.info({ submissionId, reviewNo }, 'jiaoduitai.sent')
}

/* ── 轮询同步 ─────────────────────────────────────────────────────── */

export async function syncSubmission(submissionId: string): Promise<void> {
  const sub = await getSubmission(submissionId)
  if (!sub?.externalReviewNo || TERMINAL_EXTERNAL.includes(sub.externalStatus ?? '')) return
  if (['approved', 'rejected', 'withdrawn'].includes(sub.status)) return

  let r: ReviewByNo
  try {
    r = await getReviewByNo(sub.externalReviewNo, ref(sub))
  } catch (e) {
    logger.warn({ submissionId, reviewNo: sub.externalReviewNo, err: (e as Error).message }, 'jiaoduitai.poll_failed')
    return
  }

  const label = `校对台：${r.status_label || r.status}`
  const mapped = mapExternalStatus(r.status)
  if (mapped === 'approved') return applyApproved(sub, r)
  // 机审高危拦截与人工驳回同为「审核意见」：退回我方改稿，意见写入 reject_reason，改稿重提后 resubmit
  if (r.status === 'pending_revise') {
    const findings = formatFindings(r)
    const reason = findings
      ? `校对台机审拦截（审核单 ${sub.externalReviewNo}）共 ${r.machine_risk_count ?? '若干'} 项风险，修改后重新提交将重送审核：\n${findings}`
      : `校对台机审拦截（审核单 ${sub.externalReviewNo}），请按审核意见修改后重新提交`
    return rejectLocally(sub, reason, r.status)
  }
  if (mapped === 'rejected') {
    const opinion = typeof r.reject_detail === 'string' && r.reject_detail.trim() ? r.reject_detail.trim() : null
    const firstOpinion = typeof r.first_opinion === 'string' && r.first_opinion.trim() ? r.first_opinion.trim() : null
    const finalOpinion = typeof r.final_opinion === 'string' && r.final_opinion.trim() ? r.final_opinion.trim() : null
    const detail = opinion ?? [firstOpinion, finalOpinion].filter(Boolean).join('；') ?? null
    const reason = `校对台驳回（审核单 ${sub.externalReviewNo}），修改后重新提交将重送审核${detail ? `：\n${detail}` : '，驳回意见请在校对台查看'}`
    return rejectLocally(sub, reason, r.status)
  }
  if (!mapped) {
    logger.warn({ submissionId, reviewNo: sub.externalReviewNo, status: r.status }, 'jiaoduitai.unknown_status')
  }
  if (mapped && mapped !== sub.status) {
    await advance(sub, mapped, label, r.status)
  } else if (r.status !== sub.externalStatus) {
    await getDb().run('UPDATE `review_submission` SET `external_status` = ?, `updated_at` = ? WHERE `id` = ?', [
      r.status,
      toDb(utcNow()),
      sub.id,
    ])
  }
}

async function applyApproved(sub: SubmissionRow, r: ReviewByNo): Promise<void> {
  // 平台只出意见不改稿：通过即认可我方送审版本，直接锁定（不再依赖返回文案）
  const ready = await ensurePendingManual(sub, '校对台审核通过')
  if (!ready) return
  await onReviewResult({
    submissionId: sub.id,
    result: 'approved',
    // D4：校对台返回了风险话术就以它为准（存为审核单的追加话术，取稿优先使用）
    appendedRiskText: extractRiskText(r, config.jiaoduitai.riskField),
    operator: OPERATOR,
  })
  await markExternal(sub.id, 'approved')
  logger.info({ submissionId: sub.id, reviewNo: sub.externalReviewNo, approvedVersionId: sub.copyVersionId }, 'jiaoduitai.approved')
}

/* ── 后台轮询 ─────────────────────────────────────────────────────── */

/** 跑一轮：补送未送出的审核单 + 同步在审单进度 */
export async function runJiaoduitaiSync(): Promise<void> {
  const db = getDb()
  const unsent = await db.all<{ id: string }>(
    "SELECT `id` FROM `review_submission` WHERE `status` = 'submitted' AND `is_stub` = 0 AND (`external_review_no` IS NULL OR `external_status` = 'resubmit_pending') ORDER BY `created_at` LIMIT 50",
  )
  for (const { id } of unsent) {
    await sendSubmission(id).catch((e) => logger.error({ submissionId: id, err: (e as Error).message }, 'jiaoduitai.send_failed'))
  }
  const inflight = await db.all<{ id: string }>(
    `SELECT \`id\` FROM \`review_submission\`
      WHERE \`external_review_no\` IS NOT NULL AND \`status\` IN ('submitted', 'gate1', 'gate2', 'gate3', 'pending_manual')
        AND (\`external_status\` IS NULL OR \`external_status\` NOT IN ('approved', 'rejected'))
      ORDER BY \`updated_at\` LIMIT 100`,
  )
  for (const { id } of inflight) {
    await syncSubmission(id).catch((e) => logger.error({ submissionId: id, err: (e as Error).message }, 'jiaoduitai.sync_failed'))
  }
}

export function startJiaoduitaiSync(): void {
  if (!hasJiaoduitai()) return
  let running = false
  const tick = async () => {
    if (running) return // 上一轮还没跑完（平台慢）时跳过，避免同一单并发处理
    running = true
    try {
      await runJiaoduitaiSync()
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'jiaoduitai.tick_failed')
    } finally {
      running = false
    }
  }
  void tick()
  setInterval(() => void tick(), Math.max(3000, config.jiaoduitai.pollMs)).unref()
  logger.info({ baseUrl: config.jiaoduitai.baseUrl, pollMs: config.jiaoduitai.pollMs }, 'jiaoduitai.sync_started')
}
