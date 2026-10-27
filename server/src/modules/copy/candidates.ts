import { TOPIC_BLOCK_MARK } from './prompt.js'

const DIRECTIONS = ['误区纠正', '生活场景', '问题解答', '观点解读', '行动清单']
/** 已有选题角度时只换开场方式，不再改写选题定好的角度 */
const OPENINGS = ['直接结论开场', '提问开场', '反差开场', '数据开场', '场景开场']

/** 选题要求块固定在创作模板之前；来源正文里出现同样字样不算 */
function hasTopicAngle(base: string): boolean {
  const i = base.indexOf(TOPIC_BLOCK_MARK)
  const tpl = base.indexOf('【创作模板】')
  return i >= 0 && (tpl < 0 || i < tpl)
}

/** Shared by prompt preview and generation, so every candidate shows its actual request. */
export function candidateUser(base: string, index: number, count: number): { direction: string; user: string } {
  if (count <= 1) return { direction: '自由创作', user: base }
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
