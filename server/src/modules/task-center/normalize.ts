/**
 * 任务树归一纯函数（任务书 §3.2 状态归一表 / §3.3 任务级归一）。
 * 只做数据变换，不碰数据库——单测覆盖全分支（AC-R1 的规范来源）。
 * 基础视频节点动作透传 video 模块 nextActionsOf（TC4：规则只写一份）；发布节点动作透传 publish 模块 nextActionOf + 任务中心补充 manual_confirm。
 */
import { nextActionsOf } from '../video/actions.js'
import { nextActionOf } from '../publish/plans.js'
import { VIDEO_PHASE_LABELS, actionLabelOf, type NodeKey, type NodeTone, type TaskNode, type TaskStatus } from './types.js'

export interface TopicLite {
  id: string
  title: string
  status: string
}

export interface CopyLite {
  id: string
  title: string | null
  topicId: string | null
  status: string
  approvedVersionId: string | null
  currentDraftId: string | null
  reviewGate: string | null
  line: string | null
  createdBy: string | null
  personaName: string | null
  ownerSubject: string | null
  updatedAt: string | null
}

export interface ReviewLite {
  status: string
  rejectedGate: string | null
}

export interface VideoJobLite {
  versionNo: number
  phase: string
  progressFloor: number
  statusMessage: string | null
  errorCode: string | null
  timelineSource: string | null
  remoteTaskId: string | null
  remoteResultUrl: string | null
  updatedAt: string | null
}

export interface PublishPlanLite {
  id: string
  status: string
  reviewState: string
  updatedAt: string | null
}

const GATE_LABELS: Record<string, string> = {
  submitted: '审核中',
  gate1: '审核中 · 第 1 关',
  gate2: '审核中 · 第 2 关',
  gate3: '审核中 · 第 3 关',
  pending_manual: '审核中 · 人工复核',
}

function node(pick: Omit<TaskNode, 'actions' | 'action' | 'actionLabel'> & { actions?: string[] }): TaskNode {
  const actions = pick.actions ?? []
  const action = actions[0] ?? null
  return { ...pick, actions, action, actionLabel: actionLabelOf(action) }
}

/** 选题节点：copy.topic_id 非空才展示（TC1），返回 null 表示整节点省略 */
export function normalizeTopicNode(topic: TopicLite | null): TaskNode | null {
  if (!topic) return null
  if (topic.status === 'candidate') {
    return node({ key: 'topic', title: '选题', statusKey: 'pending', statusLabel: '待分配人物', tone: 'todo', progress: null, happenedAt: null })
  }
  return node({
    key: 'topic', title: '选题',
    statusKey: 'done', statusLabel: topic.status === 'assigned' ? '已分配' : '已进入创作',
    tone: 'done', progress: null, happenedAt: null,
  })
}

export function normalizeCopyNode(
  copy: CopyLite,
  review: ReviewLite | null,
  versionNos: { latest: number | null; approved: number | null },
  hasVideoJob: boolean,
): TaskNode {
  const base = { key: 'copy' as const, progress: null, happenedAt: copy.updatedAt }
  const title = versionNos.latest ? `稿件 v${versionNos.latest}` : '稿件'
  const approvedTitle = versionNos.approved ? `稿件 v${versionNos.approved}` : title

  if (copy.status === 'rejected') {
    return node({ ...base, title, statusKey: 'rejected', statusLabel: '已退回', tone: 'error', actions: ['revise_resubmit'] })
  }
  if (copy.status === 'in_review') {
    const gate = review?.status ?? copy.reviewGate
    return node({ ...base, title, statusKey: 'in_review', statusLabel: GATE_LABELS[gate ?? ''] ?? '审核中', tone: 'wait', actions: ['view_review'] })
  }
  if (copy.status === 'approved') {
    return node({
      ...base, title: approvedTitle, statusKey: 'approved', statusLabel: `已通过 v${versionNos.approved ?? '-'}`,
      tone: 'done', actions: hasVideoJob ? [] : ['create_video'],
    })
  }
  // draft 派生（文案工坊 §3.1 口径：revising > writing > pending_write）
  if (copy.approvedVersionId) {
    return node({ ...base, title, statusKey: 'revising', statusLabel: '修订中', tone: 'doing', actions: ['continue_write'] })
  }
  if (copy.currentDraftId) {
    return node({ ...base, title, statusKey: 'writing', statusLabel: '编辑中', tone: 'doing', actions: ['continue_write'] })
  }
  return node({ ...base, title: '稿件', statusKey: 'pending_write', statusLabel: '待写稿', tone: 'todo', actions: ['write_copy'] })
}

export function normalizeVideoNode(job: VideoJobLite | null, copyApproved: boolean): TaskNode {
  const base = { key: 'base_video' as const, progress: null as number | null, happenedAt: job?.updatedAt ?? null }
  if (!job) {
    return copyApproved
      ? node({ ...base, title: '基础视频', statusKey: 'pending', statusLabel: '未开始', tone: 'todo', actions: ['create_video'] })
      : node({ ...base, title: '基础视频', statusKey: 'pending', statusLabel: '未开始', tone: 'todo', actions: [] })
  }
  const title = `基础视频 v${job.versionNo}`
  const actions = nextActionsOf(job)

  if (job.phase === 'completed') {
    return node({ ...base, title, statusKey: 'completed', statusLabel: `已生成 v${job.versionNo}`, tone: 'done', actions })
  }
  if (job.phase === 'failed') {
    return node({ ...base, title, statusKey: 'failed', statusLabel: job.errorCode ? `生成失败（${job.errorCode}）` : '生成失败', tone: 'error', actions })
  }
  if (job.phase === 'save_failed') {
    return node({ ...base, title, statusKey: 'save_failed', statusLabel: '保存失败', tone: 'error', actions })
  }
  if (job.phase === 'submission_unknown') {
    return node({ ...base, title, statusKey: 'submission_unknown', statusLabel: '提交结果待确认', tone: 'error', actions })
  }
  if (job.phase === 'paused') {
    return node({ ...base, title, statusKey: 'paused', statusLabel: '已暂停', tone: 'wait', actions })
  }
  if (job.phase === 'cancelled') {
    return node({ ...base, title, statusKey: 'cancelled', statusLabel: '已取消', tone: 'todo', actions })
  }
  // 进行中主链 + 混剪专属阶段：label 取写入的 status_message，兜底阶段中文
  const fallback = { ...base, title, statusKey: 'doing', tone: 'doing' as NodeTone, actions, progress: job.progressFloor }
  if (job.statusMessage) return node({ ...fallback, statusLabel: job.statusMessage })
  return node({ ...fallback, statusLabel: VIDEO_PHASE_LABELS[job.phase] ?? job.phase })
}

export function normalizePublishNode(
  plan: PublishPlanLite | null,
  logStatuses: string[],
  videoCompleted: boolean,
): TaskNode {
  const base = { key: 'publish' as const, title: '发布', progress: null as number | null, happenedAt: plan?.updatedAt ?? null }
  if (!plan) {
    return videoCompleted
      ? node({ ...base, statusKey: 'pending', statusLabel: '待安排发布', tone: 'todo', actions: ['create_plan'] })
      : node({ ...base, statusKey: 'pending', statusLabel: '待安排发布', tone: 'todo', actions: [] })
  }
  // 优先级：复审确认 > 分平台人工处理 > plan 状态（验证中/人工待处理的记录需优先暴露）
  if (plan.reviewState === 'needs_review') {
    return node({ ...base, statusKey: 'needs_review', statusLabel: '待复审确认', tone: 'wait', actions: ['wait_review'] })
  }
  if (logStatuses.includes('verification_required') || logStatuses.includes('manual_pending')) {
    return node({ ...base, statusKey: 'manual', statusLabel: '平台人工处理', tone: 'error', actions: ['manual_confirm'] })
  }
  const action = nextActionOf({ reviewState: plan.reviewState, status: plan.status } as Parameters<typeof nextActionOf>[0])
  const act = (label: string, statusKey: string, tone: NodeTone): TaskNode =>
    node({ ...base, statusKey, statusLabel: label, tone, actions: action ? [action] : [] })

  switch (plan.status) {
    case 'draft':
      return node({ ...base, statusKey: 'draft', statusLabel: '待安排', tone: 'todo', actions: ['create_plan'] })
    case 'scheduled':
      return act('已排期', 'scheduled', 'wait')
    case 'executing':
    case 'cancelling':
      return act('发布中', 'executing', 'doing')
    case 'partial':
      return act('部分失败', 'partial', 'error')
    case 'failed':
      return act('发布失败', 'failed', 'error')
    case 'completed':
      return node({ ...base, statusKey: 'published', statusLabel: '已发布', tone: 'done' })
    case 'cancelled':
      return node({ ...base, statusKey: 'cancelled', statusLabel: '已取消', tone: 'todo' })
    default:
      return node({ ...base, statusKey: plan.status, statusLabel: plan.status, tone: 'todo' })
  }
}

/** 剪辑节点占位（TC9：模块未立项，剪辑模块上线后替换） */
export function editPlaceholderNode(): TaskNode {
  return node({ key: 'edit', title: '剪辑', statusKey: 'pending', statusLabel: '剪辑模块未上线 · 可直接发布基础视频', tone: 'todo', progress: null, happenedAt: null })
}

/** 需处理判定（TC5 口径：需人工介入才能继续；审核中不算，needs_review 算） */
export function needAttentionOf(nodes: TaskNode[]): boolean {
  return nodes.some((n) => {
    if (n.key === 'copy') return n.statusKey === 'rejected'
    if (n.key === 'base_video') return ['failed', 'save_failed', 'submission_unknown'].includes(n.statusKey)
    if (n.key === 'publish') return ['needs_review', 'manual', 'partial', 'failed'].includes(n.statusKey)
    return false
  })
}

/** 任务级状态（§3.3，优先级：需处理 > 已取消 > 已完成 > 进行中） */
export function taskStatusOf(nodes: TaskNode[]): TaskStatus {
  if (needAttentionOf(nodes)) return 'attention'
  const cancelled = nodes.some((n) => (n.key === 'base_video' || n.key === 'publish') && n.statusKey === 'cancelled')
  if (cancelled) return 'cancelled'
  const byKey = (k: NodeKey) => nodes.find((n) => n.key === k)
  if (byKey('copy')?.statusKey === 'approved' && byKey('base_video')?.statusKey === 'completed' && byKey('publish')?.statusKey === 'published') {
    return 'completed'
  }
  return 'in_progress'
}

/** 当前活动节点（§3.3：链路顺序第一个非 done；剪辑占位不计；全 done 取发布节点为终点） */
export function stageOf(nodes: TaskNode[]): TaskNode {
  const order: NodeKey[] = ['topic', 'copy', 'base_video', 'publish']
  for (const k of order) {
    const n = nodes.find((x) => x.key === k)
    if (n && n.tone !== 'done') return n
  }
  return nodes.find((n) => n.key === 'publish') ?? nodes[nodes.length - 1]
}

/** 任务级状态中文（FR-T3 status 筛选取值） */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  in_progress: '进行中',
  completed: '已完成',
  attention: '需处理',
  cancelled: '已取消',
}
