/** TikHub 平台无关 DTO（§3.1 字段口径；扩展平台只加解析实现） */
export interface TikUser {
  secUid: string
  uid: string
  nickname: string
  fansCount: number
  avatarUrl: string | null
}

export interface TikPost {
  videoId: string
  title: string
  coverUrl: string | null
  duration: number | null
  playCount: number
  diggCount: number
  commentCount: number
  shareCount: number
  isTop: boolean
  publishedAt: Date | null
  shareUrl: string | null
}

export interface TikPostPage {
  posts: TikPost[]
  nextCursor: number | null
  hasMore: boolean
}

export interface TikVideoDetail {
  videoId: string
  title: string
  coverUrl: string | null
  /** 新鲜播放地址（有时效，不持久化，提取时重新获取 D11） */
  playUrl: string | null
  duration: number | null
  authorNickname: string | null
  authorSecUid: string | null
  playCount: number
  diggCount: number
  commentCount: number
  shareCount: number
  publishedAt: Date | null
}

export interface TikShareParse {
  videoId: string
  authorSecUid: string | null
  authorNickname: string | null
  title: string | null
}
