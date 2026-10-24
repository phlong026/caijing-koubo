/**
 * 任务中心共享类型（任务书 §3.1 节点模型 / §3.3 归一）。
 * 任务中心是只读聚合视图：不建任务主表，不复制状态，节点数据实时读各业务表。
 */

export type NodeKey = 'topic' | 'copy' | 'base_video' | 'edit' | 'publish'
export type NodeTone = 'done' | 'doing' | 'todo' | 'error' | 'wait'
/** 任务级状态（筛选用，§3.3；needAttention 与「需处理」同口径） */
export type TaskStatus = 'in_progress' | 'completed' | 'attention' | 'cancelled'

export interface TaskNode {
  key: NodeKey
  title: string
  statusKey: string
  statusLabel: string
  tone: NodeTone
  /** 下一步动作键（actions 的首项） */
  action: string | null
  /** 全部可用动作（视频节点可能是多个，如 completed + estimated → continue_edit/realign） */
  actions: string[]
  actionLabel: string | null
  /** 仅基础视频节点：进度百分比（PHASE_FLOORS 同源） */
  progress: number | null
  /** 节点最近事件时间（ISO） */
  happenedAt: string | null
  /** 动作跳转定位 id（剪辑节点 = videoJobId，剪辑页按此定位；其余节点用 copyId） */
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
  stage: { key: NodeKey; title: string; statusKey: string; statusLabel: string; tone: NodeTone; progress: number | null }
  nodes: TaskNode[]
}

export interface TimelineItem {
  time: string
  node: NodeKey
  title: string
  desc: string
  tone: NodeTone
}

export interface TaskDetail {
  task: TaskSummary
  /** 时间线（倒序，上限 100 条；§3.6） */
  timeline: TimelineItem[]
  /** 超过 100 条被截断时置 true，前端提示「仅显示最近 100 条」 */
  timelineTruncated: boolean
  chips: { key: NodeKey; title: string; sub: string; current: boolean }[]
}

/** 下一步动作中文文案（前后端共用一处，任务中心是唯一出口） */
export const ACTION_LABELS: Record<string, string> = {
  write_copy: '去写文案',
  continue_write: '继续编辑',
  view_review: '查看审核',
  revise_resubmit: '修改重投',
  create_video: '去视频创作',
  view_progress: '查看进度',
  retry_download: '重试下载',
  query_original: '查询原任务',
  bind_remote: '补录任务号',
  continue_edit: '继续剪辑',
  create_cut: '去剪辑',
  view_cut_progress: '查看剪辑进度',
  retry_cut: '重试渲染',
  view_cut_review: '查看成片复审',
  realign: '重新对齐',
  regenerate: '重新生成',
  create_plan: '安排发布',
  wait_review: '待复审确认',
  view_logs: '查看记录',
  retry: '重试发布',
  manual_confirm: '去处理',
}

/** 视频阶段中文（时间线与 label 兜底用；与 video 模块写入的 status_message 互补） */
export const VIDEO_PHASE_LABELS: Record<string, string> = {
  waiting: '排队中',
  preparing: '准备中',
  tts: '配音合成中',
  submitting: '提交生成服务',
  generating: '口播画面生成中',
  recovering: '恢复查询中',
  downloading: '成片下载中',
  verifying: '成片校验中',
  aligning: '时间轴对齐中',
  composing: '素材合成中',
  completed: '生成完成',
  failed: '生成失败',
  save_failed: '保存失败',
  submission_unknown: '提交结果待确认',
  paused: '已暂停',
  cancelled: '已取消',
}

export function actionLabelOf(action: string | null): string | null {
  return action ? ACTION_LABELS[action] ?? action : null
}
