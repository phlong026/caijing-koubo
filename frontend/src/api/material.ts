import { ApiError, apiDel, apiGet, apiPatch, apiPost, apiUrl, readToken } from './client'

/**
 * 素材库接口（任务书 §6）。
 * `/material-packs*`、`/material-keyword-groups*` 与视频创作 V1 交付时路径完全一致（仅后端代码归位），
 * `/fonts`、`/voice-library` 为素材库新增。
 */

/**
 * 带进度的上传（素材包可能是几十 MB 的片段/压缩包，无进度条体验很差）。
 * fetch 无法读上传进度，这里单独用 XHR；鉴权头与错误信封口径与 client.ts 保持一致。
 */
function uploadWithProgress<T>(path: string, form: FormData, onProgress?: (percent: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl(path))
    const token = readToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let payload: { ok?: boolean; data?: T; error?: { code?: string; message?: string } } | undefined
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : undefined
      } catch {
        payload = undefined
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload?.ok) {
        onProgress?.(100)
        resolve(payload.data as T)
        return
      }
      reject(
        new ApiError(
          payload?.error?.code ?? `http_${xhr.status}`,
          payload?.error?.message ?? `上传失败（${xhr.status}）`,
          xhr.status,
        ),
      )
    }
    xhr.onerror = () => reject(new ApiError('network_error', '网络中断，上传失败'))
    xhr.send(form)
  })
}

export type LicenseType = 'ofl' | 'commercial' | 'other'

export interface FontItem {
  id: string
  fileName: string
  displayName: string
  fileHash: string
  sizeBytes: number
  licenseType: LicenseType
  licenseNote: string | null
  enabled: boolean
  /** 被成片字幕样式显式引用的版本数（>0 时不可删，FR-F3） */
  inUseCount: number
  createdAt: string | null
  updatedAt: string | null
}

export interface EnabledFont {
  id: string
  fileName: string
  displayName: string
  licenseType: string
}

export interface FontListResult {
  items: FontItem[]
  enabled: EnabledFont[]
}

/** 授权类型展示口径（§3.3） */
export const LICENSE_LABELS: Record<LicenseType, string> = {
  ofl: '开源授权 OFL',
  commercial: '已购商用',
  other: '其他 / 待核',
}

export function listFonts(): Promise<FontListResult> {
  return apiGet('/fonts')
}

export function uploadFont(
  file: File,
  meta: { displayName?: string; licenseType: LicenseType; licenseNote?: string },
  onProgress?: (percent: number) => void,
): Promise<FontItem> {
  const form = new FormData()
  form.append('file', file)
  if (meta.displayName) form.append('displayName', meta.displayName)
  form.append('licenseType', meta.licenseType)
  if (meta.licenseNote) form.append('licenseNote', meta.licenseNote)
  return uploadWithProgress('/fonts', form, onProgress)
}

export function patchFont(
  id: string,
  patch: { enabled?: boolean; displayName?: string; licenseType?: LicenseType; licenseNote?: string | null },
): Promise<FontItem> {
  return apiPatch(`/fonts/${id}`, patch)
}

export function deleteFont(id: string): Promise<{ deleted: boolean }> {
  return apiDel(`/fonts/${id}`)
}

/* ── 素材包（FR-P1~P4）──────────────────────────────────────── */

export interface MaterialPackView {
  id: string
  name: string
  line: string | null
  sourcePath: string | null
  itemCount: number
  /** 后端为 1/0（历史口径） */
  enabled: number
  licenseNote: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface MaterialItemView {
  id: string
  packId: string
  storageKey: string
  isImage: boolean
  durationMs: number | null
  width: number | null
  height: number | null
  thumbKey: string | null
  /** 服务端已签名的缩略图直链（OSS 或 /api/media 兜底），可直接用于 <img> */
  thumbUrl: string | null
  tags: string[]
  enabled: number
}

export function listMaterialPacks(): Promise<MaterialPackView[]> {
  return apiGet('/material-packs')
}

export function listMaterialItems(packId: string): Promise<MaterialItemView[]> {
  return apiGet(`/material-packs/${packId}/items`)
}

export function uploadMaterialPack(
  input: { name: string; line?: string | null; licenseNote?: string | null; files: File[] },
  onProgress?: (percent: number) => void,
): Promise<MaterialPackView> {
  const form = new FormData()
  form.append('name', input.name)
  if (input.line) form.append('line', input.line)
  if (input.licenseNote) form.append('licenseNote', input.licenseNote)
  input.files.forEach((f) => form.append('files', f, f.name))
  return uploadWithProgress('/material-packs', form, onProgress)
}

export function patchMaterialPack(
  id: string,
  patch: { name?: string; enabled?: boolean; line?: string | null; licenseNote?: string | null },
): Promise<MaterialPackView> {
  return apiPatch(`/material-packs/${id}`, patch)
}

export function deleteMaterialPack(id: string): Promise<{ deleted: boolean }> {
  return apiDel(`/material-packs/${id}`)
}

export function patchMaterialItem(
  packId: string,
  itemId: string,
  tags: string[],
): Promise<{ id: string; tags: string[] }> {
  return apiPatch(`/material-packs/${packId}/items/${itemId}`, { tags })
}

/* ── 关键词组（FR-K1）───────────────────────────────────────── */

export interface KeywordGroupView {
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

export interface KeywordGroupInput {
  name: string
  keywords: string[]
  packIds: string[]
  durationMinMs: number
  durationMaxMs: number
  selectionMode: 'random' | 'sequential'
  enabled: boolean
  sort: number
}

export function listKeywordGroups(): Promise<KeywordGroupView[]> {
  return apiGet('/material-keyword-groups')
}

export function createKeywordGroup(input: KeywordGroupInput): Promise<KeywordGroupView> {
  return apiPost('/material-keyword-groups', input)
}

export function patchKeywordGroup(id: string, patch: Partial<KeywordGroupInput>): Promise<KeywordGroupView> {
  return apiPatch(`/material-keyword-groups/${id}`, patch)
}

export function deleteKeywordGroup(id: string): Promise<{ deleted: boolean }> {
  return apiDel(`/material-keyword-groups/${id}`)
}

/* ── 声音库聚合（FR-V1，只读）────────────────────────────────── */

export type VoiceLicenseState = 'verified' | 'pending' | 'unbound'

export interface VoiceLibraryItem {
  voiceId: string
  personaId: string
  personaName: string
  line: string
  voiceName: string
  status: string
  isSample: boolean
  confirmed: boolean
  consentBound: boolean
  authorizationId: string | null
  demoKey: string | null
  createdAt: string | null
}

/** 与后端 licenseStateOf 同口径（前端仅展示） */
export function voiceLicenseStateOf(v: Pick<VoiceLibraryItem, 'confirmed' | 'consentBound'>): VoiceLicenseState {
  if (v.confirmed && v.consentBound) return 'verified'
  if (v.consentBound) return 'pending'
  return 'unbound'
}

export const VOICE_LICENSE_LABELS: Record<VoiceLicenseState, string> = {
  verified: '已核验',
  pending: '待人工确认',
  unbound: '未绑授权',
}

export function listVoiceLibrary(filter: { line?: string; personaId?: string } = {}): Promise<VoiceLibraryItem[]> {
  return apiGet('/voice-library', filter)
}
