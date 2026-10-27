import type { Section } from './constants.js'
import { toPlainText } from './text.js'

/**
 * 校对台（外部内容审核平台）接入的纯函数部分：送审正文、状态映射、审核后文案解析。
 * 接口约定见 docs/jiaoduitai-review-api-v1.1.md。
 */

/** 本地审核单在校对台审核过程中可能处于的状态 */
export type MappedStatus = 'gate1' | 'gate2' | 'pending_manual' | 'approved' | 'rejected'

const STATUS_MAP: Record<string, MappedStatus> = {
  pending_machine: 'gate1',
  machine_reviewing: 'gate1',
  // 机审高危拦截：提交人在校对台处理（改稿重送或确认继续）
  pending_revise: 'gate2',
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

/** 校对台审核通过后返回的文案（查询接口 content_text 字段） */
export function extractReviewedText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const text = (body as Record<string, unknown>).content_text
  return typeof text === 'string' && text.trim() ? text : null
}

/**
 * 审核后文案 → 标题 + 段落。原稿有标题时首行即标题；正文按空行切段，
 * 段名按顺序沿用原稿（视频创作按段落名定位），多出的段落按序号命名。
 */
export function parseReviewedText(
  text: string,
  original: { title: string | null | undefined; sections: Section[] },
): { title: string; sections: Section[] } {
  let body = text.replace(/\r\n?/g, '\n').trim()
  let title = ''
  if ((original.title ?? '').trim()) {
    const nl = body.indexOf('\n')
    title = (nl === -1 ? body : body.slice(0, nl)).trim()
    body = nl === -1 ? '' : body.slice(nl + 1)
  }
  const paragraphs = body
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const sections = paragraphs.map((p, i) => ({ label: original.sections[i]?.label ?? `第${i + 1}段`, text: p }))
  return { title, sections }
}
