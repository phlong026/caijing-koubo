import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, paths } from '../../../config.js'
import { err } from '../../../errors.js'
import { getDb } from '../../../db/index.js'
import { newId } from '../../../lib/util.js'
import { toDb, utcNow } from '../../../lib/time.js'
import { dedupOpts, enqueue, QUEUE_NAMES } from '../../../queue/index.js'
import { downloadObjectToFile, putObjectFromFile } from '../../../integrations/aliyun-oss/client.js'
import { normalizeAudioToMp3, probeMedia } from '../../../media/inspect.js'
import { resolveHiflyClient } from '../../../integrations/hifly/index.js'
import { appendJobEvent, casTransition, getVideoJob } from '../repo.js'
import type { VideoJob } from '../repo.js'
import { resolveJobTempDir } from '../temp-dir.js'
import { matchReplacements, type MixcutKeywordGroup, type MixcutMaterialItem } from './matcher.js'
import { composeMixcut, composeCover } from './compose.js'
import { SEGMENTATION_VERSION } from '../text-snapshot.js'
import type { MixcutConfig } from '../types.js'

/**
 * 混剪编排（FR-M3）：tts（配音整轨 + 身份缓存）→ aligning（对齐，archive.ts 复用）→ composing。
 * 配音缓存（AC-T5）：identity = SHA-256(text_hash, vendor_voice_id, 声音参数, 切句规则版本)；
 * 命中 ready 缓存记 0 积分（credits_estimated 已在创建时计入，实际调用不再发生）。
 */

interface TtsAudioRow {
  id: string
  identity: string
  status: string
  storage_key: string | null
  duration_ms: number | null
  timeline: string | null
  timeline_source: string | null
}

function ttsIdentity(vendorVoiceId: string, textHash: string, speechRate: number, volume: number, pitch: number): string {
  return createHash('sha256')
    .update([textHash, vendorVoiceId, speechRate, volume, pitch, SEGMENTATION_VERSION].join('|'))
    .digest('hex')
}

function jobWorkDir(jobId: string): string {
  return resolveJobTempDir(paths.tempDir, jobId)
}

/** 混剪任务的配音声音（FR-M1：经理/KOS 用人物默认声音；素人线用公共音色 Q12） */
function vendorVoiceOf(job: VideoJob): { vendorVoiceId: string; speechRate: number; volume: number; pitch: number } | null {
  const mix = job.configSnapshot?.mixcut
  if (job.configSnapshot?.voice) {
    const v = job.configSnapshot.voice
    return { vendorVoiceId: v.vendorVoiceId, speechRate: v.speechRate ?? 1, volume: v.volume ?? 1, pitch: v.pitch ?? 1 }
  }
  if (mix?.publicVoiceId) return { vendorVoiceId: mix.publicVoiceId, speechRate: 1, volume: 1, pitch: 1 }
  return null
}

/** tts 阶段：缓存命中直接推进；否则 createAudioByTts → 轮询 → 下载 → 归档 mp3 */
export async function runTtsStage(jobId: string): Promise<void> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  if (!job || job.phase !== 'tts' || !job.textSnapshot) return
  const voice = vendorVoiceOf(job)
  if (!voice) {
    await markMixcutFailed(jobId, 'tts', 'PERSONA_NOT_READY', '没有可用的配音声音（人物无克隆声音且未指定公共音色）')
    return
  }
  const identity = ttsIdentity(voice.vendorVoiceId, job.textSnapshot.textHash ?? '', voice.speechRate, voice.volume, voice.pitch)

  // 缓存命中（AC-T5）
  const cached = await db.get<TtsAudioRow>('SELECT * FROM `video_tts_audio` WHERE `identity` = ?', [identity])
  if (cached?.status === 'ready' && cached.storage_key && cached.duration_ms) {
    const moved = await casTransition(db, jobId, 'tts', 'aligning', {
      ttsAudioId: cached.id,
      statusMessage: '时间轴对齐中（复用配音缓存）',
      progressFloor: 15,
    })
    if (moved) {
      await appendJobEvent({ jobId, fromPhase: 'tts', toPhase: 'aligning', detail: { reused: true, ttsAudioId: cached.id } }, db)
      await db.run('UPDATE `video_tts_audio` SET `last_used_at` = ? WHERE `id` = ?', [toDb(utcNow()), cached.id])
      await enqueue(QUEUE_NAMES.videoGenerate, 'align', { jobId }, dedupOpts(`video-align-${jobId}`)).catch(() => undefined)
    }
    return
  }

  const dir = jobWorkDir(jobId)
  await fsp.mkdir(dir, { recursive: true })
  const client = resolveHiflyClient()
  try {
    // 缓存行占位（running），同身份并发只跑一次
    const cacheId = cached?.id ?? newId('ttsa')
    if (!cached) {
      await db.run(
        'INSERT INTO `video_tts_audio` (`id`, `identity`, `provider`, `vendor_voice_id`, `voice_params`, `text_hash`, `status`, `segment_count`, `created_at`, `last_used_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [cacheId, identity, 'hifly', voice.vendorVoiceId, JSON.stringify(voice), job.textSnapshot.textHash ?? '', 'running', job.textSnapshot.segments.length, toDb(utcNow()), toDb(utcNow())],
      )
    } else {
      await db.run('UPDATE `video_tts_audio` SET `status` = ? WHERE `id` = ?', ['running', cacheId])
    }
    await casTransition(db, jobId, 'tts', 'tts', { ttsAudioId: cacheId })

    // 提交（事务外；createAudioByTts 文本上限由客户端校验）
    const acc = await client.createAudioByTts({
      voiceId: voice.vendorVoiceId,
      text: job.textSnapshot.submitText,
      title: `配音-${jobId.slice(-6)}`,
    })
    // 轮询到 DONE（音频合成通常分钟级；本地阶段占用 worker 不占飞影视频并发）
    const deadline = Date.now() + config.hifly.pollMaxAgeMs
    let audioUrl: string | null = null
    let taskRow = await client.voiceTask(acc.taskId)
    while (Date.now() < deadline) {
      if (taskRow.state === 'DONE') {
        audioUrl = taskRow.audioUrl ?? taskRow.demoUrl ?? null
        break
      }
      if (taskRow.state === 'FAILED') break
      await new Promise((r) => setTimeout(r, client.mock ? 200 : 5000))
      taskRow = await client.voiceTask(acc.taskId)
    }
    if (!audioUrl) throw new Error(taskRow.failReason || '配音合成未返回音频地址')

    // 下载 → mp3 规范化 → 探测时长 → 归档
    const rawPath = path.join(dir, 'tts-raw.dat')
    await client.download(audioUrl, rawPath)
    const mp3Path = await normalizeAudioToMp3(rawPath, `video-jobs/${jobId}/tts.mp3`).catch(async () => {
      // normalize 失败时直接探测（mock 的 WAV 本身可用）
      return rawPath
    })
    const probe = await probeMedia(mp3Path)
    if (!probe.durationMs || probe.durationMs <= 0) throw new Error('配音音频时长无效')
    const storageKey = `video-jobs/${jobId}/tts.mp3`
    await putObjectFromFile(mp3Path, storageKey, '')
    await fsp.rm(rawPath, { force: true })

    await db.run(
      'UPDATE `video_tts_audio` SET `status` = ?, `storage_key` = ?, `duration_ms` = ?, `remote_task_ids` = ? WHERE `id` = ?',
      ['ready', storageKey, probe.durationMs, JSON.stringify([acc.taskId]), cacheId],
    )
    const moved = await casTransition(db, jobId, 'tts', 'aligning', {
      statusMessage: '时间轴对齐中',
      progressFloor: 15,
    })
    if (moved) {
      await appendJobEvent({ jobId, fromPhase: 'tts', toPhase: 'aligning', detail: { ttsAudioId: cacheId, durationMs: probe.durationMs, mock: client.mock } }, db)
      await enqueue(QUEUE_NAMES.videoGenerate, 'align', { jobId }, dedupOpts(`video-align-${jobId}`)).catch(() => undefined)
    }
  } catch (e) {
    if (cached?.id) await db.run('UPDATE `video_tts_audio` SET `status` = ? WHERE `identity` = ?', ['failed', identity]).catch(() => undefined)
    await markMixcutFailed(jobId, 'tts', 'VIDEO_VENDOR_REJECTED', e instanceof Error ? e.message : '配音合成失败')
  }
}

/** composing 阶段：匹配 → 下载素材 → 合成 → 校验 → 归档上传 → completed */
export async function runComposeStage(jobId: string): Promise<void> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  if (!job || job.phase !== 'composing' || !job.timeline || !job.configSnapshot?.mixcut) return
  const mix = job.configSnapshot.mixcut
  const dir = jobWorkDir(jobId)
  await fsp.mkdir(dir, { recursive: true })

  try {
    const { groups, itemsByPack, items } = await loadMixcutInputs(db, mix)
    const { replacements, reused } = matchReplacements({ timeline: job.timeline, groups, itemsByPack })
    if (replacements.length && reused) {
      await appendJobEvent({ jobId, fromPhase: 'composing', toPhase: 'composing', errorCode: 'MATERIAL_REUSED', detail: { message: '素材不足，同一视频内重复使用了部分素材' } }, db).catch(() => undefined)
    }

    // 下载素材与配音
    const itemsMap = new Map<string, { itemId: string; localPath: string; isImage: boolean; durationMs: number | null }>()
    for (const r of replacements) {
      if (itemsMap.has(r.itemId)) continue
      const item = items.get(r.itemId)
      if (!item) continue
      const ext = path.extname(item.storageKey) || (item.isImage ? '.jpg' : '.mp4')
      const localPath = path.join(dir, `mat-${r.itemId}${ext}`)
      await downloadObjectToFile(item.storageKey, localPath)
      let durationMs = item.durationMs
      if (!item.isImage && !durationMs) {
        durationMs = (await probeMedia(localPath)).durationMs
      }
      itemsMap.set(r.itemId, { itemId: r.itemId, localPath, isImage: item.isImage, durationMs })
    }
    // 底板（FR-M1：人物背景 / 空镜；无则纯色兜底）
    let baseItem: { localPath: string; isImage: boolean } | null = null
    if (mix.backgroundAssetId) {
      const asset = await db.get('SELECT `storage_key`, `kind` FROM `persona_asset` WHERE `id` = ? AND `deleted_at` IS NULL', [mix.backgroundAssetId])
      if (asset?.storage_key) {
        const isImage = asset.kind === 'background_image'
        const localPath = path.join(dir, `base-${mix.backgroundAssetId}${path.extname(String(asset.storage_key)) || (isImage ? '.jpg' : '.mp4')}`)
        await downloadObjectToFile(String(asset.storage_key), localPath)
        baseItem = { localPath, isImage }
      }
    }
    const ttsRow = job.ttsAudioId ? await db.get<TtsAudioRow>('SELECT * FROM `video_tts_audio` WHERE `id` = ?', [job.ttsAudioId]) : null
    if (!ttsRow?.storage_key) throw new Error('缺少配音整轨（tts 缓存丢失）')
    const audioPath = path.join(dir, 'tts.mp3')
    await downloadObjectToFile(ttsRow.storage_key, audioPath)
    const audioProbe = await probeMedia(audioPath)
    if (!audioProbe.durationMs) throw new Error('配音音频不可读')

    // 合成
    const composed = await composeMixcut({
      audioPath,
      audioDurationMs: audioProbe.durationMs,
      baseItem,
      replacements,
      items: itemsMap,
      display: mix.display ?? 'fullscreen',
      workDir: dir,
    })

    // 归档：封面 + 上传
    const coverPath = await composeCover(composed.path, composed.durationMs)
    const resultKey = `video-jobs/${jobId}/base.mp4`
    const coverKey = `video-jobs/${jobId}/cover.jpg`
    await putObjectFromFile(composed.path, resultKey, '')
    await putObjectFromFile(coverPath, coverKey, '')
    const st = await fsp.stat(composed.path)

    const moved = await casTransition(db, jobId, 'composing', 'completed', {
      resultKey,
      coverKey,
      durationMs: composed.durationMs,
      width: config.video.outputWidth,
      height: config.video.outputHeight,
      sizeBytes: st.size,
      replacements,
      statusMessage: '已完成',
      finishedAt: toDb(utcNow()),
    })
    if (!moved) return
    await appendJobEvent({ jobId, fromPhase: 'composing', toPhase: 'completed', detail: { replacements: replacements.length, reused, durationMs: composed.durationMs } }, db)
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  } catch (e) {
    await markMixcutFailed(jobId, ['composing'], 'VIDEO_SAVE_FAILED', e instanceof Error ? e.message : '素材合成失败')
  }
}

async function loadMixcutInputs(db: ReturnType<typeof getDb>, mix: MixcutConfig) {
  const groupRows = mix.keywordGroupIds?.length
    ? await db.all(`SELECT * FROM \`material_keyword_group\` WHERE \`id\` IN (${mix.keywordGroupIds.map(() => '?').join(',')}) AND \`enabled\` = 1`, mix.keywordGroupIds)
    : await db.all('SELECT * FROM `material_keyword_group` WHERE `enabled` = 1')
  const groups: MixcutKeywordGroup[] = groupRows.map((g: Record<string, unknown>) => ({
    id: String(g.id),
    name: String(g.name),
    keywords: safeStringArray(g.keywords),
    packIds: safeStringArray(g.pack_ids),
    durationMinMs: Number(g.duration_min_ms ?? 800),
    durationMaxMs: Number(g.duration_max_ms ?? 3000),
    selectionMode: g.selection_mode === 'sequential' ? 'sequential' : 'random',
  }))
  const packIds = [...new Set(groups.flatMap((g) => g.packIds))]
  const itemRows = packIds.length
    ? await db.all(`SELECT * FROM \`material_item\` WHERE \`pack_id\` IN (${packIds.map(() => '?').join(',')}) AND \`enabled\` = 1`, packIds)
    : []
  const itemsByPack = new Map<string, MixcutMaterialItem[]>()
  const items = new Map<string, MixcutMaterialItem>()
  for (const r of itemRows) {
    const item: MixcutMaterialItem = {
      id: String(r.id),
      packId: String(r.pack_id),
      storageKey: String(r.storage_key),
      isImage: Number(r.is_image ?? 0) === 1,
      durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    }
    const list = itemsByPack.get(item.packId) ?? []
    list.push(item)
    itemsByPack.set(item.packId, list)
    items.set(item.id, item)
  }
  return { groups, itemsByPack, items }
}

function safeStringArray(v: unknown): string[] {
  try {
    const arr = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

async function markMixcutFailed(jobId: string, fromPhase: string | string[], errorCode: string, message: string): Promise<void> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  const phases = (Array.isArray(fromPhase) ? fromPhase : [fromPhase]) as never[]
  const moved = await casTransition(db, jobId, phases, 'failed', {
    errorCode,
    errorDetail: message.slice(0, 4000),
    statusMessage: message.slice(0, 200),
    finishedAt: toDb(utcNow()),
  })
  if (moved) {
    await appendJobEvent({ jobId, fromPhase: job?.phase ?? null, toPhase: 'failed', errorCode, operator: 'system' }, db).catch(() => undefined)
  }
}

/** FR-M2 匹配预览：按字数估算时间轴做纯计算匹配，不调用飞影与 ASR */
export async function previewMixcut(
  segments: Array<{ index: number; kind: 'normal' | 'risk'; text: string }>,
  estSeconds: number,
  mix: { keywordGroupIds?: string[]; backgroundAssetId?: string | null },
): Promise<{ timelineEstimated: Array<{ index: number; startMs: number; endMs: number; text: string }>; matches: Array<{ index: number; keyword: string; groupName: string; itemId: string; startMs: number; endMs: number }> }> {
  const durationMs = Math.round(Math.max(3, estSeconds) * 1000)
  // 纯计算的估算时间轴（按句序均匀切分，供预览；生成时以对齐结果为准）
  const per = Math.max(800, Math.round(durationMs / Math.max(1, segments.length)))
  const timeline = segments.map((s, i) => ({ index: s.index, kind: s.kind, text: s.text, startMs: i * per, endMs: (i + 1) * per }))
  const db = getDb()
  const { groups, itemsByPack } = await loadMixcutInputs(db, {
    packIds: [],
    keywordGroupIds: mix.keywordGroupIds ?? [],
    backgroundAssetId: mix.backgroundAssetId ?? null,
    voiceSource: 'persona',
    publicVoiceId: null,
    display: 'fullscreen',
  })
  const { replacements } = matchReplacements({ timeline, groups, itemsByPack })
  return {
    timelineEstimated: timeline.map((t) => ({ index: t.index, startMs: t.startMs, endMs: t.endMs, text: t.text })),
    matches: replacements,
  }
}
