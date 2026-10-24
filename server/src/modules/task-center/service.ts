/**
 * 任务中心聚合服务（任务书 §3 / §6）。
 * 列表 = 固定次数查询 + 内存筛选分页（phase/status/needAttention 是聚合属性，无法下推 SQL；
 * 一期量级下全量投影 + 内存过滤为最简正确实现，见任务书 §3.5）。
 * 任一聚合来源失败只降级该来源对应的节点（AC-R1），不阻塞整树。
 */
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { parsePaging, pageResult, type PageResult } from '../../lib/util.js'
import {
  CUT_STATUS_LABELS,
  needAttentionOf,
  normalizeCopyNode,
  normalizeEditNode,
  normalizePublishNode,
  normalizeTopicNode,
  normalizeVideoNode,
  stageOf,
  taskStatusOf,
  type CopyLite,
  type CutLite,
  type PublishPlanLite,
  type ReviewLite,
  type TopicLite,
  type VideoJobLite,
} from './normalize.js'
import { VIDEO_PHASE_LABELS, type NodeKey, type TaskNode, type TaskSummary, type TimelineItem, type TaskDetail } from './types.js'
import {
  copyDetailById,
  cutEventsOfCopy,
  cutOfCopy,
  cutReviewOfCut,
  latestCuts,
  latestPublishPlans,
  latestReviewByCopyIds,
  latestVideoJobs,
  listCandidateCopies,
  logStatusByPlanIds,
  publishLogsOfCopy,
  publishPlanOfCopy,
  reviewDetailOfCopy,
  topicsByIds,
  topicOfCopy,
  versionNosByCopyIds,
  versionsDetailOfCopy,
  videoJobEvents,
  videoJobOfCopy,
} from './repo.js'

export interface ListQuery {
  tab?: string
  phase?: string
  status?: string
  line?: string
  keyword?: string
  page?: number
  pageSize?: number
  operator: string
}

/** 聚合来源（与 §3.5 的查询一一对应），任一失败只降级它负责的节点 */
export type SourceKey = 'topics' | 'reviews' | 'versions' | 'jobs' | 'cuts' | 'plans' | 'logStatuses'

function degradeNode(key: NodeKey, title: string, e?: unknown): TaskNode {
  if (e) logger.warn({ err: e, node: key }, 'task-center 节点聚合失败，已降级')
  return {
    key, title, statusKey: 'error', statusLabel: '状态获取失败',
    tone: 'error', action: null, actions: [], actionLabel: null, progress: null, happenedAt: null, refId: null,
  }
}

/** 单步聚合降级：失败记 warn、登记失败来源并返回兜底值，不阻塞整树（AC-R1） */
async function safe<T>(label: string, failed: Set<SourceKey>, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    logger.warn({ err: e, step: label }, 'task-center 聚合步骤失败，已降级为空')
    failed.add(label as SourceKey)
    return fallback
  }
}

export interface Aggregates {
  topics: Map<string, TopicLite>
  reviews: Map<string, ReviewLite>
  versions: Map<string, { latest: number | null; approved: number | null }>
  jobs: Map<string, VideoJobLite>
  cuts: Map<string, CutLite>
  plans: Map<string, PublishPlanLite>
  logStatuses: Map<string, string[]>
  /** 失败来源集合：命中即对应节点输出「状态获取失败」 */
  failed: Set<SourceKey>
}

async function aggregate(copies: CopyLite[], approvedIds: (string | null)[]): Promise<Aggregates> {
  const failed = new Set<SourceKey>()
  const topicIds = [...new Set(copies.map((c) => c.topicId).filter(Boolean) as string[])]
  const copyIds = copies.map((c) => c.id)
  const [topics, reviews, versions, jobs, cuts, plans] = await Promise.all([
    safe('topics', failed, () => topicsByIds(topicIds), new Map<string, TopicLite>()),
    safe('reviews', failed, () => latestReviewByCopyIds(copyIds), new Map<string, ReviewLite>()),
    safe('versions', failed, () => versionNosByCopyIds(copyIds, approvedIds), new Map<string, { latest: number | null; approved: number | null }>()),
    safe('jobs', failed, () => latestVideoJobs(), new Map<string, VideoJobLite>()),
    safe('cuts', failed, () => latestCuts(), new Map<string, CutLite>()),
    safe('plans', failed, () => latestPublishPlans(), new Map<string, PublishPlanLite>()),
  ])
  const logStatuses = await safe(
    'logStatuses',
    failed,
    () => logStatusByPlanIds([...plans.values()].map((p) => p.id)),
    new Map<string, string[]>(),
  )
  return { topics, reviews, versions, jobs, cuts, plans, logStatuses, failed }
}

/** 组装单条任务树（导出仅供单测构造聚合输入，AC-R1 降级分支覆盖） */
export function buildTaskSummary(copy: CopyLite, agg: Aggregates): TaskSummary {
  const nodes: TaskNode[] = []
  const topic = copy.topicId ? agg.topics.get(copy.topicId) ?? null : null
  try {
    if (agg.failed.has('topics') && copy.topicId) nodes.push(degradeNode('topic', '选题'))
    else {
      const topicNode = normalizeTopicNode(topic)
      if (topicNode) nodes.push(topicNode)
    }
  } catch (e) {
    nodes.push(degradeNode('topic', '选题', e))
  }
  const job = agg.jobs.get(copy.id) ?? null
  try {
    if (agg.failed.has('reviews') || agg.failed.has('versions')) nodes.push(degradeNode('copy', '稿件'))
    else nodes.push(normalizeCopyNode(copy, agg.reviews.get(copy.id) ?? null, agg.versions.get(copy.id) ?? { latest: null, approved: null }, Boolean(job)))
  } catch (e) {
    nodes.push(degradeNode('copy', '稿件', e))
  }
  try {
    if (agg.failed.has('jobs')) nodes.push(degradeNode('base_video', '基础视频'))
    else nodes.push(normalizeVideoNode(job, copy.status === 'approved' || Boolean(copy.approvedVersionId)))
  } catch (e) {
    nodes.push(degradeNode('base_video', '基础视频', e))
  }
  try {
    if (agg.failed.has('cuts')) nodes.push(degradeNode('edit', '剪辑'))
    else nodes.push(normalizeEditNode(agg.cuts.get(copy.id) ?? null, job?.phase === 'completed'))
  } catch (e) {
    nodes.push(degradeNode('edit', '剪辑', e))
  }
  try {
    if (agg.failed.has('plans') || agg.failed.has('logStatuses')) nodes.push(degradeNode('publish', '发布'))
    else {
      const plan = agg.plans.get(copy.id) ?? null
      const videoCompleted = job?.phase === 'completed'
      nodes.push(normalizePublishNode(plan, plan ? agg.logStatuses.get(plan.id) ?? [] : [], videoCompleted))
    }
  } catch (e) {
    nodes.push(degradeNode('publish', '发布', e))
  }

  const stage = stageOf(nodes)
  return {
    copyId: copy.id,
    taskNo: copy.id.slice(-6),
    title: copy.title || topic?.title || '未命名任务',
    line: copy.line,
    subject: copy.ownerSubject,
    personaName: copy.personaName,
    createdBy: copy.createdBy,
    status: taskStatusOf(nodes),
    needAttention: needAttentionOf(nodes),
    updatedAt: copy.updatedAt,
    stage: { key: stage.key, title: stage.title, statusKey: stage.statusKey, statusLabel: stage.statusLabel, tone: stage.tone, progress: stage.progress },
    nodes,
  }
}

/** keyword 口径（FR-T3 + 前端提示）：标题 / 选题标题 / 人物名 / 任务号 / 负责人 */
function matchKeyword(t: TaskSummary, kw: string): boolean {
  const needle = kw.toLowerCase()
  const haystack = [t.title, t.personaName, t.createdBy, t.taskNo, t.copyId].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(needle)
}

export async function listTasks(q: ListQuery): Promise<PageResult<TaskSummary> & { counts: { all: number; mine: number; todo: number } }> {
  const tab = (['all', 'mine', 'todo'].includes(q.tab ?? '') ? q.tab : 'all') as 'all' | 'mine' | 'todo'
  // counts 与筛选无关：先对全量未归档任务建档，再过滤
  const copies = await listCandidateCopies()
  const agg = await aggregate(copies, copies.map((c) => c.approvedVersionId))
  const all = copies.map((c) => buildTaskSummary(c, agg))

  const counts = {
    all: all.length,
    mine: all.filter((t) => t.createdBy === q.operator).length,
    todo: all.filter((t) => t.needAttention).length,
  }

  let filtered = all
  if (tab === 'mine') filtered = filtered.filter((t) => t.createdBy === q.operator)
  else if (tab === 'todo') filtered = filtered.filter((t) => t.needAttention)
  if (q.line) filtered = filtered.filter((t) => t.line === q.line)
  if (q.keyword) filtered = filtered.filter((t) => matchKeyword(t, q.keyword!))
  if (q.status && ['attention', 'completed', 'cancelled', 'in_progress'].includes(q.status)) {
    filtered = filtered.filter((t) => t.status === q.status)
  }
  if (q.phase && ['topic', 'copy', 'base_video', 'edit', 'publish'].includes(q.phase)) {
    filtered = filtered.filter((t) => t.stage.key === q.phase)
  }

  const p = parsePaging({ page: q.page, pageSize: q.pageSize }, 20, 100)
  return { ...pageResult(filtered.slice(p.offset, p.offset + p.limit), filtered.length, p), counts }
}

/** 时间线上限（§3.6） */
export const TIMELINE_LIMIT = 100

export async function getTaskDetail(copyId: string): Promise<TaskDetail> {
  const copy = await copyDetailById(copyId)
  if (!copy) throw err.taskNotFound()

  // 详情同样逐步降级（AC-R1：单节点失败不阻塞其余节点），只有 copy 主查询失败才抛 404
  const failed = new Set<SourceKey>()
  const [topic, review, versions, job, cut, plan] = await Promise.all([
    safe('topics', failed, () => topicOfCopy(copy.topicId), null),
    safe('reviews', failed, () => reviewDetailOfCopy(copy.id), null),
    safe('versions', failed, () => versionsDetailOfCopy(copy.id), { latest: null, submitted: null, approved: null, rows: [] }),
    safe('jobs', failed, () => videoJobOfCopy(copy.id), null),
    safe('cuts', failed, () => cutOfCopy(copy.id), null),
    safe('plans', failed, () => publishPlanOfCopy(copy.id), null),
  ])
  const [logStatuses, events, logs, cutEvents, cutReview] = await Promise.all([
    plan ? safe('logStatuses', failed, () => logStatusByPlanIds([plan.id]), new Map<string, string[]>()) : Promise.resolve(new Map<string, string[]>()),
    job ? safe('jobs', failed, () => videoJobEvents(job.id), []) : Promise.resolve([]),
    plan ? safe('plans', failed, () => publishLogsOfCopy(plan.id), []) : Promise.resolve([]),
    safe('cuts', failed, () => cutEventsOfCopy(copy.id), []),
    cut ? safe('cuts', failed, () => cutReviewOfCut(cut.id), null) : Promise.resolve(null),
  ])

  const agg: Aggregates = {
    topics: topic ? new Map([[topic.id, topic]]) : new Map(),
    reviews: review ? new Map([[copy.id, review]]) : new Map(),
    versions: new Map([[copy.id, { latest: versions.latest, approved: versions.approved }]]),
    jobs: job ? new Map([[copy.id, job]]) : new Map(),
    cuts: cut ? new Map([[copy.id, cut]]) : new Map(),
    plans: plan ? new Map([[copy.id, plan]]) : new Map(),
    logStatuses,
    failed,
  }
  const task = buildTaskSummary(copy, agg)

  /* ── 时间线（§3.6：copy / copy_version / review_submission / video_job_event / publish_log）── */
  const timeline: TimelineItem[] = []
  if (copy.createdAt) timeline.push({ time: copy.createdAt, node: 'copy', title: '任务创建', desc: copy.title || '未命名任务', tone: 'done' })
  // 稿件关键版本：提交版 / 通过版 / 最新一版（同一版本去重）
  const keyVersionIds = new Set<string>()
  const keyRows = versions.rows.filter((v) => {
    const key = v.versionNo === versions.submitted || v.versionNo === versions.approved || v.versionNo === versions.latest
    if (!key || keyVersionIds.has(v.id)) return false
    keyVersionIds.add(v.id)
    return true
  })
  for (const v of keyRows) {
    if (!v.createdAt) continue
    const tag = v.versionNo === versions.approved ? '已通过' : v.versionNo === versions.submitted ? '已提交审核' : '保存'
    timeline.push({ time: v.createdAt, node: 'copy', title: `稿件 v${v.versionNo} 保存`, desc: tag, tone: 'done' })
  }
  if (review?.createdAt) timeline.push({ time: review.createdAt, node: 'copy', title: '提交审核', desc: '', tone: 'wait' })
  if (review?.updatedAt && review.updatedAt !== review.createdAt && ['approved', 'rejected'].includes(review.status)) {
    timeline.push({
      time: review.updatedAt, node: 'copy',
      title: review.status === 'approved' ? '审核通过' : '审核退回',
      desc: review.status === 'rejected' && review.rejectedGate ? `第 ${review.rejectedGate.replace('gate', '')} 关退回` : '',
      tone: review.status === 'approved' ? 'done' : 'error',
    })
  }
  for (const e of events) {
    timeline.push({
      time: e.createdAt, node: 'base_video',
      title: `基础视频 v${job?.versionNo ?? ''}：${VIDEO_PHASE_LABELS[e.toPhase] ?? e.toPhase}`,
      desc: e.errorCode ?? '', tone: ['failed', 'save_failed', 'submission_unknown'].includes(e.toPhase) ? 'error' : 'doing',
    })
  }
  for (const e of cutEvents) {
    timeline.push({
      time: e.createdAt, node: 'edit',
      title: `成片 v${e.versionNo}：${CUT_STATUS_LABELS[e.toStatus] ?? e.toStatus}`,
      desc: e.errorCode ?? '', tone: e.toStatus === 'failed' ? 'error' : 'doing',
    })
  }
  if (cutReview?.createdAt) timeline.push({ time: cutReview.createdAt, node: 'edit', title: `成片 v${cut?.versionNo ?? ''} 提交复审`, desc: '', tone: 'wait' })
  if (cutReview?.decisionAt && ['approved', 'rejected'].includes(cutReview.status)) {
    timeline.push({
      time: cutReview.decisionAt, node: 'edit',
      title: cutReview.status === 'approved' ? `成片 v${cut?.versionNo ?? ''} 复审通过` : `成片 v${cut?.versionNo ?? ''} 复审退回`,
      desc: cutReview.decisionReason ?? '', tone: cutReview.status === 'approved' ? 'done' : 'error',
    })
  }
  if (plan?.createdAt) timeline.push({ time: plan.createdAt, node: 'publish', title: '创建发布单', desc: '', tone: 'doing' })
  for (const l of logs) {
    if (!l.finishedAt) continue
    const ok = l.status === 'published'
    timeline.push({
      time: l.finishedAt, node: 'publish',
      title: `${l.platform} ${ok ? '发布成功' : `发布${l.status === 'failed_final' ? '最终失败' : '未完成'}`}`,
      desc: l.status, tone: ok ? 'done' : 'error',
    })
  }
  timeline.sort((a, b) => (a.time < b.time ? 1 : -1))

  const stageKey = task.stage.key
  const nodeOf = (k: NodeKey) => task.nodes.find((n) => n.key === k)
  return {
    task,
    // 倒序返回（§3.6），前端正序展示
    timeline: timeline.slice(0, TIMELINE_LIMIT),
    timelineTruncated: timeline.length > TIMELINE_LIMIT,
    chips: [
      { key: 'copy', title: nodeOf('copy')?.title ?? '稿件', sub: nodeOf('copy')?.statusLabel ?? '', current: stageKey === 'copy' },
      { key: 'base_video', title: nodeOf('base_video')?.title ?? '基础视频', sub: nodeOf('base_video')?.statusLabel ?? '', current: stageKey === 'base_video' },
      ...(cut && cut.versionNo >= 1
        ? [{ key: 'edit' as NodeKey, title: nodeOf('edit')?.title ?? `成片 v${cut.versionNo}`, sub: nodeOf('edit')?.statusLabel ?? '', current: stageKey === 'edit' }]
        : []),
      { key: 'publish', title: '发布单', sub: nodeOf('publish')?.statusLabel ?? '', current: stageKey === 'publish' },
    ],
  }
}
