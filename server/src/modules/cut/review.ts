import { getDb } from '../../db/index.js'
import { newId, jdec } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { getCut, approveReview, appendEvent } from './repo.js'
import type { CutSegment, VideoCut } from './types.js'

/**
 * 成片复审链（任务书 FR-V / CE5，EC9：对照文案审核链，同步三关桩）：
 * submitted → gate1(禁用词扫描) → gate2(智能体桩) → gate3(尾页校验) → pending_manual
 * → approved（冻结 approved_content_hash）/ rejected（原因必填）。
 * 推进在提交请求内同步完成（无 sleep、无 is_stub 续推需求）。
 */

export interface CutReviewSubmission {
  id: string
  cutId: string
  cutVersionNo: number
  contentHash: string | null
  status: 'submitted' | 'gate1' | 'gate2' | 'gate3' | 'pending_manual' | 'approved' | 'rejected'
  gates: Array<{ gate: string; result: 'pass' | 'fail'; reason: string }>
  riskPoints: string[]
  decisionBy: string | null
  decisionAt: string | null
  decisionReason: string | null
  createdAt: string | null
}

function rowToSubmission(r: Record<string, unknown>): CutReviewSubmission {
  return {
    id: String(r.id),
    cutId: String(r.cut_id),
    cutVersionNo: Number(r.cut_version_no ?? 0),
    contentHash: (r.content_hash as string) ?? null,
    status: r.status as CutReviewSubmission['status'],
    gates: jdec(r.gates, [] as CutReviewSubmission['gates']),
    riskPoints: jdec(r.risk_points, [] as string[]),
    decisionBy: (r.decision_by as string) ?? null,
    decisionAt: (r.decision_at as string) ?? null,
    decisionReason: (r.decision_reason as string) ?? null,
    createdAt: (r.created_at as string) ?? null,
  }
}

const SUB_COLS = 'id, cut_id, cut_version_no, content_hash, status, gates, risk_points, decision_by, decision_at, decision_reason, created_at'

async function getSubmission(id: string): Promise<CutReviewSubmission | null> {
  const row = await getDb().get(`SELECT ${SUB_COLS} FROM \`cut_review_submission\` WHERE \`id\` = ?`, [id])
  return row ? rowToSubmission(row) : null
}

export async function getLatestSubmission(cutId: string): Promise<CutReviewSubmission | null> {
  const row = await getDb().get(`SELECT ${SUB_COLS} FROM \`cut_review_submission\` WHERE \`cut_id\` = ? ORDER BY \`created_at\` DESC LIMIT 1`, [cutId])
  return row ? rowToSubmission(row) : null
}

/** 第 1 关禁用词扫描：只读复用文案合规模板词库（§12：不改其表与接口） */
async function scanBannedWords(texts: string[], personaId: string | null): Promise<string[]> {
  const { listComplianceWords } = await import('../copy/repo.js')
  const words = await listComplianceWords({ enabledOnly: true }).catch(() => [])
  let claims: string[] = []
  if (personaId) {
    const { getPersonaById } = await import('../personas/repo.js')
    const p = await getPersonaById(personaId, true).catch(() => null)
    claims = p?.ipProfile?.forbiddenClaims ?? []
  }
  const joined = texts.join('\n')
  const hits: string[] = []
  for (const w of [...words.map((x) => x.word), ...claims]) {
    if (w?.trim() && joined.includes(w.trim())) hits.push(w.trim())
  }
  return [...new Set(hits)]
}

/** 提交复审（FR-V1）：completed 才可；rejected 后同版本禁重提；进行中幂等返回 */
export async function submitCutReview(cutId: string, operator: string): Promise<{ submission: CutReviewSubmission; idempotent: boolean }> {
  const cut = await getCut(cutId)
  if (!cut) throw err.notFound('成片版本不存在')
  if (cut.status !== 'completed') throw err.cutNotCompleted(`当前状态 ${cut.status}，仅渲染完成的成片可提交复审`)

  const latest = await getLatestSubmission(cutId)
  if (latest && ['submitted', 'gate1', 'gate2', 'gate3', 'pending_manual'].includes(latest.status)) {
    return { submission: latest, idempotent: true }
  }
  if (latest && latest.status === 'rejected' && latest.cutVersionNo === cut.versionNo) {
    throw err.invalidState('该版本复审已被退回，请修改配置重新渲染新版本后再提交', { submissionId: latest.id })
  }

  // 同步三关推进（EC9）
  const texts = cut.segments.map((s) => s.text).concat(cut.riskTailEnabled ? [cut.riskTailText ?? ''] : [])
  const job = await getDb().get<{ persona_id: string | null }>('SELECT `persona_id` FROM `video_job` WHERE `id` = ?', [cut.videoJobId])
  const bannedHits = await scanBannedWords(texts, job?.persona_id ?? null)
  const gates: CutReviewSubmission['gates'] = [
    { gate: 'gate1', result: 'pass', reason: bannedHits.length ? `禁用词扫描命中 ${bannedHits.length} 项，请人工复核` : '禁用词与禁用表述扫描通过' },
    { gate: 'gate2', result: 'pass', reason: '事实与风险点检查通过（审核智能体对接后替换桩结论）' },
  ]
  const riskPoints = [...bannedHits.map((w) => `字幕/尾页命中禁用词：${w}`)]
  if (!cut.riskTailEnabled || !cut.riskTailText) riskPoints.push('成片未包含风险尾页（gate3 仅校验存在性，Q4 拍板适用范围后可收紧）')
  gates.push({ gate: 'gate3', result: 'pass', reason: cut.riskTailEnabled && cut.riskTailText ? '风险尾页已包含' : '风险尾页未开启（已记入 risk_points）' })

  const id = newId('crev')
  const now = toDb(utcNow())
  await getDb().run(
    'INSERT INTO `cut_review_submission` (`id`, `cut_id`, `cut_version_no`, `content_hash`, `status`, `gates`, `risk_points`, `created_by`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, cutId, cut.versionNo, cut.contentHash, 'pending_manual', JSON.stringify(gates), JSON.stringify(riskPoints), operator, now, now],
  )
  await getDb().run('UPDATE `video_cut` SET `review_status` = \'in_review\', `updated_at` = ? WHERE `id` = ?', [now, cutId])
  await appendEvent(cutId, 'completed', 'completed', { detail: { review: 'submitted', submissionId: id }, operator })
  logger.info({ cutId, submissionId: id, riskPoints: riskPoints.length }, 'cut.review.submitted')
  return { submission: (await getSubmission(id))!, idempotent: false }
}

/** 人工裁决（FR-V2）：reviewer/admin（路由层 ROLE_RULES 已限）；rejected 原因必填 */
export async function decideCutReview(
  cutId: string,
  input: { result: 'approved' | 'rejected'; reason?: string },
  operator: string,
): Promise<CutReviewSubmission> {
  const latest = await getLatestSubmission(cutId)
  if (!latest || latest.status !== 'pending_manual') throw err.invalidState('该成片没有待人工复核的复审单')
  if (input.result === 'rejected' && !input.reason?.trim()) throw err.badRequest('退回原因必填')

  const db = getDb()
  const now = toDb(utcNow())
  const w = await db.run(
    'UPDATE `cut_review_submission` SET `status` = ?, `decision_by` = ?, `decision_at` = ?, `decision_reason` = ?, `updated_at` = ? WHERE `id` = ? AND `status` = ?',
    [input.result, operator, now, input.reason?.trim().slice(0, 500) ?? null, now, latest.id, 'pending_manual'],
  )
  if (!w.affectedRows) throw err.invalidState('复审单状态已变化，请刷新后重试')

  const cut = await getCut(cutId)
  if (input.result === 'approved' && cut?.contentHash) {
    await approveReview(cutId, cut.contentHash)
  } else if (input.result === 'rejected') {
    await db.run('UPDATE `video_cut` SET `review_status` = \'rejected\', `updated_at` = ? WHERE `id` = ?', [now, cutId])
  }
  await appendEvent(cutId, 'completed', 'completed', { detail: { review: input.result, submissionId: latest.id }, operator })
  return (await getSubmission(latest.id))!
}

/** 复审队列（FR-V4，审核工作台成片 Tab）：按状态 / 线筛选 */
export async function listCutReviewQueue(query: { status?: string; line?: string } = {}): Promise<
  Array<{ cut: VideoCut; submission: CutReviewSubmission | null; copyTitle: string | null }>
> {
  const db = getDb()
  const status = query.status || 'pending_manual'
  const subs = await db.all<Record<string, unknown>>(
    `SELECT ${SUB_COLS.replaceAll('`', '')} FROM \`cut_review_submission\` WHERE \`status\` = ? ORDER BY \`created_at\` ASC LIMIT 200`,
    [status],
  )
  const out: Array<{ cut: VideoCut; submission: CutReviewSubmission | null; copyTitle: string | null }> = []
  for (const r of subs) {
    const sub = rowToSubmission(r)
    const cut = await getCut(sub.cutId)
    if (!cut) continue
    const job = await db.get<{ line: string | null; copy_id: string }>('SELECT `line`, `copy_id` FROM `video_job` WHERE `id` = ?', [
      cut.videoJobId,
    ])
    if (query.line && (job?.line ?? null) !== query.line) continue
    const copy = job ? await db.get<{ title: string | null }>('SELECT `title` FROM `copy` WHERE `id` = ?', [job.copy_id]) : null
    out.push({ cut, submission: sub, copyTitle: copy?.title ?? null })
  }
  return out
}

/** 字幕 diff（FR-V4）：编辑段前后对照 */
export function subtitleDiff(cut: VideoCut, baseTimelineTexts: string[]): Array<{ index: number; original: string; edited: string; kind: string }> {
  return cut.segments
    .map((s: CutSegment, i: number) => ({ index: s.index, original: baseTimelineTexts[i] ?? '', edited: s.text, kind: s.kind }))
    .filter((d) => d.original !== d.edited)
}
