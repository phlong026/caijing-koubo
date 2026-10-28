import { apiGet, apiPost, apiUpload, apiUrl, readToken, type PageResult, type QueryValue } from './client'
import type { PersonaLine, Platform } from './publish'

/**
 * 数据看板接口层（任务书 v1.0 §6：10 个端点 + 模板下载 + 元信息）。
 * 类型与 server/src/modules/analytics/*.ts 的返回结构一一对应，字段名保持后端原样（不再二次改名），
 * 避免后端调整时前后端各写一套映射。
 */

export type MetricWindow = 't1' | 't7'

export const WINDOW_LABELS: Record<MetricWindow, string> = { t1: 'T+1', t7: 'T+7' }

/** 采集来源：一期只有 CSV（Q1 拍板创作者中心仅占位） */
export interface ProviderStatus {
  name: string
  available: boolean
  hint: string
}

export interface AnalyticsSchedulerStatus {
  intervalMs: number
  windowHours: { t1: number; t7: number }
  now: string
}

export interface AnalyticsMeta {
  windows: Array<{ key: MetricWindow; label: string; count: number; lastCapturedAt: string | null }>
  platforms: Platform[]
  templates: Array<{ platform: string; label: string; headers: string[] }>
  provider: ProviderStatus
  scheduler: AnalyticsSchedulerStatus
}

export interface OverviewCards {
  published: number
  captured: number
  plays: number
  interacts: number
  completionRate: number | null
  hotCount: number
}

export interface ContentPerfRow {
  publishLogId: string
  title: string
  platform: string
  platformLabel: string
  accountName: string | null
  line: string | null
  lineLabel: string | null
  personaName: string | null
  finishedAt: string | null
  playsT1: number | null
  playsT7: number | null
  /** 每内容最新窗口的播放（Q7：T+7 优先） */
  plays: number | null
  interacts: number | null
  completionRate: number | null
  fansGained: number | null
  /** null = 账号样本不足 5 条，未判定（前端显示「样本不足」） */
  isHot: 0 | 1 | null
  accountAvgPlays: number | null
  /** 命中对标账号时给出「提升监控」入口（FR-M9），无匹配为 null */
  benchmark: { accountId: string; nickname: string | null; intervalHours: number } | null
}

export interface OverviewResult {
  range: { days: number; from: string; to: string; dayKeys: string[] }
  cards: OverviewCards
  trend: {
    dayKeys: string[]
    series: Array<{ line: PersonaLine; name: string; values: number[] }>
  }
  lines: Array<{ line: PersonaLine; name: string; count: number; avgPlays: number | null }>
  contents: PageResult<ContentPerfRow>
  capture: Record<MetricWindow, { lastCapturedAt: string | null; pending: number }>
  provider: ProviderStatus
  /** 无任何快照：前端展示引导空态（AC-M13） */
  empty: boolean
}

export interface FeatureValueStat {
  value: string
  count: number
  hotCount: number
  /** 该取值在**爆款样本**中的占比（0~1） */
  ratio: number
  /** 该取值的爆款率（0~1），用于判断相关性强度 */
  hotRate: number
}

export type FeatureDimKey = 'hook' | 'duration' | 'cover' | 'publishTime' | 'direction'

export interface FeatureDimStat {
  key: FeatureDimKey
  label: string
  note: string
  validSamples: number
  top: FeatureValueStat | null
  items: FeatureValueStat[]
  status: '待确认' | '样本不足' | '已沉淀'
}

export interface PreferenceProfile {
  id: string
  windowBasis: MetricWindow
  profile: unknown
  sampleCount: number
  /** 注入文案全文（确认弹窗与「当前生效」区展示） */
  basisText: string
  status: 'active' | 'archived'
  confirmedBy: string | null
  createdAt: string | null
}

export interface FeatureStats {
  window: MetricWindow
  days: number
  sampleCount: number
  hotCount: number
  minHotSamples: number
  dims: FeatureDimStat[]
  basisText: string
  profile: PreferenceProfile | null
  empty: boolean
}

export interface Suggestion {
  id: string
  kind: string
  basis: Record<string, unknown>
  payload: Record<string, unknown>
  status: 'pending' | 'confirmed' | 'dismissed'
  topicId: string | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string | null
}

export interface UnmatchedRow {
  lineNo: number
  reason: string
  title?: string | null
  externalVideoId?: string | null
}

export interface ImportResult {
  platform: string
  window: MetricWindow
  total: number
  imported: number
  created: number
  updated: number
  unmatchedCount: number
  rejectedCount: number
  unmatched: UnmatchedRow[]
  /** 标准字段 → 命中的原始表头，导入结果里回显供核对 */
  mapping: Record<string, string | undefined>
  capturedAt: string
  accounts: number
  suggestions: number
}

/** 单个窗口的采集结果；Provider 未启用时到期记录进 pending（不写空快照） */
export interface CollectWindowOutcome {
  window: MetricWindow
  due: number
  collected: number
  pending: Array<{ publishLogId: string; window: MetricWindow; reason: string }>
  provider: string
  message: string
}

export interface CollectOutcome {
  windows: CollectWindowOutcome[]
  provider: ProviderStatus
}

/* ── 读取 ── */

export function getAnalyticsMeta() {
  return apiGet<AnalyticsMeta>('/analytics/meta')
}

export function getOverview(
  query: { days?: number; line?: string; platform?: string; page?: number; pageSize?: number } = {},
) {
  return apiGet<OverviewResult>('/analytics/overview', query as Record<string, QueryValue>)
}

export function getFeatures(query: { window?: MetricWindow; days?: number } = {}) {
  return apiGet<FeatureStats>('/analytics/features', query as Record<string, QueryValue>)
}

export function getPreferenceProfile() {
  return apiGet<{ profile: PreferenceProfile | null; injection: string | null }>('/analytics/preference-profile')
}

export function getSuggestions(query: { status?: string; page?: number; pageSize?: number } = {}) {
  return apiGet<PageResult<Suggestion>>('/analytics/suggestions', query as Record<string, QueryValue>)
}

/* ── 写入（角色见 server/modules/auth/guard.ts ROLE_RULES） ── */

export function importMetricsCsv(input: { platform: Platform; window: MetricWindow; file: File }) {
  const form = new FormData()
  form.append('platform', input.platform)
  form.append('window', input.window)
  form.append('file', input.file)
  return apiUpload<ImportResult>('/analytics/metrics/import', form)
}

export function collectMetrics(body: { window?: MetricWindow } = {}) {
  return apiPost<CollectOutcome>('/analytics/metrics/collect', body)
}

export function confirmFeatures(body: { window: MetricWindow; days?: number }) {
  return apiPost<{ profile: PreferenceProfile; basisText: string; sampleCount: number }>(
    '/analytics/features/confirm',
    body,
  )
}

export function refreshSuggestions(body: { window?: MetricWindow; days?: number } = {}) {
  return apiPost<{ created: number }>('/analytics/suggestions/refresh', body)
}

export function confirmSuggestion(id: string) {
  return apiPost<{ suggestion: Suggestion; topicId: string }>(`/analytics/suggestions/${id}/confirm`)
}

export function dismissSuggestion(id: string, reason?: string) {
  return apiPost<Suggestion>(`/analytics/suggestions/${id}/dismiss`, { reason })
}

export function raiseBenchmarkPriority(benchmarkAccountId: string) {
  return apiPost<{
    accountId: string
    nickname: string | null
    from: number
    to: number
    /** 已到 2 小时下限，不再降档 */
    capped: boolean
    nextCheckAt: string
  }>('/analytics/benchmark-priority', { benchmarkAccountId })
}

/**
 * CSV 模板下载。
 * 该端点直接返回 text/csv（不是 JSON 信封），所以走原生 fetch + Bearer 令牌，
 * 不能复用 request()（它按 {ok,data} 解包）。
 */
export async function downloadCsvTemplate(platform: Platform): Promise<Blob> {
  const token = readToken()
  const res = await fetch(apiUrl(`/analytics/csv-template?platform=${platform}`), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!res.ok) throw new Error(`模板下载失败（${res.status}）`)
  return res.blob()
}
