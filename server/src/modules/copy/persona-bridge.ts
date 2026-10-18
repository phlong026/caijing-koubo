import { getPersonaById, listPersonas, type Persona } from '../personas/repo.js'

/**
 * persona 桥接层（D13 / §4.3）。
 * 单个人物读取与扩展字段 audienceNeeds / factualBackground / sampleScript 的解析
 * 已并入 personas/repo（同一套 readProfile），这里只保留文案工坊侧的入口。
 * M1 人物库落地后，替换 personas/repo 的数据源即可，接口不变。
 */
export { getPersonaById }

/** 供 GET /copy/options 与来源卡使用；含已停用（前端标灰） */
export async function listPersonasForCopy(): Promise<Array<Persona & { lineLabel: string }>> {
  const all = await listPersonas(false)
  const labels: Record<string, string> = { manager: '经理 IP', kos: '员工 KOS', persona: '素人矩阵' }
  return all.map((p) => ({ ...p, lineLabel: labels[p.line] ?? p.line }))
}
