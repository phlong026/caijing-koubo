import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import { err } from '../../errors.js'
import { countWords, estimateSeconds } from '../copy/text.js'
import type { Section } from '../copy/constants.js'
import type { TextSegment, TextSnapshot } from './types.js'

/**
 * 口播文本快照（FR-P1 / V6）。
 *
 * - 提交文本 = 已通过版本各段正文 + 风险话术（最后一段，kind=risk），按原顺序以换行拼接，
 *   **逐字等于过审原文 + 风险话术**（切句只用于时间轴，不改变提交文本）；
 * - 切句：每段按句末标点（。！？；…及换行）切，句长超过 VIDEO_SENTENCE_MAX 再按逗号切，
 *   仍超长则硬切（剪辑模块展示用，SRT 行长可控）；
 * - text_hash：去空白后 SHA-256，同一版本两次切分结果一致（AC-T1）；
 * - 超 10000 字（飞影上限）或预估时长 > VIDEO_MAX_SECONDS → VIDEO_TEXT_TOO_LONG。
 */

/** 切句规则版本：规则变更会改变 segments 结构，配音缓存身份随之失效 */
export const SEGMENTATION_VERSION = config.video.segmentationVersion

const SENTENCE_END = /([。！？；…!?;]|\n)/
const CLAUSE_SPLIT = /([，、,])/ // 超长句二次切分点

/** 按句末标点切句；句尾标点保留在句内（split 捕获组返回的独立标点并回前句） */
export function splitSentences(text: string, maxChars = config.video.sentenceMaxChars): string[] {
  const out: string[] = []
  for (const para of text.split(/\n+/)) {
    const trimmed = para.trim()
    if (!trimmed) continue
    const pieces: string[] = []
    for (const piece of trimmed.split(SENTENCE_END)) {
      if (!piece) continue
      const isStrayPunct = piece.length <= 2 && SENTENCE_END.test(piece)
      if (isStrayPunct && pieces.length) pieces[pieces.length - 1] += piece
      else pieces.push(piece)
    }
    for (const piece of pieces) out.push(...splitLongSentence(piece.trim(), maxChars))
  }
  return out.length ? out : (text.trim() ? [text.trim()] : [])
}

/** 超长句按逗号切；无逗号可切时按 maxChars 硬切（R7 字幕行切分口径） */
function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence]
  const parts = sentence.split(CLAUSE_SPLIT).reduce<string[]>((acc, piece, i) => {
    // split 捕获组会把分隔符单独返回，把它并回前一段
    if (i % 2 === 1 && acc.length) acc[acc.length - 1] += piece
    else if (piece) acc.push(piece)
    return acc
  }, [])
  const merged: string[] = []
  let buf = ''
  for (const p of parts) {
    if (buf && buf.length + p.length > maxChars) {
      merged.push(buf)
      buf = p
    } else {
      buf += p
    }
    if (buf.length >= maxChars) {
      merged.push(buf)
      buf = ''
    }
  }
  if (buf) merged.push(buf)
  // 逗号也切不开时硬切
  return merged.flatMap((p) => chunkHard(p, maxChars))
}

function chunkHard(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const out: string[] = []
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars))
  return out
}

function normalizeForHash(text: string): string {
  return text.replace(/\s+/g, '')
}

/** FR-P1：构建不可变文本快照；超限直接拒绝（VIDEO_TEXT_TOO_LONG） */
export function buildTextSnapshot(
  sections: Section[],
  riskHint: string | null | undefined,
): TextSnapshot {
  const segments: TextSegment[] = []
  let index = 0
  sections.forEach((s, sectionIndex) => {
    for (const sentence of splitSentences(s.text ?? '')) {
      segments.push({ index: index++, sectionIndex, kind: 'normal', text: sentence })
    }
  })
  const risk = (riskHint ?? '').trim()
  if (risk) {
    for (const sentence of splitSentences(risk)) {
      segments.push({ index: index++, sectionIndex: sections.length, kind: 'risk', text: sentence })
    }
  }

  // 提交文本：段落原文换行拼接 + 风险话术（不改写原文）
  const bodyText = sections.map((s) => (s.text ?? '').trim()).filter(Boolean).join('\n')
  const submitText = risk ? (bodyText ? `${bodyText}\n${risk}` : risk) : bodyText

  const charCount = countWords(submitText)
  const estSeconds = estimateSeconds(charCount)
  const textHash = createHash('sha256').update(normalizeForHash(submitText)).digest('hex')

  if (submitText.length > config.video.maxTextChars || estSeconds > config.video.maxSeconds) {
    throw err.videoTextTooLong(
      `口播文本 ${charCount} 字（预计 ${Math.round(estSeconds)} 秒），超出上限（${config.video.maxTextChars} 字 / ${config.video.maxSeconds} 秒）`,
      { charCount, estSeconds, maxTextChars: config.video.maxTextChars, maxSeconds: config.video.maxSeconds },
    )
  }

  return { segments, submitText, textHash, charCount, estSeconds }
}
