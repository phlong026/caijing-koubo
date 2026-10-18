import { getDb, type Db } from '../../db/index.js'
import { config, hasTikHub } from '../../config.js'
import { jdec, jenc, newId } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { QUEUE_NAMES, dedupOpts, enqueue, registerWorker } from '../../queue/index.js'
import { fetchVideoDetail } from '../../integrations/tikhub/client.js'
import type { TikVideoDetail } from '../../integrations/tikhub/types.js'
import { submitTask, waitForResult, type AsrSentence } from '../../integrations/dashscope/asr.js'
import { putObjectFromFile, signedUrl } from '../../integrations/aliyun-oss/client.js'
import { checkFfmpeg, cleanup, downloadToTemp, extractAudio } from '../../media/pipeline.js'
import { getVideoById, type ExtractStatus } from './videos.js'

export interface CacheRow {
  id: string
  platform: string
  videoId: string
  text: string | null
  sentences: AsrSentence[]
  duration: number | null
  engine: string | null
  extractMode: string | null
  taskId: string | null
  status: ExtractStatus | 'pending' | 'submitting' | 'running' | 'done' | 'failed' | 'uncertain'
  ossKey: string | null
  attempts: number
  error: string | null
  cost: number
  createdAt: string | null
  updatedAt: string | null
}

function mapCache(r: Record<string, any>): CacheRow {
  return {
    id: r.id,
    platform: r.platform,
    videoId: r.video_id,
    text: r.text ?? null,
    sentences: jdec<AsrSentence[]>(r.sentences, []),
    duration: r.duration ?? null,
    engine: r.engine ?? null,
    extractMode: r.extract_mode ?? null,
    taskId: r.task_id ?? null,
    status: r.status,
    ossKey: r.oss_key ?? null,
    attempts: Number(r.attempts ?? 0),
    error: r.error ?? null,
    cost: Number(r.cost ?? 0),
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}

export async function getCacheById(id: string, db = getDb()): Promise<CacheRow | null> {
  const r = await db.get<Record<string, any>>('SELECT * FROM `script_extract_cache` WHERE `id` = ?', [id])
  return r ? mapCache(r) : null
}

export async function getCacheByVideo(platform: string, videoId: string, db = getDb()): Promise<CacheRow | null> {
  const r = await db.get<Record<string, any>>(
    'SELECT * FROM `script_extract_cache` WHERE `platform` = ? AND `video_id` = ?',
    [platform, videoId],
  )
  return r ? mapCache(r) : null
}

export async function getStatusByVideo(videoInternalId: string): Promise<{ status: string; error: string | null; cacheId: string | null }> {
  const video = await getVideoById(videoInternalId)
  if (!video) throw err.notFound('视频不存在')
  const cache = await getCacheByVideo(video.platform, video.videoId)
  return {
    status: cache?.status ?? 'none',
    error: cache?.error ?? null,
    cacheId: cache?.id ?? null,
  }
}

export async function getScriptByVideo(videoInternalId: string): Promise<{
  text: string
  sentences: AsrSentence[]
  duration: number | null
  engine: string | null
  extractMode: string | null
  updatedAt: string | null
}> {
  const video = await getVideoById(videoInternalId)
  if (!video) throw err.notFound('视频不存在')
  const cache = await getCacheByVideo(video.platform, video.videoId)
  if (!cache) throw err.notFound('尚未提取文案')
  if (cache.status !== 'done') throw err.invalidState(`当前提取状态为 ${cache.status}，暂不可查看文案`)
  return {
    text: cache.text ?? '',
    sentences: cache.sentences,
    duration: cache.duration,
    engine: cache.engine,
    extractMode: cache.extractMode,
    updatedAt: cache.updatedAt,
  }
}

/**
 * FR-B6 触发提取（幂等 + 并发占位）：
 * - 以 (platform, video_id) 唯一键占位，保证同一视频同时只有一个百炼任务
 * - done 直接返回；pending/submitting/running 返回当前状态不入队
 * - failed 条件更新为 pending 后入队（重试）
 * - uncertain 须界面确认（confirm=1）后才改回 pending 入队
 */
/**
 * 调用方刚取到的视频详情（P2-6）：直接提取时 parse-link 已调过一次 TikHub 详情，
 * 随任务带上，提取时在有效期内直接复用，省掉一次重复计费的详情调用。
 */
export type PrefetchedDetail = Pick<TikVideoDetail, 'playUrl' | 'duration'> & { fetchedAt: number }

/** 播放地址有时效，超过这个时间的预取详情不再复用，回到「提取时现取」（T6 验收 2） */
const PREFETCH_TTL_MS = 10 * 60 * 1000

export async function requestExtract(
  videoInternalId: string,
  opts: { confirm?: boolean; prefetched?: PrefetchedDetail } = {},
): Promise<{ status: string; cacheId: string; message?: string }> {
  const db = getDb()
  const video = await getVideoById(videoInternalId)
  if (!video) throw err.notFound('视频不存在')

  const existing = await getCacheByVideo(video.platform, video.videoId)
  if (existing) {
    if (existing.status === 'done') return { status: 'done', cacheId: existing.id }
    if (['pending', 'submitting', 'running'].includes(existing.status)) {
      return { status: existing.status, cacheId: existing.id }
    }
    if (existing.status === 'failed') {
      const res = await db.run("UPDATE `script_extract_cache` SET `status` = 'pending', `error` = NULL, `updated_at` = ? WHERE `id` = ? AND `status` = 'failed'", [
        toDb(utcNow()),
        existing.id,
      ])
      if (!res.affectedRows) return { status: 'failed', cacheId: existing.id }
      await enqueueExtract(existing.id, opts.prefetched)
      return { status: 'pending', cacheId: existing.id }
    }
    if (existing.status === 'uncertain') {
      if (!opts.confirm) {
        return {
          status: 'uncertain',
          cacheId: existing.id,
          message: '上次提交结果未知，请确认后再重试（确认不会重复计费）',
        }
      }
      const res = await db.run(
        "UPDATE `script_extract_cache` SET `status` = 'pending', `error` = NULL, `updated_at` = ? WHERE `id` = ? AND `status` = 'uncertain'",
        [toDb(utcNow()), existing.id],
      )
      if (!res.affectedRows) return { status: existing.status, cacheId: existing.id }
      await enqueueExtract(existing.id, opts.prefetched)
      return { status: 'pending', cacheId: existing.id }
    }
  }

  const id = newId('cache')
  await db.run(
    'INSERT INTO `script_extract_cache` (`id`, `platform`, `video_id`, `status`, `attempts`, `created_at`, `updated_at`) VALUES (?, ?, ?, \'pending\', 0, ?, ?)',
    [id, video.platform, video.videoId, toDb(utcNow()), toDb(utcNow())],
  )
  await enqueueExtract(id, opts.prefetched)
  return { status: 'pending', cacheId: id }
}

export async function enqueueExtract(cacheId: string, prefetched?: PrefetchedDetail): Promise<void> {
  // P0-2：不能用固定 jobId。runExtract 内部吞掉异常并写 failed，BullMQ 视为「已完成」，
  // 固定 jobId 会被已完成任务永久占位，用户点「重试」后任务永远停在「排队中」。
  // deduplication 只在任务未结束时去重，任务落地即释放。
  await enqueue(
    QUEUE_NAMES.scriptExtract,
    'extract',
    prefetched ? { cacheId, prefetched } : { cacheId },
    { ...dedupOpts(`extract-${cacheId}`), attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
  )
}

export async function registerExtractWorker(): Promise<void> {
  registerWorker(
    QUEUE_NAMES.scriptExtract,
    async (job) => {
      const { cacheId, prefetched } = job.data as { cacheId: string; prefetched?: PrefetchedDetail }
      // 预取详情只给首次执行用；BullMQ 重试时地址可能已失效，回到现取
      await runExtract(cacheId, job.attemptsMade === 0 ? prefetched : undefined)
      return { cacheId }
    },
    { concurrency: 2 },
  )
  // FR-B6 续跑：进程重启后，running 且有 task_id 的记录直接续轮询，不重新提交
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    "SELECT `id` FROM `script_extract_cache` WHERE `status` = 'running' AND `task_id` IS NOT NULL",
  )
  for (const r of rows) {
    await enqueueExtract(r.id).catch((e) => logger.error({ err: (e as Error).message }, 'extract.resume_failed'))
    logger.info({ cacheId: r.id }, 'extract.resumed')
  }
}

function setStatus(db: Db, id: string, status: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const keys = Object.keys(extra)
  const setSql = keys.length ? `, ${keys.map((k) => `\`${k}\` = ?`).join(', ')}` : ''
  return db.run(`UPDATE \`script_extract_cache\` SET \`status\` = ?, \`updated_at\` = ?${setSql} WHERE \`id\` = ?`, [
    status,
    toDb(utcNow()),
    ...keys.map((k) => extra[k]),
    id,
  ])
}

/** FR-B6 链路：取新鲜地址 → 时长校验 → 下载 → ffmpeg 抽音轨 → OSS → 签名 URL → 百炼 → 轮询 → 落库 → 清理 */
export async function runExtract(cacheId: string, prefetched?: PrefetchedDetail): Promise<void> {
  const db = getDb()
  const cache = await getCacheById(cacheId)
  if (!cache) throw new Error('提取任务不存在')
  if (cache.status === 'done') return

  const tempFiles: string[] = []
  try {
    await db.run('UPDATE `script_extract_cache` SET `attempts` = `attempts` + 1, `updated_at` = ? WHERE `id` = ?', [
      toDb(utcNow()),
      cacheId,
    ])

    // 续跑：已提交过且有 task_id，直接进入轮询，不重新提交
    if (cache.status === 'running' && cache.taskId) {
      await pollAndPersist(cacheId, cache.taskId)
      return
    }

    // P1-3②：submitting 必须紧挨着 submitTask 之前才置；此前（下载/ffmpeg/OSS）
    // 失败都属于可安全重试的 failed，不应被误判为 uncertain 而要求人工确认。
    const reuse = !!prefetched?.playUrl && Date.now() - prefetched.fetchedAt < PREFETCH_TTL_MS
    const detail = reuse ? prefetched! : await fetchVideoDetail(cache.videoId)
    if (reuse) logger.info({ cacheId }, 'extract.reuse_prefetched_detail')
    if (!detail.playUrl) {
      await setStatus(db, cacheId, 'failed', { error: '未取到播放地址' })
      return
    }
    const durationSec = detail.duration ?? 0
    const maxSec = config.extract.maxDurationMin * 60
    if (durationSec > maxSec) {
      // 在下载前拦截（T6 验收 7）
      await setStatus(db, cacheId, 'failed', {
        error: `视频时长 ${Math.round(durationSec / 60)} 分钟，超过上限 ${config.extract.maxDurationMin} 分钟`,
      })
      return
    }

    let fileUrl = detail.playUrl ?? 'mock://local'
    let ossKey: string | null = null
    // mock 数据源（无 TikHub 密钥）时播放地址是占位串、不可真实下载，跳过下载/抽音轨/OSS
    const mockSource = !hasTikHub()
    if (config.extract.mode === 'direct' || mockSource) {
      logger.info({ cacheId, mode: config.extract.mode, mockSource }, 'extract.skip_media_pipeline')
    } else {
      const ffmpegOk = await checkFfmpeg()
      if (!ffmpegOk.ok) {
        await setStatus(db, cacheId, 'failed', { error: ffmpegOk.error ?? 'ffmpeg 不可用' })
        return
      }
      const videoPath = await downloadToTemp(detail.playUrl, `${cacheId}.mp4`)
      tempFiles.push(videoPath)
      const audioPath = await extractAudio(videoPath, `${cacheId}.wav`)
      tempFiles.push(audioPath)
      const put = await putObjectFromFile(audioPath, `${cacheId}.wav`)
      ossKey = put.key
      fileUrl = await signedUrl(put.key)
    }

    await setStatus(db, cacheId, 'submitting')
    let taskId: string
    try {
      taskId = await submitTask(fileUrl, { type: 'cache', id: cacheId })
    } catch (e) {
      // P1-3③：提交超时/网络错误时请求可能已到百炼，若记 failed 用户重试会**重复计费**，
      // 因此记为 uncertain，由人工确认后再重试。
      const msg = (e as Error).message || '提交百炼任务失败'
      await setStatus(db, cacheId, 'uncertain', { error: `提交结果未知：${msg}` })
      logger.warn({ cacheId, err: msg }, 'extract.submit_uncertain')
      return
    }
    await setStatus(db, cacheId, 'running', {
      task_id: taskId,
      submitted_at: toDb(utcNow()),
      extract_mode: mockSource ? 'mock' : config.extract.mode,
      oss_key: ossKey,
      engine: `bailian-${config.dashscope.asrModel}`,
    })
    await pollAndPersist(cacheId, taskId)
  } catch (e) {
    const msg = (e as Error).message || '提取失败'
    await setStatus(db, cacheId, 'failed', { error: msg })
    logger.error({ cacheId, err: msg }, 'extract.failed')
  } finally {
    await cleanup(tempFiles)
  }
}

async function pollAndPersist(cacheId: string, taskId: string): Promise<void> {
  const db = getDb()
  let result: Awaited<ReturnType<typeof waitForResult>>
  try {
    result = await waitForResult(taskId)
  } catch (e) {
    // P1-3③：轮询超时/失败时 task_id 仍然有效，保持 running 让续跑逻辑继续轮询，
    // 若记为 failed 会导致重试时重复提交、重复计费。
    const msg = (e as Error).message || '轮询失败'
    await db.run('UPDATE `script_extract_cache` SET `error` = ?, `updated_at` = ? WHERE `id` = ?', [
      `轮询未完成：${msg}`.slice(0, 1000),
      toDb(utcNow()),
      cacheId,
    ])
    logger.warn({ cacheId, taskId, err: msg }, 'extract.poll_kept_running')
    return
  }
  await db.run(
    "UPDATE `script_extract_cache` SET `status` = 'done', `text` = ?, `sentences` = ?, `duration` = ?, `cost` = `cost` + ?, `updated_at` = ? WHERE `id` = ?",
    [
      result.text,
      jenc(result.sentences),
      result.sentences.length ? Math.round((result.sentences[result.sentences.length - 1]?.endTime ?? 0) / 1000) : null,
      config.dashscope.asrUnitPrice,
      toDb(utcNow()),
      cacheId,
    ],
  )
  logger.info({ cacheId, taskId, chars: result.text.length, sentences: result.sentences.length }, 'extract.done')
}
