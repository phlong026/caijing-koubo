import { createHash } from 'node:crypto'
import type { TikPost, TikPostPage, TikShareParse, TikUser, TikVideoDetail } from './types.js'

/**
 * mock 兜底（仅开发/联调使用，MOCK_FALLBACK=true 且无 key 时生效）。
 * 数据确定性可复现：同一 sec_uid / video_id 每次返回一致，便于验证增量与去重。
 */
function h(source: string): string {
  return createHash('sha1').update(source).digest('hex')
}
function num(source: string, mod = 100000): number {
  return parseInt(h(source).slice(0, 8), 16) % mod
}

const TITLES = [
  '三条思路看懂今天的资金流向',
  '定投最常见的三个误区',
  '债基为什么也会波动',
  '红利策略适合什么人',
  '读懂基金季报的三个维度',
  '市场震荡期，仓位怎么管',
  '费率下调对持有人的影响',
  'ETF 与场外基金的区别',
  '怎么用一句话讲清复利',
  '新手开户前必须知道的事',
]

export function mockUser(secUid: string): TikUser {
  const s = h(secUid)
  return {
    secUid,
    uid: String(num(s, 9_000_000_000) + 1_000_000_000),
    nickname: `示例账号_${s.slice(0, 4)}`,
    fansCount: num(s + 'fans', 500_000) + 5_000,
    avatarUrl: null,
  }
}

export function mockUserPosts(secUid: string, cursor = 0, count = 20): TikPostPage {
  const now = Date.now()
  // 以 10 分钟为窗口产生"新视频"，便于验证新发布告警链路
  const bucket = Math.floor(now / (10 * 60_000))
  const posts: TikPost[] = []
  const page = cursor === 0 ? 0 : 1

  for (let i = 0; i < count; i++) {
    const idx = page * count + i
    // 第 1 页前两条为置顶作品（FR-B3：置顶不参与"遇到已知视频即停"判断）
    const isTop = page === 0 && i < 2
    const seedKey = isTop ? `${secUid}:top:${i}` : `${secUid}:post:${bucket - idx}`
    const s = h(seedKey)
    const videoId = String(num(s, 9_000_000_000_000_000_000) + 1_000_000_000_000_000_000)
    posts.push({
      videoId,
      title: TITLES[Math.abs(num(seedKey, TITLES.length))] ?? TITLES[0],
      coverUrl: null,
      duration: 45 + num(s + 'd', 240),
      // 非本人视频的 play_count 实测常为 0（§9 口径），mock 与之保持一致
      playCount: 0,
      diggCount: num(s + 'digg', 20_000),
      commentCount: num(s + 'cmt', 2_000),
      shareCount: num(s + 'share', 1_500),
      isTop,
      publishedAt: new Date(now - (idx * 3 + 1) * 3600_000),
      shareUrl: `https://www.douyin.com/video/${videoId}`,
    })
  }
  return { posts, nextCursor: cursor === 0 ? now : null, hasMore: cursor === 0 }
}

export function mockVideoDetail(videoId: string): TikVideoDetail {
  const s = h(videoId)
  return {
    videoId,
    title: TITLES[num(videoId, TITLES.length)] ?? TITLES[0],
    coverUrl: null,
    // 提取链路 mock：指向一个占位地址，真实 key 下为抖音 CDN 签名地址
    playUrl: `https://www.iesdouyin.com/mock/play/${videoId}.mp4`,
    duration: 45 + num(s + 'd', 240),
    authorNickname: `示例账号_${s.slice(0, 4)}`,
    authorSecUid: `MS4wLjABAAAA${s.slice(0, 20)}`,
    playCount: 0,
    diggCount: num(s + 'digg', 20_000),
    commentCount: num(s + 'cmt', 2_000),
    shareCount: num(s + 'share', 1_500),
    publishedAt: new Date(Date.now() - 3600_000),
  }
}

export function mockShareParse(url: string): TikShareParse {
  const s = h(url)
  return {
    videoId: String(num(s, 9_000_000_000_000_000_000) + 1_000_000_000_000_000_000),
    authorSecUid: `MS4wLjABAAAA${s.slice(4, 24)}`,
    authorNickname: `示例账号_${s.slice(0, 4)}`,
    title: TITLES[num(url, TITLES.length)] ?? TITLES[0],
  }
}
