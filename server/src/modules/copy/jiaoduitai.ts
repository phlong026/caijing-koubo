import type { Section } from './constants.js'
import { toPlainText } from './text.js'

/**
 * 校对台（外部内容审核平台）接入的纯函数部分：送审正文、状态映射、审核后文案解析。
 * 接口约定见 docs/jiaoduitai-review-api-v1.3.md。
 */

/** 本地审核单在校对台审核过程中可能处于的状态 */
export type MappedStatus = 'gate1' | 'gate2' | 'pending_manual' | 'approved' | 'rejected'

const STATUS_MAP: Record<string, MappedStatus> = {
  pending_machine: 'gate1',
  machine_reviewing: 'gate1',
  // pending_revise（机审高危拦截）不在此映射：与 rejected 同样视为「审核意见」，本地退回改稿后 resubmit 重审
  pending_first: 'pending_manual',
  first_reviewing: 'pending_manual',
  pending_final: 'pending_manual',
  final_reviewing: 'pending_manual',
  approved: 'approved',
  rejected: 'rejected',
}

/** superseded 只出现在历史版本上，正常查询不会返回，按未知处理 */
export function mapExternalStatus(status: string): MappedStatus | null {
  return STATUS_MAP[status] ?? null
}

/** 整行只有 ≥3 个相同分隔符（=== / --- 等）：平台会把它当作篇界 */
const SEPARATOR_LINE = /^[ \t]*([=\-*_~#])\1{2,}[ \t]*(?:\n|$)/gm
/** 两个及以上连续空行：平台会把它当作篇界 */
const MULTI_BLANK = /\n[ \t]*\n(?:[ \t]*\n)+/g

/**
 * 送审正文：标题首行 + 段落（段间空一行）。
 * 平台遇到 ≥2 连续空行或纯分隔符行会把一篇拆成多篇，这里统一压掉，保证一篇文案只建一张审核单。
 */
export function toSubmitText(title: string | null | undefined, sections: Section[]): string {
  const cleaned = sections.map((s) => ({
    ...s,
    text: (s.text ?? '').replace(/\r\n?/g, '\n').replace(SEPARATOR_LINE, ''),
  }))
  return toPlainText(title, cleaned).replace(MULTI_BLANK, '\n\n').trim()
}

/**
 * 校对台返回的风险提示话术（决策 D4）。字段名由 JIAODUITAI_RISK_FIELD 指定（预留，v1.1 文档尚无），
 * 未配置或取不到时返回 null，由取稿处回退模板话术。
 */
export function extractRiskText(body: unknown, field: string): string | null {
  if (!field || !body || typeof body !== 'object') return null
  const v = (body as Record<string, unknown>)[field]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * 机审风险项（findings）→ 可读审核意见，供本地退回时写入 reject_reason 透传给改稿人。
 * 平台只出意见不改稿（2026-10-28 方案）：改稿由我方完成，改完 resubmit 重审。
 */
export function formatFindings(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const list = (body as Record<string, unknown>).findings
  if (!Array.isArray(list) || !list.length) return null
  const lines: string[] = []
  for (const f of list) {
    if (!f || typeof f !== 'object') continue
    const o = f as Record<string, unknown>
    const rule = typeof o.rule_name === 'string' ? o.rule_name : ''
    const excerpt = typeof o.excerpt === 'string' ? o.excerpt.trim() : ''
    const desc = typeof o.description === 'string' ? o.description.trim() : ''
    const tip = typeof o.suggestion === 'string' ? o.suggestion.trim() : ''
    const head = [typeof o.severity_label === 'string' ? o.severity_label : '', rule].filter(Boolean).join('｜')
    lines.push([head, excerpt ? `原文「${excerpt}」` : '', desc, tip ? `建议：${tip}` : ''].filter(Boolean).join('，'))
  }
  return lines.length ? lines.map((l, i) => `${i + 1}. ${l}`).join('\n') : null
}
