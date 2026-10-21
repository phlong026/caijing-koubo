import { getDb, isDuplicateKey, upsert } from '../../../db/index.js'
import crypto from 'node:crypto'
import path from 'node:path'
import { newId } from '../../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../../lib/time.js'
import { sha256File } from '../../../lib/upload.js'
import { err } from '../../../errors.js'
import { logger } from '../../../log.js'
import { recordOperation } from '../../audit/repo.js'
import { enqueue, QUEUE_NAMES, dedupOpts } from '../../../queue/index.js'
import { deleteObject, putObjectFromFile } from '../../../integrations/aliyun-oss/client.js'
import { MAGIC_HEAD_BYTES, validateUploadFile } from '../../../lib/upload.js'
import { normalizeAudioToMp3, probeMedia } from '../../../media/inspect.js'
import { ensureTempDir, cleanup } from '../../../media/pipeline.js'
import { getPersonaById } from '../repo.js'
import { assertConsentValid, getConsentById } from '../consent.js'
import { validAuthorizationsOf } from '../authorizations.js'
import { LINE_RULES, UPLOAD_LIMITS, VOICE_LANGUAGES, VOICE_STATUS_LABELS, type VoiceStatus } from '../types.js'
import { checkVoiceSampleQuality } from '../assets/quality.js'
import { buildVendorTitle, uniqueShortRef } from './short-ref.js'
import { ensurePersonaVersion } from '../versions.js'

/**
 * 声音档案（FR-V1~V9，平移众墅之家 oral_voices）。
 *
 * 数据模型说明：样本与克隆共用 persona_voice 表，以 is_sample 区分——
 *  - is_sample=1：声音样本（FR-V1 上传，未发起克隆，无厂商字段）；
 *  - is_sample=0：克隆声音（FR-V3 发起，携带样本 key/sha/时长与厂商任务）。
 * consent 的 sourceKind='voice_sample' 指向样本行（见 consent.ts）。
 */

export interface PersonaVoice {
  id: string
  personaId: string
  name: string
  isSample: boolean
  provider: string
  voiceType: number
  language: string
  sampleKey: string
  sampleSha256: string
  sampleDurationMs: number | null
  vendorTitle: string
  shortRef: string
  vendorTaskId: string | null
  vendorVoiceId: string | null
  demoKey: string | null
  consentId: string | null
  authorizationId: string | null
  status: VoiceStatus
  error: string | null
  confirmed: boolean
  confirmedBy: string | null
  confirmedAt: string | null
  speechRate: number
  volume: number
  pitch: number
  idempotencyKey: string | null
  requestHash: string | null
  attempts: number
  submittedAt: string | null
  lastPolledAt: string | null
  nextPollAt: string | null
  readyAt: string | null
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
  deletedAt: string | null
  deletedBy: string | null
}

export function mapVoiceRow(r: Record<string, any>): PersonaVoice {
  return {
    id: r.id,
    personaId: r.persona_id,
    name: r.name,
    isSample: !!r.is_sample,
    provider: r.provider ?? 'hifly',
    voiceType: Number(r.voice_type ?? 8),
    language: r.language ?? 'zh',
    sampleKey: r.sample_key,
    sampleSha256: r.sample_sha256,
    sampleDurationMs: r.sample_duration_ms === null || r.sample_duration_ms === undefined ? null : Number(r.sample_duration_ms),
    vendorTitle: r.vendor_title,
    shortRef: r.short_ref,
    vendorTaskId: r.vendor_task_id ?? null,
    vendorVoiceId: r.vendor_voice_id ?? null,
    demoKey: r.demo_key ?? null,
    consentId: r.consent_id ?? null,
    authorizationId: r.authorization_id ?? null,
    status: r.status as VoiceStatus,
    error: r.error ?? null,
    confirmed: !!r.confirmed,
    confirmedBy: r.confirmed_by ?? null,
    confirmedAt: fromDb(r.confirmed_at),
    speechRate: Number(r.speech_rate ?? 1),
    volume: Number(r.volume ?? 1),
    pitch: Number(r.pitch ?? 1),
    idempotencyKey: r.idempotency_key ?? null,
    requestHash: r.request_hash ?? null,
    attempts: Number(r.attempts ?? 0),
    submittedAt: fromDb(r.submitted_at),
    lastPolledAt: fromDb(r.last_polled_at),
    nextPollAt: fromDb(r.next_poll_at),
    readyAt: fromDb(r.ready_at),
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
    deletedAt: fromDb(r.deleted_at),
    deletedBy: r.deleted_by ?? null,
  }
}

const SELECT = 'SELECT * FROM `persona_voice`'

export async function getVoiceById(id: string, includeDeleted = false): Promise<PersonaVoice | null> {
  const r = await getDb().get<Record<string, any>>(`${SELECT} WHERE \`id\` = ?`, [id])
  if (!r) return null
  if (!includeDeleted && r.deleted_at) return null
  return mapVoiceRow(r)
}

/** 克隆声音列表（is_sample=0） */
export async function listVoices(personaId: string, includeDeleted = false): Promise<PersonaVoice[]> {
  const where = includeDeleted
    ? '`persona_id` = ? AND `is_sample` = 0'
    : '`persona_id` = ? AND `is_sample` = 0 AND `deleted_at` IS NULL'
  const rows = await getDb().all<Record<string, any>>(
    `${SELECT} WHERE ${where} ORDER BY \`created_at\` DESC`,
    [personaId],
  )
  return rows.map(mapVoiceRow)
}

/** 声音样本列表（is_sample=1） */
export async function listVoiceSamples(personaId: string): Promise<PersonaVoice[]> {
  const rows = await getDb().all<Record<string, any>>(
    `${SELECT} WHERE \`persona_id\` = ? AND \`is_sample\` = 1 AND \`deleted_at\` IS NULL ORDER BY \`created_at\` DESC`,
    [personaId],
  )
  return rows.map(mapVoiceRow)
}

/* ── 样本上传（FR-V1）──────────────────────────────────────────── */

export interface UploadVoiceSampleInput {
  personaId: string
  filePath: string
  filename: string
  size: number
  head: Buffer
  operator: string
}

/** 上传声音样本：线规则 → 三重校验 → ffprobe → 规范化单声道 mp3 → 私有存储 */
export async function uploadVoiceSample(input: UploadVoiceSampleInput): Promise<PersonaVoice> {
  const db = getDb()
  const persona = await getPersonaById(input.personaId, true)
  if (!persona) throw err.personaNotFound()
  if (persona.archivedAt) throw err.personaArchived()
  const rule = LINE_RULES[persona.line]
  if (!rule.voiceAllowed) throw err.lineNotAllowed('素人矩阵不提供声音克隆，不能上传声音样本')

  const limits = UPLOAD_LIMITS.voice_sample
  const meta = validateUploadFile(input.filename, input.size, input.head.subarray(0, MAGIC_HEAD_BYTES), {
    allowedExts: [...limits.exts],
    maxBytes: limits.maxBytes,
  })

  // ffprobe 校验（时长 5–180 秒、有音频流）
  const probe = await probeMedia(input.filePath)
  const quality = checkVoiceSampleQuality(probe, {
    minDurationMs: limits.minDurationMs,
    maxDurationMs: limits.maxDurationMs,
  })
  if (!quality.pass) {
    throw err.assetQualityFailed(quality.hard.map((h) => h.message).join('；'), { issues: quality.hard })
  }

  await ensureTempDir()
  const mp3 = await normalizeAudioToMp3(input.filePath, `${newId('vs')}_norm.mp3`)
  const mp3Probe = await probeMedia(mp3)
  const sha256 = await sha256File(mp3)

  const id = newId('pvs')
  const sampleKey = `persona/${input.personaId}/voice_sample/${id}.mp3`
  const shortRef = await uniqueShortRef('persona_voice', id)
  const now = toDb(utcNow())
  try {
    await putObjectFromFile(mp3, sampleKey, '')
    await db.run(
      `INSERT INTO \`persona_voice\`
        (\`id\`, \`persona_id\`, \`name\`, \`is_sample\`, \`provider\`, \`voice_type\`, \`language\`,
         \`sample_key\`, \`sample_sha256\`, \`sample_duration_ms\`, \`vendor_title\`, \`short_ref\`,
         \`status\`, \`created_by\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, 1, 'hifly', 8, 'zh', ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      [
        id,
        input.personaId,
        path.parse(input.filename).name || '声音样本',
        sampleKey,
        sha256,
        mp3Probe.durationMs ?? probe.durationMs ?? 0,
        '样本',
        shortRef,
        input.operator,
        now,
        now,
      ],
    )
  } finally {
    await cleanup([mp3])
  }
  await recordOperation({
    operator: input.operator,
    action: 'persona.voice_sample_upload',
    targetType: 'persona',
    targetId: input.personaId,
    detail: { sampleId: id, filename: input.filename, durationMs: mp3Probe.durationMs, sha256 },
  })
  return (await getVoiceById(id))!
}

/* ── 发起克隆（FR-V2 / FR-V3）──────────────────────────────────── */

/** 每人有效声音上限（FR-V3） */
const MAX_VOICES_PER_PERSONA = 5

export interface CreateVoiceInput {
  personaId: string
  name?: string
  sampleId: string
  consentId: string
  language?: string
  /** 幂等键（请求头 Idempotency-Key，必填） */
  idempotencyKey: string
  operator: string
}

function voiceRequestHashOf(input: { personaId: string; name: string; sampleId: string; consentId: string; language: string }): string {
  const normalized = JSON.stringify({
    personaId: input.personaId,
    name: input.name,
    sampleId: input.sampleId,
    consentId: input.consentId,
    language: input.language,
  })
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

const VOICE_IN_PROGRESS: VoiceStatus[] = ['pending', 'submitting', 'running']

export async function createVoice(input: CreateVoiceInput): Promise<{ voice: PersonaVoice; replayed: boolean }> {
  const db = getDb()
  const idemKey = String(input.idempotencyKey ?? '').trim()
  if (!idemKey) throw err.badRequest('缺少 Idempotency-Key 请求头（幂等键必填）')
  if (idemKey.length > 64) throw err.badRequest('Idempotency-Key 过长（≤64 字符）')

  const persona = await getPersonaById(input.personaId, true)
  if (!persona) throw err.personaNotFound()
  if (persona.archivedAt) throw err.personaArchived()
  const rule = LINE_RULES[persona.line]
  if (!rule.voiceAllowed) throw err.lineNotAllowed('素人矩阵不提供声音克隆')

  // 样本必须存在且属于该人物
  const sample = await getVoiceById(input.sampleId, true)
  if (!sample || sample.personaId !== input.personaId || !sample.isSample) {
    throw err.notFound('声音样本不存在')
  }
  if (sample.deletedAt) throw err.invalidState('声音样本已删除')

  // consent 五元组校验（R12）
  const consent = await assertConsentValid({
    consentId: input.consentId,
    purpose: 'VOICE_CLONE',
    sourceKind: 'voice_sample',
    sourceId: sample.id,
    sourceSha256: sample.sampleSha256,
  })
  const auths = await validAuthorizationsOf(input.personaId)
  if (!auths.some((a) => a.id === consent.authorizationId && a.scopes.includes('voice'))) {
    throw err.authorizationRequired('该授权当前不可用或范围不含「声音」', { authorizationId: consent.authorizationId })
  }

  // 语种白名单（R14：普通话默认，不进 hash）
  const language = String(input.language ?? 'zh').trim() || 'zh'
  if (!VOICE_LANGUAGES.some((l) => l.code === language)) {
    throw err.badRequest(`不支持的语种：${language}`, { allowed: VOICE_LANGUAGES.map((l) => l.code) })
  }

  const name = String(input.name ?? '').trim() || `${persona.name} · 声音`
  if (name.length > 60) throw err.badRequest('声音名称不能超过 60 字')

  const requestHash = voiceRequestHashOf({
    personaId: input.personaId,
    name,
    sampleId: sample.id,
    consentId: consent.id,
    language,
  })

  // 幂等（R14）：同键同参返回原记录；同键异参 409
  const existing = await db.get<Record<string, any>>(
    'SELECT * FROM `persona_voice` WHERE `idempotency_key` = ? AND `is_sample` = 0',
    [idemKey],
  )
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw err.idempotencyConflict('同一 Idempotency-Key 的请求参数不一致', { idempotencyKey: idemKey })
    }
    return { voice: mapVoiceRow(existing), replayed: true }
  }

  // 数量上限：≤5 条有效声音（失败不计入）
  const liveCount =
    (await db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM `persona_voice` WHERE `persona_id` = ? AND `is_sample` = 0 AND `deleted_at` IS NULL AND `status` != ?',
      [input.personaId, 'failed'],
    ))?.c ?? 0
  if (liveCount >= MAX_VOICES_PER_PERSONA) {
    throw err.assetLimit(`每人最多 ${MAX_VOICES_PER_PERSONA} 条有效声音，请先删除失效声音`, {
      max: MAX_VOICES_PER_PERSONA,
    })
  }

  const id = newId('pvc')
  const shortRef = await uniqueShortRef('persona_voice', id)
  const now = toDb(utcNow())
  try {
    await db.run(
      `INSERT INTO \`persona_voice\`
        (\`id\`, \`persona_id\`, \`name\`, \`is_sample\`, \`provider\`, \`voice_type\`, \`language\`,
         \`sample_key\`, \`sample_sha256\`, \`sample_duration_ms\`, \`vendor_title\`, \`short_ref\`,
         \`status\`, \`consent_id\`, \`authorization_id\`, \`idempotency_key\`, \`request_hash\`,
         \`created_by\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, 0, 'hifly', 8, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.personaId,
        name,
        language,
        sample.sampleKey,
        sample.sampleSha256,
        sample.sampleDurationMs ?? 0,
        buildVendorTitle(name, shortRef),
        shortRef,
        consent.id,
        consent.authorizationId,
        idemKey,
        requestHash,
        input.operator,
        now,
        now,
      ],
    )
  } catch (e) {
    if (isDuplicateKey(e)) {
      const dup = await db.get<Record<string, any>>(
        'SELECT * FROM `persona_voice` WHERE `idempotency_key` = ? AND `is_sample` = 0',
        [idemKey],
      )
      if (dup) {
        if (dup.request_hash !== requestHash) throw err.idempotencyConflict('同一 Idempotency-Key 的请求参数不一致')
        return { voice: mapVoiceRow(dup), replayed: true }
      }
    }
    throw e
  }

  await recordOperation({
    operator: input.operator,
    action: 'persona.voice_create',
    targetType: 'persona',
    targetId: input.personaId,
    detail: { voiceId: id, name, sampleId: sample.id, consentId: consent.id, language, shortRef },
  })

  await enqueue(
    QUEUE_NAMES.personaClone,
    'voice_submit',
    { kind: 'voice', recordId: id },
    dedupOpts(`voice-submit-${id}`),
  ).catch((e) => {
    logger.error({ voiceId: id, err: (e as Error).message }, 'persona.clone.enqueue_failed')
  })

  return { voice: (await getVoiceById(id))!, replayed: false }
}

/* ── 试听确认（FR-V5）──────────────────────────────────────────── */

export async function confirmVoice(id: string, operator: string): Promise<PersonaVoice> {
  const db = getDb()
  const voice = await getVoiceById(id)
  if (!voice) throw err.notFound('声音不存在')
  if (voice.isSample) throw err.badRequest('声音样本无需确认')
  if (voice.deletedAt) throw err.invalidState('声音已删除')
  if (voice.status !== 'ready') {
    throw err.cloneNotReady(`声音尚未克隆完成（${VOICE_STATUS_LABELS[voice.status]}），不能确认`)
  }
  if (voice.confirmed) return voice
  // 确认时复核授权与 consent 仍有效（FR-V5）
  if (!voice.consentId) throw err.consentMismatch('缺少授权确认记录，不能确认')
  const consent = await getConsentById(voice.consentId)
  if (!consent) throw err.consentMismatch('授权确认记录不存在')
  const sample = await getVoiceById(consent.sourceId, true)
  if (!sample) throw err.consentMismatch('授权确认绑定的声音样本不存在')
  await assertConsentValid({
    consentId: voice.consentId,
    purpose: 'VOICE_CLONE',
    sourceKind: 'voice_sample',
    sourceId: consent.sourceId,
    sourceSha256: sample.sampleSha256,
  })
  const now = toDb(utcNow())
  await db.run(
    'UPDATE `persona_voice` SET `confirmed` = 1, `confirmed_by` = ?, `confirmed_at` = ?, `updated_at` = ? WHERE `id` = ?',
    [operator, now, now, id],
  )
  await recordOperation({
    operator,
    action: 'persona.voice_confirm',
    targetType: 'persona',
    targetId: voice.personaId,
    detail: { voiceId: id },
  })
  return (await getVoiceById(id))!
}

/* ── 参数（FR-V6 / R17）────────────────────────────────────────── */

export interface VoiceSettings {
  speechRate: number
  volume: number
  pitch: number
}

const SETTING_RANGES: Record<keyof VoiceSettings, { min: number; max: number; label: string }> = {
  speechRate: { min: 0.5, max: 2.0, label: '语速' },
  volume: { min: 0.1, max: 2.0, label: '音量' },
  pitch: { min: 0.1, max: 2.0, label: '音调' },
}

function validateSettings(input: VoiceSettings): VoiceSettings {
  const out = {} as VoiceSettings
  for (const key of Object.keys(SETTING_RANGES) as Array<keyof VoiceSettings>) {
    const raw = Number(input[key])
    const range = SETTING_RANGES[key]
    if (!Number.isFinite(raw)) throw err.badRequest(`${range.label}必须是数字`)
    // 最多一位小数
    if (Math.round(raw * 10) !== raw * 10) throw err.badRequest(`${range.label}最多一位小数`)
    const v = Math.round(raw * 10) / 10
    if (v < range.min || v > range.max) {
      throw err.badRequest(`${range.label}需在 ${range.min}–${range.max} 之间`, { field: key, received: raw })
    }
    out[key] = v
  }
  return out
}

/**
 * 三段式（R17）：先调飞影 voice/edit，成功后落库并产生人物版本；
 * 飞影失败则本地不变并提示原因。调用方传入已解析的客户端（worker / 路由共用）。
 */
export async function updateVoiceSettings(
  id: string,
  input: Partial<VoiceSettings>,
  operator: string,
  editVendor: (voiceId: string, settings: VoiceSettings) => Promise<void>,
): Promise<PersonaVoice> {
  const db = getDb()
  const voice = await getVoiceById(id)
  if (!voice) throw err.notFound('声音不存在')
  if (voice.isSample) throw err.badRequest('声音样本不支持参数调整')
  if (voice.deletedAt) throw err.invalidState('声音已删除')
  if (voice.status !== 'ready' || !voice.vendorVoiceId) {
    throw err.cloneNotReady(`声音尚未就绪（${VOICE_STATUS_LABELS[voice.status]}），不能调整参数`)
  }
  const merged = validateSettings({
    speechRate: input.speechRate ?? voice.speechRate,
    volume: input.volume ?? voice.volume,
    pitch: input.pitch ?? voice.pitch,
  })
  const changed =
    merged.speechRate !== voice.speechRate || merged.volume !== voice.volume || merged.pitch !== voice.pitch
  if (!changed) return voice

  // ① 先调飞影（事务外）；失败则本地不变
  await editVendor(voice.vendorVoiceId, merged)

  // ② 落库
  const now = toDb(utcNow())
  await db.run(
    'UPDATE `persona_voice` SET `speech_rate` = ?, `volume` = ?, `pitch` = ?, `updated_at` = ? WHERE `id` = ?',
    [merged.speechRate, merged.volume, merged.pitch, now, id],
  )
  await recordOperation({
    operator,
    action: 'persona.voice_settings',
    targetType: 'persona',
    targetId: voice.personaId,
    detail: { voiceId: id, ...merged },
  })
  // ③ 声音参数变化 → 人物版本（L7）
  const persona = await getPersonaById(voice.personaId, true)
  if (persona) await ensurePersonaVersion(persona, 'voice_settings', operator)
  return (await getVoiceById(id))!
}

/* ── 默认与删除（FR-V8 / FR-V9）────────────────────────────────── */

export async function setDefaultVoice(id: string, operator: string): Promise<PersonaVoice> {
  const db = getDb()
  const voice = await getVoiceById(id)
  if (!voice) throw err.notFound('声音不存在')
  if (voice.isSample) throw err.badRequest('声音样本不能设为默认')
  if (voice.deletedAt) throw err.invalidState('声音已删除')
  if (voice.status !== 'ready' || !voice.confirmed) {
    throw err.cloneNotReady(
      voice.status !== 'ready' ? `声音尚未就绪（${VOICE_STATUS_LABELS[voice.status]}）` : '声音尚未试听确认，不能设为默认',
    )
  }
  const persona = await getPersonaById(voice.personaId, true)
  if (!persona) throw err.personaNotFound()
  // 授权有效（肖像 / 声音范围）
  const auths = await validAuthorizationsOf(voice.personaId)
  const auth = auths.find((a) => a.id === voice.authorizationId)
  if (!auth || !auth.scopes.includes('voice')) {
    throw err.authorizationRequired('该声音的授权已失效，不能设为默认', { authorizationId: voice.authorizationId })
  }
  // FR-V9：共享人物的声音用于多个账号须「允许共享」授权
  if (persona.bindingMode === 'shared' && !auth.scopes.includes('share')) {
    throw err.authorizationRequired('声音共享须单独核验授权（范围含「允许共享」）', {
      authorizationId: auth.id,
      scopes: auth.scopes,
    })
  }
  await db.run('UPDATE `persona` SET `default_voice_id` = ?, `updated_at` = ?, `updated_by` = ? WHERE `id` = ?', [
    id,
    toDb(utcNow()),
    operator,
    voice.personaId,
  ])
  await recordOperation({
    operator,
    action: 'persona.voice_set_default',
    targetType: 'persona',
    targetId: voice.personaId,
    detail: { voiceId: id },
  })
  // 默认声音变化 → 人物版本（L7）
  await ensurePersonaVersion(persona, 'default_asset', operator)
  return (await getVoiceById(id))!
}

/**
 * 重命名（R18）：只改本地显示名，不动厂商侧与短引用。
 * 样本与克隆声音均可重命名；已删除的拒绝。
 */
export async function patchVoice(id: string, patch: { name?: string }, operator: string): Promise<PersonaVoice> {
  const db = getDb()
  const voice = await getVoiceById(id, true)
  if (!voice) throw err.notFound('声音不存在')
  if (voice.deletedAt) throw err.invalidState('声音已删除')
  if (patch.name === undefined) return voice
  const name = String(patch.name).trim()
  if (!name) throw err.badRequest('名称不能为空')
  if (name.length > 60) throw err.badRequest('声音名称不能超过 60 字')
  if (name === voice.name) return voice
  await db.run('UPDATE `persona_voice` SET `name` = ?, `updated_at` = ? WHERE `id` = ?', [name, toDb(utcNow()), id])
  await recordOperation({
    operator,
    action: voice.isSample ? 'persona.voice_sample_rename' : 'persona.voice_rename',
    targetType: 'persona',
    targetId: voice.personaId,
    detail: { voiceId: id, name },
  })
  return (await getVoiceById(id, true))!
}

export async function softDeleteVoice(id: string, operator: string): Promise<void> {
  const db = getDb()
  const voice = await getVoiceById(id, true)
  if (!voice) throw err.notFound('声音不存在')
  if (voice.deletedAt) return // 幂等
  if (VOICE_IN_PROGRESS.includes(voice.status) || voice.status === 'uncertain') {
    throw err.invalidState(
      voice.status === 'uncertain' ? '状态待核对，不能删除（请先核对）' : '声音克隆中，不能删除',
      { status: voice.status },
    )
  }
  const persona = await getPersonaById(voice.personaId, true)
  if (persona?.defaultVoiceId === id) {
    throw err.invalidState('该声音是默认声音，请先设置其他默认声音')
  }
  const now = toDb(utcNow())
  await db.run('UPDATE `persona_voice` SET `deleted_at` = ?, `deleted_by` = ?, `updated_at` = ? WHERE `id` = ?', [
    now,
    operator,
    now,
    id,
  ])
  await recordOperation({
    operator,
    action: voice.isSample ? 'persona.voice_sample_delete' : 'persona.voice_delete',
    targetType: 'persona',
    targetId: voice.personaId,
    detail: { voiceId: id, name: voice.name },
  })
}

/* ── 任意文本试听（FR-V7）──────────────────────────────────────── */

/** 试听文本上限（FR-V7：≤100 字） */
const MAX_PREVIEW_CHARS = 100
/** 缓存有效期（7 天） */
const PREVIEW_TTL_MS = 7 * 86_400_000

export interface VoicePreview {
  id: string
  voiceId: string
  paramsHash: string
  textHash: string
  vendorTaskId: string | null
  status: 'running' | 'ready' | 'failed'
  audioKey: string | null
  error: string | null
  createdAt: string | null
  expiresAt: string | null
}

function mapPreviewRow(r: Record<string, any>): VoicePreview {
  return {
    id: r.id,
    voiceId: r.voice_id,
    paramsHash: r.params_hash,
    textHash: r.text_hash,
    vendorTaskId: r.vendor_task_id ?? null,
    status: r.status,
    audioKey: r.audio_key ?? null,
    error: r.error ?? null,
    createdAt: fromDb(r.created_at),
    expiresAt: fromDb(r.expires_at),
  }
}

export async function getVoicePreview(id: string): Promise<VoicePreview | null> {
  const r = await getDb().get<Record<string, any>>('SELECT * FROM `persona_voice_preview` WHERE `id` = ?', [id])
  return r ? mapPreviewRow(r) : null
}

/**
 * 发起任意文本试听：同参数同文本命中缓存不再调用飞影（FR-V7）。
 * 返回 { preview, cached }；未命中时入队 persona-clone 的 preview 任务。
 */
export async function createVoicePreview(
  voiceId: string,
  text: string,
  operator: string,
): Promise<{ preview: VoicePreview; cached: boolean }> {
  const db = getDb()
  const voice = await getVoiceById(voiceId)
  if (!voice) throw err.notFound('声音不存在')
  if (voice.isSample) throw err.badRequest('声音样本不能试听')
  if (voice.deletedAt) throw err.invalidState('声音已删除')
  if (voice.status !== 'ready' || !voice.vendorVoiceId) {
    throw err.cloneNotReady(`声音尚未就绪（${VOICE_STATUS_LABELS[voice.status]}），不能试听`)
  }
  const cleanText = String(text ?? '').trim()
  if (!cleanText) throw err.badRequest('试听文本不能为空')
  if (cleanText.length > MAX_PREVIEW_CHARS) {
    throw err.badRequest(`试听文本不超过 ${MAX_PREVIEW_CHARS} 字`, { length: cleanText.length })
  }
  const paramsHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ speechRate: voice.speechRate, volume: voice.volume, pitch: voice.pitch }))
    .digest('hex')
  const textHash = crypto.createHash('sha256').update(cleanText).digest('hex')

  // 缓存命中（未过期）
  const hit = await db.get<Record<string, any>>(
    'SELECT * FROM `persona_voice_preview` WHERE `voice_id` = ? AND `params_hash` = ? AND `text_hash` = ?',
    [voiceId, paramsHash, textHash],
  )
  if (hit) {
    const preview = mapPreviewRow(hit)
    const expired = preview.expiresAt ? new Date(preview.expiresAt).getTime() <= Date.now() : false
    if (!expired && (preview.status === 'ready' || preview.status === 'running')) {
      return { preview, cached: true }
    }
  }

  const id = newId('pvp')
  const now = new Date()
  const expires = new Date(now.getTime() + PREVIEW_TTL_MS)
  // 同（声音 + 参数 + 文本）唯一：重试 / 复发时重置为 running（幂等）
  await upsert(getDb(), {
    table: 'persona_voice_preview',
    row: {
      id,
      voice_id: voiceId,
      params_hash: paramsHash,
      text_hash: textHash,
      text: cleanText,
      status: 'running',
      attempts: 0,
      created_at: toDb(now),
      expires_at: toDb(expires),
    },
    uniqueCols: ['voice_id', 'params_hash', 'text_hash'],
    updateCols: ['status', 'vendor_task_id', 'audio_key', 'error', 'attempts', 'expires_at'],
  })
  await recordOperation({
    operator,
    action: 'persona.voice_preview_create',
    targetType: 'persona',
    targetId: voice.personaId,
    detail: { previewId: id, voiceId, textLength: cleanText.length },
  })
  await enqueue(
    QUEUE_NAMES.personaClone,
    'preview_submit',
    { kind: 'preview', recordId: id },
    dedupOpts(`preview-submit-${id}`),
  ).catch((e) => {
    logger.error({ previewId: id, err: (e as Error).message }, 'persona.clone.enqueue_failed')
  })
  return { preview: (await getVoicePreview(id))!, cached: false }
}

/** 试听音频的流式读取目标（经后端代理） */
export function previewAudioTarget(preview: VoicePreview): { storageKey: string; filename: string } {
  if (!preview.audioKey) throw err.notFound('试听音频尚未生成')
  return { storageKey: preview.audioKey, filename: `试听_${preview.id}.mp3` }
}

/** 试听缓存清理（过期行，worker 周期调用） */
export async function cleanExpiredPreviews(): Promise<number> {
  // P2-7：连同存储里的试听音频一起删除，否则过期记录删了文件还留着
  const db = getDb()
  const now = toDb(utcNow())
  const rows = await db.all<{ id: string; audio_key: string | null }>(
    'SELECT `id`, `audio_key` FROM `persona_voice_preview` WHERE `expires_at` < ? LIMIT 500',
    [now],
  )
  for (const r of rows) {
    if (r.audio_key) await deleteObject(r.audio_key)
    await db.run('DELETE FROM `persona_voice_preview` WHERE `id` = ?', [r.id])
  }
  return rows.length
}
