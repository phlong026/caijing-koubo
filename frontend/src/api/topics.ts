import { apiDel, apiGet, apiPatch, apiPost, apiPut, type PageResult } from './client'

export type TopicSource = 'news' | 'benchmark' | 'manual' | 'article' | 'feedback'
export type TopicStatus = 'candidate' | 'assigned' | 'sent' | 'archived'
export type BatchStatus = 'running' | 'done' | 'failed'

export interface Topic {
  id: string
  source: TopicSource
  sourceId: string | null
  title: string
  direction: string | null
  hook: string | null
  rationale: string | null
  personaIds: string[]
  status: TopicStatus
  batchId: string | null
  newsTitle: string | null
  sentAt: string | null
  createdBy: string | null
  createdAt: string | null
}

export interface TopicBatch {
  id: string
  status: BatchStatus
  newsIds: string[]
  personaIds: string[]
  countPer: number
  templateId?: string
  expected: number
  produced: number
  llmCost: number
  createdAt: string
  error?: string
}

export interface TopicTemplate {
  id: string
  name: string
  content: string
  isDefault: boolean
  builtin: string | null
  createdBy: string | null
  updatedAt: string | null
}

export interface TopicQuery {
  /** 单个状态，或逗号分隔多个（如 `candidate,assigned`） */
  status?: TopicStatus | string
  source?: TopicSource
  batchId?: string
  page?: number
  pageSize?: number
}

export interface GenerateTopicsPayload {
  newsIds: string[]
  personaIds: string[]
  countPer: number
  templateId?: string
}

export function generateTopics(payload: GenerateTopicsPayload) {
  return apiPost<{ batchId: string }>('/topics/generate', payload)
}

export function getTopicBatch(id: string) {
  return apiGet<TopicBatch>(`/topics/batches/${encodeURIComponent(id)}`)
}

export function getTopics(query: TopicQuery) {
  return apiGet<PageResult<Topic>>('/topics', { ...query })
}

export function patchTopic(id: string, payload: { personaIds?: string[]; status?: 'archived' }) {
  return apiPatch<Topic>(`/topics/${encodeURIComponent(id)}`, payload)
}

export function sendTopics(topicIds: string[]) {
  return apiPost<{ created: number; copyIds: string[] }>('/topics/send', { topicIds })
}

export function getTopicTemplates() {
  return apiGet<TopicTemplate[]>('/topic-templates')
}

export function createTopicTemplate(payload: { name: string; content: string; isDefault?: boolean }) {
  return apiPost<TopicTemplate>('/topic-templates', payload)
}

export function updateTopicTemplate(id: string, payload: { name?: string; content?: string; isDefault?: boolean }) {
  return apiPut<TopicTemplate>(`/topic-templates/${encodeURIComponent(id)}`, payload)
}

export function deleteTopicTemplate(id: string) {
  return apiDel<{ ok: true }>(`/topic-templates/${encodeURIComponent(id)}`)
}
