import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, paths } from '../../config.js'
import { getDb } from '../../db/index.js'
import { toDb, utcNow } from '../../lib/time.js'
import { deleteObject, putObjectFromFile } from '../../integrations/aliyun-oss/client.js'
import { cleanup, extractAudio } from '../../media/pipeline.js'
import { extractCoverFrame, normalizeGeneratedVideo, MediaValidationFailed } from '../../media/inspect.js'
import { asrSubmitAndWait } from './asr-run.js'
import { alignTimeline } from './align.js'
import { createVideoEngine } from './engine.js'
import { appendJobEvent, casTransition, getVideoJob } from './repo.js'
import type { VideoJob } from './repo.js'
import { resolveJobTempDir } from './temp-dir.js'

/**
 * 下载与归档（FR-P4，🔁 Z4 平移众墅之家 oral_worker#task_archive / oral.py#_archive_oral_result）：
 *
 * downloading——结果地址过防 SSRF 校验（engine.download 内置）后流式下载，上限 VIDEO_ARCHIVE_MAX_MB；
 *   地址失效（403/404）先重调 video/task 取新地址再下载，**不重新提交**。
 * verifying——规范化（1080×1920 等比补边 H.264/AAC）+ 时长校验（与飞影 duration 偏差 ≤1 秒）+ 抽首帧。
 * 上传 OSS → CAS（WHERE phase='verifying' AND remote_task_id=?），影响行数 ≠1 时回滚删除已上传对象。
 * 任何一步失败 → save_failed，保留 remote_task_id / remote_result_url，「重试下载」从 downloading 重来。
 */

function jobTempDir(jobId: string): string {
  return resolveJobTempDir(paths.tempDir, jobId)
}

export async function runArchiveStage(jobId: string): Promise<void> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  if (!job || job.phase !== 'downloading') return

  const dir = jobTempDir(jobId)
  await fsp.mkdir(dir, { recursive: true })
  const engine = createVideoEngine()
  let downloaded = false
  try {
    // downloading：无地址（或已失效）时重查一次 video/task 取新地址（FR-P4，不重新提交）
    let url = job.remoteResultUrl
    if (!url) {
      const fresh = await engine.poll(job.remoteTaskId ?? '', jobId)
      if (!fresh.videoUrl) throw new MediaValidationFailed('生成服务已完成但未返回成片地址')
      url = fresh.videoUrl
      await casTransition(db, jobId, 'downloading', 'downloading', { remoteResultUrl: url, remoteDurationSec: fresh.durationSec ?? job.remoteDurationSec })
    }
    const srcPath = path.join(dir, 'source.mp4')
    try {
      await engine.download(url, srcPath, config.video.archiveMaxMb * 1024 * 1024)
    } catch (e) {
      // 地址失效：重调 video/task 取新地址后重下（一次）
      const fresh = await engine.poll(job.remoteTaskId ?? '', jobId)
      if (fresh.videoUrl && fresh.videoUrl !== url) {
        await casTransition(db, jobId, 'downloading', 'downloading', { remoteResultUrl: fresh.videoUrl })
        await engine.download(fresh.videoUrl, srcPath, config.video.archiveMaxMb * 1024 * 1024)
      } else {
        throw e
      }
    }
    downloaded = true

    // verifying：CAS downloading → verifying
    const moved = await casTransition(db, jobId, 'downloading', 'verifying', { statusMessage: '成片校验与规范化中', progressFloor: 94 })
    if (!moved) return
    await appendJobEvent({ jobId, fromPhase: 'downloading', toPhase: 'verifying', operator: 'system' }, db)

    // 规范化（等比缩放补边 1080×1920 / H.264+AAC / +faststart）+ 媒体校验
    const normalizedPath = path.join(dir, 'base.mp4')
    const norm = await normalizeGeneratedVideo(srcPath, normalizedPath, {
      targetWidth: config.video.outputWidth,
      targetHeight: config.video.outputHeight,
      fps: config.video.outputFps,
    })
    // 几何与编码已达标时 normalize 不重编码（透传）：这里统一落一份归档文件
    if (!norm.transformed) await fsp.copyFile(srcPath, normalizedPath)
    // 时长校验（FR-P4）：>0 且与飞影 duration 偏差 ≤1 秒（飞影未给 duration 时跳过偏差项）
    if (norm.durationMs <= 0) throw new MediaValidationFailed('成片时长无效')
    if (job.remoteDurationSec && Math.abs(norm.durationMs / 1000 - job.remoteDurationSec) * 1000 > config.video.durationToleranceMs) {
      throw new MediaValidationFailed(`成片时长 ${norm.durationMs}ms 与生成服务报告 ${job.remoteDurationSec}s 偏差超过 ${config.video.durationToleranceMs}ms`)
    }
    const st = await fsp.stat(normalizedPath)

    // 抽首帧缩略图（FR-A8 / §1.2：本模块只抽首帧，封面设计在剪辑/发布）
    // extractCoverFrame 的 destName 相对源文件目录拼接，传文件名即可
    const coverPath = await extractCoverFrame(normalizedPath, 'cover.jpg', norm.durationMs)

    // 上传 OSS（本地兜底由 oss client 处理，V12）
    const resultKey = `video-jobs/${jobId}/base.mp4`
    const coverKey = `video-jobs/${jobId}/cover.jpg`
    await putObjectFromFile(normalizedPath, resultKey, '')
    await putObjectFromFile(coverPath, coverKey, '')

    // CAS verifying → aligning（归档完成后进入时间轴对齐；FR-P5）
    const moved2 = await casTransition(db, jobId, 'verifying', 'aligning', {
      resultKey,
      coverKey,
      durationMs: norm.durationMs,
      width: norm.width,
      height: norm.height,
      sizeBytes: st.size,
      isMock: engine.mock ? 1 : 0,
      statusMessage: '时间轴对齐中',
      progressFloor: 97,
    })
    if (!moved2) {
      // 并发归档冲突：另一方已成功，删除本方刚上传的对象（AC-J12）
      await Promise.all([deleteObject(resultKey).catch(() => undefined), deleteObject(coverKey).catch(() => undefined)])
      return
    }
    await appendJobEvent({ jobId, fromPhase: 'verifying', toPhase: 'aligning', detail: { resultKey, durationMs: norm.durationMs, transformed: norm.transformed } }, db)
  } catch (e) {
    // 终态清理在 save_failed 恢复后再做；此处保留临时目录便于排障与重试
    const message = e instanceof Error ? e.message : '成片保存失败'
    const moved = await casTransition(db, jobId, ['downloading', 'verifying'], 'save_failed', {
      errorCode: 'VIDEO_SAVE_FAILED',
      errorDetail: message.slice(0, 4000),
      statusMessage: '视频已生成，但保存失败，请重试下载',
    })
    if (moved) {
      await appendJobEvent({ jobId, fromPhase: job.phase, toPhase: 'save_failed', errorCode: 'VIDEO_SAVE_FAILED', detail: { message, downloaded } }, db)
    }
    return
  }

  // aligning：时间轴对齐（FR-P5；失败也 completed，timeline_source=estimated）
  await runAlignStage(jobId).catch(() => undefined)
}

/**
 * 时间轴对齐（FR-P5 / §3.4）：抽音轨 → OSS 签名 URL → 百炼 ASR → 与原文对齐。
 * score ≥ VIDEO_ALIGN_MIN_SCORE → aligned；否则或 ASR 失败 → 估算兜底，任务照样 completed。
 * 「重新对齐」复用本函数（不调用飞影）。
 */
export async function runAlignStage(jobId: string): Promise<void> {
  const db = getDb()
  const job = await getVideoJob(jobId, db)
  if (!job || !job.textSnapshot) return
  // 从 verifying 直跑（归档刚完成）或从 completed（重新对齐）进入
  if (job.phase !== 'aligning') {
    const moved = await casTransition(db, jobId, ['completed'], 'aligning', { statusMessage: '时间轴对齐中' })
    if (!moved) return
  }

  const dir = jobTempDir(jobId)
  const fallback = () => finishWithTimeline(job, null, 0, 'estimated', null)

  let asrResult = null
  try {
    await fsp.mkdir(dir, { recursive: true })
    let audioPath: string
    if (job.ttsAudioId) {
      // 混剪：直接对配音整轨做 ASR（无成片）
      const db2 = getDb()
      const tts = await db2.get('SELECT `storage_key` FROM `video_tts_audio` WHERE `id` = ?', [job.ttsAudioId])
      if (!tts?.storage_key) throw new Error('缺少配音整轨（tts 缓存丢失）')
      audioPath = path.join(dir, 'tts.mp3')
      const { downloadObjectToFile } = await import('../../integrations/aliyun-oss/client.js')
      await downloadObjectToFile(String(tts.storage_key), audioPath)
    } else {
      if (!job.resultKey) throw new Error('缺少成片对象')
      const localVideo = path.join(dir, 'base.mp4')
      if (!fs.existsSync(localVideo)) {
        const { downloadObjectToFile } = await import('../../integrations/aliyun-oss/client.js')
        await downloadObjectToFile(job.resultKey, localVideo)
      }
      audioPath = await extractAudio(localVideo, `video-jobs/${jobId}/align.wav`)
    }
    // 上传取签名 URL（百炼按 URL 拉取）
    const audioKey = `video-jobs/${jobId}/align.wav`
    await putObjectFromFile(audioPath, audioKey, '')
    const { signedUrl } = await import('../../integrations/aliyun-oss/client.js')
    const fileUrl = await signedUrl(audioKey)
    asrResult = await asrSubmitAndWait(fileUrl, { type: 'video_job', id: jobId })
    // mock ASR 的固定语料与原文无关：改用按原文合成的确定性句级结果，
    // 让无密钥 smoke 走与真实一致的 aligned 路径（真实 ASR 不受影响）
    if (asrResult.mock) asrResult = syntheticAsr(job)
    await cleanup([audioPath])
  } catch (e) {
    await appendJobEvent({ jobId, fromPhase: 'aligning', toPhase: 'aligning', errorCode: 'VIDEO_ALIGN_FALLBACK', detail: { message: e instanceof Error ? e.message : 'ASR 失败', fallback: 'estimated' } }, db).catch(() => undefined)
    await fallback()
    return
  }

  // 对齐基准时长：口播 = 成片时长；混剪 = 配音整轨时长（成片尚未合成）
  let alignDurationMs = job.durationMs || 0
  if (job.mode === 'mixcut' && job.ttsAudioId) {
    const tts = await getDb().get('SELECT `duration_ms` FROM `video_tts_audio` WHERE `id` = ?', [job.ttsAudioId])
    alignDurationMs = Number(tts?.duration_ms ?? 0)
  }
  const outcome = alignTimeline(job.textSnapshot.segments, asrResult, alignDurationMs)
  const source: 'aligned' | 'estimated' = outcome.source === 'estimated' || outcome.score < config.video.alignMinScore ? 'estimated' : 'aligned'
  if (source === 'estimated') {
    await appendJobEvent({ jobId, fromPhase: 'aligning', toPhase: 'aligning', errorCode: 'VIDEO_ALIGN_FALLBACK', detail: { score: outcome.score, threshold: config.video.alignMinScore, fallback: 'estimated' } }, db).catch(() => undefined)
  }
  await finishWithTimeline(job, outcome.timeline, outcome.score, source, asrResult)
}

/** 对齐收尾：口播 → completed；混剪 → composing（时间轴先落库供匹配） */
async function finishWithTimeline(
  job: VideoJob,
  timeline: import('./types.js').TimelineItem[] | null,
  score: number,
  source: 'aligned' | 'estimated' | 'measured',
  asrRaw: unknown,
): Promise<void> {
  const db = getDb()
  if (job.mode === 'mixcut') {
    const { dedupOpts, enqueue, QUEUE_NAMES } = await import('../../queue/index.js')
    const moved = await casTransition(db, job.id, 'aligning', 'composing', {
      timeline,
      timelineSource: source,
      alignScore: Number(score.toFixed(3)),
      statusMessage: '素材合成中',
      progressFloor: 20,
    })
    if (!moved) return
    await appendJobEvent({ jobId: job.id, fromPhase: 'aligning', toPhase: 'composing', detail: { timelineSource: source, score, asrRaw } }, db)
    await enqueue(QUEUE_NAMES.videoGenerate, 'compose', { jobId: job.id }, dedupOpts(`video-compose-${job.id}`)).catch(() => undefined)
    return
  }
  const moved = await casTransition(db, job.id, 'aligning', 'completed', {
    timeline,
    timelineSource: source,
    alignScore: Number(score.toFixed(3)),
    statusMessage: '已完成',
    finishedAt: toDb(utcNow()),
  })
  if (!moved) return
  await appendJobEvent({ jobId: job.id, fromPhase: 'aligning', toPhase: 'completed', detail: { timelineSource: source, score, asrRaw } }, db)
  // 终态清理临时目录（AC-N3）
  await fsp.rm(jobTempDir(job.id), { recursive: true, force: true }).catch(() => undefined)
}

/** mock 专用：按原文切句合成确定性 ASR 结果（时间按 8s/句均匀分布） */
function syntheticAsr(job: VideoJob) {
  const segments = job.textSnapshot?.segments ?? []
  const per = 8000
  return {
    text: segments.map((s) => s.text).join(''),
    taskId: 'mock-align',
    mock: true as const,
    sentences: segments.map((s, i) => {
      const beginTime = i * per
      const endTime = beginTime + per - 500
      const chars = [...s.text]
      const span = endTime - beginTime
      return {
        text: s.text,
        beginTime,
        endTime,
        words: chars.map((ch, k) => ({
          text: ch,
          beginTime: Math.round(beginTime + (span * k) / chars.length),
          endTime: Math.round(beginTime + (span * (k + 1)) / chars.length),
        })),
      }
    }),
  }
}
