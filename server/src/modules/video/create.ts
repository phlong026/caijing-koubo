import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import { err } from '../../errors.js'
import { getDb } from '../../db/index.js'
import { isDuplicateKey } from '../../db/index.js'
import { newId } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { dedupOpts, enqueue, QUEUE_NAMES } from '../../queue/index.js'
import { buildVendorTitle, uniqueShortRef } from '../personas/clone/short-ref.js'
import { upsert } from '../../db/index.js'
import { runPrecheck, getActiveJobForCopy, type VideoPrecheckInput } from './precheck.js'
import { getPersonaProductionProfile } from './persona-bridge.js'
import { buildTextSnapshot } from './text-snapshot.js'
import { appendJobEvent, insertVideoJob, mapVideoJob, type VideoJob } from './repo.js'
import type { ConfigSnapshot, MixcutConfig, VideoMode } from './types.js'

/**
 * 创建视频任务（FR-A6，🔁 Z1 平移众墅之家 create_oral_task 的幂等 / 快照 / 取号骨架；
 * 分身与声音校验改为调用人物库 service，行锁改为事务内非终态复查）。
 *
 * 全流程：幂等重放检查 → precheck 硬项 → production-profile → 同一事务内
 * （非终态复查 + 版本上限 + 取号 + 冻结快照 + 建行）→ 提交后入队 → 记忆配置。
 * 飞影调用不在本函数（worker 的 task_submit），事务只负责任务的诞生。
 */

export interface CreateVideoJobInput {
  copyId: string
  mode: VideoMode
  avatarId?: string | null
  mixcutPackIds?: string[]
  /** 混剪启用的关键词组（空 = 全部启用） */
  mixcutKeywordGroupIds?: string[]
  /** 混剪底板：人物库 persona_asset.id（背景图/背景视频/空镜） */
  mixcutBackgroundAssetId?: string | null
  voiceSource?: 'persona' | 'public'
  publicVoiceId?: string | null
  display?: 'fullscreen' | 'pip'
}

export interface CreateVideoJobResult {
  jobId: string
  versionNo: number
  phase: string
  replayed: boolean
}

function requestHashOf(input: CreateVideoJobInput): string {
  return createHash('sha256').update(JSON.stringify(input, Object.keys(input).sort() as never)).digest('hex')
}

export async function createVideoJob(
  input: CreateVideoJobInput,
  opts: { idempotencyKey?: string | null; operator: string },
): Promise<CreateVideoJobResult> {
  const db = getDb()
  const reqHash = requestHashOf(input)

  // 幂等平移 Z1：同键同请求 hash 重放原任务；同键不同 hash 冲突
  if (opts.idempotencyKey) {
    const existing = await db.get('SELECT * FROM `video_job` WHERE `idempotency_key` = ? LIMIT 1', [opts.idempotencyKey])
    if (existing) {
      const job = mapVideoJob(existing)
      if (job.requestHash !== reqHash) throw err.idempotencyConflict()
      return { jobId: job.id, versionNo: job.versionNo, phase: job.phase, replayed: true }
    }
  }

  // 硬检查（V10）：文案/人物/模式/文本/引擎/素材包
  const pre = await runPrecheck({
    copyId: input.copyId,
    mode: input.mode,
    avatarId: input.avatarId ?? null,
    mixcutPackIds: input.mixcutPackIds,
    voiceSource: input.voiceSource,
    publicVoiceId: input.publicVoiceId,
  } satisfies VideoPrecheckInput)
  if (pre.checks.some((c) => c.level === 'hard' && !c.pass)) {
    throw err.videoPrecheckFailed('配置检查未通过', { checks: pre.checks })
  }
  const approved = pre.approved!
  const personaId = approved.personaId

  // 同 copy 非终态任务互斥（§3.1；未进事务前的快速失败，事务内还会复查）
  const activeId = await getActiveJobForCopy(input.copyId)
  if (activeId) throw err.videoJobActive('该文案已有进行中的视频任务', { activeJobId: activeId })

  // 冻结 production-profile（FR-A6：可带 ?avatarId 取用所选分身；V7 不再建本模块人物桩）
  const profile = await getPersonaProductionProfile(personaId, {
    ...(input.mode === 'avatar' && input.avatarId ? { avatarId: input.avatarId } : {}),
    ...(input.mode === 'mixcut' ? { purpose: 'mixcut' as const } : {}),
  })

  // 文本快照（FR-P1）：precheck 已算过一次，这里重建保证与落库一致
  const textSnapshot = buildTextSnapshot(approved.sections, approved.riskHint)

  const now = toDb(utcNow())
  const jobId = newId('vjob')

  // 取号 + 建行在同一事务；UNIQUE(copy_id, version_no) 撞号时重试
  for (let attempt = 0; ; attempt++) {
    try {
      const created = await db.tx(async (tx) => {
        // 事务内非终态复查（并发双击兜底）
        const active = await tx.get<{ id: string }>(
          "SELECT `id` FROM `video_job` WHERE `copy_id` = ? AND `archived_at` IS NULL AND `phase` NOT IN ('completed', 'failed', 'cancelled') ORDER BY `created_at` DESC LIMIT 1",
          [input.copyId],
        )
        if (active) throw err.videoJobActive('该文案已有进行中的视频任务', { activeJobId: active.id })

        // 版本上限（Q11：默认 10）
        const countRow = await tx.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM `video_job` WHERE `copy_id` = ? AND `archived_at` IS NULL',
          [input.copyId],
        )
        if (Number(countRow?.n ?? 0) >= config.video.jobLimitPerCopy) {
          throw err.videoJobLimit()
        }

        // 取号：copy 内单调递增
        const maxRow = await tx.get<{ m: number }>('SELECT COALESCE(MAX(`version_no`), 0) AS m FROM `video_job` WHERE `copy_id` = ?', [
          input.copyId,
        ])
        const versionNo = Number(maxRow?.m ?? 0) + 1

        const shortRef = await uniqueShortRef('video_job', jobId)
        const vendorTitle = buildVendorTitle(approved.title || input.copyId, shortRef)

        const avatar = profile.avatar
        const voice = profile.voice
        const mixcut: MixcutConfig | null =
          input.mode === 'mixcut'
            ? {
                packIds: input.mixcutPackIds ?? [],
                keywordGroupIds: input.mixcutKeywordGroupIds ?? [],
                backgroundAssetId: input.mixcutBackgroundAssetId ?? null,
                voiceSource: input.voiceSource ?? 'persona',
                publicVoiceId: input.publicVoiceId ?? null,
                display: input.display ?? 'fullscreen',
              }
            : null
        const configSnapshot: ConfigSnapshot = {
          personaVersionId: profile.versionId,
          avatar: avatar
            ? {
                avatarId: input.avatarId ?? avatar.avatarId,
                vendorAvatarId: avatar.vendorAvatarId,
                name: avatar.name,
                backgroundLabel: avatar.backgroundLabel,
                sourceWidth: avatar.sourceWidth,
                sourceHeight: avatar.sourceHeight,
              }
            : null,
          voice: voice
            ? {
                voiceId: voice.voiceId,
                vendorVoiceId: voice.vendorVoiceId,
                name: voice.name,
                language: voice.language,
                speechRate: voice.speechRate,
                volume: voice.volume,
                pitch: voice.pitch,
              }
            : null,
          genMode: 'tts', // Q3 备选 B 拍板前固定文本直出（§11）
          submitParams: {
            vendorTitle,
            aigcFlag: config.hifly.aigcFlag,
            subtitle: { st_show: 0 },
          },
          ...(mixcut ? { mixcut } : {}),
        }

        const row: Omit<VideoJob, 'createdAt'> = {
          id: jobId,
          copyId: input.copyId,
          copyVersionId: approved.versionId,
          copyVersionNo: approved.versionNo,
          versionNo,
          personaId,
          personaVersionId: profile.versionId,
          line: approved.line,
          mode: input.mode,
          genMode: 'tts',
          provider: 'hifly',
          phase: 'waiting',
          progressFloor: 0,
          statusMessage: '排队中，等待生成资源',
          errorCode: null,
          errorDetail: null,
          configSnapshot,
          textSnapshot,
          textHash: textSnapshot.textHash,
          avatarId: input.mode === 'avatar' ? (configSnapshot.avatar?.avatarId ?? null) : null,
          voiceId: configSnapshot.voice?.voiceId ?? null,
          vendorTitle,
          shortRef,
          remoteTaskId: null,
          remoteResultUrl: null,
          remoteDurationSec: null,
          submitAttempts: 0,
          submittedAt: null,
          nextPollAt: null,
          pollFailures: 0,
          expectedGenSeconds: Math.round(pre.estSeconds ? Math.max(config.video.genSecondsMin, pre.estSeconds * config.video.genSecondsFactor) : config.video.genSecondsMin),
          ttsAudioId: null,
          timeline: null,
          timelineSource: null,
          alignScore: null,
          replacements: null,
          resultKey: null,
          coverKey: null,
          durationMs: 0,
          width: 0,
          height: 0,
          sizeBytes: 0,
          isMock: 0,
          creditsEstimated: pre.estCredits,
          idempotencyKey: opts.idempotencyKey ?? null,
          requestHash: reqHash,
          queuedAt: now,
          startedAt: null,
          finishedAt: null,
          createdBy: opts.operator,
          updatedAt: now,
          archivedAt: null,
        }
        await insertVideoJob(tx, row)
        await appendJobEvent({ jobId, fromPhase: null, toPhase: 'waiting', operator: opts.operator, detail: { mode: input.mode, versionNo } }, tx)
        return { versionNo }
      })

      // 事务提交后入队（队列不可用时 sweep 兜底推进 waiting）
      await enqueue(QUEUE_NAMES.videoGenerate, 'submit', { jobId }, dedupOpts(`video-submit-${jobId}`)).catch(() => undefined)

      // 配置记忆（FR-C4：生成时自动保存一次）
      await saveVideoConfig(input.copyId, input, opts.operator).catch(() => undefined)
      return { jobId, versionNo: created.versionNo, phase: 'waiting', replayed: false }
    } catch (e) {
      if (isDuplicateKey(e) && attempt < 3) continue // version_no 并发撞号重试
      throw e
    }
  }
}

/** FR-C4：按 copy 保存创作配置（生成时自动保存 / 保存配置按钮共用） */
export async function saveVideoConfig(copyId: string, input: CreateVideoJobInput, operator: string): Promise<void> {
  const db = getDb()
  const now = toDb(utcNow())
  await upsert(db, {
    table: 'video_config',
    row: {
      id: newId('vcfg'),
      copy_id: copyId,
      mode: input.mode,
      avatar_id: input.avatarId ?? null,
      background_asset_id: null,
      voice_source: input.voiceSource ?? null,
      public_voice_id: input.publicVoiceId ?? null,
      mixcut:
        input.mode === 'mixcut'
          ? JSON.stringify({
              packIds: input.mixcutPackIds ?? [],
              keywordGroupIds: input.mixcutKeywordGroupIds ?? [],
              backgroundAssetId: input.mixcutBackgroundAssetId ?? null,
              display: input.display ?? 'fullscreen',
            })
          : null,
      updated_by: operator,
      updated_at: now,
    },
    uniqueCols: ['copy_id'],
    updateCols: ['mode', 'avatar_id', 'voice_source', 'public_voice_id', 'mixcut', 'updated_by', 'updated_at'],
  })
}
