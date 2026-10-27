/**
 * 候选选题启发式打分（纯函数，生成时落库，辅助人工挑选排序）。
 * 规则取自财经口播赛道通行的选题方法：数字具体感、悬念/反差、身份代入、
 * 开场钩子完整度、选题理由充分性；命中合规风险词重扣。
 * 它是排序参考不是爆款预测——分高优先看，分低不代表不能用。
 */

export interface TopicScore {
  score: number
  reasons: string[]
}

/** 悬念 / 反差类词根：同行标题公式里的「留白钩子」 */
const SUSPENSE_WORDS =
  /(为什么|别再|其实|真相|背后|竟然|居然|难怪|到底|小心|注意|误区|信号|关键|变化|真相了|说清楚)/
/** 身份代入类词根：让观众对号入座 */
const AUDIENCE_WORDS = /(你|你的|咱们|我们|普通人|散户|打工人|手里|家里|账户)/
/** 财经内容硬风险词：生成提示词已约束，这里做兜底扣分 */
const RISK_WORDS =
  /(稳赚|必涨|必赚|保本|零风险|百分百|稳了|翻倍|暴富|抄底|满仓|梭哈|内幕|保证收益|只赚不赔)/

export function scoreTopic(t: { title: string; hook?: string | null; rationale?: string | null }): TopicScore {
  const reasons: string[] = []
  let score = 50

  const title = String(t.title ?? '').trim()
  const len = title.length
  if (len >= 8 && len <= 24) {
    score += 15
    reasons.push('标题长度适合口播')
  } else if (len > 0) {
    score -= 5
    reasons.push('标题偏长或偏短，口播不够顺')
  }

  if (/\d|[一二两三四五六七八九十]/.test(title)) {
    score += 10
    reasons.push('标题含数字，更具体')
  }
  if (SUSPENSE_WORDS.test(title)) {
    score += 10
    reasons.push('含悬念或反差钩子')
  }
  if (AUDIENCE_WORDS.test(title)) {
    score += 5
    reasons.push('有身份代入感')
  }

  const hook = String(t.hook ?? '').trim()
  if (hook.length >= 10 && hook.length <= 60) {
    score += 10
    reasons.push('开场钩子长度合适')
  } else if (!hook) {
    score -= 5
    reasons.push('缺少开场钩子')
  }

  const rationale = String(t.rationale ?? '').trim()
  if (rationale.length >= 20) {
    score += 5
    reasons.push('选题理由充分')
  } else if (!rationale) {
    score -= 5
    reasons.push('缺少选题理由')
  }

  const risky = title.match(RISK_WORDS) ?? hook.match(RISK_WORDS)
  if (risky) {
    score -= 30
    reasons.push(`命中风险表述「${risky[0]}」，送入前必须改写`)
  }

  return { score: Math.max(0, Math.min(100, score)), reasons }
}
