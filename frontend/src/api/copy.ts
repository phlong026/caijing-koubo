/**
 * 文案工坊 API（任务书 §5.1）。
 *
 * 约定：所有接口都经过 `client.ts` 的统一信封解析，失败时抛 `ApiError`。
 * 类型字段与后端 `modules/copy/repo.ts` 的 mapper 一一对应，改动需同步。
 */
import { apiDel, apiGet, apiPatch, apiPost, apiPut, apiUpload, type PageResult } from './client'

/* ── 枚举与标签 ──────────────────────────────────────────────────── */

export type CopySource = 'news' | 'benchmark' | 'article' | 'manual'
export type CopyLine = 'manager' | 'kos' | 'persona'
export type CopyStatus = 'draft' | 'in_review' | 'approved' | 'rejected' | 'archived'
export type CopyDerivedStatus =
  | 'pending_write'
  | 'writing'
  | 'in_review'
  | 'rejected'
  | 'approved'
  | 'revising'
export type DurationTier = 'short' | 'medium' | 'long' | 'custom'
export type VersionOrigin = 'ai_generate' | 'manual_save' | 'restore' | 'submit'
export type DraftOrigin = 'ai' | 'manual'
export type SubmissionStatus =
  | 'submitted'
  | 'gate1'
  | 'gate2'
  | 'gate3'
  | 'pending_manual'
  | 'approved'
  | 'rejected'
  | 'withdrawn'

/** 结构化纯文本段落（W4） */
export interface Section {
  label: string
  text: string
  /** 文章改写模式下溯源到大纲节点序号，非递减 */
  sourceRefs?: number[]
  /** 前端只读：变体高亮区间（不提交后端） */
  highlight?: { start: number; end: number } | null
}

export interface PersonaBrief {
  id: string
  name: string
  line: string
  lineLabel?: string
}

export interface CopyListItem {
  id: string
  title: string | null
  source: CopySource
  sourceLabel: string
  status: CopyStatus
  derivedStatus: CopyDerivedStatus
  derivedStatusLabel: string
  persona: PersonaBrief | null
  line: CopyLine | null
  lineLabel: string | null
  draftCount: number
  submittedVersionId: string | null
  approvedVersionId: string | null
  reviewGate: string | null
  everSubmitted: boolean
  createdBy: string
  createdAt: string
  updatedAt: string | null
  topicId: string | null
}

export interface CreativeSettings { templateId: string; styleId: string; durationTier: DurationTier; durationSeconds: number | null; count: number; instructions: string }
export interface SourceReview { correctedText: string; note: string; confirmed: boolean; reviewedAt?: string }
export interface SourceMaterial { type: string; title?: string; text: string | null; videoId?: string; coverUrl?: string; author?: string; shareUrl?: string; contentUrl?: string; publishedAt?: string; duration?: number; sentences?: Array<{ text: string; startTime: number; endTime: number }> }

export interface Draft {
  id: string
  copyId: string
  draftNo: number
  name: string
  title: string | null
  sections: Section[]
  wordCount: number
  rev: number
  latestVersionNo: number
  hasSubmitted: boolean
  origin: DraftOrigin
  isFinal?: boolean
  generationId?: string | null
  updatedAt: string
}

export interface CopyVersion {
  id: string
  copyId: string
  draftId: string
  draftName?: string
  versionNo: number
  title: string | null
  wordCount: number
  contentHash: string
  origin: VersionOrigin
  isLocked: boolean
  complianceHits: ComplianceHit[]
  createdBy: string
  createdAt: string
}

export interface ComplianceHit {
  sectionIndex: number
  start: number
  end: number
  word: string
  level: 'hard' | 'soft'
  fromPersona?: boolean
}

export interface SimilarityResult {
  similarity: number
  threshold: number
  blocked: boolean
  longest: string
  fragments: Array<string | {text:string;length:number}>
}

export interface Generation {
  id: string
  copyId: string
  status: 'pending' | 'running' | 'done' | 'partial' | 'failed'
  kind: 'generate' | 'variant'
  mode: CopySource
  succeeded: number
  failed: number
  count: number
  error: string | null
  cost: number
  durationTier: DurationTier
  durationSeconds: number | null
  wordRange: { min: number; max: number; seconds: number } | null
  templateId: string | null
  styleId: string | null
  model: string
  prompt: string | null
  promptHash: string | null
  personaSnapshot?: {
    name: string
    line: string
    ipProfile: Record<string, unknown>
    capturedAt: string
  } | null
  /**
   * 本批次已产出的稿（后端 generation 接口实时返回）。
   * 用于生成过程中「第 N 份已到」的即时反馈 —— 真实模型单份 40–60 秒，
   * 只靠 succeeded 计数（收尾才更新）会让用户以为没在动。
   */
  drafts?: Array<{ id: string; draftNo: number; name: string; title: string | null; wordCount: number }>
  variants?: Variant[]
  createdAt: string
  finishedAt: string | null
}

export interface Variant {
  id: string
  copyId: string
  draftId: string
  generationId: string | null
  sectionIndex: number
  kind: string
  text: string
  appliedAt: string | null
  createdAt: string
}

/** 审核单 gate_results 的单项（§5.3 契约，与后端 review.ts gateResult 一致） */
export interface GateResult {
  gate: string
  result: 'pass' | 'fail'
  reason: string | null
  riskPoints: string[] | null
  confidence: number | null
  at: string | null
}

export interface Submission {
  isStub?: boolean
  id: string
  copyId: string
  copyVersionId: string
  versionNo: number
  status: SubmissionStatus
  statusLabel: string
  gates: GateResult[]
  riskHint: string | null
  rejectReason: string | null
  rejectedGate: string | null
  submittedBy: string
  submittedAt: string
  decidedAt: string | null
}

export interface CopyDetail {
  copy: CopyListItem & {
    currentDraftId: string | null
    settings: Record<string, unknown> | null
    rejectReason: string | null
    reviewSubmissionId: string | null
    reviewGate: string | null
    sourceText: string | null
    keywords: string | null
  }
  drafts: Draft[]
  currentDraft: Draft | null
  review: Submission | null
  persona: (PersonaBrief & { ipProfile: Record<string, unknown> }) | null
  topic: { id: string; title: string; source: string } | null
  sourceSummary: { label: string; text: string } | null
  versions: CopyVersion[]
  generations: Generation[]
  variants: Variant[]
  article: ArticleDetail | null
}

/* ── 选项（下拉/表单） ───────────────────────────────────────────── */

export interface DurationTierOption {
  key: DurationTier
  name: string
  minSeconds: number
  maxSeconds: number
  minWords: number
  maxWords: number
  custom: boolean
  wordsPerSecond: { min: number; max: number } | null
}

export interface TemplateOption {
  id: string
  name: string
  description: string
  structureHint: string
  riskHint: string
  isBuiltin: boolean
  revision: number
  prompt: string
  sort: number
}

export interface StyleOption {
  id: string
  name: string
  description: string
  prompt: string
  line: CopyLine | null
  isBuiltin: boolean
  revision: number
  sort: number
}

export interface CopyOptions {
  durationTiers: DurationTierOption[]
  templates: TemplateOption[]
  styles: StyleOption[]
  limits: {
    charsPerSec: number
    maxDrafts: number
    maxBatchCount: number
    customDurationMin: number
    customDurationMax: number
    maxInstructions: number
    maxTitle: number
    maxManualSource: number
    similarityThreshold: number
  }
  labels: {
    sources: Record<string, string>
    derivedStatuses: Record<string, string>
    lines: Record<string, string>
    gates: Record<string, string>
    origins: Record<string, string>
  }
  personas: Array<PersonaBrief & { enabled: boolean }>
}

/* ── 文章 ────────────────────────────────────────────────────────── */

export interface OutlineNode {
  index: number
  level: number
  title: string
  paragraphs: number
  chars: number
}

export interface ArticleDetail {
  id: string
  filename: string | null
  mime: string | null
  size: number
  plainText: string
  wordCount: number
  charCount?: number
  status: string
  outline: OutlineNode[]
  createdAt: string
}

export interface ArticleCreated {
  articleId: string
  wordCount: number
  outline: OutlineNode[]
}

/* ── 预检 ────────────────────────────────────────────────────────── */

export interface PrecheckCheck {
  key: string
  label: string
  level: 'hard' | 'soft'
  pass: boolean
  message: string
  hint?: string | null
}

export interface PrecheckResult {
  draftId: string
  wordCount: number
  bodyWordCount: number
  estSeconds: number
  tier: DurationTier
  wordRange: { min: number; max: number }
  tierOk: boolean
  complianceHits: ComplianceHit[]
  similarity: SimilarityResult | null
  checks: PrecheckCheck[]
  canSubmit: boolean
  durationRange: { min: number; max: number }
  durationOk: boolean
  warnings: number
  riskHintMode: string
}

/* ── 接口方法 ────────────────────────────────────────────────────── */

export const copyApi = {
  options(personaId?: string) {
    return apiGet<CopyOptions>('/copy/options', { personaId })
  },

  list(query: {
    page?: number
    pageSize?: number
    status?: CopyStatus
    derivedStatus?: CopyDerivedStatus
    personaId?: string
    line?: CopyLine
    source?: CopySource
    keyword?: string
    ids?: string
    topicId?: string
    includeArchived?: boolean
  }) {
    return apiGet<PageResult<CopyListItem>>('/copy', query)
  },

  detail(copyId: string) {
    return apiGet<CopyDetail>(`/copy/${copyId}`)
  },

  create(body: {
    source: CopySource
    personaIds: string[]
    title?: string
    sourceText?: string
    keywords?: string
    articleId?: string
    topicId?: string
    line?: CopyLine
  }) {
    return apiPost<{ copyIds: string[]; topicId: string | null }>('/copy', body)
  },

  update(copyId: string, body: { title?: string; keywords?: string; line?: CopyLine }) {
    return apiPatch<{ ok: true }>(`/copy/${copyId}`, body)
  },

  archive(copyId: string) {
    return apiPost<{ ok: true }>(`/copy/${copyId}/archive`)
  },

  saveSettings(copyId: string, body: CreativeSettings) { return apiPut<{ settings: Record<string, unknown> }>(`/copy/${copyId}/settings`, body) },
  saveSourceReview(copyId: string, body: SourceReview) { return apiPut<{ sourceReview: SourceReview }>(`/copy/${copyId}/source-review`, body) },
  finalize(copyId: string, body: { draftId: string; rev: number }) { return apiPost<{ finalSelection: { draftId: string; versionId: string; versionNo: number } }>(`/copy/${copyId}/finalize`, body) },
  source(copyId: string) {
    return apiGet<SourceMaterial>(`/copy/${copyId}/source`)
  },

  /* 稿 */
  createDraft(copyId: string, from?: string) {
    return apiPost<Draft>(`/copy/${copyId}/drafts`, { from })
  },
  getDraft(copyId: string, draftId: string) {
    return apiGet<Draft>(`/copy/${copyId}/drafts/${draftId}`)
  },
  saveDraft(copyId: string, draftId: string, body: { title?: string | null; sections: Section[]; rev: number; confirmReedit?: boolean }) {
    return apiPut<{ draft: Draft; versionCreated: false }>(`/copy/${copyId}/drafts/${draftId}`, body)
  },
  renameDraft(copyId: string, draftId: string, name: string) {
    return apiPatch<Draft>(`/copy/${copyId}/drafts/${draftId}`, { name })
  },
  switchDraft(copyId: string, draftId: string) {
    return apiPatch<Draft>(`/copy/${copyId}/drafts/${draftId}`, { current: true })
  },
  deleteDraft(copyId: string, draftId: string) {
    return apiDel<{ ok: true }>(`/copy/${copyId}/drafts/${draftId}`)
  },

  /* 版本 */
  saveVersion(copyId: string, draftId: string) {
    return apiPost<{ versionId: string; versionNo: number; created: boolean }>(
      `/copy/${copyId}/drafts/${draftId}/versions`,
    )
  },
  versions(copyId: string) {
    return apiGet<CopyVersion[]>(`/copy/${copyId}/versions`)
  },
  version(versionId: string) {
    return apiGet<CopyVersion & { sections: Section[]; plainText: string }>(`/copy/versions/${versionId}`)
  },
  versionDiff(versionId: string) {
    return apiGet<{
      baseVersionNo: number | null
      targetVersionNo: number
      sections: Array<{ label: string; change: 'added' | 'removed' | 'modified' | 'same'; base: string; target: string }>
    }>(`/copy/versions/${versionId}/diff`)
  },
  restoreVersion(versionId: string) {
    return apiPost<{ draft: Draft }>(`/copy/versions/${versionId}/restore`)
  },

  /* 生成 */
  generate(
    copyId: string,
    body: {
      templateId: string
      styleId: string
      durationTier: DurationTier
      durationSeconds?: number | null
      count: number
      instructions?: string
      scope?: 'all' | 'opinion'
    },
  ) {
    // Idempotency-Key：同一次点击只产生一条生成记录（AC-G2）
    const key = `gen-${copyId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return apiPost<{ generationId: string; status: string; reused?: boolean }>(`/copy/${copyId}/generate`, body, {
      'Idempotency-Key': key,
    })
  },
  generation(generationId: string) {
    return apiGet<Generation>(`/copy/generations/${generationId}`)
  },

  /* 变体 */
  variants(copyId: string, draftId: string, body: { sectionIndex: number; kinds: string[]; count?: number }) {
    return apiPost<{ generationId: string }>(`/copy/${copyId}/drafts/${draftId}/variants`, body)
  },
  applyVariant(variantId: string, body: { mode: 'replace' | 'new_draft'; confirmChanged?: boolean }) {
    return apiPost<{ applied: boolean; requiresConfirm?: boolean; draft?: Draft }>(
      `/copy/variants/${variantId}/apply`,
      body,
    )
  },

  /* 预检 / 提交 / 撤回 */
  precheck(copyId: string, draftId: string) {
    return apiPost<PrecheckResult>(`/copy/${copyId}/precheck`, { draftId })
  },
  submit(copyId: string, body: { draftId: string; rev: number }) {
    return apiPost<{ versionId: string; versionNo: number; submissionId: string; reused: boolean }>(
      `/copy/${copyId}/submit`,
      body,
    )
  },
  withdraw(copyId: string) {
    return apiPost<{ ok: true }>(`/copy/${copyId}/withdraw`)
  },
  approved(copyId: string) {
    return apiGet<{
      copyId: string
      versionId: string
      versionNo: number
      title: string | null
      sections: Section[]
      plainText: string
      riskHint: string | null
      persona: PersonaBrief | null
    }>(`/copy/${copyId}/approved`)
  },

  /* 审核契约（供审核端/调试使用） */
  submission(submissionId: string) {
    return apiGet<Submission>(`/review/submissions/${submissionId}`)
  },
  /** 审核桩人工裁决（§5.3，仅桩开启时可用；退回必须带原因） */
  decision(
    submissionId: string,
    body: { result: 'approved' | 'rejected'; reason?: string; rejectedGate?: string; riskPoints?: string[] },
  ) {
    return apiPost<{ copyId: string; status: 'approved' | 'rejected' }>(`/review/submissions/${submissionId}/decision`, body)
  },

  /* 工具 */
  /** P1-22：编辑时实时合规扫描（后端 POST /copy/compliance/scan）；copyId 用于带出人物禁用表述 */
  scanCompliance(body: { copyId?: string; title?: string | null; sections: Section[] }) {
    return apiPost<{ hits: ComplianceHit[] }>('/copy/compliance/scan', body)
  },
  promptPreview(copyId: string, body: { templateId: string; styleId: string; durationTier: DurationTier; durationSeconds?: number | null; instructions?: string; count?: number }) {
    return apiPost<{ candidates?: Array<{direction: string; user: string}>; system: string; user: string; prompt: string; promptHash: string; wordRange: { min: number; max: number } }>(
      `/copy/${copyId}/prompt-preview`,
      body,
    )
  },
}

export const articleApi = {
  /** 上传文件（.docx / .pdf / .txt / .md） */
  uploadEdit(file: File) {
    const form = new FormData()
    form.append('file', file)
    return apiUpload<ArticleCreated>('/articles', form)
  },
  /** 粘贴纯文本 */
  uploadText(text: string, filename?: string) {
    return apiPost<ArticleCreated>('/articles', { text, filename })
  },
  detail(articleId: string) {
    return apiGet<ArticleDetail>(`/articles/${articleId}`)
  },
}

export interface CopyTemplate {
  id: string
  name: string
  description: string
  prompt: string
  structureHint: string
  riskHint: string
  isBuiltin: boolean
  revision: number
  sort: number
}

export interface CopyStyle {
  id: string
  name: string
  description: string
  prompt: string
  line: CopyLine | null
  isBuiltin: boolean
  revision: number
  sort: number
}

export interface ComplianceWord {
  id: string
  word: string
  level: 'hard' | 'soft'
  note: string | null
  isBuiltin: boolean
  enabled: boolean
  revision: number
}

export const configApi = {
  templates() {
    return apiGet<CopyTemplate[]>('/copy-templates')
  },
  createTemplate(body: Partial<CopyTemplate>) {
    return apiPost<CopyTemplate>('/copy-templates', body)
  },
  updateTemplate(id: string, body: Partial<CopyTemplate>) {
    return apiPut<CopyTemplate>(`/copy-templates/${id}`, body)
  },
  deleteTemplate(id: string) {
    return apiDel<{ ok: true }>(`/copy-templates/${id}`)
  },

  styles() {
    return apiGet<CopyStyle[]>('/copy-styles')
  },
  createStyle(body: Partial<CopyStyle>) {
    return apiPost<CopyStyle>('/copy-styles', body)
  },
  updateStyle(id: string, body: Partial<CopyStyle>) {
    return apiPut<CopyStyle>(`/copy-styles/${id}`, body)
  },
  deleteStyle(id: string) {
    return apiDel<{ ok: true }>(`/copy-styles/${id}`)
  },

  words(params?: { level?: 'hard' | 'soft'; enabledOnly?: boolean }) {
    return apiGet<ComplianceWord[]>('/compliance-words', params)
  },
  createWord(body: { word: string; level: 'hard' | 'soft'; note?: string }) {
    return apiPost<ComplianceWord>('/compliance-words', body)
  },
  updateWord(id: string, body: Partial<ComplianceWord>) {
    return apiPut<ComplianceWord>(`/compliance-words/${id}`, body)
  },
  deleteWord(id: string) {
    return apiDel<{ ok: true }>(`/compliance-words/${id}`)
  },
}
