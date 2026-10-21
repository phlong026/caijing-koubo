import { config, hasTikHub, hasDashScope, hasOss } from '../../config.js'
import { getDb } from '../../db/index.js'
import { fromDb } from '../../lib/time.js'

// 旧 smoke 测试数据保留在数据库；实际运营视图单独统计，避免混入真实样本。
export async function getResearchOverview() {
  const db = getDb()
  const accounts = await db.get<{ total: number; monitoring: number }>(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN `monitor_status` = 'on' THEN 1 ELSE 0 END) AS monitoring FROM `benchmark_account` WHERE `removed_at` IS NULL AND NOT (`added_by` = 'smoke' AND `nickname` LIKE '示例账号_%')",
  )
  const stats = await db.get<{ total: number; hot: number; interactions: number; lastFetched: string | null }>(
    "SELECT COUNT(*) AS total, SUM(v.`is_hot`) AS hot, SUM(v.`interact_total`) AS interactions, MAX(COALESCE(v.`stats_updated_at`, v.`fetched_at`)) AS lastFetched FROM `benchmark_video` v WHERE NOT EXISTS (SELECT 1 FROM `benchmark_account` a WHERE a.`id` = v.`account_id` AND a.`added_by` = 'smoke' AND a.`nickname` LIKE '示例账号_%') AND COALESCE(v.`author_nickname`, '') NOT LIKE '示例账号_%'",
  )
  return {
    provider: { name: 'TikHub', mode: hasTikHub() ? 'live' : config.mockFallback ? 'demo' : 'unconfigured' },
    accounts: Number(accounts?.total ?? 0),
    monitoring: Number(accounts?.monitoring ?? 0),
    videos: Number(stats?.total ?? 0),
    hotVideos: Number(stats?.hot ?? 0),
    interactions: Number(stats?.interactions ?? 0),
    lastFetchedAt: fromDb(stats?.lastFetched ?? null),
    extractionReady: hasDashScope() && (config.extract.mode === 'direct' || hasOss()),
    methodology: {
      interactionFields: ['点赞', '评论', '分享'],
      multiplier: config.hot.multiplier,
      sampleSize: config.hot.baselineSample,
      minSample: config.hot.minSample,
      refreshDays: config.hot.refreshDays,
      formula: `本条赞评转 > 同账号最近 ${config.hot.baselineSample} 条（排除本条）赞评转均值 × ${config.hot.multiplier}`,
    },
  }
}
