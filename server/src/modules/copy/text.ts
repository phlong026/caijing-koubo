import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import type { Section } from './constants.js'

/**
 * 文案工坊文本算法（任务书 §3.2 / §3.5 / FR-E5 / FR-R1）。
 * 全部为纯函数，便于 smoke 与回归脚本直接断言（AC-E5 / AC-R2）。
 */

/* ── 计字规则（FR-E5 / AC-E5）──────────────────────────────────────
 * 汉字每字 1；连续英文字母或数字串计 1；标点与空白不计；风险提示块不计入。
 * 汉字范围按 CJK 统一表意文字（含扩展 A 与兼容区常见字）。
 */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
const ALNUM = /[A-Za-z0-9]/

export function countWords(text: string): number {
  if (!text) return 0
  let count = 0
  let inRun = false
  for (const ch of text) {
    if (CJK.test(ch)) {
      count += 1
      inRun = false
      continue
    }
    if (ALNUM.test(ch)) {
      // 连续英文/数字串整体计 1
      if (!inRun) {
        count += 1
        inRun = true
      }
      continue
    }
    inRun = false
  }
  return count
}

/** 整稿字数：标题 + 各段正文（风险提示块不计） */
export function countSectionsWords(title: string | null | undefined, sections: Section[]): number {
  let n = countWords(title ?? '')
  for (const s of sections) n += countWords(s.text ?? '')
  return n
}

/** 除标题外的正文字数（预检展示与查重都用它） */
export function countBodyWords(sections: Section[]): number {
  let n = 0
  for (const s of sections) n += countWords(s.text ?? '')
  return n
}

/** 预计口播秒数 = 字数 ÷ COPY_CHARS_PER_SEC（默认 3.5） */
export function estimateSeconds(words: number): number {
  const cps = config.copy.charsPerSec || 3.5
  return Math.round((words / cps) * 10) / 10
}

/* ── 结构化正文 ───────────────────────────────────────────────────── */

/** 拼纯文本（段落之间空一行；风险提示块不参与） */
export function toPlainText(title: string | null | undefined, sections: Section[]): string {
  const body = sections
    .map((s) => {
      const label = (s.label ?? '').trim()
      const text = (s.text ?? '').trim()
      return label ? `${label}\n${text}` : text
    })
    .filter(Boolean)
    .join('\n\n')
  const t = (title ?? '').trim()
  return t ? `${t}\n\n${body}` : body
}

/** 内容 hash：规范化（标题 + 段落 label/text，去首尾空白）后 SHA-256（§3.2） */
export function contentHash(title: string | null | undefined, sections: Section[]): string {
  const normalized = [
    (title ?? '').trim(),
    ...sections.map((s) => `${(s.label ?? '').trim()}\u0001${(s.text ?? '').trim()}`),
  ].join('\u0002')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/** 去控制字符（FR-G4），并收敛多余空行 */
export function sanitizeText(v: unknown): string {
  return String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 归一化段落数组（供 LLM 输出校验与前端回写使用） */
export function normalizeSections(raw: unknown): Section[] {
  const arr = Array.isArray(raw) ? raw : []
  const out: Section[] = []
  for (const item of arr) {
    const o = (item ?? {}) as Record<string, unknown>
    const text = sanitizeText(o.text)
    if (!text) continue
    const sec: Section = { label: sanitizeText(o.label) || `段落 ${out.length + 1}`, text }
    const refs = o.sourceRefs ?? o.source_refs
    if (Array.isArray(refs)) {
      const nums = refs.map((x) => Number(x)).filter((x) => Number.isFinite(x)).map((x) => Math.trunc(x))
      if (nums.length) sec.sourceRefs = nums
    }
    out.push(sec)
    if (out.length >= 8) break // FR-G4：1–8 段
  }
  return out
}

/* ── 查重（§3.5 / AC-R2）────────────────────────────────────────────
 * 预处理：去标点与空白、全角转半角、英文转小写；风险提示块不参与。
 * 相似度 = |R ∩ S| / |R|，R = 改写稿，S = 原文；n 默认 5。
 */
export function normalizeForSimilarity(text: string): string {
  return String(text ?? '')
    // 全角转半角（FF01–FF5E → 0021–007E）
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    // 去标点、空白、符号（保留字母数字与汉字）
    .replace(/[^\p{Script=Han}a-z0-9]/gu, '')
}

function ngrams(s: string, n: number): Set<string> {
  const set = new Set<string>()
  if (s.length < n) return set
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n))
  return set
}

/** 最长公共子串（用于高亮重合片段） */
export function longestCommonSubstring(a: string, b: string): { length: number; text: string; aStart: number; bStart: number } {
  if (!a || !b) return { length: 0, text: '', aStart: -1, bStart: -1 }
  // 滚动数组 DP，避免 O(n*m) 内存
  const prev = new Array<number>(b.length + 1).fill(0)
  let best = 0
  let aEnd = 0
  for (let i = 1; i <= a.length; i++) {
    let diagPrev = 0
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      if (a[i - 1] === b[j - 1]) {
        prev[j] = diagPrev + 1
        if (prev[j] > best) {
          best = prev[j]
          aEnd = i
        }
      } else {
        prev[j] = 0
      }
      diagPrev = tmp
    }
  }
  return {
    length: best,
    text: a.slice(aEnd - best, aEnd),
    aStart: aEnd - best,
    bStart: b.indexOf(a.slice(aEnd - best, aEnd)),
  }
}

export interface SimilarityResult {
  /** |R ∩ S| / |R| */
  similarity: number
  /** 改写稿被原文覆盖的字符数（n-gram 重合数 × n 的近似，仅用于展示） */
  overlapChars: number
  totalChars: number
  longest: { length: number; text: string }
  /** 重合片段（归一化后的坐标，供前端在原文/稿上定位） */
  fragments: Array<{ text: string; length: number }>
  n: number
  threshold: number
  blocked: boolean
}

/**
 * 计算改写稿相对原文的相似度。
 * `line=persona` 才拦截（阈值默认 0.30），其他线只提示（FR-R2）。
 */
export function computeSimilarity(
  original: string,
  rewritten: string,
  line: string | null | undefined,
): SimilarityResult {
  const n = Math.max(2, config.copy.similarityN)
  const threshold = config.copy.similarityThreshold
  const S = normalizeForSimilarity(original)
  const R = normalizeForSimilarity(rewritten)
  const empty: SimilarityResult = {
    similarity: 0,
    overlapChars: 0,
    totalChars: R.length,
    longest: { length: 0, text: '' },
    fragments: [],
    n,
    threshold,
    blocked: false,
  }
  // R 少于 n 字时相似度记 0
  if (R.length < n || !S.length) return empty

  const rGrams = ngrams(R, n)
  const sGrams = ngrams(S, n)
  let hit = 0
  const hitGrams: string[] = []
  for (const g of rGrams) {
    if (sGrams.has(g)) {
      hit += 1
      hitGrams.push(g)
    }
  }
  const similarity = rGrams.size ? hit / rGrams.size : 0
  const longest = longestCommonSubstring(R, S)

  // 用最长公共子串作为主要高亮片段，最多再补 3 段互不重叠的命中片段
  const fragments: Array<{ text: string; length: number }> = []
  if (longest.length >= n) fragments.push({ text: longest.text, length: longest.length })
  for (const g of hitGrams) {
    if (fragments.length >= 4) break
    if (fragments.some((f) => f.text.includes(g) || g.includes(f.text))) continue
    fragments.push({ text: g, length: n })
  }

  return {
    similarity: Math.round(similarity * 1000) / 1000,
    overlapChars: hit * n,
    totalChars: R.length,
    longest: { length: longest.length, text: longest.text },
    fragments,
    n,
    threshold,
    blocked: line === 'persona' && similarity > threshold,
  }
}

/* ── 合规扫描（FR-R1 / AC-R1）────────────────────────────────────── */

export interface ComplianceWordRow {
  word: string
  level: 'hard' | 'soft'
  category?: string | null
}

export interface ComplianceHit {
  word: string
  level: 'hard' | 'soft'
  category: string
  /** 命中位置：段落序号 + 段内起止（用于编辑器高亮） */
  sectionIndex: number
  start: number
  end: number
  /** forbiddenClaims 来源的命中（人物禁用表述视同硬禁用） */
  fromPersona: boolean
}

/**
 * 扫描正文：词库两级 + 人物 forbiddenClaims（视为硬禁用）。
 * forbiddenClaims 常写成整句话（如「不承诺收益」），此处按「含否定前缀则取核心词」处理，
 * 同时整句也会被匹配，保证不漏。
 */
export function scanCompliance(
  sections: Section[],
  words: ComplianceWordRow[],
  forbiddenClaims: string[] = [],
): ComplianceHit[] {
  const hits: ComplianceHit[] = []
  const push = (word: string, level: 'hard' | 'soft', category: string, fromPersona: boolean) => {
    if (!word.trim()) return
    sections.forEach((s, index) => {
      const text = s.text ?? ''
      let from = 0
      for (;;) {
        const at = text.indexOf(word, from)
        if (at < 0) break
        hits.push({ word, level, category, sectionIndex: index, start: at, end: at + word.length, fromPersona })
        from = at + word.length
        if (hits.length > 500) break
      }
    })
  }

  for (const w of words) {
    push(w.word, w.level, w.category ?? '词库', false)
  }
  for (const claim of forbiddenClaims) {
    const raw = String(claim ?? '').trim()
    if (!raw) continue
    // 整句匹配（如「不给出个股买卖建议」不太可能出现在正文，但保留以防漏）
    push(raw, 'hard', '人物禁用表述', true)
    // 去否定前缀后的核心词（「不承诺收益」→「承诺收益」）
    const core = raw.replace(/^(不|严禁|禁止|避免|不得|勿)/, '').trim()
    if (core && core !== raw && core.length >= 2) push(core, 'hard', '人物禁用表述', true)
  }

  // 去重（同位置同词）并按位置排序
  const seen = new Set<string>()
  const unique = hits.filter((h) => {
    const k = `${h.sectionIndex}:${h.start}:${h.end}:${h.word}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return unique.sort((a, b) => a.sectionIndex - b.sectionIndex || a.start - b.start)
}

/** 硬禁用命中数（提交硬项） */
export function hardHitCount(hits: ComplianceHit[]): number {
  return hits.filter((h) => h.level === 'hard').length
}
