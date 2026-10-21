import { apiDel, apiGet, apiPatch, apiPost, type PageResult } from './client'

export type MonitorStatus = 'on' | 'paused'
export type VideoOrigin = 'monitor' | 'adhoc'
export type ExtractStatus = 'none' | 'pending' | 'submitting' | 'running' | 'done' | 'failed' | 'uncertain'
export type AlertType = 'new_publish' | 'hot'

export interface Account {
  addedBy?: string | null
  id: string
  platform: string
  platformUid: string
  secUid: string
  nickname: string
  fansCount: number
  sourceUrl: string
  monitorStatus: MonitorStatus
  monitorIntervalHours: number
  nextCheckAt: string | null
  lastCheckedAt: string | null
  consecutiveFailures: number
  lastError: string | null
  abnormalAt: string | null
  removedAt: string | null
  createdAt: string
}

export interface AccountPreview {
  secUid: string
  nickname: string
  fansCount: number
  exists: boolean
  existingId?: string
}

export interface DailyQuota {
  accounts: number
  dailyCalls: number
  estimatedCost: number
  currency: 'CNY'
  unitPrice: { postList: number; userInfo: number; videoDetail: number }
}

export interface BenchVideo {
  width?: number
  height?: number
  statsUpdatedAt?: string | null
  id: string
  accountId: string | null
  origin: VideoOrigin
  platform: string
  videoId: string
  title: string | null
  coverUrl: string | null
  duration: number | null
  shareUrl: string | null
  authorNickname: string | null
  authorSecUid?: string | null
  accountNickname: string | null
  isTop: boolean
  playCount: number
  diggCount: number
  commentCount: number
  shareCount: number
  interactTotal: number
  isHot: boolean
  hotBaseline?: unknown
  isBackfill?: boolean
  publishedAt: string | null
  fetchedAt?: string | null
  extractStatus: ExtractStatus
  extractError: string | null
  sentCopyCount: number
}

export interface BenchmarkVideoQuery {
  format?: 'landscape' | 'portrait' | 'square'
  sort?: 'latest' | 'interaction'
  dataSource?: 'real'
  accountId?: string
  onlyHot?: boolean
  extractStatus?: ExtractStatus
  origin?: VideoOrigin
  page?: number
  pageSize?: number
}

export interface ResearchOverview {
  provider: { name: string; mode: 'live' | 'demo' | 'unconfigured' }
  accounts: number
  monitoring: number
  videos: number
  hotVideos: number
  interactions: number
  lastFetchedAt: string | null
  extractionReady: boolean
  methodology: { interactionFields: string[]; multiplier: number; sampleSize: number; minSample: number; refreshDays: number; formula: string }
}

export function getResearchOverview() {
  return apiGet<ResearchOverview>('/benchmark/research')
}

export function getVideoPlayback(id: string) {
  return apiGet<{ playUrl: string; title: string }>(`/benchmark/videos/${encodeURIComponent(id)}/playback`)
}

export type BenchmarkVideoPage = PageResult<BenchVideo> & {
  meta?: { showPlayCount: boolean }
}

export interface VideoScript {
  text: string
  sentences: { text: string; beginTime: number; endTime: number }[]
  duration: number | null
  engine: string | null
  extractMode: string | null
  updatedAt: string | null
}

/** 告警快照：新发布 = 基础字段；爆款 = 基础字段 + 均值/阈值快照 */
export interface AlertPayload {
  title?: string | null
  nickname?: string | null
  coverUrl?: string | null
  videoId?: string
  diggCount?: number
  commentCount?: number
  shareCount?: number
  interactTotal?: number
  publishedAt?: string | null
  baseline?: number
  threshold?: number
  [key: string]: unknown
}

export interface Alert {
  id: string
  type: AlertType
  accountId: string | null
  videoId: string | null
  payload: AlertPayload | null
  isRead: boolean
  createdAt: string | null
}

export interface AlertQuery {
  dataSource?: 'real'
  type?: AlertType
  isRead?: boolean
  page?: number
  pageSize?: number
}

export function previewAccount(url: string) {
  return apiPost<AccountPreview>('/benchmark/accounts/preview', { url })
}

export function createAccount(payload: { url: string; intervalHours: number }) {
  return apiPost<Account & { backfillStarted: boolean }>('/benchmark/accounts', payload)
}

export function getAccounts() {
  return apiGet<Account[]>('/benchmark/accounts')
}

export function getDailyQuota() {
  return apiGet<DailyQuota>('/benchmark/accounts/daily-quota')
}

export function patchAccount(id: string, payload: { intervalHours?: number; monitorStatus?: MonitorStatus }) {
  return apiPatch<Account>(`/benchmark/accounts/${encodeURIComponent(id)}`, payload)
}

export function fetchAccountNow(id: string) {
  return apiPost<{ ok: true }>(`/benchmark/accounts/${encodeURIComponent(id)}/fetch-now`)
}

export function deleteAccount(id: string) {
  return apiDel<{ ok: true }>(`/benchmark/accounts/${encodeURIComponent(id)}`)
}

export function getBenchmarkVideos(query: BenchmarkVideoQuery) {
  return apiGet<BenchmarkVideoPage>('/benchmark/videos', { ...query })
}

/** P1-3①：uncertain 状态必须由界面二次确认（confirm=true）才允许重新入队 */
export function extractVideo(id: string, confirm = false) {
  return apiPost<{ status: string; cacheId: string }>(`/benchmark/videos/${encodeURIComponent(id)}/extract`, { confirm })
}

export function getExtractStatus(id: string) {
  return apiGet<{ status: ExtractStatus; error?: string }>(`/benchmark/videos/${encodeURIComponent(id)}/extract-status`)
}

export function getVideoScript(id: string) {
  return apiGet<VideoScript>(`/benchmark/videos/${encodeURIComponent(id)}/script`)
}

export function sendVideoToCopy(id: string, personaIds: string[]) {
  return apiPost<{ topicId: string; copyIds: string[] }>(`/benchmark/videos/${encodeURIComponent(id)}/send-to-copy`, { personaIds })
}

export function parseBenchmarkLink(shareUrl: string) {
  return apiPost<{ video: BenchVideo; extractStatus: string }>('/benchmark/parse-link', { shareUrl })
}

export function getAlerts(query: AlertQuery) {
  return apiGet<PageResult<Alert>>('/benchmark/alerts', { ...query })
}

export function getUnreadAlertCount() {
  return apiGet<{ count: number }>('/benchmark/alerts/unread-count', { dataSource: 'real' })
}

export function markAlertRead(id: string) {
  return apiPatch<{ ok: true }>(`/benchmark/alerts/${encodeURIComponent(id)}/read`)
}

export function markAllAlertsRead() {
  return apiPost<{ ok: true }>('/benchmark/alerts/read-all')
}
