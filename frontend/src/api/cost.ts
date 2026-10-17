import { apiGet } from './client'

export interface ApiCallSummary {
  total: number
  cost: number
  byProvider: { provider: string; calls: number; cost: number }[]
  byDay: { day: string; calls: number; cost: number }[]
}

export interface ApiCallSummaryQuery {
  provider?: string
  from?: string
  to?: string
}

export function getApiCallSummary(query: ApiCallSummaryQuery = {}) {
  return apiGet<ApiCallSummary>('/api-calls/summary', { ...query })
}
