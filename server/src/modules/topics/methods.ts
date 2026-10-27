/**
 * 选题方法规则（人物库 × 爆款选题 × 文案工坊共用，纯函数）。
 * - 人物「选题方法配比」引用选题方法；没勾选时按生产线给默认可用范围；
 * - 素人矩阵默认不用「产品推荐」，勾选后才可用（合规口径）；
 * - 每个选题方法对应一个文案模板，送入文案工坊时自动带出。
 */

export interface MethodLite {
  id: string
  name: string
  builtin: string | null
  isDefault: boolean
  copyTemplateId: string | null
}

export interface MethodMixItem {
  label: string
  ratio?: number
  methodId?: string
}

export interface PersonaMethods {
  /** 人物是否勾选过选题方法（false = 使用默认可用范围） */
  configured: boolean
  items: Array<{ method: MethodLite; weight: number }>
}

/** 内置选题方法 → 内置文案模板 */
export const BUILTIN_COPY_TEMPLATE: Record<string, string> = {
  market: 'ctpl_market',
  education: 'ctpl_education',
  product: 'ctpl_product',
  comment: 'ctpl_comment',
}
export const DEFAULT_COPY_TEMPLATE_ID = 'ctpl_market'

/** 需要人物主动勾选才可用的内置方法（按生产线） */
export const OPT_IN_BY_LINE: Record<string, string[]> = {
  persona: ['product'],
}

/** 旧「内容配比」标签 → 内置方法（只做识别，不改库） */
const LABEL_ALIASES: Record<string, string[]> = {
  market: ['市场解读', '市场解读型'],
  education: ['投教科普', '投教科普型', '知识科普', '投资者教育'],
  product: ['产品推荐', '产品推荐型', '产品品类讲解'],
  comment: ['热点评论', '热点评论型'],
}

export function matchMethodByLabel(label: string, all: MethodLite[]): MethodLite | null {
  const text = label.trim()
  if (!text) return null
  const exact = all.find((m) => m.name === text)
  if (exact) return exact
  const builtin = Object.keys(LABEL_ALIASES).find((k) => LABEL_ALIASES[k]!.includes(text))
  return (builtin && all.find((m) => m.builtin === builtin)) || null
}

/** 旧「内容配比」里对应不上任何选题方法的标签（人物页保存时移入内容方向，避免丢失） */
export function unmatchedMixLabels(contentMix: MethodMixItem[] | null | undefined, all: MethodLite[]): string[] {
  return (contentMix ?? [])
    .filter((x) => !(x.methodId ? all.some((m) => m.id === x.methodId) : matchMethodByLabel(x.label, all)))
    .map((x) => x.label.trim())
    .filter(Boolean)
}

export function personaMethods(
  persona: { line: string; contentMix?: MethodMixItem[] | null },
  all: MethodLite[],
): PersonaMethods {
  const items: PersonaMethods['items'] = []
  for (const mix of persona.contentMix ?? []) {
    const method = mix.methodId ? all.find((m) => m.id === mix.methodId) : matchMethodByLabel(mix.label, all)
    if (!method) continue
    // 非法比例（手工改库的 NaN / 0）按 1 处理，避免轮转取到 -1 下标
    const weight = Number.isFinite(mix.ratio) && mix.ratio! > 0 ? mix.ratio! : 1
    const same = items.find((x) => x.method.id === method.id)
    // 两个旧标签指向同一方法（如「知识科普」+「投教科普」）时合并，比例累加
    if (same) same.weight += weight
    else items.push({ method, weight })
  }
  if (items.length) return { configured: true, items }

  const optIn = OPT_IN_BY_LINE[persona.line] ?? []
  return {
    configured: false,
    items: all.filter((m) => !m.builtin || !optIn.includes(m.builtin)).map((method) => ({ method, weight: 1 })),
  }
}

/**
 * 自动分配：第 index 条资讯用哪个方法。
 * 未配置时固定用默认方法；配置了则按比例做平滑加权轮转（结果只取决于 index，重试稳定）。
 */
export function pickMethod(p: PersonaMethods, index: number): MethodLite | null {
  if (!p.items.length) return null
  if (!p.configured) return (p.items.find((x) => x.method.isDefault) ?? p.items[0]!).method

  const total = p.items.reduce((s, x) => s + x.weight, 0)
  const current = p.items.map(() => 0)
  let chosen = 0
  for (let step = 0; step <= index; step++) {
    p.items.forEach((x, i) => (current[i]! += x.weight))
    chosen = current.indexOf(Math.max(...current))
    current[chosen]! -= total
  }
  return p.items[chosen]!.method
}

/** 人物的主选题方法：已配置取比例最高（同比例取先勾选），未配置取默认方法 */
export function mainMethod(p: PersonaMethods): MethodLite | null {
  if (!p.items.length) return null
  if (!p.configured) return pickMethod(p, 0)
  return p.items.reduce((best, x) => (x.weight > best.weight ? x : best)).method
}

/**
 * 送入文案工坊时继承的方法：选题的方法对该人物可用才随选题；
 * 否则（改派给没开启该方法的人物，如素人未勾选产品推荐，或选题本身没有方法）随人物主方法。
 */
export function inheritedMethod(
  topicMethodId: string | null | undefined,
  persona: { line: string; contentMix?: MethodMixItem[] | null },
  all: MethodLite[],
): { method: MethodLite | null; from: 'topic' | 'persona' } {
  const available = personaMethods(persona, all)
  const fromTopic = available.items.find((x) => x.method.id === topicMethodId)
  return fromTopic ? { method: fromTopic.method, from: 'topic' } : { method: mainMethod(available), from: 'persona' }
}

export function copyTemplateFor(method: MethodLite | null): string {
  if (!method) return DEFAULT_COPY_TEMPLATE_ID
  return method.copyTemplateId || (method.builtin && BUILTIN_COPY_TEMPLATE[method.builtin]) || DEFAULT_COPY_TEMPLATE_ID
}
