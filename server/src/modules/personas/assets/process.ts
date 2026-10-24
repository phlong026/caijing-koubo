import path from 'node:path'
import { getDb } from '../../../db/index.js'
import { jenc } from '../../../lib/util.js'
import { toDb, utcNow } from '../../../lib/time.js'
import { logger } from '../../../log.js'
import { paths } from '../../../config.js'
import { downloadObjectToFile, putObjectFromFile } from '../../../integrations/aliyun-oss/client.js'
import {
  extractCoverFrame,
  makeThumb,
  probeImage,
  probeMedia,
  transcodeCompatVideo,
} from '../../../media/inspect.js'
import { ensureTempDir, cleanup } from '../../../media/pipeline.js'
import { QUEUE_NAMES, registerWorker } from '../../../queue/index.js'
import { getAssetById, markAssetFailed, type PersonaAsset } from '../assets.js'
import { UPLOAD_LIMITS } from '../types.js'
import { checkAvatarSourceQuality, checkImageQuality, checkVideoQuality } from './quality.js'

/**
 * persona-asset-process 队列 worker（R20/R21）。
 * 流程：取原件到本地 → ffprobe → 按类型处理（兼容转码 / 抽帧 / 缩略图）→ 质检 → pending_review。
 * 硬性质检不过 → failed（含原因）；软性提示写 quality.soft。
 */

/** 把存储对象取到本地临时文件（OSS 走流式下载，本地兜底直接复制） */
async function fetchOriginal(asset: PersonaAsset): Promise<string> {
  await ensureTempDir()
  const ext = path.extname(asset.storageKey) || '.bin'
  const dest = path.join(paths.tempDir, `${asset.id}_orig${ext}`)
  await downloadObjectToFile(asset.storageKey, dest)
  return dest
}

/** 上传派生文件并返回存储 key */
async function putDerived(localPath: string, asset: PersonaAsset, suffix: string): Promise<string> {
  const ext = path.extname(localPath)
  const key = `persona/${asset.personaId}/${asset.kind}/${asset.id}_${suffix}${ext}`
  await putObjectFromFile(localPath, key, '')
  return key
}

export async function processAsset(assetId: string): Promise<void> {
  const db = getDb()
  const asset = await getAssetById(assetId)
  if (!asset || asset.deletedAt) return
  if (asset.status !== 'uploaded' && asset.status !== 'processing' && asset.status !== 'failed') return

  const tempFiles: string[] = []
  try {
    const original = await fetchOriginal(asset)
    tempFiles.push(original)
    const probe = await probeMedia(original)
    const now = toDb(utcNow())
    const updates: Record<string, unknown> = { status: 'processing', updated_at: now }

    if (asset.kind === 'photo' || asset.kind === 'background_image') {
      const img = await probeImage(original)
      updates.width = img.width
      updates.height = img.height
      const quality = checkImageQuality({ width: img.width, height: img.height }, UPLOAD_LIMITS.photo.minShortEdge)
      updates.quality = jenc(quality)
      if (!quality.pass) {
        await markAssetFailed(assetId, quality.hard.map((h) => h.message).join('；'))
        return
      }
      const thumb = await makeThumb(original, `${asset.id}_thumb.jpg`)
      tempFiles.push(thumb)
      updates.thumb_key = await putDerived(thumb, asset, 'thumb')
      updates.status = 'pending_review'
    } else if (asset.kind === 'avatar_source') {
      const quality = checkAvatarSourceQuality(probe, {
        minDurationMs: UPLOAD_LIMITS.avatar_source.minDurationMs,
        maxDurationMs: UPLOAD_LIMITS.avatar_source.maxDurationMs,
        minShortEdge: UPLOAD_LIMITS.avatar_source.minShortEdge,
      })
      updates.width = probe.width
      updates.height = probe.height
      updates.duration_ms = probe.durationMs
      updates.fps = probe.fps
      updates.quality = jenc(quality)
      if (!quality.pass) {
        await markAssetFailed(assetId, quality.hard.map((h) => h.message).join('；'))
        return
      }
      // R20：先转兼容版本（H.264 mp4）再交飞影
      const compat = await transcodeCompatVideo(original, `${asset.id}_compat.mp4`)
      tempFiles.push(compat)
      const compatProbe = await probeMedia(compat)
      updates.compat_key = await putDerived(compat, asset, 'compat')
      updates.compat_sha256 = await sha256Of(compat)
      updates.duration_ms = compatProbe.durationMs ?? probe.durationMs
      // 抽帧封面 + 缩略图
      const cover = await extractCoverFrame(compat, `${asset.id}_cover.jpg`, compatProbe.durationMs)
      tempFiles.push(cover)
      updates.thumb_key = await putDerived(cover, asset, 'thumb')
      updates.status = 'pending_review'
    } else {
      // background_video / broll_video
      const quality = checkVideoQuality(probe, UPLOAD_LIMITS.background_video.maxDurationMs)
      updates.width = probe.width
      updates.height = probe.height
      updates.duration_ms = probe.durationMs
      updates.fps = probe.fps
      updates.quality = jenc(quality)
      if (!quality.pass) {
        await markAssetFailed(assetId, quality.hard.map((h) => h.message).join('；'))
        return
      }
      const cover = await extractCoverFrame(original, `${asset.id}_cover.jpg`, probe.durationMs)
      tempFiles.push(cover)
      updates.thumb_key = await putDerived(cover, asset, 'thumb')
      updates.status = 'pending_review'
    }

    const sets = Object.keys(updates)
      .map((k) => `\`${k}\` = ?`)
      .join(', ')
    await db.run(`UPDATE \`persona_asset\` SET ${sets} WHERE \`id\` = ?`, [...Object.values(updates), assetId])
    logger.info({ assetId, kind: asset.kind, status: updates.status }, 'persona.asset.processed')
  } catch (e) {
    logger.error({ assetId, err: (e as Error).message }, 'persona.asset.process_failed')
    await markAssetFailed(assetId, (e as Error).message)
  } finally {
    await cleanup(tempFiles)
  }
}

async function sha256Of(filePath: string): Promise<string> {
  const crypto = await import('node:crypto')
  const fs = await import('node:fs')
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** 注册 worker（concurrency 2：转码吃 CPU，避免打满） */
export function registerAssetProcessWorker(): void {
  registerWorker(
    QUEUE_NAMES.personaAssetProcess,
    async (job) => {
      const { assetId } = job.data as { assetId: string }
      if (!assetId) return
      await processAsset(assetId)
    },
    { concurrency: 2 },
  )
}
