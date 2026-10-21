/** Shared by prompt preview and generation, so every candidate shows its actual request. */
export function candidateUser(base: string, index: number, count: number): { direction: string; user: string } {
  const directions = ['误区纠正', '生活场景', '问题解答', '观点解读', '行动清单']
  const direction = count > 1 ? directions[(index - 1) % directions.length]! : '自由创作'
  return { direction, user: count > 1 ? `【本份创作方向】第 ${index}/${count} 份：${direction}。开场、展开结构应突出此方向；仅使用材料已有事实，不虚构场景经历或数据。\n\n${base}` : base }
}
