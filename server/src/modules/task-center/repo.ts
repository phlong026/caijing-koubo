/**
 * 任务中心聚合查询（任务书 §3.5：固定次数批量查询，杜绝 N+1）。
 * 只读；所有查询命中既有索引；JOIN copy 限定未归档，避免拉全库历史数据。
 */
import { getDb } from '../../db/index.js'
import { fromDb } from '../../lib/time.js'
import type { CopyLite, CutLite, PublishPlanLite, ReviewLite, TopicLite, VideoJobLite } from './normalize.js'

/**
 * 候选任务 = 未归档 copy（TC1）。
 * tab / line / keyword / phase / status 都是聚合属性或计数口径相关，一律在内存过滤：
 * 若把 tab=mine 下推 SQL，则 counts.all 会退化成「我的」数量（§6.1 tab 计数须为全量口径）。
 */
export async function listCandidateCopies(): Promise<CopyLite[]> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT c.`id`, c.`title`, c.`topic_id`, c.`status`, c.`approved_version_id`, c.`current_draft_id`, ' +
      'c.`review_gate`, c.`line`, c.`created_by`, c.`updated_at`, p.`name` AS `persona_name`, p.`owner_subject` ' +
      'FROM `copy` c ' +
      'LEFT JOIN `persona` p ON p.`id` = c.`persona_id` ' +
      'WHERE c.`archived_at` IS NULL ' +
      'ORDER BY c.`updated_at` DESC',
  )
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? null,
    topicId: r.topic_id ?? null,
    status: r.status,
    approvedVersionId: r.approved_version_id ?? null,
    currentDraftId: r.current_draft_id ?? null,
    reviewGate: r.review_gate ?? null,
    line: r.line ?? null,
    createdBy: r.created_by ?? null,
    personaName: r.persona_name ?? null,
    ownerSubject: r.owner_subject ?? null,
    updatedAt: fromDb(r.updated_at),
  }))
}

export async function topicsByIds(ids: string[]): Promise<Map<string, TopicLite>> {
  if (!ids.length) return new Map()
  const db = getDb()
  const marks = ids.map(() => '?').join(',')
  const rows = await db.all<Record<string, any>>(
    `SELECT \`id\`, \`title\`, \`status\` FROM \`topic\` WHERE \`id\` IN (${marks})`,
    ids,
  )
  return new Map(rows.map((r) => [r.id as string, { id: r.id, title: r.title, status: r.status }]))
}

/** 每 copy 的版本号信息：latest = 最大 version_no；approved = approved_version_id 对应的 version_no */
export async function versionNosByCopyIds(copyIds: string[], approvedIds: (string | null)[]): Promise<Map<string, { latest: number | null; approved: number | null }>> {
  const result = new Map<string, { latest: number | null; approved: number | null }>()
  if (!copyIds.length) return result
  const approvedSet = new Set(approvedIds.filter(Boolean) as string[])
  const db = getDb()
  const marks = copyIds.map(() => '?').join(',')
  const rows = await db.all<Record<string, any>>(
    `SELECT \`copy_id\`, \`id\`, \`version_no\` FROM \`copy_version\` WHERE \`copy_id\` IN (${marks})`,
    copyIds,
  )
  const latestMap = new Map<string, number>()
  const approvedMap = new Map<string, number>()
  for (const r of rows) {
    const copyId = r.copy_id as string
    const no = Number(r.version_no)
    const cur = latestMap.get(copyId)
    if (cur === undefined || no > cur) latestMap.set(copyId, no)
    if (approvedSet.has(r.id as string)) approvedMap.set(copyId, no)
  }
  for (const copyId of copyIds) {
    result.set(copyId, { latest: latestMap.get(copyId) ?? null, approved: approvedMap.get(copyId) ?? null })
  }
  return result
}

/** 详情：单 copy（含 created_at 供时间线），不存在或已归档返回 null */
export async function copyDetailById(id: string): Promise<(CopyLite & { createdAt: string | null }) | null> {
  const db = getDb()
  const r = await db.get<Record<string, any>>(
    'SELECT c.`id`, c.`title`, c.`topic_id`, c.`status`, c.`approved_version_id`, c.`current_draft_id`, ' +
      'c.`review_gate`, c.`line`, c.`created_by`, c.`created_at`, c.`updated_at`, ' +
      'p.`name` AS `persona_name`, p.`owner_subject` ' +
      'FROM `copy` c LEFT JOIN `persona` p ON p.`id` = c.`persona_id` ' +
      'WHERE c.`id` = ? AND c.`archived_at` IS NULL',
    [id],
  )
  if (!r) return null
  return {
    id: r.id,
    title: r.title ?? null,
    topicId: r.topic_id ?? null,
    status: r.status,
    approvedVersionId: r.approved_version_id ?? null,
    currentDraftId: r.current_draft_id ?? null,
    reviewGate: r.review_gate ?? null,
    line: r.line ?? null,
    createdBy: r.created_by ?? null,
    personaName: r.persona_name ?? null,
    ownerSubject: r.owner_subject ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}

/** 详情：审核单（含时间，供时间线） */
export async function reviewDetailOfCopy(copyId: string): Promise<(ReviewLite & { createdAt: string | null; updatedAt: string | null }) | null> {
  const db = getDb()
  const r = await db.get<Record<string, any>>(
    'SELECT `status`, `rejected_gate`, `created_at`, `updated_at` FROM `review_submission` ' +
      'WHERE `copy_id` = ? ORDER BY `created_at` DESC LIMIT 1',
    [copyId],
  )
  if (!r) return null
  return { status: r.status as string, rejectedGate: r.rejected_gate ?? null, createdAt: fromDb(r.created_at), updatedAt: fromDb(r.updated_at) }
}

export interface VersionRow {
  id: string
  versionNo: number
  createdAt: string | null
}

/** 详情：文案版本（供 latest / submitted / approved 版本号与时间线） */
export async function versionsDetailOfCopy(copyId: string): Promise<{
  latest: number | null
  submitted: number | null
  approved: number | null
  rows: VersionRow[]
}> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT `id`, `version_no`, `created_at` FROM `copy_version` WHERE `copy_id` = ? ORDER BY `version_no` ASC',
    [copyId],
  )
  if (!rows.length) return { latest: null, submitted: null, approved: null, rows: [] }
  const copy = await getDb().get<Record<string, any>>(
    'SELECT `submitted_version_id`, `approved_version_id` FROM `copy` WHERE `id` = ?',
    [copyId],
  )
  const submittedId = copy?.submitted_version_id ?? null
  const approvedId = copy?.approved_version_id ?? null
  const mapped = rows.map((r) => ({ id: r.id as string, versionNo: Number(r.version_no), createdAt: fromDb(r.created_at) }))
  const versionOf = (id: string | null) => (id ? (mapped.find((v) => v.id === id)?.versionNo ?? null) : null)
  return { latest: mapped[mapped.length - 1].versionNo, submitted: versionOf(submittedId), approved: versionOf(approvedId), rows: mapped }
}

/** 每 copy 最新审核单（按 created_at 取最后一条） */
export async function latestReviewByCopyIds(copyIds: string[]): Promise<Map<string, ReviewLite>> {
  if (!copyIds.length) return new Map()
  const db = getDb()
  const marks = copyIds.map(() => '?').join(',')
  const rows = await db.all<Record<string, any>>(
    `SELECT \`copy_id\`, \`status\`, \`rejected_gate\` FROM \`review_submission\` WHERE \`copy_id\` IN (${marks}) ORDER BY \`created_at\` ASC`,
    copyIds,
  )
  const map = new Map<string, ReviewLite>()
  for (const r of rows) {
    map.set(r.copy_id as string, { status: r.status as string, rejectedGate: r.rejected_gate ?? null })
  }
  return map
}

/** 每 copy 最新版本的基础视频任务（含混剪；JOIN copy 限定未归档） */
export async function latestVideoJobs(): Promise<Map<string, VideoJobLite>> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT v.`copy_id`, v.`version_no`, v.`phase`, v.`progress_floor`, v.`status_message`, v.`error_code`, ' +
      'v.`timeline_source`, v.`remote_task_id`, v.`remote_result_url`, v.`updated_at` ' +
      'FROM `video_job` v ' +
      'JOIN `copy` c ON c.`id` = v.`copy_id` AND c.`archived_at` IS NULL ' +
      'JOIN (SELECT `copy_id`, MAX(`version_no`) AS `mv` FROM `video_job` WHERE `archived_at` IS NULL GROUP BY `copy_id`) m ' +
      'ON m.`copy_id` = v.`copy_id` AND m.`mv` = v.`version_no` ' +
      'WHERE v.`archived_at` IS NULL',
  )
  return new Map(
    rows.map((r) => [
      r.copy_id as string,
      {
        versionNo: Number(r.version_no),
        phase: r.phase as string,
        progressFloor: Number(r.progress_floor ?? 0),
        statusMessage: r.status_message ?? null,
        errorCode: r.error_code ?? null,
        timelineSource: r.timeline_source ?? null,
        remoteTaskId: r.remote_task_id ?? null,
        remoteResultUrl: r.remote_result_url ?? null,
        updatedAt: fromDb(r.updated_at),
      } satisfies VideoJobLite,
    ]),
  )
}

/** 每 copy 最新成片行（copy 最新 video_job 下 version_no 最大的 video_cut；草稿行 v0 也算最新——无成片行时即草稿） */
export async function latestCuts(): Promise<Map<string, CutLite>> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT vc.`id`, vc.`video_job_id`, vc.`version_no`, vc.`status`, vc.`render_stage`, vc.`progress`, ' +
    'vc.`review_status`, vc.`error_code`, vc.`updated_at`, vj.`copy_id` ' +
    'FROM `video_cut` vc ' +
    'INNER JOIN `video_job` vj ON vj.`id` = vc.`video_job_id` ' +
    'JOIN `copy` c ON c.`id` = vj.`copy_id` AND c.`archived_at` IS NULL ' +
    'JOIN (SELECT `copy_id`, MAX(`version_no`) AS `mj` FROM `video_job` WHERE `archived_at` IS NULL GROUP BY `copy_id`) lj ' +
    'ON lj.`copy_id` = vj.`copy_id` AND lj.`mj` = vj.`version_no` ' +
    'JOIN (SELECT `video_job_id`, MAX(`version_no`) AS `mv` FROM `video_cut` GROUP BY `video_job_id`) lc ' +
    'ON lc.`video_job_id` = vc.`video_job_id` AND lc.`mv` = vc.`version_no` ' +
    'WHERE vj.`archived_at` IS NULL',
  )
  const toCut = (r: Record<string, any>): CutLite => ({
    id: r.id,
    videoJobId: r.video_job_id,
    versionNo: Number(r.version_no),
    status: r.status as string,
    renderStage: r.render_stage as string,
    progress: Number(r.progress ?? 0),
    reviewStatus: r.review_status as string,
    errorCode: r.error_code ?? null,
    updatedAt: fromDb(r.updated_at),
  })
  return new Map(rows.map((r) => [r.copy_id as string, toCut(r)]))
}

/** 每 copy 最新发布单（JOIN copy 限定未归档；同秒并列时内存取首条） */export async function latestPublishPlans(): Promise<Map<string, PublishPlanLite>> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT p.`id`, p.`copy_id`, p.`status`, p.`review_state`, p.`updated_at` ' +
      'FROM `publish_plan` p ' +
      'JOIN `copy` c ON c.`id` = p.`copy_id` AND c.`archived_at` IS NULL ' +
      'JOIN (SELECT `copy_id`, MAX(`created_at`) AS `mc` FROM `publish_plan` WHERE `deleted_at` IS NULL GROUP BY `copy_id`) m ' +
      'ON m.`copy_id` = p.`copy_id` AND m.`mc` = p.`created_at` ' +
      'WHERE p.`deleted_at` IS NULL',
  )
  const map = new Map<string, PublishPlanLite>()
  for (const r of rows) {
    const copyId = r.copy_id as string
    if (map.has(copyId)) continue
    map.set(copyId, {
      id: r.id as string,
      status: r.status as string,
      reviewState: r.review_state ?? 'none',
      updatedAt: fromDb(r.updated_at),
    })
  }
  return map
}

/** 发布单的分平台记录状态分布（GROUP BY 聚合，供 manual / 需处理判定） */
export async function logStatusByPlanIds(planIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (!planIds.length) return map
  const db = getDb()
  const marks = planIds.map(() => '?').join(',')
  const rows = await db.all<Record<string, any>>(
    `SELECT \`plan_id\`, \`status\` FROM \`publish_log\` WHERE \`plan_id\` IN (${marks})`,
    planIds,
  )
  for (const r of rows) {
    const list = map.get(r.plan_id as string) ?? []
    list.push(r.status as string)
    map.set(r.plan_id as string, list)
  }
  return map
}

/* ── 详情（单 copy，逐表查询）── */

export async function videoJobOfCopy(copyId: string): Promise<(VideoJobLite & { id: string }) | null> {
  const db = getDb()
  const r = await db.get<Record<string, any>>(
    'SELECT `id`, `version_no`, `phase`, `progress_floor`, `status_message`, `error_code`, ' +
      '`timeline_source`, `remote_task_id`, `remote_result_url`, `updated_at` ' +
      'FROM `video_job` WHERE `copy_id` = ? AND `archived_at` IS NULL ORDER BY `version_no` DESC LIMIT 1',
    [copyId],
  )
  if (!r) return null
  return {
    id: r.id,
    versionNo: Number(r.version_no),
    phase: r.phase,
    progressFloor: Number(r.progress_floor ?? 0),
    statusMessage: r.status_message ?? null,
    errorCode: r.error_code ?? null,
    timelineSource: r.timeline_source ?? null,
    remoteTaskId: r.remote_task_id ?? null,
    remoteResultUrl: r.remote_result_url ?? null,
    updatedAt: fromDb(r.updated_at),
  }
}

export async function videoJobEvents(jobId: string, limit = 60): Promise<{ toPhase: string; errorCode: string | null; createdAt: string }[]> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT `to_phase`, `error_code`, `created_at` FROM `video_job_event` WHERE `video_job_id` = ? ORDER BY `created_at` DESC LIMIT ?',
    [jobId, limit],
  )
  return rows.map((r) => ({ toPhase: r.to_phase as string, errorCode: r.error_code ?? null, createdAt: fromDb(r.created_at) as string }))
}

export async function publishPlanOfCopy(copyId: string): Promise<(PublishPlanLite & { id: string; createdAt: string | null }) | null> {
  const db = getDb()
  const r = await db.get<Record<string, any>>(
    'SELECT `id`, `status`, `review_state`, `created_at`, `updated_at` FROM `publish_plan` ' +
      'WHERE `copy_id` = ? AND `deleted_at` IS NULL ORDER BY `created_at` DESC LIMIT 1',
    [copyId],
  )
  if (!r) return null
  return {
    id: r.id,
    status: r.status,
    reviewState: r.review_state ?? 'none',
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}

export async function publishLogsOfCopy(planId: string): Promise<{ platform: string; status: string; createdAt: string | null; finishedAt: string | null }[]> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT `platform`, `status`, `created_at`, `finished_at` FROM `publish_log` WHERE `plan_id` = ? ORDER BY `created_at` ASC',
    [planId],
  )
  return rows.map((r) => ({ platform: r.platform as string, status: r.status as string, createdAt: fromDb(r.created_at), finishedAt: fromDb(r.finished_at) }))
}

export async function topicOfCopy(topicId: string | null): Promise<TopicLite | null> {
  if (!topicId) return null
  const map = await topicsByIds([topicId])
  return map.get(topicId) ?? null
}

/** 详情：copy 最新成片行（含 cut id 供事件查询） */
export async function cutOfCopy(copyId: string): Promise<CutLite | null> {
  const db = getDb()
  const r = await db.get<Record<string, any>>(
    'SELECT vc.`id`, vc.`video_job_id`, vc.`version_no`, vc.`status`, vc.`render_stage`, vc.`progress`, ' +
    'vc.`review_status`, vc.`error_code`, vc.`updated_at` ' +
    'FROM `video_cut` vc ' +
    'INNER JOIN `video_job` vj ON vj.`id` = vc.`video_job_id` AND vj.`archived_at` IS NULL ' +
    'WHERE vj.`copy_id` = ? ' +
    'ORDER BY vj.`version_no` DESC, vc.`version_no` DESC LIMIT 1',
    [copyId],
  )
  if (!r) return null
  return {
    id: r.id,
    videoJobId: r.video_job_id,
    versionNo: Number(r.version_no),
    status: r.status as string,
    renderStage: r.render_stage as string,
    progress: Number(r.progress ?? 0),
    reviewStatus: r.review_status as string,
    errorCode: r.error_code ?? null,
    updatedAt: fromDb(r.updated_at),
  }
}

/** 详情：成片渲染事件流水（§3.6 时间线；取 copy 最新 job 的全部成片版本事件） */
export async function cutEventsOfCopy(copyId: string, limit = 60): Promise<{ versionNo: number; toStatus: string; errorCode: string | null; createdAt: string }[]> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT vc.`version_no`, e.`to_status`, e.`error_code`, e.`created_at` ' +
    'FROM `video_cut_event` e ' +
    'INNER JOIN `video_cut` vc ON vc.`id` = e.`cut_id` ' +
    'INNER JOIN `video_job` vj ON vj.`id` = vc.`video_job_id` AND vj.`archived_at` IS NULL ' +
    'WHERE vj.`copy_id` = ? ' +
    'ORDER BY e.`created_at` DESC LIMIT ?',
    [copyId, limit],
  )
  return rows.map((r) => ({ versionNo: Number(r.version_no), toStatus: r.to_status as string, errorCode: r.error_code ?? null, createdAt: fromDb(r.created_at) as string }))
}

/** 详情：成片复审单（最新一条，供时间线） */
export async function cutReviewOfCut(cutId: string): Promise<{ status: string; createdAt: string | null; decisionAt: string | null; decisionReason: string | null } | null> {
  const db = getDb()
  const r = await db.get<Record<string, any>>(
    'SELECT `status`, `created_at`, `decision_at`, `decision_reason` FROM `cut_review_submission` ' +
    'WHERE `cut_id` = ? ORDER BY `created_at` DESC LIMIT 1',
    [cutId],
  )
  if (!r) return null
  return { status: r.status as string, createdAt: fromDb(r.created_at), decisionAt: fromDb(r.decision_at), decisionReason: r.decision_reason ?? null }
}
