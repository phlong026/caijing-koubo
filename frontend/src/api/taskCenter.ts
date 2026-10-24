import { apiGet, type PageResult, type QueryValue } from './client'

/* ── 类型（与 server/src/modules/task-center/types.ts 对应）── */

export type NodeKey = 'topic' | 'copy' | 'base_video' | 'edit' | 'publish'
export type NodeTone = 'done' | 'doing' | 'todo' | 'error' | 'wait'
export type TaskStatus = 'in_progress' | 'completed' | 'attention' | 'cancelled'

export interface TaskNode {
  key: NodeKey
  title: string
  statusKey: string
  statusLabel: string
  tone: NodeTone
  action: string | null
  actions: string[]
  actionLabel: string | null
  progress: number | null
  happenedAt: string | null
  /** 动作跳转定位 id（剪辑节点 = videoJobId；其余节点用 copyId） */
  refId?: string | null
}

export interface TaskSummary {
  copyId: string
  taskNo: string
  title: string
  line: string | null
  subject: string | null
  personaName: string | null
  createdBy: string | null
  status: TaskStatus
  needAttention: boolean
  updatedAt: string | null
  stage: {
    key: NodeKey
    title: string
    statusKey: string
    statusLabel: string
    tone: NodeTone
    progress: number | null
  }
  nodes: TaskNode[]
}

export interface TaskTimelineItem {
  time: string
  node: NodeKey
  title: string
  desc: string
  tone: NodeTone
}

export interface TaskDetail {
  task: TaskSummary
  /** 时间线（倒序，上限 100 条） */
  timeline: TaskTimelineItem[]
  /** 超过 100 条被截断 */
  timelineTruncated: boolean
  chips: { key: NodeKey; title: string; sub: string; current: boolean }[]
}

export interface TaskListResult extends PageResult<TaskSummary> {
  counts: { all: number; mine: number; todo: number }
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  in_progress: '进行中',
  completed: '已完成',
  attention: '需处理',
  cancelled: '已取消',
}

export const LINE_LABELS: Record<string, string> = { manager: '经理 IP', kos: '员工 KOS', persona: '素人矩阵' }

export const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'topic', label: '选题' },
  { value: 'copy', label: '稿件' },
  { value: 'base_video', label: '基础视频' },
  { value: 'edit', label: '剪辑' },
  { value: 'publish', label: '发布' },
]

export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'in_progress', label: '进行中' },
  { value: 'attention', label: '需处理' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
]

export function listTasks(query?: Record<string, QueryValue>) {
  return apiGet<TaskListResult>('/task-center/tasks', query)
}

export function getTaskDetail(copyId: string) {
  return apiGet<TaskDetail>(`/task-center/tasks/${copyId}`)
}
