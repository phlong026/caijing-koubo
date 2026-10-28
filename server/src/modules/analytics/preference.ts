import type { Db } from '../../db/index.js'
import { getDb } from '../../db/index.js'
import { newId, jdec, jenc } from '../../lib/util.js'
import { toDb, utcNow, fromDb } from '../../lib/time.js'
import { config } from '../../config.js'
import type { MetricWindow } from './types.js'

/**
 * 已确认的爆款特征偏好（FR-M7 / AC-M7）。
 *
 * A2：metric_snapshot 与特征统计分窗口留存，但 preference_profile 只保留**一条 active**
 * （window_basis 记录来源窗口），否则两个窗口的偏差会互相覆盖，文案生成拿到的偏好会来回跳。
 * copy 侧只在「用户未显式传 instructions」时注入 basis_text，prompt 本身零改动。
 */

export interface PreferenceProfileRow {
  id: string
  windowBasis: MetricWindow
  profile: unknown
  sampleCount: number
  basisText: string
  status: 'active' | 'archived'
  confirmedBy: string | null
  createdAt: string | null
}

function mapProfile(r: Record<string, any>): PreferenceProfileRow {
  return {
    id: r.id,
    windowBasis: (r.window_basis ?? 't1') as MetricWindow,
    profile: jdec<unknown>(r.profile, null),
    sampleCount: Number(r.sample_count ?? 0),
    basisText: String(r.basis_text ?? ''),
    status: (r.status ?? 'active') as 'active' | 'archived',
    confirmedBy: r.confirmed_by ?? null,
    createdAt: fromDb(r.created_at),
  }
}

export async function getActiveProfile(db: Db = getDb()): Promise<PreferenceProfileRow | null> {
  const r = await db.get<Record<string, any>>(
    "SELECT * FROM `preference_profile` WHERE `status` = 'active' ORDER BY `created_at` DESC LIMIT 1",
  )
  return r ? mapProfile(r) : null
}

/** 冻结当前统计为 active 档案：旧的 active 一律置 archived（单条 active） */
export async function saveActiveProfile(
  input: { windowBasis: MetricWindow; profile: unknown; sampleCount: number; basisText: string; operator: string },
  db: Db = getDb(),
): Promise<PreferenceProfileRow> {
  const now = toDb(utcNow())
  await db.run("UPDATE `preference_profile` SET `status` = 'archived' WHERE `status` = 'active'")
  const id = newId('pprof')
  const text = input.basisText.slice(0, config.copy.maxInstructions)
  await db.run(
    'INSERT INTO `preference_profile` (`id`, `window_basis`, `profile`, `sample_count`, `basis_text`, `status`, `confirmed_by`, `created_at`) VALUES (?, ?, ?, ?, ?, \'active\', ?, ?)',
    [id, input.windowBasis, jenc(input.profile), input.sampleCount, text, input.operator, now],
  )
  const row = await db.get<Record<string, any>>('SELECT * FROM `preference_profile` WHERE `id` = ?', [id])
  return mapProfile(row!)
}

/**
 * 生成注入文案（§3.3）：固定模板 + 「侧重但不强制」。
 * 措辞刻意收敛——basis_text 会进提示词，写成硬约束会带偏文案风格（风险 §10.4）。
 */
export function buildBasisText(input: {
  window: MetricWindow
  days: number
  sampleCount: number
  hotCount: number
  values: Array<{ label: string; value: string }>
}): string {
  const parts = input.values.filter((v) => v.value && !v.value.startsWith('未')).map((v) => `${v.label}偏「${v.value}」`)
  const head = `近 ${input.days} 天 ${input.window === 't1' ? 'T+1' : 'T+7'} 数据（样本 ${input.sampleCount} 条、爆款 ${input.hotCount} 条）`
  const body = parts.length ? `表现较好的内容${parts.join('，')}` : '样本特征尚不集中'
  const text = `${head}：${body}。以上为统计观察，作为侧重参考，不得违反人设与合规规则，也不强制套用。`
  return text.slice(0, config.copy.maxInstructions)
}
