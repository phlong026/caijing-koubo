import { apiDel, apiGet, apiPatch, apiPost, apiPut, type PageResult } from './client'

/** 数据反哺（看板建议确认后生成，走 news 同款状态机：candidate → assigned → sent） */
export type TopicSource = 'news' | 'benchmark' | 'manual' | 'article' | 'feedback' | 'data_backfeed'
export type TopicStatus = 'candidate' | 'assigned' | 'sent' | 'archived'
export type BatchStatus = 'running' | 'done' | 'failed'

/** 来源展示文案（列表 tag 用；benchmark/manual 等沿用各自业务入口的既有叫法） */
export const TOPIC_SOURCE_LABELS: Record<TopicSource, string> = {
  news: '资讯',
  benchmark: '对标',
  manual: '手动',
  article: '文章',
  feedback: '反馈',
  data_backfeed: '数据反哺',
}

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
  /** 生成时用的选题方法 */
  methodId: string | null
  methodName: string | null
  /** 按哪个人物的人设生成 */
  originPersonaId: string | null
  /** 生成时启发式打分 0~100（辅助挑选；旧数据为 0/空不展示） */
  score: number | null
  /** 打分依据明细 */
  scoreReasons: string[] | null
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
  /** 对应的文案工坊内容模板 */
  copyTemplateId: string | null
  createdBy: string | null
  updatedAt: string | null
}

/** 选题方法取值：按每个人物配置的选题方法自动分配 */
export const AUTO_METHOD = 'auto'

/** 人物开启的选题方法（configured=false：人物未勾选，items 为默认可用范围） */
export interface PersonaMethods {
  configured: boolean
  items: Array<{ methodId: string; ratio: number | null }>
  /** 旧配比里对应不上选题方法的标签 */
  unmatched: string[]
}

export interface TopicQuery {
  /** 单个状态，或逗号分隔多个（如 `candidate,assigned`） */
  status?: TopicStatus | string
  source?: TopicSource
  batchId?: string
  /** sort=score：按生成评分降序（辅助人工挑选） */
  sort?: 'score'
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

export interface TopicTemplatePayload {
  name: string
  content: string
  isDefault?: boolean
  copyTemplateId?: string
}

export function getPersonaMethods(personaIds: string[]) {
  return apiGet<Record<string, PersonaMethods>>('/topics/persona-methods', { personaIds: personaIds.join(',') })
}

export function createTopicTemplate(payload: TopicTemplatePayload) {
  return apiPost<TopicTemplate>('/topic-templates', payload)
}

export function updateTopicTemplate(id: string, payload: Partial<TopicTemplatePayload>) {
  return apiPut<TopicTemplate>(`/topic-templates/${encodeURIComponent(id)}`, payload)
}

export function deleteTopicTemplate(id: string) {
  return apiDel<{ ok: true }>(`/topic-templates/${encodeURIComponent(id)}`)
}
