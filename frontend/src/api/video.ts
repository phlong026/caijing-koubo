import { apiGet, apiPost, apiPut, type QueryValue } from './client'

/** 视频创作模块 API（任务书 §6.1 / §7 工程）。 */

export type VideoMode = 'avatar' | 'mixcut'
export type VideoPhase =
  | 'waiting'
  | 'preparing'
  | 'submitting'
  | 'generating'
  | 'recovering'
  | 'downloading'
  | 'verifying'
  | 'aligning'
  | 'completed'
  | 'tts'
  | 'composing'
  | 'failed'
  | 'save_failed'
  | 'submission_unknown'
  | 'paused'
  | 'cancelled'

export type NextAction =
  'view_progress' | 'retry_download' | 'query_original' | 'bind_remote' | 'continue_edit' | 'realign' | 'regenerate'

export interface PrecheckItem {
  key: string
  level: 'hard' | 'soft'
  pass: boolean
  message: string
  action?: string
}

export interface TimelineItem {
  index: number
  kind: 'normal' | 'risk'
  text: string
  startMs: number
  endMs: number
}

export interface VideoOptions {
  modes: Array<{ key: VideoMode; label: string; desc: string; personaLineBlocked?: string }>
  genModes: Array<{ key: 'tts' | 'audio'; label: string }>
  engine: { provider: string; configured: boolean; mock: boolean; credit: number | null; creditError: string | null }
  pricing: { creditsPerSec: number; desc: string; note: string }
  output: { width: number; height: number; fps: number; codec: string }
  limits: {
    maxSeconds: number
    maxTextChars: number
    jobLimitPerCopy: number
    genConcurrency: number
    sentenceMaxChars: number
    archiveMaxMb: number
  }
  alignMinScore: number
  storage: { oss: boolean; mode: 'oss' | 'local' }
}

export interface AvatarOption {
  avatarId: string
  name: string
  status: string
  statusLabel: string
  selectable: boolean
  blockedReason: string | null
  backgroundLabel: string | null
  coverUrl: string | null
  sourceWidth: number | null
  sourceHeight: number | null
  isDefault: boolean
  fromLibrary: true
}

export interface ProductionProfile {
  personaId: string
  versionId: string | null
  name: string
  line: string
  avatar: {
    avatarId: string
    vendorAvatarId: string
    name: string
    backgroundLabel: string | null
    coverUrl: string | null
    sourceWidth: number | null
    sourceHeight: number | null
  } | null
  voice: {
    voiceId: string
    vendorVoiceId: string
    name: string
    language: string
    speechRate: number
    volume: number
    pitch: number
    demoUrl: string | null
  } | null
}

export interface JobSummary {
  id: string
  copyId: string
  copyVersionNo: number
  versionNo: number
  personaId: string
  line: string | null
  mode: VideoMode
  genMode: string | null
  phase: VideoPhase
  progress: number
  message: string
  errorCode: string | null
  errorDetail: string | null
  nextActions: NextAction[]
  avatarId: string | null
  vendorTitle: string | null
  shortRef: string | null
  remoteTaskId: string | null
  timelineSource: 'aligned' | 'estimated' | 'measured' | null
  alignScore: number | null
  timeline: TimelineItem[] | null
  replacements: Array<{
    index: number
    keyword: string
    groupName: string
    itemId: string
    startMs: number
    endMs: number
  }> | null
  resultKey: string | null
  coverKey: string | null
  durationMs: number
  width: number
  height: number
  isMock: boolean
  creditsEstimated: number
  createdAt: string
  archivedAt: string | null
}

export interface CopyContext {
  copy: {
    id: string
    title: string | null
    persona: { id: string; name: string; line: string } | null
    line: string | null
    versionId: string
    versionNo: number
    wordCount: number
    estSeconds: number
    revising: boolean
    riskHint: string | null
    sections: Array<{ label: string; text: string }>
  }
  persona: { id: string; name: string; line: string; status: string } | null
  productionProfile: ProductionProfile | null
  readiness: { pass: boolean; checks: PrecheckItem[] } | null
  avatars: AvatarOption[]
  backgrounds: Array<{ id: string; kind: string; name: string; coverUrl: string | null }>
  savedConfig: {
    mode: VideoMode
    avatarId: string | null
    backgroundAssetId: string | null
    voiceSource: string | null
    publicVoiceId: string | null
    mixcut: {
      packIds?: string[]
      keywordGroupIds?: string[]
      backgroundAssetId?: string | null
      display?: 'fullscreen' | 'pip'
    } | null
  } | null
  jobs: JobSummary[]
  limits: { maxSeconds: number; maxTextChars: number; jobLimitPerCopy: number }
}

export interface PrecheckResult {
  estSeconds: number
  estCredits: number
  segments: Array<{ index: number; sectionIndex: number; kind: 'normal' | 'risk'; text: string }>
  checks: PrecheckItem[]
  approved: {
    copyId: string
    versionId: string
    versionNo: number
    title: string
    personaId: string
    line: string
    revising: boolean
  } | null
}

export interface CreateJobInput {
  copyId: string
  mode: VideoMode
  avatarId?: string | null
  mixcutPackIds?: string[]
  mixcutKeywordGroupIds?: string[]
  mixcutBackgroundAssetId?: string | null
  voiceSource?: 'persona' | 'public'
  publicVoiceId?: string | null
  display?: 'fullscreen' | 'pip'
}

export interface KeywordGroup {
  id: string
  name: string
  keywords: string[]
  packIds: string[]
  durationMinMs: number
  durationMaxMs: number
  selectionMode: 'random' | 'sequential'
  enabled: number
  sort: number
}

export interface MaterialPack {
  id: string
  name: string
  line: string | null
  sourcePath: string | null
  itemCount: number
  enabled: number
}

export interface BaseVideo {
  videoJobId: string
  versionNo: number
  mode: string
  copyId: string
  copyVersionNo: number
  persona: { id: string; name: string; line: string | null; versionId: string | null }
  avatar: { avatarId: string | null; backgroundLabel: string | null }
  url: string
  coverUrl: string | null
  durationMs: number
  width: number
  height: number
  timeline: TimelineItem[]
  timelineSource: string
  alignScore: number | null
  riskText: string | null
  isMock: boolean
}

export function getVideoOptions(): Promise<VideoOptions> {
  return apiGet('/video/options')
}

export function getVideoCopies(query?: Record<string, QueryValue>): Promise<{
  items: Array<{
    id: string
    title: string | null
    persona_id: string | null
    line: string | null
    status: string
    updated_at: string | null
  }>
  total: number
}> {
  return apiGet('/video/copies', query)
}

export function getVideoCopyContext(copyId: string): Promise<CopyContext> {
  return apiGet(`/video/copies/${copyId}/context`)
}

export function putVideoCopyConfig(copyId: string, input: Partial<CreateJobInput>): Promise<{ saved: boolean }> {
  return apiPut(`/video/copies/${copyId}/config`, input)
}

export function postVideoPrecheck(input: {
  copyId: string
  mode: VideoMode
  avatarId?: string | null
  mixcutPackIds?: string[]
}): Promise<PrecheckResult> {
  return apiPost('/video/precheck', input)
}

export function postMixcutPreview(input: {
  copyId: string
  keywordGroupIds?: string[]
  backgroundAssetId?: string | null
}): Promise<{
  timelineEstimated: Array<{ index: number; startMs: number; endMs: number; text: string }>
  matches: Array<{ index: number; keyword: string; groupName: string; itemId: string; startMs: number; endMs: number }>
}> {
  return apiPost('/video/mixcut/preview', input)
}

export function createVideoJob(
  input: CreateJobInput,
  idempotencyKey: string,
): Promise<{ jobId: string; versionNo: number; phase: string; replayed: boolean }> {
  return apiPost('/video/jobs', input, { 'Idempotency-Key': idempotencyKey })
}

export function listVideoJobs(query?: Record<string, QueryValue>): Promise<{ items: JobSummary[]; total: number }> {
  return apiGet('/video/jobs', query)
}

export function getVideoJob(id: string): Promise<
  JobSummary & {
    snapshot: unknown
    textSnapshot: { segments: TimelineItem[]; charCount: number; estSeconds: number } | null
    events: Array<{
      id: string
      fromPhase: string | null
      toPhase: string
      errorCode: string | null
      detail: unknown
      operator: string | null
      createdAt: string
    }>
  }
> {
  return apiGet(`/video/jobs/${id}`)
}

export function getVideoJobBase(id: string): Promise<BaseVideo> {
  return apiGet(`/video/jobs/${id}/base`)
}

export function postJobAction(id: string, action: string, body?: unknown): Promise<{ done?: boolean; phase?: string }> {
  return apiPost(`/video/jobs/${id}/${action}`, body ?? {})
}

export function listMaterialPacks(): Promise<MaterialPack[]> {
  return apiGet('/material-packs')
}

export function listKeywordGroups(): Promise<KeywordGroup[]> {
  return apiGet('/material-keyword-groups')
}
