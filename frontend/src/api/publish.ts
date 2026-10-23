import { apiGet, apiPost, apiPatch, apiDel, type PageResult, type QueryValue } from './client'

/* ── 类型（与 server/src/modules/publish/types.ts 对应）── */

export type Platform = 'douyin' | 'xiaohongshu' | 'kuaishou' | 'shipinhao'
export type PersonaLine = 'manager' | 'kos' | 'persona'
export type AccountLoginStatus = 'pending_login' | 'active' | 'expired' | 'failed' | 'disabled'
export type PlanStatus =
  'draft' | 'scheduled' | 'executing' | 'cancelling' | 'completed' | 'partial' | 'failed' | 'cancelled'
export type ReviewState = 'none' | 'needs_review' | 'confirmed'
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

export const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  kuaishou: '快手',
  shipinhao: '视频号',
}
export const LINE_LABELS: Record<PersonaLine, string> = { manager: '经理 IP', kos: '员工 KOS', persona: '素人矩阵' }

export const ACCOUNT_STATUS_LABELS: Record<AccountLoginStatus, string> = {
  pending_login: '待登录',
  active: '在线',
  expired: '登录失效',
  failed: '登录失败',
  disabled: '已停用',
}

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: '待安排',
  scheduled: '已排期',
  executing: '执行中',
  cancelling: '取消中',
  completed: '已完成',
  partial: '部分成功',
  failed: '全部失败',
  cancelled: '已取消',
}

export const LOG_STATUS_LABELS: Record<PublishLogStatus, string> = {
  scheduled: '待发布',
  uploading: '上传中',
  confirming: '发布确认中',
  published: '已发布',
  failed: '失败（可重试）',
  failed_final: '失败',
  verification_required: '验证中',
  manual_pending: '人工待处理',
  cancelled: '已取消',
}

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
  bindingCount?: number
  publishedToday?: number
}

export interface LoginSession {
  id: string
  accountId: string
  status: 'waiting_scan' | 'scanned' | 'confirmed' | 'failed' | 'expired'
  qrObjectKey: string | null
  pollAttempts: number
  expiresAt: string | null
  error: string | null
  createdAt: string | null
}

export interface PublishPlan {
  id: string
  copyId: string
  copyVersionId: string | null
  videoJobId: string | null
  baseVideoVersionNo: number
  title: string
  description: string | null
  tags: string[]
  coverSource: 'first_frame' | 'custom'
  reviewState: ReviewState
  reviewBy: string | null
  reviewAt: string | null
  status: PlanStatus
  scheduledAt: string | null
  completedAt: string | null
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
  logs?: PublishLogView[]
  nextAction?: string | null
}

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
}

export interface PublishLogView extends PublishLog {
  accountName: string | null
  planTitle: string | null
}

export interface MatrixCell {
  allowed: boolean
  activeAccounts: number
  dailyLimit: number
}

export interface PublishOptions {
  engine: { mock: boolean; headless: boolean; maxContexts: number }
  limits: { dailyLimitPerAccount: number; confirmTimeoutMs: number; manualWindowMs: number; maxContexts: number }
}

/* ── API ── */

export function getPublishOptions() {
  return apiGet<PublishOptions>('/publish/options')
}

export function getPlatformMatrix() {
  return apiGet<{ matrix: Record<PersonaLine, Record<Platform, MatrixCell>> }>('/publish/platform-matrix')
}

export function listAccounts(query?: Record<string, QueryValue>) {
  return apiGet<PageResult<PlatformAccount>>('/platform-accounts', query)
}

export function createAccount(body: { platform: Platform; line: PersonaLine; displayName: string; remark?: string }) {
  return apiPost<{
    account: PlatformAccount
    login: { session: LoginSession; qrUrl: string | null; qrDataUrl: string | null } | null
  }>('/platform-accounts', body)
}

export function patchAccount(id: string, body: { enabled?: boolean; remark?: string }) {
  return apiPatch<PlatformAccount>(`/platform-accounts/${id}`, body)
}

export function deleteAccount(id: string) {
  return apiDel<{ deleted: boolean }>(`/platform-accounts/${id}`)
}

export function startLoginSession(id: string) {
  return apiPost<{ session: LoginSession; qrUrl: string | null; qrDataUrl: string | null }>(
    `/platform-accounts/${id}/login-sessions`,
  )
}

export function latestLoginSession(id: string) {
  return apiGet<{ session: LoginSession | null; qrUrl: string | null; qrDataUrl: string | null }>(
    `/platform-accounts/${id}/login-sessions/latest`,
  )
}

export function checkAccountLogin(id: string) {
  return apiPost<{ loggedIn: boolean; nickname: string | null }>(`/platform-accounts/${id}/check-login`)
}

export function createPlan(body: {
  copyId: string
  videoJobId: string
  items: Array<{ platform: Platform; accountId: string; title?: string; description?: string; tags?: string[] }>
  scheduledAt?: string | null
}) {
  return apiPost<{ plan: PublishPlan; logs: PublishLog[] }>('/publish-plans', body)
}

export function listPlans(query?: Record<string, QueryValue>) {
  return apiGet<PageResult<PublishPlan & { logs: PublishLogView[] }>>('/publish-plans', query)
}

export function getPlan(id: string) {
  return apiGet<PublishPlan & { logs: PublishLogView[] }>(`/publish-plans/${id}`)
}

export function schedulePlan(id: string, scheduledAt: string) {
  return apiPost<PublishPlan>(`/publish-plans/${id}/schedule`, { scheduledAt })
}

export function executePlanNow(id: string) {
  return apiPost<PublishPlan>(`/publish-plans/${id}/execute-now`)
}

export function confirmPlanReview(id: string) {
  return apiPost<PublishPlan>(`/publish-plans/${id}/review-confirm`)
}

export function cancelPlan(id: string) {
  return apiPost<PublishPlan>(`/publish-plans/${id}/cancel`)
}

export function listLogs(query?: Record<string, QueryValue>) {
  return apiGet<PageResult<PublishLogView>>('/publish-logs', query)
}

export function retryLog(id: string) {
  return apiPost<{ retried: boolean }>(`/publish-logs/${id}/retry`)
}

export function recheckLog(id: string) {
  return apiPost<{ status: string }>(`/publish-logs/${id}/recheck`)
}

export function markManualResult(id: string, body: { published: boolean; videoUrl?: string; reason?: string }) {
  return apiPost<PublishLog>(`/publish-logs/${id}/manual-result`, body)
}

export function createManualLog(body: {
  platform: Platform
  accountId: string
  title: string
  videoUrl?: string
  externalVideoId?: string
}) {
  return apiPost<PublishLog>('/publish-logs', body)
}
