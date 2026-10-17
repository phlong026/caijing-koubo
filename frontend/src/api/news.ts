import { apiGet, apiPost, type PageResult } from './client'

export type NewsCategory = '市场' | '政策' | '行业' | '基金' | '其他' | string

export interface NewsItem {
  id: string
  externalId: string
  source: string
  category: NewsCategory
  title: string
  summary: string | null
  contentUrl: string | null
  imageUrl: string | null
  publishedAt: string | null
  fetchedAt: string | null
}

export interface NewsQuery {
  category?: string
  keyword?: string
  source?: string
  page?: number
  pageSize?: number
}

export interface NewsCategories {
  all: number
  items: { key: string; count: number }[]
  sources: string[]
}

/** 手动刷新：done=同步完成；running=超时转后台；busy=已有任务在执行 */
export interface NewsRefreshResult {
  status: 'done' | 'running' | 'busy'
  fetched: number
  inserted: number
  bySource: { source: string; ok: boolean; count: number; error?: string }[]
  nextRunAt: string | null
  message?: string
}

export interface NewsRule {
  id: string
  category: string
  keyword: string
  priority: number
  enabled: boolean
}

export function getNews(query: NewsQuery) {
  return apiGet<PageResult<NewsItem>>('/news', { ...query })
}

export function getNewsCategories() {
  return apiGet<NewsCategories>('/news/categories')
}

export function refreshNews() {
  return apiPost<NewsRefreshResult>('/news/refresh')
}

export function getNewsRules() {
  return apiGet<NewsRule[]>('/news/rules')
}
