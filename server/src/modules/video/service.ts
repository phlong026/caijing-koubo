import { getDb } from '../../db/index.js'
import { config } from '../../config.js'
import { countWords, estimateSeconds } from '../copy/text.js'
import { getApprovedCopy } from '../copy/review.js'
import { listAssets } from '../personas/assets.js'
import { listVideoJobs, mapVideoJob, getVideoJob, type VideoJob } from './repo.js'
import { computeJobProgress, phaseMessage } from './progress.js'
import { nextActionsOf } from './actions.js'
import { getPersonaBrief, getPersonaProductionProfile, getPersonaReadiness, listPersonaAvatarOptions } from './persona-bridge.js'
import { saveVideoConfig, type CreateVideoJobInput } from './create.js'

/**
 * 任务查询与视图组装（FR-C2 / FR-C3 / FR-X2 / §6.1 context）。
 */

/** GET /video/jobs/:id 详情 */
export async function getJobDetail(jobId: string) {
  const job = await getVideoJob(jobId)
  if (!job) return null
  const db = getDb()
  const events = await db.all(
    'SELECT `id`, `from_phase`, `to_phase`, `error_code`, `detail`, `operator`, `created_at` FROM `video_job_event` WHERE `video_job_id` = ? ORDER BY `created_at` ASC LIMIT 200',
    [jobId],
  )
  return {
    ...toJobSummary(job),
    snapshot: job.configSnapshot,
    textSnapshot: job.textSnapshot
      ? { segments: job.textSnapshot.segments, charCount: job.textSnapshot.charCount, estSeconds: job.textSnapshot.estSeconds, submitText: job.textSnapshot.submitText }
      : null,
    events: events.map((e) => ({
      id: e.id,
      fromPhase: e.from_phase,
      toPhase: e.to_phase,
      errorCode: e.error_code,
      detail: typeof e.detail === 'string' ? safeJson(e.detail) : e.detail,
      operator: e.operator,
      createdAt: e.created_at,
    })),
  }
}

/** FR-X2 任务树节点字段：阶段、进度、状态文案、下一步动作 */
export function toJobSummary(job: VideoJob) {
  return {
    id: job.id,
    copyId: job.copyId,
    copyVersionId: job.copyVersionId,
    copyVersionNo: job.copyVersionNo,
    versionNo: job.versionNo,
    personaId: job.personaId,
    line: job.line,
    mode: job.mode,
    genMode: job.genMode,
    provider: job.provider,
    phase: job.phase,
    progress: computeJobProgress(job),
    message: job.statusMessage ?? phaseMessage(job),
    errorCode: job.errorCode,
    errorDetail: job.errorDetail,
    nextActions: nextActionsOf(job),
    avatarId: job.avatarId,
    voiceId: job.voiceId,
    vendorTitle: job.vendorTitle,
    shortRef: job.shortRef,
    remoteTaskId: job.remoteTaskId,
    timelineSource: job.timelineSource,
    alignScore: job.alignScore,
    timeline: job.timeline,
    replacements: job.replacements,
    resultKey: job.resultKey,
    coverKey: job.coverKey,
    durationMs: job.durationMs,
    width: job.width,
    height: job.height,
    sizeBytes: job.sizeBytes,
    isMock: !!job.isMock,
    creditsEstimated: job.creditsEstimated,
    submitAttempts: job.submitAttempts,
    submittedAt: job.submittedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
    archivedAt: job.archivedAt,
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

/** GET /video/copies/:copyId/context（FR-C1/C2/C3/A2/M1） */
export async function getCopyContext(copyId: string) {
  const ap = await getApprovedCopy(copyId)
  const db = getDb()
  const words = countWords(ap.plainText ?? '')
  const revising = (await db.get<{ status: string }>('SELECT `status` FROM `copy` WHERE `id` = ?', [copyId]))?.status === 'draft'
  const personaId = ap.persona?.id ?? ''

  const persona = personaId ? await getPersonaBrief(personaId) : null
  const purpose = persona?.line === 'persona' ? 'mixcut' : 'avatar_video'
  let productionProfile: Awaited<ReturnType<typeof getPersonaProductionProfile>> | null = null
  let readiness: Awaited<ReturnType<typeof getPersonaReadiness>> | null = null
  if (personaId) {
    try {
      productionProfile = await getPersonaProductionProfile(personaId, { purpose })
    } catch {
      readiness = await getPersonaReadiness(personaId, purpose)
    }
  }
  const avatars = personaId ? await listPersonaAvatarOptions(personaId) : []
  // 混剪底板候选（FR-M1）：人物库已审核通过的背景图 / 背景视频 / 空镜
  const backgrounds = personaId
    ? await listAssets(personaId, { kind: 'background_image', status: 'approved' } as never).then(async (a) => [
        ...a,
        ...(await listAssets(personaId, { kind: 'background_video', status: 'approved' } as never)),
        ...(await listAssets(personaId, { kind: 'broll_video', status: 'approved' } as never)),
      ]).catch(() => [])
    : []
  const savedConfig = await db.get('SELECT * FROM `video_config` WHERE `copy_id` = ?', [copyId])
  const versions = await listVideoJobs({ copyId }, db)

  return {
    copy: {
      id: ap.copyId,
      title: ap.title,
      persona: ap.persona,
      line: ap.persona?.line ?? null,
      versionId: ap.versionId,
      versionNo: ap.versionNo,
      wordCount: words,
      estSeconds: estimateSeconds(words),
      revising,
      riskHint: ap.riskHint,
      sections: ap.sections,
    },
    persona,
    productionProfile,
    readiness,
    avatars,
    backgrounds,
    savedConfig: savedConfig
      ? {
          mode: savedConfig.mode,
          avatarId: savedConfig.avatar_id,
          backgroundAssetId: savedConfig.background_asset_id,
          voiceSource: savedConfig.voice_source,
          publicVoiceId: savedConfig.public_voice_id,
          mixcut: typeof savedConfig.mixcut === 'string' ? safeJson(savedConfig.mixcut) : savedConfig.mixcut,
        }
      : null,
    jobs: versions.items.map(toJobSummary),
    limits: {
      maxSeconds: config.video.maxSeconds,
      maxTextChars: config.video.maxTextChars,
      jobLimitPerCopy: config.video.jobLimitPerCopy,
    },
  }
}

/** PUT /video/copies/:copyId/config（FR-C4） */
export async function putCopyConfig(copyId: string, input: CreateVideoJobInput, operator: string): Promise<void> {
  await saveVideoConfig(copyId, input, operator)
}

/** GET /video/jobs（FR-X2 任务树） */
export async function listJobsView(q: { copyId?: string; personaId?: string; phase?: string; ids?: string[]; page?: number; pageSize?: number; includeArchived?: boolean }) {
  const r = await listVideoJobs(q)
  return { items: r.items.map(toJobSummary), total: r.total, page: r.page, pageSize: r.pageSize }
}

/** FR-X3：文案工坊 latestVideoJob（只读冗余，由查询派生） */
export async function getLatestVideoJobBrief(copyId: string): Promise<{ id: string; versionNo: number; phase: string } | null> {
  const db = getDb()
  const row = await db.get(
    'SELECT * FROM `video_job` WHERE `copy_id` = ? AND `archived_at` IS NULL ORDER BY `created_at` DESC, `version_no` DESC LIMIT 1',
    [copyId],
  )
  if (!row) return null
  const job = mapVideoJob(row)
  return { id: job.id, versionNo: job.versionNo, phase: job.phase }
}
