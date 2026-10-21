import axios from 'axios'
import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { getVideoById } from './videos.js'
import { fetchVideoDetail } from '../../integrations/tikhub/client.js'

const playback = new Map<string, { url: string; title: string; expires: number }>()
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
    const now = Date.now()
    for (const [key, entry] of playback) if (entry.expires <= now) playback.delete(key)
    if (!playback.has(id)) {
      const detail = await fetchVideoDetail(video.videoId)
      if (!detail.playUrl) throw err.upstream('未获取到可播放地址，可前往抖音查看原视频')
      assertVideoCdn(detail.playUrl)
      if (playback.size >= 50) playback.delete(playback.keys().next().value!)
      playback.set(id, { url: detail.playUrl, title: detail.title, expires: now + 5 * 60_000 })
    }
    return ok({ playUrl: `/api/benchmark/videos/${encodeURIComponent(id)}/media`, title: playback.get(id)!.title })
  })

  app.get('/benchmark/videos/:id/media', async (req, reply) => {
    const { id } = req.params as { id: string }
    const entry = playback.get(id)
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
