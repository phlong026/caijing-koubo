/**
 * 数据看板模块 · 类型与常量（任务书 v1.0 §4 / v1.1 §3 / v1.2）。
 *
 * 口径约定（DB2）：快照粒度为 publish_log 记录级——一条已发布内容 × 一个窗口 = 一行，
 * 平台 / 账号 / 线 / 人物维度全部由 publish_log → plan → copy → persona JOIN 上卷，
 * 不在 metric_snapshot 里冗余，保证单一事实源。
 */

export type MetricWindow = 't1' | 't7'

export const METRIC_WINDOWS: MetricWindow[] = ['t1', 't7']

export const WINDOW_LABELS: Record<MetricWindow, string> = { t1: 'T+1', t7: 'T+7' }

/** 窗口 → 到期延迟（小时），由 config.analytics 注入 */
export function windowDelayHours(window: MetricWindow, t1Hours: number, t7Hours: number): number {
  return window === 't1' ? t1Hours : t7Hours
}

export function asWindow(v: unknown): MetricWindow {
  return String(v) === 't7' ? 't7' : 't1'
}

/** 六项基础指标（DB6）：平台缺项置 null，不补 0（Q5） */
export interface MetricValues {
  plays: number
  likes: number
  comments: number
  shares: number
  collects: number
  fansGained: number
  completionRate: number | null
}

export interface MetricSnapshot extends MetricValues {
  id: string
  publishLogId: string
  platform: string
  accountId: string
  window: MetricWindow
  /** 1 爆款 / 0 非爆款 / null 样本不足（DB3） */
  isHot: 0 | 1 | null
  accountAvgPlays: number | null
  capturedAt: string | null
  source: 'csv' | 'provider'
}

/** 互动量口径：赞 + 评 + 转 + 藏（原型「互动」= 四者之和） */
export function interactOf(m: Pick<MetricValues, 'likes' | 'comments' | 'shares' | 'collects'>): number {
  return (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.collects ?? 0)
}

/* ── CSV 列映射（Q8 已拍板引入 papaparse；列名中英兼容） ─────────────── */

export type CsvField =
  | 'externalVideoId'
  | 'title'
  | 'accountName'
  | 'publishedAt'
  | 'plays'
  | 'likes'
  | 'comments'
  | 'shares'
  | 'collects'
  | 'fansGained'
  | 'completionRate'

/**
 * 标准列 → 可识别的表头别名（归一化后比较：小写、去空白与括号内容）。
 * 各平台创作者中心导出格式互不一致，这里用「别名集合 + 包含匹配」兜底。
 */
export const CSV_HEADER_ALIASES: Record<CsvField, string[]> = {
  externalVideoId: [
    '视频id', '作品id', '笔记id', '动态id', '视频编号', '作品编号', '内容id',
    'videoid', 'video_id', 'itemid', 'item_id', 'noteid', 'note_id', 'awemeid',
  ],
  title: ['作品标题', '视频标题', '笔记标题', '内容标题', '标题', '作品名称', '视频描述', 'title', 'name'],
  accountName: ['账号名称', '账号昵称', '账号', '昵称', '作者', '发布账号', '博主', 'account', 'nickname', 'author'],
  publishedAt: ['发布时间', '发布日期', '发表时间', '发布日期时间', '日期', 'publishtime', 'publish_time', 'publishedat', 'published_at', 'posttime'],
  plays: ['播放量', '播放次数', '播放', '观看量', '阅读量', '曝光量', 'playcount', 'play_count', 'plays', 'viewcount', 'view_count', 'vv'],
  likes: ['点赞量', '点赞数', '点赞', '喜欢数', 'diggcount', 'digg_count', 'likecount', 'like_count', 'likes'],
  comments: ['评论量', '评论数', '评论', 'commentcount', 'comment_count', 'comments'],
  shares: ['分享量', '分享数', '转发数', '分享', '转发', 'sharecount', 'share_count', 'shares', 'forward'],
  collects: ['收藏量', '收藏数', '收藏', 'collectcount', 'collect_count', 'collects', 'favoritecount', 'favorite_count'],
  fansGained: ['粉丝增量', '新增粉丝', '涨粉数', '涨粉', '新增关注', 'fansgained', 'fans_gained', 'newfans', 'new_fans'],
  completionRate: ['完播率', '五秒完播率', '5秒完播率', '完播', 'completionrate', 'completion_rate'],
}

/** 必需列：至少要能定位到发布记录（FR-M1 两级匹配） */
export const CSV_REQUIRED_ONE_OF: CsvField[] = ['externalVideoId', 'title']

/** 四平台推荐表头（下载模板用；导入不强制列序） */
export const CSV_TEMPLATES: Record<string, { label: string; headers: string[]; sample: string[] }> = {
  douyin: {
    label: '抖音',
    headers: ['视频ID', '作品标题', '账号名称', '发布时间', '播放量', '点赞量', '评论量', '分享量', '收藏量', '粉丝增量', '完播率'],
    sample: ['7384726150938472615', '这一轮调整的三个信号', '张经理财经', '2026-10-20 12:30', '128000', '3200', '186', '94', '412', '58', '38.5%'],
  },
  xiaohongshu: {
    label: '小红书',
    headers: ['笔记ID', '笔记标题', '账号名称', '发布时间', '观看量', '点赞量', '评论量', '分享量', '收藏量', '粉丝增量'],
    sample: ['66f1c2a9000000001e01abcd', '债基也会跌，先看清这三件事', '小林投教', '2026-10-20 19:10', '46000', '1800', '76', '55', '620', '31'],
  },
  kuaishou: {
    label: '快手',
    headers: ['作品ID', '作品标题', '账号名称', '发布时间', '播放量', '点赞量', '评论量', '分享量', '收藏量', '粉丝增量'],
    sample: ['3xf8k2m1q9', '定投到底适不适合你', '老周聊债基', '2026-10-19 20:00', '72000', '2100', '64', '28', '190', '22'],
  },
  shipinhao: {
    label: '视频号',
    headers: ['动态ID', '标题', '账号名称', '发布时间', '播放量', '点赞量', '评论量', '转发量', '收藏量', '涨粉数'],
    sample: ['1408723948', '利率下行，债基为什么反而跌', '张经理财经', '2026-10-18 08:30', '96000', '2400', '102', '168', '340', '44'],
  },
}

/* ── 特征归因五维度（A4 / DB4） ─────────────────────────────────── */

export type FeatureDimKey = 'hook' | 'duration' | 'cover' | 'publishTime' | 'direction'

export const FEATURE_DIMS: Array<{ key: FeatureDimKey; label: string; note: string }> = [
  { key: 'hook', label: '开场钩子类型', note: '一期以「文案模板 × 选题方向」代理（Q3）' },
  { key: 'duration', label: '时长区间', note: '按成片时长档位' },
  { key: 'cover', label: '封面样式', note: '按封面来源档位' },
  { key: 'publishTime', label: '发布时间', note: '按发布完成时刻的时段档' },
  { key: 'direction', label: '选题方向', note: '按选题方向标签' },
]

/** 时长档（秒）：<15 / 15-30 / 30-60 / >60 */
export function durationBucket(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '未记录'
  if (seconds < 15) return '<15 秒'
  if (seconds < 30) return '15-30 秒'
  if (seconds < 60) return '30-60 秒'
  return '>60 秒'
}

/** 发布时段档（0-6 / 6-12 / 12-18 / 18-24，按北京时间） */
export function hourBucket(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return '未记录'
  // 存储为 UTC，展示与归因按北京时间（+8）
  const h = (date.getUTCHours() + 8) % 24
  if (h < 6) return '0-6 点'
  if (h < 12) return '6-12 点'
  if (h < 18) return '12-18 点'
  return '18-24 点'
}

export const COVER_LABELS: Record<string, string> = {
  first_frame: '首帧封面',
  custom: '自定义封面',
}

export function coverBucket(source: string | null | undefined): string {
  if (!source) return '未记录'
  return COVER_LABELS[source] ?? source
}

/** 「未记录 / 未标注」不参与高表现取值竞争（避免脏数据抢 top） */
export function isUnknownValue(v: string): boolean {
  return v === '未记录' || v === '未标注'
}
