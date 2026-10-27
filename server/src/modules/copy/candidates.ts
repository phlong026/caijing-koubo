import { TOPIC_BLOCK_MARK } from './prompt.js'
import { STRUCTURE_LOCK_MARK } from './structure-core.js'

const DIRECTIONS = ['误区纠正', '生活场景', '问题解答', '观点解读', '行动清单']
/** 已有选题角度时只换开场方式，不再改写选题定好的角度 */
const OPENINGS = ['直接结论开场', '提问开场', '反差开场', '数据开场', '场景开场']

/** 沿用对标结构时，多份只在表达上做差异：钩子类型与段落分工由结构参考定下，不能再被开场方式 / 创作方向改掉 */
const STRUCTURE_VARIANTS = ['稳妥版', '口语版', '凝练版', '例证版', '提问版']
const STRUCTURE_VARIANT_HINTS: Record<string, string> = {
  稳妥版: '措辞稳妥，结构与钩子手法贴近参考',
  口语版: '同样的结构与钩子手法，换成更口语、更像聊天的说法',
  凝练版: '同样的结构与钩子手法，压缩铺垫、句子更短',
  例证版: '同样的结构与钩子手法，用一个贴近人物受众的生活化例子来说明，不虚构数据',
  提问版: '同样的结构与钩子手法，把关键转折句改成提问',
}

/** 选题要求块 / 结构参考块都固定在创作模板之前；来源正文里出现同样字样不算 */
function beforeTemplate(base: string, mark: string): boolean {
  const i = base.indexOf(mark)
  const tpl = base.indexOf('【创作模板】')
  return i >= 0 && (tpl < 0 || i < tpl)
}
function hasTopicAngle(base: string): boolean {
  return beforeTemplate(base, TOPIC_BLOCK_MARK)
}
function hasStructureLock(base: string): boolean {
  return beforeTemplate(base, STRUCTURE_LOCK_MARK)
}

/** Shared by prompt preview and generation, so every candidate shows its actual request. */
export function candidateUser(base: string, index: number, count: number): { direction: string; user: string } {
  if (count <= 1) return { direction: '自由创作', user: base }
  if (hasStructureLock(base)) {
    const variant = STRUCTURE_VARIANTS[(index - 1) % STRUCTURE_VARIANTS.length]!
    return {
      direction: variant,
      user: `【本份写法】第 ${index}/${count} 份：${variant}——${STRUCTURE_VARIANT_HINTS[variant]}。材料没有数据或场景时不虚构场景、经历或数据。\n\n${base}`,
    }
  }
  if (hasTopicAngle(base)) {
    const opening = OPENINGS[(index - 1) % OPENINGS.length]!
    return {
      direction: opening,
      user: `【本份开场方式】第 ${index}/${count} 份：${opening}。选题角度保持不变，只调整开场与展开方式；材料没有数据或场景时改用直接结论开场，不虚构场景、经历或数据。\n\n${base}`,
    }
  }
  const direction = DIRECTIONS[(index - 1) % DIRECTIONS.length]!
  return { direction, user: `【本份创作方向】第 ${index}/${count} 份：${direction}。开场、展开结构应突出此方向；仅使用材料已有事实，不虚构场景经历或数据。\n\n${base}` }
}
