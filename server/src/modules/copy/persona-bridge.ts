import { decoratePersonas } from '../personas/decorate.js'
import {
  getPersonaById,
  listPersonas,
  type Persona,
} from '../personas/repo.js'

/**
 * persona 桥接层（D13 / §4.3）。
 * 单个人物读取与扩展字段 audienceNeeds / factualBackground / sampleScript 的解析
 * 已并入 personas/repo（同一套 readProfile），这里只保留文案工坊侧的入口。
 * 人物库落地后，列表附带 usable / statusReasons（FR-X1 / FR-X7），
 * 前端人物下拉据此前置灰不可用人物并展示原因。
 */
export { getPersonaById }

export interface PersonaForCopy extends Persona {
  lineLabel: string
  /** 有效状态（读时派生） */
  status: string
  statusLabel: string
  usable: boolean
  statusReasons: Array<{ code: string; message: string }>
}

/** 供 GET /copy/options 与来源卡使用；含已停用（前端标灰 + 原因） */
export async function listPersonasForCopy(): Promise<PersonaForCopy[]> {
  const labels: Record<string, string> = { manager: '经理 IP', kos: '员工 KOS', persona: '素人矩阵' }
  // 批量派生（decorate.ts）：不再对每个人物各发多条查询
  const decorated = await decoratePersonas(await listPersonas({ includeDisabled: true }))
  return decorated.map((d) => ({ ...d, lineLabel: labels[d.line] ?? d.line }))
}
