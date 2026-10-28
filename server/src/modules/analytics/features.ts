import type { Db } from '../../db/index.js'
import { getDb } from '../../db/index.js'
import { jdec } from '../../lib/util.js'
import { toDb, fromDb, fromIso } from '../../lib/time.js'
import { config } from '../../config.js'
import { err } from '../../errors.js'
import {
  coverBucket,
  durationBucket,
  FEATURE_DIMS,
  hourBucket,
  isUnknownValue,
  type FeatureDimKey,
  type MetricWindow,
} from './types.js'
import { buildBasisText, getActiveProfile, saveActiveProfile, type PreferenceProfileRow } from './preference.js'

/**
 * 爆款特征沉淀（FR-M6 / FR-M7 / DB4：一期规则统计，不做模型）。
 *
 * 五维度取值：
 *  - 钩子：以「文案模板 × 选题方向」代理（Q3，视频无 CV 分析）；
 *  - 时长：成片时长档（video_job.duration_ms，缺失时回落创作设置里的目标时长）；
 *  - 封面：封面来源档（首帧 / 自定义）；
 *  - 发布时间：发布完成时刻的时段档（北京时间）；
 *  - 选题方向：topic.direction。
 *
 * 每个维度输出「高表现取值 + 爆款占比」，占比定义为**该取值在爆款样本中的占比**；
 * 同时给出 hotRate（该取值的爆款率）供人工判断相关性强度。
 */

interface SampleRow {
  log_id: string
  is_hot: number | null
  finished_at: string | null
  cover_source: string | null
  copy_settings: unknown
  direction: string | null
  duration_ms: number | null
}

export interface FeatureValueStat {
  value: string
  count: number
  hotCount: number
  ratio: number
  hotRate: number
}

export interface FeatureDimStat {
  key: FeatureDimKey
  label: string
  note: string
  validSamples: number
  top: FeatureValueStat | null
  items: FeatureValueStat[]
  status: '待确认' | '样本不足' | '已沉淀'
}

export interface FeatureStats {
  window: MetricWindow
  days: number
  sampleCount: number
  hotCount: number
  minHotSamples: number
  dims: FeatureDimStat[]
  basisText: string
  /** 当前 active 偏好档案（前端展示「已确认」状态与已生效文案） */
  profile: PreferenceProfileRow | null
  empty: boolean
}

function r2(n: number): number {
  return Number(n.toFixed(4))
}

async function loadSamples(window: MetricWindow, days: number, db: Db): Promise<SampleRow[]> {
  const since = toDb(new Date(Date.now() - days * 86_400_000))
  return db.all<SampleRow>(
    `SELECT s.\`publish_log_id\` AS \`log_id\`, s.\`is_hot\`, l.\`finished_at\`, p.\`cover_source\`,
            c.\`settings\` AS \`copy_settings\`, t.\`direction\`, v.\`duration_ms\`
     FROM \`metric_snapshot\` s
     JOIN \`publish_log\` l ON l.\`id\` = s.\`publish_log_id\`
     LEFT JOIN \`publish_plan\` p ON p.\`id\` = l.\`plan_id\`
     LEFT JOIN \`copy\` c ON c.\`id\` = p.\`copy_id\`
     LEFT JOIN \`topic\` t ON t.\`id\` = c.\`topic_id\`
     LEFT JOIN \`video_job\` v ON v.\`id\` = p.\`video_job_id\`
     WHERE s.\`window\` = ? AND l.\`finished_at\` >= ?`,
    [window, since],
  )
}

/** 模板 id → 名称（copy.settings.templateId 是 JSON 内字段，不能 SQL JOIN） */
async function templateNames(ids: string[], db: Db): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const list = Array.from(new Set(ids.filter(Boolean)))
  if (!list.length) return out
  const ph = list.map(() => '?').join(', ')
  const rows = await db.all<{ id: string; name: string }>(
    `SELECT \`id\`, \`name\` FROM \`copy_template\` WHERE \`id\` IN (${ph})`,
    list,
  )
  for (const r of rows) out.set(r.id, r.name)
  return out
}

export async function buildFeatures(
  query: { window?: unknown; days?: unknown },
  db: Db = getDb(),
): Promise<FeatureStats> {
  const window: MetricWindow = String(query.window) === 't7' ? 't7' : 't1'
  const days = Math.min(config.analytics.maxDays, Math.max(7, Number(query.days ?? 30) || 30))

  const samples = await loadSamples(window, days, db)
  const settings = samples.map((s) => jdec<{ templateId?: string; durationSeconds?: number } | null>(s.copy_settings, null))
  const names = await templateNames(settings.map((s) => s?.templateId ?? ''), db)

  const hotTotal = samples.filter((s) => Number(s.is_hot) === 1).length
  const dimValues = new Map<FeatureDimKey, string[]>()
  const push = (k: FeatureDimKey, v: string) => {
    const list = dimValues.get(k) ?? []
    list.push(v)
    dimValues.set(k, list)
  }

  samples.forEach((s, i) => {
    const setting = settings[i] ?? null
    const templateName = setting?.templateId ? names.get(setting.templateId) ?? '已删除模板' : '未记录模板'
    const direction = s.direction?.trim() || '未标注'
    push('hook', `${templateName} × ${direction}`)
    const seconds = s.duration_ms && s.duration_ms > 0
      ? s.duration_ms / 1000
      : setting?.durationSeconds ?? null
    push('duration', durationBucket(seconds))
    push('cover', coverBucket(s.cover_source))
    push('publishTime', hourBucket(fromIso(fromDb(s.finished_at))))
    push('direction', direction)
  })

  const active = await getActiveProfile(db)
  const activeDims = jdec<{ dims?: Record<string, { value?: string }> }>(active?.profile, {})?.dims ?? {}

  const dims: FeatureDimStat[] = FEATURE_DIMS.map((dim) => {
    const values = dimValues.get(dim.key) ?? []
    const agg = new Map<string, { count: number; hotCount: number }>()
    values.forEach((v, i) => {
      const a = agg.get(v) ?? { count: 0, hotCount: 0 }
      a.count += 1
      if (Number(samples[i]?.is_hot) === 1) a.hotCount += 1
      agg.set(v, a)
    })
    const items: FeatureValueStat[] = Array.from(agg.entries())
      .map(([value, a]) => ({
        value,
        count: a.count,
        hotCount: a.hotCount,
        ratio: hotTotal ? r2(a.hotCount / hotTotal) : 0,
        hotRate: a.count ? r2(a.hotCount / a.count) : 0,
      }))
      .sort((a, b) => (b.hotCount - a.hotCount) || (b.count - a.count) || a.value.localeCompare(b.value))

    // 「未记录 / 未标注」不参与高表现取值竞争，但仍保留在明细里供核对
    const top = items.find((it) => !isUnknownValue(it.value)) ?? null
    const validSamples = values.filter((v) => !isUnknownValue(v)).length
    const status: FeatureDimStat['status'] =
      hotTotal < config.analytics.minHotSamplesForSuggest
        ? '样本不足'
        : activeDims[dim.key]?.value && activeDims[dim.key]?.value === top?.value
          ? '已沉淀'
          : '待确认'

    return {
      key: dim.key,
      label: dim.label,
      note: dim.note,
      validSamples,
      top,
      items: items.slice(0, 8),
      status,
    }
  })

  const basisText = buildBasisText({
    window,
    days,
    sampleCount: samples.length,
    hotCount: hotTotal,
    values: dims.map((d) => ({ label: d.label.replace('开场钩子类型', '开场'), value: d.top?.value ?? '' })),
  })

  return {
    window,
    days,
    sampleCount: samples.length,
    hotCount: hotTotal,
    minHotSamples: config.analytics.minHotSamplesForSuggest,
    dims,
    basisText,
    profile: active,
    empty: samples.length === 0,
  }
}

/** FR-M7：确认当前统计为 active 偏好（ops/admin），旧档案归档并留痕 */
export async function confirmFeatures(
  query: { window?: unknown; days?: unknown; operator: string },
  db: Db = getDb(),
): Promise<{ profile: PreferenceProfileRow; stats: FeatureStats }> {
  const stats = await buildFeatures(query, db)
  if (stats.empty) throw err.badRequest('暂无回采数据，无法确认特征偏好')
  if (!stats.hotCount) throw err.badRequest('当前窗口没有爆款样本，无法确认特征偏好')

  const profile = await saveActiveProfile(
    {
      windowBasis: stats.window,
      profile: {
        window: stats.window,
        days: stats.days,
        sampleCount: stats.sampleCount,
        hotCount: stats.hotCount,
        dims: Object.fromEntries(
          stats.dims.map((d) => [d.key, d.top ? { value: d.top.value, ratio: d.top.ratio, hotRate: d.top.hotRate } : null]),
        ),
      },
      sampleCount: stats.sampleCount,
      basisText: stats.basisText,
      operator: query.operator,
    },
    db,
  )
  return { profile, stats }
}

/** 供 copy 生成入口使用的注入文案（无 active 档案时返回 null，行为与现状一致） */
export async function instructionsFromProfile(db: Db = getDb()): Promise<string | null> {
  const p = await getActiveProfile(db)
  const text = p?.basisText?.trim()
  return text ? text : null
}
