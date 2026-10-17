import { getDb } from '../../db/index.js'
import { jdec } from '../../lib/util.js'
import { fromDb } from '../../lib/time.js'

/** 对外统一 camelCase（前端 Persona.ipProfile 契约） */
export interface IpProfile {
  role: string
  serviceScope: string
  targetAudience: string
  expressionStyle: string
  forbiddenClaims: string[]
  /** 文案工坊可选扩展（§4.3）：受众需求，用于提示词人物档案块 */
  audienceNeeds?: string
  /** 文案工坊可选扩展：事实背景（仅按相关性引用，不得扩写为个人经历） */
  factualBackground?: string
  /** 文案工坊可选扩展：代表口播样稿（只学句式语气） */
  sampleScript?: string
}

export interface Persona {
  id: string
  name: string
  line: 'manager' | 'kos' | 'persona'
  enabled: boolean
  ipProfile: IpProfile
  isStub: boolean
  createdAt: string | null
  updatedAt: string | null
}

const EMPTY_PROFILE: IpProfile = {
  role: '',
  serviceScope: '',
  targetAudience: '',
  expressionStyle: '',
  forbiddenClaims: [],
}

/** 库内存的是 snake_case，对外统一转 camelCase；两种写法都兼容读取 */
function readProfile(raw: unknown): IpProfile {
  const ip = (raw ?? {}) as Record<string, any>
  return {
    role: String(ip.role ?? ''),
    serviceScope: String(ip.serviceScope ?? ip.service_scope ?? ''),
    targetAudience: String(ip.targetAudience ?? ip.target_audience ?? ''),
    expressionStyle: String(ip.expressionStyle ?? ip.expression_style ?? ''),
    forbiddenClaims: Array.isArray(ip.forbiddenClaims ?? ip.forbidden_claims)
      ? (ip.forbiddenClaims ?? ip.forbidden_claims).map(String)
      : [],
  }
}

function mapRow(r: Record<string, any>): Persona {
  return {
    id: r.id,
    name: r.name,
    line: r.line,
    enabled: !!r.enabled,
    ipProfile: readProfile(jdec<unknown>(r.ip_profile, null)),
    isStub: !!r.is_stub,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}

/**
 * D13：M1 人物库未就绪前读本模块 persona 只读桩。
 * M1 落地后只需替换本函数的数据源，接口与字段保持不变。
 */
export async function listPersonas(enabledOnly = true): Promise<Persona[]> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`persona\` ${enabledOnly ? 'WHERE `enabled` = 1' : ''} ORDER BY \`line\`, \`name\``,
  )
  return rows.map(mapRow)
}

export async function getPersonasByIds(ids: string[]): Promise<Persona[]> {
  if (!ids.length) return []
  const db = getDb()
  const ph = ids.map(() => '?').join(', ')
  const rows = await db.all<Record<string, any>>(
    `SELECT * FROM \`persona\` WHERE \`id\` IN (${ph}) ORDER BY \`line\`, \`name\``,
    ids,
  )
  return rows.map(mapRow)
}
