import { getDb } from '../../db/index.js'
import { jdec } from '../../lib/util.js'
import { listPersonas, type IpProfile, type Persona } from '../personas/repo.js'

/**
 * persona 桥接层（D13 / §4.3）。
 * 爆款选题已提供 `listPersonas` / `getPersonasByIds`，但文案工坊需要：
 *  1) 单个人物读取（含已停用，用于提交硬项判定）；
 *  2) 可选扩展字段 audienceNeeds / factualBackground / sampleScript（库内 snake_case、对外 camelCase）。
 * M1 人物库落地后，只替换本文件的数据源即可，接口不变。
 */
export async function getPersonaById(id: string, includeDisabled = false): Promise<Persona | null> {
  const db = getDb()
  const row = await db.get<Record<string, any>>('SELECT * FROM `persona` WHERE `id` = ?', [id])
  if (!row) return null
  if (!includeDisabled && !row.enabled) return null
  return {
    id: row.id,
    name: row.name,
    line: row.line,
    enabled: !!row.enabled,
    isStub: !!row.is_stub,
    createdAt: null,
    updatedAt: null,
    ipProfile: withExtensions(jdec<Record<string, unknown>>(row.ip_profile, {})),
  } as Persona
}

/** §4.3：三个可选字段，兼容 snake_case 与 camelCase 两种写法 */
function withExtensions(raw: Record<string, unknown>): IpProfile {
  const pick = (a: string, b: string) => {
    const v = raw[a] ?? raw[b]
    return v === undefined || v === null ? undefined : String(v)
  }
  return {
    role: String(raw.role ?? ''),
    serviceScope: String(raw.serviceScope ?? raw.service_scope ?? ''),
    targetAudience: String(raw.targetAudience ?? raw.target_audience ?? ''),
    expressionStyle: String(raw.expressionStyle ?? raw.expression_style ?? ''),
    forbiddenClaims: Array.isArray(raw.forbiddenClaims ?? raw.forbidden_claims)
      ? ((raw.forbiddenClaims ?? raw.forbidden_claims) as unknown[]).map(String)
      : [],
    audienceNeeds: pick('audienceNeeds', 'audience_needs'),
    factualBackground: pick('factualBackground', 'factual_background'),
    sampleScript: pick('sampleScript', 'sample_script'),
  }
}

/** 供 GET /copy/options 与来源卡使用；含已停用（前端标灰） */
export async function listPersonasForCopy(): Promise<Array<Persona & { lineLabel: string }>> {
  const all = await listPersonas(false)
  const labels: Record<string, string> = { manager: '经理 IP', kos: '员工 KOS', persona: '素人矩阵' }
  return all.map((p) => ({ ...p, lineLabel: labels[p.line] ?? p.line }))
}
