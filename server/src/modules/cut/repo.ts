import { createHash } from 'node:crypto'
import { getDb } from '../../db/index.js'
import { newId, jdec, jenc } from '../../lib/util.js'
import { DEFAULT_SUBTITLE_STYLE } from './types.js'
import { toDb, utcNow } from '../../lib/time.js'
import { logger } from '../../log.js'
import type { CutConfigInput, CutSegment, CutStage, CutStatus, SubtitleStyle, VideoCut } from './types.js'
import type { TimelineItem } from '../video/types.js'

/**
 * video_cut 行读写与 CAS 迁移（§3.1：所有状态迁移 UPDATE … WHERE id=? AND status IN (…)，
 * 失败即放弃本次推进，防 sweep 与 worker 双写——同 video_job casTransition 模式）。
 * draft 固定 version_no=0，upsert 语义由 unique(video_job_id, version_no) 保证。
 */

const COLS = `id, video_job_id, version_no, status, render_stage, progress, base_version_no,
  subtitle_enabled, subtitle_style, segments, risk_tail_enabled, risk_tail_text, risk_tail_seconds,
  bgm_enabled, bgm_id, bgm_volume, bgm_fade_in, bgm_fade_out, breathe_enabled, breathe_params, pip_enabled,
  result_key, cover_key, duration_ms, width, height, size_bytes, timeline, cut_text_hash, content_hash,
  review_status, approved_content_hash, is_mock, error_code, error_message, created_by, created_at, updated_at`

function rowToCut(r: Record<string, unknown>): VideoCut {
  return {
    id: String(r.id),
    videoJobId: String(r.video_job_id),
    versionNo: Number(r.version_no),
    status: r.status as CutStatus,
    renderStage: r.render_stage as CutStage,
    progress: Number(r.progress ?? 0),
    baseVersionNo: Number(r.base_version_no ?? 0),
    subtitleEnabled: !!Number(r.subtitle_enabled),
    subtitleStyle: jdec<SubtitleStyle>(r.subtitle_style, { ...DEFAULT_SUBTITLE_STYLE }),
    segments: jdec<CutSegment[]>(r.segments, []),
    riskTailEnabled: !!Number(r.risk_tail_enabled),
    riskTailText: (r.risk_tail_text as string) ?? null,
    riskTailSeconds: Number(r.risk_tail_seconds ?? 5),
    bgmEnabled: !!Number(r.bgm_enabled),
    bgmId: (r.bgm_id as string) ?? null,
    bgmVolume: Number(r.bgm_volume ?? 0.2),
    bgmFadeIn: Number(r.bgm_fade_in ?? 2000),
    bgmFadeOut: Number(r.bgm_fade_out ?? 2000),
    breatheEnabled: !!Number(r.breathe_enabled),
    breatheParams: jdec<{ noiseDb: number; minSilenceMs: number; keepGapMs: number } | null>(r.breathe_params, null),
    resultKey: (r.result_key as string) ?? null,
    coverKey: (r.cover_key as string) ?? null,
    durationMs: Number(r.duration_ms ?? 0),
    width: Number(r.width ?? 0),
    height: Number(r.height ?? 0),
    timeline: jdec<TimelineItem[] | null>(r.timeline, null),
    cutTextHash: (r.cut_text_hash as string) ?? null,
    contentHash: (r.content_hash as string) ?? null,
    reviewStatus: (r.review_status as VideoCut['reviewStatus']) ?? 'none',
    approvedContentHash: (r.approved_content_hash as string) ?? null,
    isMock: !!Number(r.is_mock),
    errorCode: (r.error_code as string) ?? null,
    errorMessage: (r.error_message as string) ?? null,
    createdBy: (r.created_by as string) ?? null,
    createdAt: (r.created_at as string) ?? null,
    updatedAt: (r.updated_at as string) ?? null,
  }
}

export async function getCut(cutId: string): Promise<VideoCut | null> {
  const row = await getDb().get(`SELECT ${COLS} FROM \`video_cut\` WHERE \`id\` = ?`, [cutId])
  return row ? rowToCut(row) : null
}

export async function getCutByJobVersion(videoJobId: string, versionNo: number): Promise<VideoCut | null> {
  const row = await getDb().get(`SELECT ${COLS} FROM \`video_cut\` WHERE \`video_job_id\` = ? AND \`version_no\` = ?`, [
    videoJobId,
    versionNo,
  ])
  return row ? rowToCut(row) : null
}

export async function getDraft(videoJobId: string): Promise<VideoCut | null> {
  return getCutByJobVersion(videoJobId, 0)
}

export async function listVersions(videoJobId: string): Promise<VideoCut[]> {
  const rows = await getDb().all(`SELECT ${COLS} FROM \`video_cut\` WHERE \`video_job_id\` = ? ORDER BY \`version_no\` ASC`, [
    videoJobId,
  ])
  return rows.map(rowToCut)
}

/** copy 下最新过审成片（FR-X2）：join video_job 限定 copy，按 version_no 倒序 */
export async function latestApprovedCutByCopy(copyId: string): Promise<VideoCut | null> {
  const cols = COLS.split(',')
    .map((c) => `c.${c.trim()} AS ${c.trim()}`)
    .join(', ')
  const row = await getDb().get(
    `SELECT ${cols}
     FROM \`video_cut\` c INNER JOIN \`video_job\` j ON j.\`id\` = c.\`video_job_id\`
     WHERE j.\`copy_id\` = ? AND c.\`status\` = 'completed' AND c.\`review_status\` = 'approved'
       AND c.\`content_hash\` = c.\`approved_content_hash\`
     ORDER BY c.\`version_no\` DESC, c.\`created_at\` DESC LIMIT 1`,
    [copyId],
  )
  return row ? rowToCut(row) : null
}

export interface DraftUpsert {
  videoJobId: string
  baseVersionNo: number
  durationMs: number
  width: number
  height: number
  config: Required<Pick<CutConfigInput, 'subtitleEnabled' | 'riskTailEnabled' | 'riskTailSeconds' | 'bgmEnabled' | 'bgmId' | 'bgmVolume' | 'bgmFadeIn' | 'bgmFadeOut' | 'breatheEnabled'>>
  style: SubtitleStyle
  segments: CutSegment[]
  riskTailText: string | null
  breatheParams: { noiseDb: number; minSilenceMs: number; keepGapMs: number } | null
  cutTextHash: string
  contentHash: string
  operator: string
}

/* ── 程序化列构建：列名与参数一一对应，杜绝占位符数量错位 ── */

type CutRowValues = Record<string, string | number | null>

function buildInsert(table: string, values: CutRowValues): { sql: string; params: unknown[] } {
  const cols = Object.keys(values)
  const sql = `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  return { sql, params: cols.map((c) => values[c]!) }
}

function buildUpdate(table: string, values: CutRowValues, where: string, whereParams: unknown[]): { sql: string; params: unknown[] } {
  const cols = Object.keys(values)
  const sql = `UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE ${where}`
  return { sql, params: [...cols.map((c) => values[c]!), ...whereParams] }
}

function rowValuesOf(d: DraftUpsert, extras: CutRowValues): CutRowValues {
  return {
    base_version_no: d.baseVersionNo,
    subtitle_enabled: d.config.subtitleEnabled ? 1 : 0,
    subtitle_style: jenc(d.style),
    segments: jenc(d.segments),
    risk_tail_enabled: d.config.riskTailEnabled ? 1 : 0,
    risk_tail_text: d.riskTailText,
    risk_tail_seconds: d.config.riskTailSeconds,
    bgm_enabled: d.config.bgmEnabled ? 1 : 0,
    bgm_id: d.config.bgmId,
    bgm_volume: d.config.bgmVolume,
    bgm_fade_in: d.config.bgmFadeIn,
    bgm_fade_out: d.config.bgmFadeOut,
    breathe_enabled: d.config.breatheEnabled ? 1 : 0,
    breathe_params: d.breatheParams ? jenc(d.breatheParams) : null,
    pip_enabled: 0,
    duration_ms: d.durationMs,
    width: d.width,
    height: d.height,
    cut_text_hash: d.cutTextHash,
    content_hash: d.contentHash,
    ...extras,
  }
}

/** 草稿 upsert（version_no=0）；被渲染占用历史版本行不受影响 */
export async function upsertDraft(d: DraftUpsert): Promise<VideoCut> {
  const db = getDb()
  const now = toDb(utcNow())
  const existing = await getDraft(d.videoJobId)
  const values = rowValuesOf(d, { updated_at: now })
  if (existing) {
    const { sql, params } = buildUpdate('video_cut', values, '\`id\` = ?', [existing.id])
    await db.run(sql, params)
    return (await getCut(existing.id))!
  }
  const { sql, params } = buildInsert('video_cut', {
    id: newId('vcut'),
    video_job_id: d.videoJobId,
    version_no: 0,
    status: 'draft',
    render_stage: 'idle',
    progress: 0,
    review_status: 'none',
    created_by: d.operator,
    created_at: now,
    ...values,
  })
  await db.run(sql, params)
  return (await getCut((await getDraft(d.videoJobId))!.id))!
}

/** 创建渲染版本：取号（max+1）+ 插入，撞 unique 重试（视频创作 §3.2 模式） */
export async function createVersionFromDraft(draft: VideoCut, operator: string): Promise<VideoCut> {
  const db = getDb()
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db.get('SELECT MAX(\`version_no\`) AS max_no FROM \`video_cut\` WHERE \`video_job_id\` = ?', [draft.videoJobId])
    const nextNo = Math.max(Number(row?.max_no ?? 0), 0) + 1
    const now = toDb(utcNow())
    const values = rowValuesOf(draftToUpsert(draft), {})
    const { sql, params } = buildInsert('video_cut', {
      id: newId('vcut'),
      video_job_id: draft.videoJobId,
      version_no: nextNo,
      status: 'queued',
      render_stage: 'idle',
      progress: 0,
      review_status: 'none',
      created_by: operator,
      created_at: now,
      ...values,
      updated_at: now,
    })
    try {
      await db.run(sql, params)
      return (await getCut(String(params[0]!)))!
    } catch (e) {
      if (attempt === 4) throw e
      logger.info({ videoJobId: draft.videoJobId, attempt }, 'cut.version_no_retry')
    }
  }
  throw new Error('unreachable')
}

/** VideoCut 行复用为 DraftUpsert（版本创建用） */
function draftToUpsert(d: VideoCut): DraftUpsert {
  return {
    videoJobId: d.videoJobId,
    baseVersionNo: d.baseVersionNo,
    durationMs: d.durationMs,
    width: d.width,
    height: d.height,
    config: {
      subtitleEnabled: d.subtitleEnabled,
      riskTailEnabled: d.riskTailEnabled,
      riskTailSeconds: d.riskTailSeconds,
      bgmEnabled: d.bgmEnabled,
      bgmId: d.bgmId,
      bgmVolume: d.bgmVolume,
      bgmFadeIn: d.bgmFadeIn,
      bgmFadeOut: d.bgmFadeOut,
      breatheEnabled: d.breatheEnabled,
    },
    style: d.subtitleStyle,
    segments: d.segments,
    riskTailText: d.riskTailText,
    breatheParams: d.breatheParams,
    cutTextHash: d.cutTextHash ?? '',
    contentHash: d.contentHash ?? '',
    operator: d.createdBy ?? 'system',
  }
}

/** CAS 状态迁移（§3.1）：from 数组任一命中即可；返回是否成功 */
export async function casStatus(
  cutId: string,
  from: CutStatus[],
  to: CutStatus,
  sets: { renderStage?: CutStage; progress?: number; errorCode?: string | null; errorMessage?: string | null } = {},
): Promise<boolean> {
  const clauses = ['`status` = ?']
  const params: unknown[] = [to]
  if (sets.renderStage !== undefined) {
    clauses.push('`render_stage` = ?')
    params.push(sets.renderStage)
  }
  if (sets.progress !== undefined) {
    clauses.push('`progress` = ?')
    params.push(sets.progress)
  }
  if (sets.errorCode !== undefined) {
    clauses.push('`error_code` = ?')
    params.push(sets.errorCode)
  }
  if (sets.errorMessage !== undefined) {
    clauses.push('`error_message` = ?')
    params.push(sets.errorMessage)
  }
  clauses.push('`updated_at` = ?')
  params.push(toDb(utcNow()))
  const where = from.map(() => '`status` = ?').join(' OR ')
  params.push(cutId, ...from)
  const w = await getDb().run(`UPDATE \`video_cut\` SET ${clauses.join(', ')} WHERE \`id\` = ? AND (${where})`, params)
  return Boolean(w.affectedRows)
}

/** 渲染中进度推进（不回退：仅当新值更大时更新；cancelling 不改状态只记 stage） */
export async function advanceProgress(cutId: string, stage: CutStage, progress: number): Promise<void> {
  await getDb().run(
    'UPDATE `video_cut` SET `render_stage` = ?, `progress` = MAX(`progress`, ?), `updated_at` = ? WHERE `id` = ? AND `status` IN (\'rendering\', \'cancelling\')',
    [stage, progress, toDb(utcNow()), cutId],
  )
}

/** 完成落库（§3.4 第 7 步）：rendering / cancelling（取消未及）→ completed */
export async function finishRender(
  cutId: string,
  out: { resultKey: string; coverKey: string | null; durationMs: number; width: number; height: number; sizeBytes: number; timeline: TimelineItem[]; contentHash: string; isMock: boolean },
): Promise<boolean> {
  const w = await getDb().run(
    `UPDATE \`video_cut\` SET \`status\`='completed', \`render_stage\`='idle', \`progress\`=100, \`result_key\`=?, \`cover_key\`=?,
      \`duration_ms\`=?, \`width\`=?, \`height\`=?, \`size_bytes\`=?, \`timeline\`=?, \`content_hash\`=?, \`is_mock\`=?, \`error_code\`=NULL, \`error_message\`=NULL, \`updated_at\`=?
     WHERE \`id\` = ? AND \`status\` IN ('rendering', 'cancelling')`,
    [
      out.resultKey,
      out.coverKey,
      out.durationMs,
      out.width,
      out.height,
      out.sizeBytes,
      jenc(out.timeline),
      out.contentHash,
      out.isMock ? 1 : 0,
      toDb(utcNow()),
      cutId,
    ],
  )
  return Boolean(w.affectedRows)
}

export async function appendEvent(cutId: string, from: CutStatus | null, to: CutStatus, opts: { stage?: CutStage; errorCode?: string | null; detail?: unknown; operator?: string | null } = {}): Promise<void> {
  await getDb().run(
    'INSERT INTO `video_cut_event` (`id`, `cut_id`, `from_status`, `to_status`, `render_stage`, `error_code`, `detail`, `operator`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [newId('vcevt'), cutId, from, to, opts.stage ?? null, opts.errorCode ?? null, opts.detail ? jenc(opts.detail) : null, opts.operator ?? null, toDb(utcNow())],
  )
}

export async function listCutsByStatus(status: CutStatus[], olderThanMs?: number): Promise<VideoCut[]> {
  const where = status.map(() => '`status` = ?').join(' OR ')
  const rows = await getDb().all(`SELECT ${COLS} FROM \`video_cut\` WHERE (${where})`, [...status])
  const cuts = rows.map(rowToCut)
  if (!olderThanMs) return cuts
  const threshold = Date.now() - olderThanMs
  return cuts.filter((c) => !c.updatedAt || new Date(c.updatedAt.replace(' ', 'T') + 'Z').getTime() < threshold)
}

/** 复审过审写回（FR-V2） */
export async function approveReview(cutId: string, contentHash: string): Promise<void> {
  await getDb().run(
    'UPDATE `video_cut` SET `review_status` = \'approved\', `approved_content_hash` = ?, `updated_at` = ? WHERE `id` = ?',
    [contentHash, toDb(utcNow()), cutId],
  )
}

/** FR-V3：过审后草稿 hash 变化 → 重置 review_status（approved_content_hash 保留供对比）。
 * 成片行的 content_hash 冻结于渲染时，实质修改看草稿行（version_no=0）的 content_hash 漂移。 */
export async function resetReviewIfHashDrifted(videoJobId: string): Promise<void> {
  await getDb().run(
    `UPDATE \`video_cut\` SET \`review_status\` = 'none', \`updated_at\` = ?
     WHERE \`video_job_id\` = ? AND \`status\` = 'completed' AND \`review_status\` = 'approved'
       AND \`approved_content_hash\` IS NOT NULL
       AND \`approved_content_hash\` != (SELECT d.\`content_hash\` FROM \`video_cut\` d
                                            WHERE d.\`video_job_id\` = \`video_cut\`.\`video_job_id\` AND d.\`version_no\` = 0)`,
    [toDb(utcNow()), videoJobId],
  )
}

/* ── hash 计算（§3.3）── */

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function computeCutTextHash(segments: CutSegment[]): string {
  return sha256(segments.map((s) => `${s.index}:${s.text}`).join('|'))
}

/** content_hash = base 版本 + 字幕文本 + 尾页文案与时长 + 各开关（开关全关时样式/参数不参与） */
export function computeContentHash(input: {
  baseVersionNo: number
  segments: CutSegment[]
  riskTailEnabled: boolean
  riskTailText: string | null
  riskTailSeconds: number
  subtitleEnabled: boolean
  subtitleStyle: SubtitleStyle
  bgmEnabled: boolean
  bgmId: string | null
  bgmVolume: number
  bgmFadeIn: number
  bgmFadeOut: number
  breatheEnabled: boolean
  breatheParams: { noiseDb: number; minSilenceMs: number; keepGapMs: number } | null
}): string {
  const anyEffect = input.subtitleEnabled || input.bgmEnabled || input.breatheEnabled
  const payload = [
    input.baseVersionNo,
    input.segments.map((s) => `${s.index}:${s.text}`).join('|'),
    input.riskTailEnabled ? `tail:${input.riskTailText ?? ''}:${input.riskTailSeconds}` : 'tail:off',
    ...(anyEffect
      ? [
          input.subtitleEnabled ? `sub:${JSON.stringify(input.subtitleStyle)}` : 'sub:off',
          input.bgmEnabled ? `bgm:${input.bgmId}:${input.bgmVolume}:${input.bgmFadeIn}:${input.bgmFadeOut}` : 'bgm:off',
          input.breatheEnabled ? `breathe:${JSON.stringify(input.breatheParams)}` : 'breathe:off',
        ]
      : ['sub:off', 'bgm:off', 'breathe:off']),
  ].join('§')
  return sha256(payload)
}
