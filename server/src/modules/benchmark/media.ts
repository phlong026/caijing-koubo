import axios from 'axios'
import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { getVideoById } from './videos.js'
import { fetchVideoDetail } from '../../integrations/tikhub/client.js'
import { config } from '../../config.js'
import { getQueueBackend, redis } from '../../queue/index.js'

type PlaybackEntry = { url: string; title: string; expires: number }

/**
 * P2-11：播放地址缓存。Redis 可用时放 Redis（多实例共享：/playback 与 /media 可能落到不同实例），
 * 否则退回进程内 Map。缓存 5 分钟，期间重复播放不再调用 TikHub 详情（计费）。
 */
const PLAYBACK_TTL_MS = 5 * 60_000
const localPlayback = new Map<string, PlaybackEntry>()
const playbackKey = (id: string) => `${config.queuePrefix}:playback:${id}`

async function getPlayback(id: string): Promise<PlaybackEntry | null> {
  if (getQueueBackend() === 'redis') {
    const raw = await redis.get(playbackKey(id)).catch(() => null)
    if (raw) {
      try {
        return JSON.parse(raw) as PlaybackEntry
      } catch {
        /* 损坏的缓存按未命中处理 */
      }
    }
    return null
  }
  const now = Date.now()
  for (const [key, entry] of localPlayback) if (entry.expires <= now) localPlayback.delete(key)
  return localPlayback.get(id) ?? null
}

async function setPlayback(id: string, entry: PlaybackEntry): Promise<void> {
  if (getQueueBackend() === 'redis') {
    await redis.set(playbackKey(id), JSON.stringify(entry), 'PX', PLAYBACK_TTL_MS).catch(() => undefined)
    return
  }
  if (localPlayback.size >= 50) localPlayback.delete(localPlayback.keys().next().value!)
  localPlayback.set(id, entry)
}
export function assertVideoCdn(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !/(^|\.)(douyinvod\.com|zjcdn\.com|douyin\.com|douyincdn\.com|snssdk\.com|bytecdn\.cn|amemv\.com)$/.test(url.hostname)) {
    throw err.upstream('播放地址不属于受支持的抖音 CDN')
  }
  return url
}

export function registerBenchmarkMedia(app: FastifyInstance): void {
  app.get('/benchmark/videos/:id/playback', async req => {
    const { id } = req.params as { id: string }
    const video = await getVideoById(id)
    if (!video) throw err.notFound('视频不存在')
    let entry = await getPlayback(id)
    if (!entry || entry.expires <= Date.now()) {
      const detail = await fetchVideoDetail(video.videoId)
      if (!detail.playUrl) throw err.upstream('未获取到可播放地址，可前往抖音查看原视频')
      assertVideoCdn(detail.playUrl)
      entry = { url: detail.playUrl, title: detail.title, expires: Date.now() + PLAYBACK_TTL_MS }
      await setPlayback(id, entry)
    }
    return ok({ playUrl: `/api/benchmark/videos/${encodeURIComponent(id)}/media`, title: entry.title })
  })

  app.get('/benchmark/videos/:id/media', async (req, reply) => {
    const { id } = req.params as { id: string }
    const entry = await getPlayback(id)
    if (!entry || entry.expires <= Date.now()) throw err.upstream('播放地址已过期，请重新点击播放')
    const range = req.headers.range
    if (range && !/^bytes=\d*-\d*$/.test(range)) throw err.badRequest('不支持的播放范围')
    const controller = new AbortController()
    reply.raw.on('close', () => controller.abort())
    let current = entry.url
    try {
      for (let hop = 0; hop < 4; hop++) {
        assertVideoCdn(current)
        const response = await axios.get(current, {
          responseType: 'stream', maxRedirects: 0, timeout: 25_000, signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.douyin.com/', ...(range ? { Range: range } : {}) },
          validateStatus: status => [200, 206, 301, 302, 303, 307, 308].includes(status),
        })
        if (response.status >= 300) {
          response.data.destroy()
          if (!response.headers.location) throw new Error('missing redirect')
          current = new URL(response.headers.location, current).href
          continue
        }
        reply.status(response.status).header('Content-Type', 'video/mp4').header('Cache-Control', 'private, max-age=300')
        for (const header of ['content-length', 'content-range', 'accept-ranges']) {
          if (response.headers[header]) reply.header(header, response.headers[header])
        }
        return reply.send(response.data)
      }
    } catch { throw err.upstream('暂时无法读取视频，可重新播放或打开抖音原视频') }
    throw err.upstream('视频跳转次数过多')
  })
}
