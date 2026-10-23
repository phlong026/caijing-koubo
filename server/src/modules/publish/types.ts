import type { PersonaLine, Platform } from '../personas/types.js'

/**
 * 发布管理模块类型（任务书 §2 / §3）。
 * Platform / PersonaLine 复用人物库定义（A8：账号独立于人物，但平台与线枚举同源）。
 */

export type { PersonaLine, Platform }

export const PUBLISH_PLATFORMS: Platform[] = ['douyin', 'xiaohongshu', 'kuaishou', 'shipinhao']

/* ── 账号（platform_account）── */

export type AccountLoginStatus = 'pending_login' | 'active' | 'expired' | 'failed' | 'disabled'

export interface PlatformAccount {
  id: string
  platform: Platform
  line: PersonaLine
  displayName: string
  uid: string | null
  avatarUrl: string | null
  loginStatus: AccountLoginStatus
  lastCheckedAt: string | null
  loginExpiresAt: string | null
  ownerId: string | null
  dataDir: string | null
  enabled: boolean
  remark: string | null
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
  /** 绑定的人物数（列表展示用，读时统计） */
  bindingCount?: number
}

/* ── 登录会话（publish_login_session）── */

export type LoginSessionStatus = 'waiting_scan' | 'scanned' | 'confirmed' | 'failed' | 'expired'

export interface PublishLoginSession {
  id: string
  accountId: string
  status: LoginSessionStatus
  qrObjectKey: string | null
  nextPollAt: string | null
  pollAttempts: number
  expiresAt: string | null
  error: string | null
  createdAt: string | null
  updatedAt: string | null
}

/* ── 发布计划（publish_plan）── */

export type PlanStatus = 'draft' | 'scheduled' | 'executing' | 'cancelling' | 'completed' | 'partial' | 'failed' | 'cancelled'
export type ReviewState = 'none' | 'needs_review' | 'confirmed'
export type CoverSource = 'first_frame' | 'custom'

export interface PublishPlan {
  id: string
  copyId: string
  copyVersionId: string | null
  videoJobId: string | null
  baseVideoVersionNo: number
  title: string
  description: string | null
  tags: string[]
  coverObjectKey: string | null
  coverSource: CoverSource
  titleHash: string | null
  reviewState: ReviewState
  reviewBy: string | null
  reviewAt: string | null
  status: PlanStatus
  scheduledAt: string | null
  completedAt: string | null
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
}

/* ── 分平台记录（publish_log）── */

/** 无 queued / retrying 态：拆分即建 scheduled；失败重试 = failed + retry_at → sweep → scheduled（任务书 §3.3） */
export type PublishLogStatus =
  | 'scheduled'
  | 'uploading'
  | 'confirming'
  | 'published'
  | 'failed'
  | 'failed_final'
  | 'verification_required'
  | 'manual_pending'
  | 'cancelled'

export interface PublishLog {
  id: string
  planId: string | null
  platform: Platform
  accountId: string
  source: 'auto' | 'manual'
  status: PublishLogStatus
  attempt: number
  title: string | null
  description: string | null
  tags: string[]
  coverObjectKey: string | null
  scheduledAt: string | null
  retryAt: string | null
  startedAt: string | null
  finishedAt: string | null
  windowExpiresAt: string | null
  videoUrl: string | null
  externalVideoId: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** 列表/详情视图：带账号与计划摘要，避免前端逐条回查 */
export interface PublishLogView extends PublishLog {
  accountName: string | null
  planTitle: string | null
}
