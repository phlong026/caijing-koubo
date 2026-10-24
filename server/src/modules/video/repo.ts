import { getDb, type Db } from '../../db/index.js'
import { newId, jdec, jenc } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import type {
  ConfigSnapshot,
  MaterialReplacement,
  TextSnapshot,
  TimelineItem,
  TimelineSource,
  VideoPhase,
} from './types.js'

/**
 * video_job 行读写与 CAS 迁移（§3.1：所有阶段迁移 UPDATE … WHERE id=? AND phase=?，
 * 涉及飞影结果的再加 AND remote_task_id=?；失败即放弃本次推进，防 sweep 与 worker 双写）。
 */

export interface VideoJob {
  id: string
  copyId: string
  copyVersionId: string
  copyVersionNo: number
  versionNo: number
  personaId: string
  personaVersionId: string | null
  line: string | null
  mode: 'avatar' | 'mixcut'
  genMode: 'tts' | 'audio' | null
  provider: string
  phase: VideoPhase
  progressFloor: number
  statusMessage: string | null
  errorCode: string | null
  errorDetail: string | null
  configSnapshot: ConfigSnapshot | null
  textSnapshot: TextSnapshot | null
  textHash: string | null
  avatarId: string | null
  voiceId: string | null
  vendorTitle: string | null
  shortRef: string | null
  remoteTaskId: string | null
  remoteResultUrl: string | null
  remoteDurationSec: number | null
  submitAttempts: number
  submittedAt: string | null
  nextPollAt: string | null
  pollFailures: number
  expectedGenSeconds: number | null
  ttsAudioId: string | null
  timeline: TimelineItem[] | null
  timelineSource: TimelineSource | null
  alignScore: number | null
  replacements: MaterialReplacement[] | null
  resultKey: string | null
  coverKey: string | null
  durationMs: number
  width: number
  height: number
  sizeBytes: number
  isMock: number
  creditsEstimated: number
  idempotencyKey: string | null
  requestHash: string | null
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string | null
  archivedAt: string | null
}

export function mapVideoJob(row: Record<string, any>): VideoJob {
  return {
    id: row.id,
    copyId: row.copy_id,
    copyVersionId: row.copy_version_id,
    copyVersionNo: Number(row.copy_version_no ?? 0),
    versionNo: Number(row.version_no ?? 0),
    personaId: row.persona_id,
    personaVersionId: row.persona_version_id ?? null,
    line: row.line ?? null,
    mode: row.mode,
    genMode: row.gen_mode ?? null,
    provider: row.provider,
    phase: row.phase,
    progressFloor: Number(row.progress_floor ?? 0),
    statusMessage: row.status_message ?? null,
    errorCode: row.error_code ?? null,
    errorDetail: row.error_detail ?? null,
    configSnapshot: jdec<ConfigSnapshot | null>(row.config_snapshot, null),
    textSnapshot: jdec<TextSnapshot | null>(row.text_snapshot, null),
    textHash: row.text_hash ?? null,
    avatarId: row.avatar_id ?? null,
    voiceId: row.voice_id ?? null,
    vendorTitle: row.vendor_title ?? null,
    shortRef: row.short_ref ?? null,
    remoteTaskId: row.remote_task_id ?? null,
    remoteResultUrl: row.remote_result_url ?? null,
    remoteDurationSec: row.remote_duration_sec == null ? null : Number(row.remote_duration_sec),
    submitAttempts: Number(row.submit_attempts ?? 0),
    submittedAt: row.submitted_at ?? null,
    nextPollAt: row.next_poll_at ?? null,
    pollFailures: Number(row.poll_failures ?? 0),
    expectedGenSeconds: row.expected_gen_seconds == null ? null : Number(row.expected_gen_seconds),
    ttsAudioId: row.tts_audio_id ?? null,
    timeline: jdec<TimelineItem[] | null>(row.timeline, null),
    timelineSource: (row.timeline_source ?? null) as TimelineSource | null,
    alignScore: row.align_score == null ? null : Number(row.align_score),
    replacements: jdec<MaterialReplacement[] | null>(row.replacements, null),
    resultKey: row.result_key ?? null,
    coverKey: row.cover_key ?? null,
    durationMs: Number(row.duration_ms ?? 0),
    width: Number(row.width ?? 0),
    height: Number(row.height ?? 0),
    sizeBytes: Number(row.size_bytes ?? 0),
    isMock: Number(row.is_mock ?? 0),
    creditsEstimated: Number(row.credits_estimated ?? 0),
    idempotencyKey: row.idempotency_key ?? null,
    requestHash: row.request_hash ?? null,
    queuedAt: row.queued_at ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
    archivedAt: row.archived_at ?? null,
  }
}

export async function getVideoJob(id: string, db: Db = getDb()): Promise<VideoJob | null> {
  const row = await db.get('SELECT * FROM `video_job` WHERE `id` = ?', [id])
  return row ? mapVideoJob(row) : null
}

export interface VideoJobListFilter {
  copyId?: string
  personaId?: string
  phase?: string
  ids?: string[]
  includeArchived?: boolean
  page?: number
  pageSize?: number
}

export async function listVideoJobs(filter: VideoJobListFilter, db: Db = getDb()) {
  const where: string[] = []
  const params: unknown[] = []
  if (!filter.includeArchived) where.push('`archived_at` IS NULL')
  if (filter.copyId) {
    where.push('`copy_id` = ?')
    params.push(filter.copyId)
  }
  if (filter.personaId) {
    where.push('`persona_id` = ?')
    params.push(filter.personaId)
  }
  if (filter.phase) {
    where.push('`phase` = ?')
    params.push(filter.phase)
  }
  if (filter.ids?.length) {
    where.push(`\`id\` IN (${filter.ids.map(() => '?').join(',')})`)
    params.push(...filter.ids)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const page = Math.max(1, filter.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20))
  const total = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM \`video_job\` ${whereSql}`, params)
  const rows = await db.all(
    `SELECT * FROM \`video_job\` ${whereSql} ORDER BY \`created_at\` DESC, \`version_no\` DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  )
  return { items: rows.map(mapVideoJob), total: Number(total?.n ?? 0), page, pageSize }
}

/** 新建任务行（须在创建事务内调用；phase 从 waiting 起步） */
export async function insertVideoJob(
  db: Db,
  row: Omit<VideoJob, 'createdAt'> & { createdAt?: string },
): Promise<void> {
  const now = toDb(utcNow())
  const r = { ...row, createdAt: row.createdAt ?? now }
  const cols: Record<string, unknown> = {
    id: r.id,
    copy_id: r.copyId,
    copy_version_id: r.copyVersionId,
    copy_version_no: r.copyVersionNo,
    version_no: r.versionNo,
    persona_id: r.personaId,
    persona_version_id: r.personaVersionId,
    line: r.line,
    mode: r.mode,
    gen_mode: r.genMode,
    provider: r.provider,
    phase: r.phase,
    progress_floor: r.progressFloor,
    status_message: r.statusMessage,
    error_code: r.errorCode,
    error_detail: r.errorDetail,
    config_snapshot: jenc(r.configSnapshot),
    text_snapshot: jenc(r.textSnapshot),
    text_hash: r.textHash,
    avatar_id: r.avatarId,
    voice_id: r.voiceId,
    vendor_title: r.vendorTitle,
    short_ref: r.shortRef,
    remote_task_id: r.remoteTaskId,
    remote_result_url: r.remoteResultUrl,
    remote_duration_sec: r.remoteDurationSec,
    submit_attempts: r.submitAttempts,
    submitted_at: r.submittedAt,
    next_poll_at: r.nextPollAt,
    poll_failures: r.pollFailures,
    expected_gen_seconds: r.expectedGenSeconds,
    tts_audio_id: r.ttsAudioId,
    timeline: jenc(r.timeline),
    timeline_source: r.timelineSource,
    align_score: r.alignScore,
    replacements: jenc(r.replacements),
    result_key: r.resultKey,
    cover_key: r.coverKey,
    duration_ms: r.durationMs,
    width: r.width,
    height: r.height,
    size_bytes: r.sizeBytes,
    is_mock: r.isMock,
    credits_estimated: r.creditsEstimated,
    idempotency_key: r.idempotencyKey,
    request_hash: r.requestHash,
    queued_at: r.queuedAt,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    created_by: r.createdBy,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    archived_at: r.archivedAt,
  }
  const keys = Object.keys(cols)
  await db.run(
    `INSERT INTO \`video_job\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => cols[k]),
  )
}

export interface PhaseTransitionSets {
  statusMessage?: string | null
  errorCode?: string | null
  errorDetail?: string | null
  remoteTaskId?: string | null
  remoteResultUrl?: string | null
  remoteDurationSec?: number | null
  submitAttempts?: number
  submittedAt?: string | null
  nextPollAt?: string | null
  pollFailures?: number
  expectedGenSeconds?: number | null
  progressFloor?: number
  timeline?: TimelineItem[] | null
  timelineSource?: TimelineSource | null
  alignScore?: number | null
  replacements?: MaterialReplacement[] | null
  resultKey?: string | null
  coverKey?: string | null
  durationMs?: number
  width?: number
  height?: number
  sizeBytes?: number
  isMock?: number
  creditsEstimated?: number
  startedAt?: string | null
  finishedAt?: string | null
  queuedAt?: string | null
  archivedAt?: string | null
  ttsAudioId?: string | null
  avatarId?: string | null
  voiceId?: string | null
}

function setsToSql(sets: PhaseTransitionSets): { sql: string; params: unknown[] } {
  const colMap: Record<keyof PhaseTransitionSets, string> = {
    statusMessage: 'status_message',
    errorCode: 'error_code',
    errorDetail: 'error_detail',
    remoteTaskId: 'remote_task_id',
    remoteResultUrl: 'remote_result_url',
    remoteDurationSec: 'remote_duration_sec',
    submitAttempts: 'submit_attempts',
    submittedAt: 'submitted_at',
    nextPollAt: 'next_poll_at',
    pollFailures: 'poll_failures',
    expectedGenSeconds: 'expected_gen_seconds',
    progressFloor: 'progress_floor',
    timeline: 'timeline',
    timelineSource: 'timeline_source',
    alignScore: 'align_score',
    replacements: 'replacements',
    resultKey: 'result_key',
    coverKey: 'cover_key',
    durationMs: 'duration_ms',
    width: 'width',
    height: 'height',
    sizeBytes: 'size_bytes',
    isMock: 'is_mock',
    creditsEstimated: 'credits_estimated',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    queuedAt: 'queued_at',
    archivedAt: 'archived_at',
    ttsAudioId: 'tts_audio_id',
    avatarId: 'avatar_id',
    voiceId: 'voice_id',
  }
  const jsonCols = new Set(['timeline', 'replacements'])
  const parts: string[] = []
  const params: unknown[] = []
  for (const [k, v] of Object.entries(sets)) {
    const col = colMap[k as keyof PhaseTransitionSets]
    if (!col) continue
    parts.push(`\`${col}\` = ?`)
    params.push(jsonCols.has(col) ? jenc(v) : v)
  }
  parts.push('`updated_at` = ?')
  params.push(toDb(utcNow()))
  return { sql: parts.join(', '), params }
}

/**
 * 阶段 CAS 迁移：期望旧阶段（及可选的远端任务号）必须匹配，影响行数 ≠1 视为并发竞争失败。
 */
export async function casTransition(
  db: Db,
  jobId: string,
  fromPhase: VideoPhase | VideoPhase[],
  toPhase: VideoPhase,
  sets: PhaseTransitionSets = {},
  opts: { expectRemoteTaskId?: string } = {},
): Promise<boolean> {
  const phases = Array.isArray(fromPhase) ? fromPhase : [fromPhase]
  const where = [`\`id\` = ?`, `\`phase\` IN (${phases.map(() => '?').join(',')})`]
  const params: unknown[] = [jobId, ...phases]
  if (opts.expectRemoteTaskId) {
    where.push('`remote_task_id` = ?')
    params.push(opts.expectRemoteTaskId)
  }
  const { sql, params: setParams } = setsToSql(sets)
  // phase 本身也是 SET 的一部分（期望旧阶段在 WHERE 中保证 CAS 语义）
  const res = await db.run(
    `UPDATE \`video_job\` SET \`phase\` = ?, ${sql} WHERE ${where.join(' AND ')}`,
    [toPhase, ...setParams, ...params],
  )
  return res.affectedRows === 1
}

export interface JobEventInput {
  jobId: string
  fromPhase?: VideoPhase | null
  toPhase: VideoPhase
  errorCode?: string | null
  detail?: unknown
  operator?: string | null
}

/** 阶段流水（FR-P8）：每次迁移一条，detail 存排障信息（ASR 原始结果等） */
export async function appendJobEvent(input: JobEventInput, db: Db = getDb()): Promise<void> {
  await db.run(
    'INSERT INTO `video_job_event` (`id`, `video_job_id`, `from_phase`, `to_phase`, `error_code`, `detail`, `operator`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      newId('vjevt'),
      input.jobId,
      input.fromPhase ?? null,
      input.toPhase,
      input.errorCode ?? null,
      input.detail == null ? null : jenc(input.detail),
      input.operator ?? 'system',
      toDb(utcNow()),
    ],
  )
}

/** 失败落库（worker 内通用）：CAS 到 failed + 事件 */
export async function markJobFailed(
  jobId: string,
  fromPhase: VideoPhase | VideoPhase[],
  errorCode: string,
  message: string,
  detail?: unknown,
): Promise<boolean> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  const ok = await casTransition(db, jobId, fromPhase, 'failed', {
    errorCode,
    errorDetail: detail == null ? message : JSON.stringify(detail).slice(0, 4000),
    statusMessage: message.slice(0, 200),
    finishedAt: toDb(utcNow()),
  })
  if (ok) {
    await appendJobEvent(
      { jobId, fromPhase: job?.phase ?? null, toPhase: 'failed', errorCode, detail, operator: 'system' },
      db,
    ).catch(() => undefined)
  }
  return ok
}
