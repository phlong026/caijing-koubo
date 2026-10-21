import axios from 'axios'
import { config, hasTikHub } from '../../config.js'
import { logger } from '../../log.js'
import { logApiCall } from '../../modules/metrics/call-log.js'
import { mockShareParse, mockUser, mockUserPosts, mockVideoDetail } from './mock.js'
import type { TikPost, TikPostPage, TikShareParse, TikUser, TikVideoDetail } from './types.js'

/**
 * TikHub 客户端（D4）。
 * 官方 APP v3 路径；2026-10-18 按 OpenAPI 核对并实测。
 * 用户、作品列表用 sec_user_id；详情用 aweme_id；分享解析用 share_url。
 * 响应信封：{ code, message, data, request_id }，非 200 视为失败。
 */

function unwrap(body: any): any {
  if (!body || typeof body !== 'object') return null
  if (body.data !== undefined) return body.data
  return body
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function msToSec(d: unknown): number | null {
  const n = num(d)
  if (!n) return null
  // TikHub 原始视频时长单位是毫秒，包括不足 10 秒的视频。
  return Math.max(1, Math.round(n / 1000))
}

function tsToDate(t: unknown): Date | null {
  const n = num(t)
  if (!n) return null
  return new Date(n > 1e12 ? n : n * 1000)
}

function firstUrl(v: unknown, image = false): string | null {
  const list = (v as { url_list?: unknown[] } | undefined)?.url_list
  if (Array.isArray(list) && list.length) {
    // APP v3 优先返回 HEIC，Chrome 无法显示；使用上游自带签名的 JPEG/WebP 备选。
    const compatible = image ? list.find(u => typeof u === 'string' && /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(u)) : null
    return String(compatible ?? list[0])
  }
  if (typeof v === 'string') return v
  return null
}

function parseAweme(a: any): TikPost {
  const st = a?.statistics ?? {}
  return {
    videoId: String(a?.aweme_id ?? ''),
    width: num(a?.video?.width),
    height: num(a?.video?.height),
    authorNickname: a?.author?.nickname ?? null,
    authorSecUid: a?.author?.sec_uid ?? null,
    title: String(a?.desc ?? a?.title ?? '').trim() || '(无标题)',
    coverUrl: firstUrl(a?.video?.cover ?? a?.video?.origin_cover ?? a?.cover, true),
    duration: msToSec(a?.duration ?? a?.video?.duration),
    playCount: num(st.play_count ?? a?.play_count),
    diggCount: num(st.digg_count ?? a?.digg_count),
    commentCount: num(st.comment_count ?? a?.comment_count),
    shareCount: num(st.share_count ?? a?.share_count),
    isTop: a?.is_top === 1 || a?.is_top === true,
    publishedAt: tsToDate(a?.create_time),
    shareUrl: a?.share_url ? String(a.share_url) : null,
  }
}

function parseDetail(a: any): TikVideoDetail {
  const p = parseAweme(a)
  return {
    videoId: p.videoId,
    title: p.title,
    coverUrl: p.coverUrl,
    playUrl: firstUrl(a?.video?.play_addr ?? a?.video?.download_addr ?? a?.play_addr),
    duration: p.duration,
    authorNickname: a?.author?.nickname ?? null,
    authorSecUid: a?.author?.sec_uid ?? null,
    playCount: p.playCount,
    diggCount: p.diggCount,
    commentCount: p.commentCount,
    shareCount: p.shareCount,
    publishedAt: p.publishedAt,
  }
}

/** 统一请求：超时 + 一次自动重试 + 写 api_call_log（FR-C4） */
async function request(
  path: string,
  params: Record<string, unknown>,
  ref?: { type: string; id: string },
): Promise<any> {
  const started = Date.now()
  const endpoint = `${config.tikhub.baseUrl}${path}`

  if (!hasTikHub()) {
    if (!config.mockFallback) throw new Error('TIKHUB_API_KEY 未配置')
    await logApiCall({
      provider: 'tikhub',
      endpoint: `${path} (mock)`,
      refType: ref?.type,
      refId: ref?.id,
      ok: true,
      durationMs: Date.now() - started,
      cost: 0,
    })
    return null // 由各方法走 mock 数据源
  }

  let lastErr = ''
  for (let attempt = 0; attempt <= config.tikhub.retry; attempt++) {
    try {
      const res = await axios.get(endpoint, {
        params,
        headers: { Authorization: `Bearer ${config.tikhub.apiKey}` },
        timeout: config.tikhub.timeoutMs,
        maxRedirects: 0,
        maxContentLength: 8 * 1024 * 1024,
      })
      const body = res.data
      const code = body?.code ?? 200
      if (code !== 200) {
        throw new Error(`TikHub code=${code} ${body?.message_zh ?? body?.message ?? ''}`.trim())
      }
      const data = unwrap(body)
      if (!data || (data.status_code !== undefined && Number(data.status_code) !== 0)) {
        throw new Error(`TikHub 数据不可用：${data?.status_msg || '未返回有效数据'}`)
      }
      await logApiCall({
        provider: 'tikhub',
        endpoint: path,
        refType: ref?.type,
        refId: ref?.id,
        ok: true,
        httpStatus: res.status,
        durationMs: Date.now() - started,
        cost: config.tikhub.unitPrice,
        requestId: body?.request_id ? String(body.request_id) : null,
      })
      return data
    } catch (e: any) {
      const detail = e?.response?.data?.detail ?? e?.response?.data
      lastErr = String(detail?.message_zh ?? detail?.message ?? e?.message ?? '请求失败')
        .split(config.tikhub.apiKey).join('[已隐藏]')
      const status = e?.response?.status ?? null
      const retryable = status === null || status >= 500 || e?.code === 'ECONNABORTED'
      if (attempt === config.tikhub.retry || !retryable) {
        await logApiCall({
          provider: 'tikhub',
          endpoint: path,
          refType: ref?.type,
          refId: ref?.id,
          ok: false,
          httpStatus: status,
          durationMs: Date.now() - started,
          error: lastErr,
        })
        break
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  throw new Error(`TikHub 调用失败（${path}）：${lastErr}`)
}

export function isMockMode(): boolean {
  return !hasTikHub()
}

export async function fetchUserInfo(secUid: string): Promise<TikUser> {
  const data = await request(config.tikhub.paths.userInfo, { sec_user_id: secUid }, { type: 'account', id: secUid })
  if (data === null) return mockUser(secUid)
  const u = data?.user ?? data?.user_info ?? data
  if (!u?.nickname) throw new Error('TikHub 未返回有效账号信息，请检查主页链接')
  return {
    secUid: String(u?.sec_uid ?? secUid),
    uid: String(u?.uid ?? ''),
    nickname: String(u?.nickname ?? ''),
    fansCount: num(u?.follower_count ?? u?.fans_count),
    avatarUrl: firstUrl(u?.avatar_larger ?? u?.avatar_thumb ?? u?.avatar, true),
  }
}

export async function fetchUserPosts(
  secUid: string,
  cursor = 0,
  count = 20,
  ref?: { type: string; id: string },
): Promise<TikPostPage> {
  const data = await request(
    config.tikhub.paths.userPosts,
    { sec_user_id: secUid, max_cursor: cursor, count, sort_type: 0 },
    ref ? { ...ref } : { type: 'account', id: secUid },
  )
  if (data === null) return mockUserPosts(secUid, cursor, count)
  const list: any[] = data?.aweme_list ?? data?.awemeList ?? data?.list
  if (!Array.isArray(list)) throw new Error('TikHub 未返回作品列表，账号可能私密或接口暂不可用')
  const posts = list.filter((a) => a?.aweme_id).map(parseAweme)
  const nextCursor = num(data?.max_cursor) || null
  return { posts, nextCursor, hasMore: data?.has_more === 1 || data?.has_more === true }
}

export async function fetchVideoDetail(videoId: string): Promise<TikVideoDetail> {
  const data = await request(
    config.tikhub.paths.videoDetail,
    { aweme_id: videoId },
    { type: 'video', id: videoId },
  )
  if (data === null) return mockVideoDetail(videoId)
  const a = data?.aweme_detail ?? data?.aweme_list?.[0] ?? data
  return parseDetail(a)
}

/** 分享链接解析（FR-B8 直接提取；入参链接须先过白名单） */
export async function parseShareLink(shareUrl: string): Promise<TikShareParse> {
  const data = await request(
    config.tikhub.paths.shareParse,
    { share_url: shareUrl },
    { type: 'link', id: shareUrl.slice(0, 64) },
  )
  if (data === null) return mockShareParse(shareUrl)
  const a = data?.aweme_detail ?? data?.aweme_list?.[0] ?? data
  return {
    videoId: String(a?.aweme_id ?? ''),
    authorSecUid: a?.author?.sec_uid ?? null,
    authorNickname: a?.author?.nickname ?? null,
    title: a?.desc ? String(a.desc).slice(0, 500) : null,
  }
}

/** 无 key / 欠费时给出可读错误，不崩溃 */
export function describeUpstream(): string {
  return hasTikHub() ? 'TikHub 已配置' : 'TikHub 未配置（当前为 mock 兜底数据）'
}
