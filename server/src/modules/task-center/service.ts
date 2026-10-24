/**
 * 任务中心聚合服务（任务书 §3 / §6）。
 * 列表 = 固定次数查询 + 内存筛选分页（phase/status/needAttention 是聚合属性，无法下推 SQL；
 * 一期量级下全量投影 + 内存过滤为最简正确实现，见任务书 §10.4）。
 * 任一聚合步骤失败只降级该节点（AC-R1），不阻塞整树。
 */
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { parsePaging, pageResult, type PageResult } from '../../lib/util.js'
import {
  editPlaceholderNode,
  needAttentionOf,
  normalizeCopyNode,
  normalizePublishNode,
  normalizeTopicNode,
  normalizeVideoNode,
  stageOf,
  taskStatusOf,
  type CopyLite,
  type PublishPlanLite,
  type ReviewLite,
  type TopicLite,
  type VideoJobLite,
} from './normalize.js'
import { VIDEO_PHASE_LABELS, type NodeKey, type TaskNode, type TaskSummary, type TimelineItem, type TaskDetail } from './types.js'
import {
  copyDetailById,
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

function degradeNode(key: NodeKey, title: string, e: unknown): TaskNode {
  logger.warn({ err: e, key, copyTitle: title }, 'task-center 节点聚合失败，已降级')
  return {
    key, title, statusKey: 'error', statusLabel: '状态获取失败',
    tone: 'error', action: null, actions: [], actionLabel: null, progress: null, happenedAt: null,
  }
}

/** 单步聚合降级：失败记 warn 并返回兜底值，不阻塞整树（AC-R1） */
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    logger.warn({ err: e, step: label }, 'task-center 聚合步骤失败，已降级为空')
    return fallback
  }
}

interface Aggregates {
  topics: Map<string, TopicLite>
  reviews: Map<string, ReviewLite>
  versions: Map<string, { latest: number | null; approved: number | null }>
  jobs: Map<string, VideoJobLite>
  plans: Map<string, PublishPlanLite>
  logStatuses: Map<string, string[]>
}

async function aggregate(copies: CopyLite[], approvedIds: (string | null)[]): Promise<Aggregates> {
  const topicIds = [...new Set(copies.map((c) => c.topicId).filter(Boolean) as string[])]
  const copyIds = copies.map((c) => c.id)
  const [topics, reviews, versions, jobs, plans] = await Promise.all([
    safe('topics', () => topicsByIds(topicIds), new Map<string, TopicLite>()),
    safe('reviews', () => latestReviewByCopyIds(copyIds), new Map<string, ReviewLite>()),
    safe('versions', () => versionNosByCopyIds(copyIds, approvedIds), new Map<string, { latest: number | null; approved: number | null }>()),
    safe('jobs', () => latestVideoJobs(), new Map<string, VideoJobLite>()),
    safe('plans', () => latestPublishPlans(), new Map<string, PublishPlanLite>()),
  ])
  const logStatuses = await safe(
    'logStatuses',
    () => logStatusByPlanIds([...plans.values()].map((p) => p.id)),
    new Map<string, string[]>(),
  )
  return { topics, reviews, versions, jobs, plans, logStatuses }
}

function buildTaskSummary(copy: CopyLite, agg: Aggregates): TaskSummary {
  const nodes: TaskNode[] = []
  try {
    const topic = normalizeTopicNode(copy.topicId ? agg.topics.get(copy.topicId) ?? null : null)
    if (topic) nodes.push(topic)
  } catch (e) {
    nodes.push(degradeNode('topic', '选题', e))
  }
  try {
    const job = agg.jobs.get(copy.id) ?? null
    nodes.push(normalizeCopyNode(copy, agg.reviews.get(copy.id) ?? null, agg.versions.get(copy.id) ?? { latest: null, approved: null }, Boolean(job)))
  } catch (e) {
    nodes.push(degradeNode('copy', '稿件', e))
  }
  try {
    nodes.push(normalizeVideoNode(agg.jobs.get(copy.id) ?? null, copy.status === 'approved' || Boolean(copy.approvedVersionId)))
  } catch (e) {
    nodes.push(degradeNode('base_video', '基础视频', e))
  }
  nodes.push(editPlaceholderNode())
  try {
    const plan = agg.plans.get(copy.id) ?? null
    const videoCompleted = agg.jobs.get(copy.id)?.phase === 'completed'
    nodes.push(normalizePublishNode(plan, plan ? agg.logStatuses.get(plan.id) ?? [] : [], videoCompleted))
  } catch (e) {
    nodes.push(degradeNode('publish', '发布', e))
  }

  const stage = stageOf(nodes)
  return {
    copyId: copy.id,
    taskNo: copy.id.slice(-6),
    title: copy.title || agg.topics.get(copy.topicId ?? '')?.title || '未命名任务',
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

export async function listTasks(q: ListQuery): Promise<PageResult<TaskSummary> & { counts: { all: number; mine: number; todo: number } }> {
  const tab = (['all', 'mine', 'todo'].includes(q.tab ?? '') ? q.tab : 'all') as 'all' | 'mine' | 'todo'
  const copies = await listCandidateCopies({ tab, line: q.line, keyword: q.keyword, createdBy: q.operator })
  const agg = await aggregate(copies, copies.map((c) => c.approvedVersionId))
  const all = copies.map((c) => buildTaskSummary(c, agg))

  const counts = {
    all: all.length,
    mine: all.filter((t) => t.createdBy === q.operator).length,
    todo: all.filter((t) => t.needAttention).length,
  }

  let filtered = all
  if (tab === 'todo') filtered = filtered.filter((t) => t.needAttention)
  if (q.status === 'attention') filtered = filtered.filter((t) => t.status === 'attention')
  else if (q.status === 'completed') filtered = filtered.filter((t) => t.status === 'completed')
  else if (q.status === 'cancelled') filtered = filtered.filter((t) => t.status === 'cancelled')
  else if (q.status === 'in_progress') filtered = filtered.filter((t) => t.status === 'in_progress')
  if (q.phase && ['topic', 'copy', 'base_video', 'publish'].includes(q.phase)) {
    filtered = filtered.filter((t) => t.stage.key === q.phase)
  }

  const p = parsePaging({ page: q.page, pageSize: q.pageSize }, 20, 100)
  return { ...pageResult(filtered.slice(p.offset, p.offset + p.limit), filtered.length, p), counts }
}

export async function getTaskDetail(copyId: string): Promise<TaskDetail> {
  const copy = await copyDetailById(copyId)
  if (!copy) throw err.notFound('任务不存在或已归档')

  // 详情同样逐步降级（AC-R1：单节点失败不阻塞其余节点），只有 copy 主查询失败才抛 404
  const [topic, review, versions, job, plan] = await Promise.all([
    safe('detail.topic', () => topicOfCopy(copy.topicId), null),
    safe('detail.review', () => reviewDetailOfCopy(copy.id), null),
    safe('detail.versions', () => versionsDetailOfCopy(copy.id), { latest: null, approved: null, rows: [] }),
    safe('detail.job', () => videoJobOfCopy(copy.id), null),
    safe('detail.plan', () => publishPlanOfCopy(copy.id), null),
  ])
  const [logStatuses, events, logs] = await Promise.all([
    plan ? safe('detail.logStatuses', () => logStatusByPlanIds([plan.id]), new Map<string, string[]>()) : Promise.resolve(new Map<string, string[]>()),
    job ? safe('detail.events', () => videoJobEvents(job.id), []) : Promise.resolve([]),
    plan ? safe('detail.logs', () => publishLogsOfCopy(plan.id), []) : Promise.resolve([]),
  ])

  const agg: Aggregates = {
    topics: topic ? new Map([[topic.id, topic]]) : new Map(),
    reviews: review ? new Map([[copy.id, review]]) : new Map(),
    versions: new Map([[copy.id, { latest: versions.latest, approved: versions.approved }]]),
    jobs: job ? new Map([[copy.id, job]]) : new Map(),
    plans: plan ? new Map([[copy.id, plan]]) : new Map(),
    logStatuses,
  }
  const task = buildTaskSummary(copy, agg)

  /* ── 时间线（§3.6）── */
  const timeline: TimelineItem[] = []
  if (copy.createdAt) timeline.push({ time: copy.createdAt, node: 'copy', title: '任务创建', desc: copy.title || '未命名任务', tone: 'done' })
  if (review?.createdAt) timeline.push({ time: review.createdAt, node: 'copy', title: '提交审核', desc: review.status === 'rejected' ? '审核退回' : '', tone: 'wait' })
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
  return {
    task,
    timeline: timeline.slice(0, 100),
    chips: [
      { key: 'copy', title: task.nodes.find((n) => n.key === 'copy')?.title ?? '稿件', sub: task.nodes.find((n) => n.key === 'copy')?.statusLabel ?? '', current: stageKey === 'copy' },
      { key: 'base_video', title: task.nodes.find((n) => n.key === 'base_video')?.title ?? '基础视频', sub: task.nodes.find((n) => n.key === 'base_video')?.statusLabel ?? '', current: stageKey === 'base_video' },
      { key: 'publish', title: '发布单', sub: task.nodes.find((n) => n.key === 'publish')?.statusLabel ?? '', current: stageKey === 'publish' },
    ],
  }
}
