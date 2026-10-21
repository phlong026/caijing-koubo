import {
  derivePersonaStatuses,
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
  const all = await listPersonas({ includeDisabled: true })
  const labels: Record<string, string> = { manager: '经理 IP', kos: '员工 KOS', persona: '素人矩阵' }
  const out: PersonaForCopy[] = []
  const statuses = await derivePersonaStatuses(all)
  for (const p of all) {
    const derived = statuses.get(p.id)!
    out.push({
      ...p,
      lineLabel: labels[p.line] ?? p.line,
      status: derived.status,
      statusLabel: derived.label,
      usable: derived.usable,
      statusReasons: derived.reasons,
    })
  }
  return out
}
