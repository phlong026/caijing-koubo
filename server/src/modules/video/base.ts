import { err } from '../../errors.js'
import { getVideoJob } from './repo.js'
import { signMediaUrl } from './routes.js'
import type { TimelineItem } from './types.js'

/**
 * FR-X1：基础视频取用契约（给视频剪辑模块）。
 * 仅 completed 返回；产物 URL 按存储模式给 OSS 签名 URL 或本地 /media 签名链接（V12）。
 */

export interface BaseVideoPayload {
  videoJobId: string
  versionNo: number
  mode: string
  copyId: string
  copyVersionId: string
  copyVersionNo: number
  persona: { id: string; name: string; line: string | null; versionId: string | null }
  avatar: { avatarId: string | null; backgroundLabel: string | null }
  url: string
  coverUrl: string | null
  durationMs: number
  width: number
  height: number
  timeline: TimelineItem[]
  timelineSource: string
  alignScore: number | null
  riskText: string | null
  isMock: boolean
}

async function storageMode(): Promise<'oss' | 'local'> {
  const { isOssEnabled } = await import('../../integrations/aliyun-oss/client.js')
  return isOssEnabled() ? 'oss' : 'local'
}

export async function getBaseVideo(jobId: string): Promise<BaseVideoPayload> {
  const job = await getVideoJob(jobId)
  if (!job) throw err.notFound('视频任务不存在')
  if (job.phase !== 'completed' || !job.resultKey) throw err.videoNotReady('基础视频尚未完成，不能取用')
  const { signedUrl } = await import('../../integrations/aliyun-oss/client.js')
  const mode = await storageMode()
  const url = mode === 'oss' ? await signedUrl(job.resultKey) : signMediaUrl(job.resultKey)
  const coverUrl = job.coverKey ? (mode === 'oss' ? await signedUrl(job.coverKey) : signMediaUrl(job.coverKey)) : null
  return {
    videoJobId: job.id,
    versionNo: job.versionNo,
    mode: job.mode,
    copyId: job.copyId,
    copyVersionId: job.copyVersionId,
    copyVersionNo: job.copyVersionNo,
    persona: { id: job.personaId, name: '', line: job.line, versionId: job.personaVersionId },
    avatar: { avatarId: job.avatarId, backgroundLabel: job.configSnapshot?.avatar?.backgroundLabel ?? null },
    url,
    coverUrl,
    durationMs: job.durationMs,
    width: job.width,
    height: job.height,
    timeline: job.timeline ?? [],
    timelineSource: job.timelineSource ?? 'estimated',
    alignScore: job.alignScore,
    riskText: job.textSnapshot?.segments.filter((s) => s.kind === 'risk').map((s) => s.text).join('') ?? null,
    isMock: !!job.isMock,
  }
}
