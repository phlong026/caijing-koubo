import { apiGet, apiPost, apiPatch, apiPut, apiDel, apiUpload, apiUrl, type QueryValue } from './client'

export type PersonaLine = 'manager' | 'kos' | 'persona'
export type BindingMode = 'exclusive' | 'shared'

/** §3.2 有效状态（读时派生） */
export type EffectiveStatus = 'active' | 'auth_pending' | 'auth_expired' | 'auth_revoked' | 'disabled' | 'archived'
export type PersonaExtraTag =
  'voice_unconfirmed' | 'avatar_in_progress' | 'uncertain' | 'auth_expiring' | 'incomplete' | 'configured'

export interface IpProfile {
  role: string
  serviceScope: string
  targetAudience: string
  expressionStyle: string
  forbiddenClaims: string[]
  audienceNeeds?: string
  factualBackground?: string
  sampleScript?: string
  contentDirections?: string[]
  contentMix?: Array<{ label: string; ratio?: number }>
}

/** 列表项（GET /personas，FR-X1：默认仅 usable） */
export interface PersonaListItem {
  id: string
  name: string
  line: PersonaLine
  enabled: boolean
  ipProfile: IpProfile
  ownerSubject: string | null
  description: string | null
  bindingMode: BindingMode
  coverAssetId: string | null
  defaultAvatarId: string | null
  defaultVoiceId: string | null
  profileRevision: number
  rev: number
  currentVersionId: string | null
  archivedAt: string | null
  isStub: boolean
  createdAt: string | null
  updatedAt: string | null
  /** 派生（后端 decorate） */
  status: EffectiveStatus
  statusLabel: string
  usable: boolean
  statusReasons: Array<{ code: string; message: string }>
  extraTags: PersonaExtraTag[]
  counts: { photos: number; avatars: number; voices: number; bindings: number }
  coverUrl: string | null
}

export interface PersonaListQuery {
  line?: PersonaLine
  keyword?: string
  includeDisabled?: boolean
  includeArchived?: boolean
  status?: 'usable' | 'incomplete' | 'disabled' | 'archived'
}

/** FR-X1：GET /personas 返回 {items,total}；默认仅 usable=true */
export function getPersonas(query: PersonaListQuery = {}) {
  const qs: Record<string, QueryValue> = {}
  if (query.line) qs.line = query.line
  if (query.keyword) qs.keyword = query.keyword
  if (query.includeDisabled) qs.includeDisabled = '1'
  if (query.includeArchived) qs.includeArchived = '1'
  if (query.status) qs.status = query.status
  return apiGet<{ items: PersonaListItem[]; total: number }>('/personas', qs)
}

export function createPersona(input: {
  name: string
  line: PersonaLine
  ownerSubject?: string
  description?: string
  bindingMode?: BindingMode
  ipProfile?: unknown
}) {
  return apiPost<PersonaListItem>('/personas', input)
}

/** PATCH 需带 rev（乐观锁，冲突 409 PERSONA_CONFLICT） */
export function patchPersona(
  id: string,
  input: {
    name?: string
    ownerSubject?: string
    description?: string
    bindingMode?: BindingMode
    rev: number
  },
) {
  return apiPatch<PersonaListItem>(`/personas/${id}`, input)
}

export function setPersonaEnabled(id: string, enabled: boolean) {
  return apiPost<PersonaListItem>(`/personas/${id}/${enabled ? 'enable' : 'disable'}`)
}

/** 归档（有进行中克隆 / 审核中文案时 409 PERSONA_IN_USE；force 强制） */
export function archivePersona(id: string, force = false) {
  return apiPost<PersonaListItem>(`/personas/${id}/archive`, { force })
}

/** IP 定位保存（规范化内容未变时 changed=false，不产生新版本） */
export function savePersonaProfile(id: string, ipProfile: unknown, rev?: number) {
  return apiPut<{ profileRevision: number; versionId: string | null; changed: boolean; persona: PersonaListItem }>(
    `/personas/${id}/profile`,
    rev === undefined ? { ipProfile } : { ipProfile, rev },
  )
}

/** 详情（GET /personas/:id）：基本信息 + 派生状态 + 授权 / 绑定 / 素材 / 分身 / 声音 / 样本 / 版本 */
export interface PersonaDetail extends PersonaListItem {
  authorizations: PersonaAuthorization[]
  bindings: AccountBinding[]
  assets: PersonaAsset[]
  avatars: PersonaAvatar[]
  voices: PersonaVoice[]
  voiceSamples: PersonaVoice[]
  versions: Array<{ id: string; versionNo: number; trigger: string; createdAt: string | null }>
}

export function getPersonaDetail(id: string) {
  return apiGet<PersonaDetail>(`/personas/${id}`)
}

export interface PersonaStats {
  lines: Record<PersonaLine, number>
  total: number
  unreadReminders: number
}

export function getPersonaStats() {
  return apiGet<PersonaStats>('/personas/stats')
}

export interface PersonaOptions {
  ipOptions: {
    roles: string[]
    serviceScopes: string[]
    expressionStyles: string[]
    contentDirections: string[]
  } & Record<string, string[]>
  lineLabels: Record<PersonaLine, string>
  lineRules: Record<
    PersonaLine,
    { label: string; bindingModes: BindingMode[]; defaultBindingMode: BindingMode } & Record<string, unknown>
  >
  lineDefaultDirections: Record<PersonaLine, string[]>
  lineDefaultForbidden: Record<PersonaLine, string[]>
  contentMixPresets: Array<{ label: string }> | string[]
  uploadLimits: Record<string, { exts: string[]; maxBytes: number } & Record<string, unknown>>
  assetLimits: Record<AssetKind, number>
  assetKindLabels: Record<string, string>
  platformLabels: Record<string, string>
  voiceLanguages: Array<{ code: string; label: string }>
  consentTextVersion: string
  consentTexts: Record<string, string>
  hifly: { configured: boolean; mock: boolean; baseUrl: string; credit: number | null; creditError: string | null }
  storage: { oss: boolean; mode: 'oss' | 'local' }
}

export function getPersonaOptions() {
  return apiGet<PersonaOptions>('/personas/options')
}

export function getPersonaVersions(id: string) {
  return apiGet<Array<{ id: string; versionNo: number; trigger: string; createdAt: string | null }>>(
    `/personas/${id}/versions`,
  )
}

/* ── readiness / production-profile（FR-X4 / FR-X5）──────────── */

export interface ReadinessCheck {
  key: string
  level: 'hard' | 'soft'
  pass: boolean
  message: string
}

export function getReadiness(id: string, purpose: 'copy' | 'avatar_video' | 'mixcut') {
  return apiGet<{
    personaId: string
    purpose: string
    status: EffectiveStatus
    pass: boolean
    checks: ReadinessCheck[]
  }>(`/personas/${id}/readiness`, { purpose })
}

export function getProductionProfile(id: string, avatarId?: string) {
  const suffix = avatarId ? `?avatarId=${encodeURIComponent(avatarId)}` : ''
  return apiGet<{
    personaId: string
    versionId: string | null
    versionNo: number | null
    name: string
    line: string
    provider: 'hifly'
    avatar: {
      avatarId: string
      vendorAvatarId: string
      name: string
      backgroundLabel: string | null
      coverUrl: string | null
      sourceWidth: number | null
      sourceHeight: number | null
    }
    voice: {
      voiceId: string
      vendorVoiceId: string
      name: string
      language: string
      speechRate: number
      volume: number
      pitch: number
      demoUrl: string | null
    }
  }>(`/personas/${id}/production-profile${suffix}`)
}

/* ── 素材 / 授权 / 声音（multipart；字段在前、文件在后）────────── */

export type AssetKind = 'photo' | 'avatar_source' | 'background_image' | 'background_video' | 'broll_video'
export type AuthorizationScope = 'portrait' | 'voice' | 'share'

/** 素材上传（kind 决定上限与校验；同内容去重时 deduplicated=true） */
export function uploadAsset(
  id: string,
  fields: { kind: AssetKind; name?: string; backgroundLabel?: string; tags?: string },
  file: File,
) {
  const form = new FormData()
  form.append('kind', fields.kind)
  if (fields.name) form.append('name', fields.name)
  if (fields.backgroundLabel) form.append('backgroundLabel', fields.backgroundLabel)
  if (fields.tags) form.append('tags', fields.tags)
  form.append('file', file)
  return apiUpload<{ assetId: string; status: string; deduplicated: boolean }>(`/personas/${id}/assets`, form)
}

/** 授权材料上传（scopes 逗号分隔；effectiveFrom / expiresAt 为 YYYY-MM-DD） */
export function uploadAuthorization(
  id: string,
  fields: {
    grantorName: string
    scopes: AuthorizationScope[]
    effectiveFrom: string
    expiresAt: string
    note?: string
  },
  file: File,
) {
  const form = new FormData()
  form.append('grantorName', fields.grantorName)
  form.append('scopes', fields.scopes.join(','))
  form.append('effectiveFrom', fields.effectiveFrom)
  form.append('expiresAt', fields.expiresAt)
  if (fields.note) form.append('note', fields.note)
  form.append('file', file)
  return apiUpload<{ id: string; status: string }>(`/personas/${id}/authorizations`, form)
}

/** 声音样本上传（wav/mp3/m4a，5–180s） */
export function uploadVoiceSample(id: string, file: File) {
  const form = new FormData()
  form.append('file', file)
  return apiUpload<{ sampleId: string; durationMs: number; sha256: string }>(`/personas/${id}/voice-samples`, form)
}

/* ── 克隆：分身 ─────────────────────────────────────────────── */

export interface PersonaAvatar {
  id: string
  personaId: string
  name: string
  sourceAssetId: string
  backgroundLabel: string | null
  vendorTitle: string
  shortRef: string
  vendorTaskId: string | null
  vendorAvatarId: string | null
  status: 'pending' | 'submitting' | 'running' | 'ready' | 'failed' | 'uncertain'
  error: string | null
  consentId: string
  authorizationId: string
  createdAt: string | null
  readyAt: string | null
}

/** 发起分身制作（必须带 Idempotency-Key；同素材已有 ready/进行中需 confirmDuplicate） */
export function createAvatar(
  id: string,
  input: { name?: string; sourceAssetId: string; consentId: string; confirmDuplicate?: boolean },
  idempotencyKey: string,
) {
  return apiPost<{ avatarId: string; status: string; replayed: boolean }>(`/personas/${id}/avatars`, input, {
    'Idempotency-Key': idempotencyKey,
  })
}

export function getAvatars(id: string) {
  return apiGet<PersonaAvatar[]>(`/personas/${id}/avatars`)
}

export function setDefaultAvatar(avatarId: string) {
  return apiPost<PersonaAvatar>(`/persona-avatars/${avatarId}/set-default`)
}

/** 立即查询厂商状态（仅 running 可调） */
export function refreshAvatar(avatarId: string) {
  return apiPost<PersonaAvatar>(`/persona-avatars/${avatarId}/refresh`)
}

/** 厂商侧核对（列表按标题短引用匹配，用于 uncertain 恢复） */
export function reconcileAvatar(avatarId: string) {
  return apiPost<PersonaAvatar>(`/persona-avatars/${avatarId}/reconcile`)
}

export function patchAvatar(avatarId: string, name: string) {
  return apiPatch<PersonaAvatar>(`/persona-avatars/${avatarId}`, { name })
}

export function deleteAvatar(avatarId: string) {
  return apiDel<{ deleted: boolean }>(`/persona-avatars/${avatarId}`)
}

/* ── 克隆：声音 ─────────────────────────────────────────────── */

export interface PersonaVoice {
  id: string
  personaId: string
  name: string
  isSample: boolean
  language: string
  status: 'pending' | 'submitting' | 'running' | 'ready' | 'failed' | 'uncertain'
  confirmed: boolean
  vendorVoiceId: string | null
  vendorTaskId: string | null
  demoKey: string | null
  speechRate: number
  volume: number
  pitch: number
  error: string | null
  sampleDurationMs: number | null
  createdAt: string | null
  readyAt: string | null
}

/** 发起声音克隆（必须带 Idempotency-Key；language 用生产语种码如 zh_cantonese） */
export function createVoice(
  id: string,
  input: { name?: string; sampleId: string; consentId: string; language?: string },
  idempotencyKey: string,
) {
  return apiPost<{ voiceId: string; status: string; replayed: boolean }>(`/personas/${id}/voices`, input, {
    'Idempotency-Key': idempotencyKey,
  })
}

export function getVoices(id: string) {
  return apiGet<{ voices: PersonaVoice[]; samples: PersonaVoice[] }>(`/personas/${id}/voices`)
}

export function confirmVoice(voiceId: string) {
  return apiPost<PersonaVoice>(`/persona-voices/${voiceId}/confirm`)
}

/** 参数调整（R17 三段式：飞影先改后落库；0.5–2.0，最多一位小数） */
export function updateVoiceSettings(
  voiceId: string,
  settings: { speechRate?: number; volume?: number; pitch?: number },
) {
  return apiPut<PersonaVoice>(`/persona-voices/${voiceId}/settings`, settings)
}

/** 任意文本试听（≤100 字；同参数同文本 7 天内走缓存） */
export function createVoicePreview(voiceId: string, text: string) {
  return apiPost<{ previewId: string; status: string; cached: boolean }>(`/persona-voices/${voiceId}/preview`, { text })
}

export function getVoicePreview(previewId: string) {
  return apiGet<{ id: string; status: 'running' | 'ready' | 'failed'; audioKey: string | null; error: string | null }>(
    `/persona-voice-previews/${previewId}`,
  )
}

export function refreshVoice(voiceId: string) {
  return apiPost<PersonaVoice>(`/persona-voices/${voiceId}/refresh`)
}

export function reconcileVoice(voiceId: string) {
  return apiPost<PersonaVoice>(`/persona-voices/${voiceId}/reconcile`)
}

export function patchVoice(voiceId: string, name: string) {
  return apiPatch<PersonaVoice>(`/persona-voices/${voiceId}`, { name })
}

export function setDefaultVoice(voiceId: string) {
  return apiPost<PersonaVoice>(`/persona-voices/${voiceId}/set-default`)
}

export function deleteVoice(voiceId: string) {
  return apiDel<{ deleted: boolean }>(`/persona-voices/${voiceId}`)
}

/* ── consent / 授权 / 提醒 ──────────────────────────────────── */

export function createConsent(
  id: string,
  input: {
    authorizationId: string
    purpose: 'AVATAR_CLONE' | 'VOICE_CLONE'
    sourceKind: 'avatar_source' | 'voice_sample'
    sourceId: string
    consentTextVersion: string
  },
) {
  return apiPost<{ consentId: string }>(`/personas/${id}/consents`, input)
}

export function verifyAuthorization(authId: string, decision: 'verified' | 'rejected', reason?: string) {
  return apiPost<{ id: string; status: string }>(`/persona-authorizations/${authId}/verify`, { decision, reason })
}

export function revokeAuthorization(authId: string, reason: string) {
  return apiPost<{ id: string; status: string }>(`/persona-authorizations/${authId}/revoke`, { reason })
}

/* ── 素材：列表 / 审核 / 封面 / 删除 / 文件地址 ─────────────────── */

export type AssetStatus = 'uploaded' | 'processing' | 'pending_review' | 'approved' | 'rejected' | 'failed'

export interface PersonaAsset {
  id: string
  personaId: string
  kind: AssetKind
  name: string
  backgroundLabel: string | null
  status: AssetStatus
  mime: string
  sizeBytes: number
  width: number | null
  height: number | null
  durationMs: number | null
  fps: number | null
  quality: {
    hard: Array<{ code: string; message: string }>
    soft: Array<{ code: string; message: string }>
    metrics: Record<string, unknown>
  } | null
  tags: string[]
  reviewDecision: string | null
  reviewReason: string | null
  reviewIssueCodes: string[]
  error: string | null
  thumbKey: string | null
  compatKey: string | null
  sort: number
  createdAt: string | null
  processing: boolean
}

export function getAssets(id: string, query: { kind?: AssetKind; status?: AssetStatus } = {}) {
  return apiGet<PersonaAsset[]>(`/personas/${id}/assets`, { kind: query.kind, status: query.status })
}

export function reviewAsset(
  assetId: string,
  input: { decision: 'approved' | 'rejected'; reason?: string; issueCodes?: string[] },
) {
  return apiPost<PersonaAsset>(`/persona-assets/${assetId}/review`, input)
}

export function setAssetCover(assetId: string) {
  return apiPost<PersonaAsset>(`/persona-assets/${assetId}/set-cover`)
}

export function patchAsset(
  assetId: string,
  input: { name?: string; backgroundLabel?: string; tags?: string[]; sort?: number },
) {
  return apiPatch<PersonaAsset>(`/persona-assets/${assetId}`, input)
}

export function deleteAsset(assetId: string) {
  return apiDel<{ deleted: boolean }>(`/persona-assets/${assetId}`)
}

/** 缩略图 / 兼容版 / 原件：经后端代理，不暴露存储路径（读取 original 会记敏感访问审计） */
export function assetFileUrl(assetId: string, variant: 'thumb' | 'compat' | 'original' = 'thumb'): string {
  return apiUrl(`/persona-assets/${assetId}/file?variant=${variant}`)
}

/* ── 授权 / 绑定 / 提醒 ───────────────────────────────────────── */

export type AuthorizationStatus = 'pending' | 'verified' | 'rejected' | 'revoked' | 'expired'

export interface PersonaAuthorization {
  id: string
  personaId: string
  grantorName: string
  scopes: AuthorizationScope[]
  fileMime: string
  fileSize: number
  effectiveFrom: string | null
  expiresAt: string | null
  status: AuthorizationStatus
  decisionReason: string | null
  verifiedBy: string | null
  verifiedAt: string | null
  revokedBy: string | null
  revokedAt: string | null
  note: string | null
  createdAt: string | null
}

export function getAuthorizations(id: string) {
  return apiGet<PersonaAuthorization[]>(`/personas/${id}/authorizations`)
}

export function authorizationFileUrl(authId: string): string {
  return apiUrl(`/persona-authorizations/${authId}/file`)
}

export type Platform = 'douyin' | 'xiaohongshu' | 'kuaishou' | 'shipinhao'

export interface AccountBinding {
  id: string
  personaId: string
  platform: Platform
  accountKey: string
  displayName: string
  createdAt: string | null
}

export function getAccounts(id: string) {
  return apiGet<AccountBinding[]>(`/personas/${id}/accounts`)
}

/** 全量替换（空数组 = 全部解绑）；违反线规则 409 PERSONA_BINDING_RULE */
export function setAccounts(
  id: string,
  accounts: Array<{ platform: Platform; accountKey: string; displayName: string }>,
) {
  return apiPut<AccountBinding[]>(`/personas/${id}/accounts`, { accounts })
}

export interface PersonaReminder {
  id: string
  personaId: string
  kind: string
  refId: string | null
  message: string
  readAt: string | null
  createdAt: string | null
}

export function getReminders(unreadOnly = false) {
  return apiGet<{ items: PersonaReminder[]; unread: number }>('/persona-reminders', {
    unread: unreadOnly ? '1' : undefined,
  })
}

export function readAllReminders() {
  return apiPost<{ updated: number }>('/persona-reminders/read-all')
}

/** 声音：厂商试听（克隆完成时归档）与任意文本试听文件 */
export function voiceDemoUrl(voiceId: string): string {
  return apiUrl(`/persona-voices/${voiceId}/demo`)
}

export function voicePreviewUrl(previewId: string): string {
  return apiUrl(`/persona-voice-previews/${previewId}/file`)
}

/** 版本详情（快照） */
export function getPersonaVersion(versionId: string) {
  return apiGet<{
    id: string
    versionNo: number
    trigger: string
    createdAt: string | null
    snapshot: Record<string, unknown>
  }>(`/persona-versions/${versionId}`)
}
