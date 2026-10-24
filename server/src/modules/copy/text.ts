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

/** 正文只包含可朗读的文案，段落名仅作内部定位，段落之间空一行。 */
export function toPlainText(title: string | null | undefined, sections: Section[]): string {
  const body = sections
    .map((s) => (s.text ?? '').trim())
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
  /** 命中位置：段落序号 + 段内起止（用于编辑器高亮）；-1 表示标题 */
  sectionIndex: number
  start: number
  end: number
  /** forbiddenClaims 来源的命中（人物禁用表述视同硬禁用） */
  fromPersona: boolean
}

/**
 * 否定前缀白名单（P1-14②）。
 * 「基金**不保本**」「本内容**不承诺收益**」是**合规的免责表述**，
 * 之前用 indexOf 直接匹配硬禁用词，反而会拦住这些正确写法。
 */
const NEGATION_PREFIXES = ['不', '非', '并非', '不得', '不会', '不能', '严禁', '禁止', '切勿', '勿', '避免', '没有', '无']

/** 该位置前是否紧邻否定词（只看紧邻的 1~3 个字，避免跨句误判） */
function isNegated(text: string, start: number): boolean {
  const head = text.slice(Math.max(0, start - 3), start)
  return NEGATION_PREFIXES.some((p) => head.endsWith(p))
}

/**
 * 疑问 / 反问 / 引述语境白名单（AC-G5 回归暴露）。
 * 「债基真的**稳赚不赔**吗？」「听到"**保本稳赚**"，先问一句依据在哪」
 * 是**辟谣式反问与引述**，语义与「承诺稳赚」完全相反，不能判违规。
 * 判定口径：命中词落在疑问句里（紧邻前后出现「吗 / 呢 / 真的…吗 / 是不是 / …？」），
 * 或被引号包裹（「」/『』/“”/""），即视为未作出承诺。
 */
const QUESTION_SUFFIX = /^(吗|呢|么|嘛|吧)/
const QUESTION_PREFIX = /(是不是|会不会|能不能|该不该|要不要|真的|难道|是否|有无)$/
const QUOTE_PAIRS: Array<[string, string]> = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
]

/** 命中处是否处于引述（被引号包裹） */
function isQuoted(text: string, start: number, end: number): boolean {
  for (const [open, close] of QUOTE_PAIRS) {
    const before = text.lastIndexOf(open, start)
    if (before < 0) continue
    // 引号内不能再夹一个同类型的收引号，否则说明命中的不在这一对里
    const innerClose = text.indexOf(close, before + open.length)
    if (innerClose >= 0 && innerClose < start) continue
    const after = text.indexOf(close, end)
    if (after < 0) continue
    const innerOpen = text.indexOf(open, before + open.length)
    if (innerOpen >= 0 && innerOpen > end) continue
    return true
  }
  return false
}

/** 命中处是否处于疑问 / 反问语境：看本句内该词之后是否以问号收尾，或紧跟疑问语气词 */
function isQuestion(text: string, start: number, end: number): boolean {
  // 句界（中英文句末标点 + 换行）
  const sentStart = Math.max(
    0,
    ...[...'。！!；;\n'].map((p) => text.lastIndexOf(p, start) + 1).filter((x) => x > 0).concat(0),
  )
  const nextEnd = [...'。！!；;\n'].map((p) => text.indexOf(p, end)).filter((x) => x >= 0)
  const sentEnd = nextEnd.length ? Math.min(...nextEnd) : text.length
  const sentence = text.slice(sentStart, sentEnd + 1)

  // 1) 词组后紧跟疑问语气词：「稳赚不赔吗」「保本吧」
  if (QUESTION_SUFFIX.test(text.slice(end, end + 2))) return true
  // 2) 词组前是「是不是 / 会不会 / 真的 / 是否」等疑问引导词
  if (QUESTION_PREFIX.test(text.slice(Math.max(0, start - 4), start))) return true
  // 3) 本句以问号收尾（反问句）
  if (/[?？]/.test(text.slice(end, sentEnd + 2))) return true
  // 4) 整句是「…是什么 / 为什么…」这类设问标题
  if (/[?？]/.test(sentence) && /(是什么|为什么|怎么|如何|多少|哪|谁)/.test(sentence)) return true
  return false
}

/** 该命中是否属于「非承诺」语境（否定 / 引述 / 疑问反问） */
function isNonClaim(text: string, start: number, end: number): boolean {
  if (isNegated(text, start)) return true
  if (isQuoted(text, start, end)) return true
  return isQuestion(text, start, end)
}

/**
 * 人物禁用表达 → 词表条目（P1-14③）。
 * forbiddenClaims 常写成**规则句**（「使用绝对化表述（稳赚、必涨）」「给出个股买卖建议」），
 * 之前截掉否定前缀后仍按整句匹配，正文里几乎永远匹配不到，等于没约束。
 * 这里把规则句拆成可匹配的词：
 *  - 括号里的列举 → 逐词；
 *  - 「...」/“...”/《》里的引用 → 逐段；
 *  - 去掉「使用/给出/出现/不得/严禁」等动词性前缀后的剩余部分，长度 ≥2 才保留。
 */
function claimsToWords(raw: string): string[] {
  const out: string[] = []
  const src = String(raw ?? '').trim()
  if (!src) return out

  // 1) 括号内列举：(稳赚、必涨) / （保本；零风险）
  for (const m of src.matchAll(/[（(]([^）)]{2,})[）)]/g)) {
    for (const p of m[1]!.split(/[、,，;；/\/]/)) {
      const w = p.trim()
      if (w.length >= 2) out.push(w)
    }
  }
  // 2) 引号内引用：「必涨」/“稳赚”/《…》
  for (const m of src.matchAll(/[「『"“《]([^」』"”》]{2,})[」』"”》]/g)) {
    const w = m[1]!.trim()
    if (w.length >= 2) out.push(w)
  }
  // 3) 规则句去前缀后的核心短语
  const core = src
    .replace(/\{|\}/g, '')
    .replace(/^(不得|不要|严禁|禁止|避免|勿|不)/, '')
    .replace(/^(使用|给出|出现|包含|含有|采用|做|进行)/, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[「『"“《][^」』"”》]*[」』"”》]/g, '')
    .trim()
  // 禁用词本身（「稳赚不赔」）去前缀后与原句相同，同样要保留：只有这样最常见的写法才会被匹配
  if (core.length >= 2 && core.length <= 12) {
    out.push(core)
  }
  return Array.from(new Set(out))
}

/**
 * 扫描稿内容：
 *  - P1-14①：**标题**与正文段落都要扫（之前只扫 sections，「稳赚」放标题也能提交）；
 *  - P1-14②：命中位置前面紧邻否定词时不算违规（「不保本」「不承诺收益」）；
 *  - P1-14③：人物 forbiddenClaims 拆成可匹配的词，不再整句硬匹配。
 */
export function scanCompliance(
  sections: Section[],
  words: ComplianceWordRow[],
  forbiddenClaims: string[] = [],
  title?: string | null,
): ComplianceHit[] {
  const hits: ComplianceHit[] = []

  // 标题作为「第 -1 段」参与扫描
  const targets: Array<{ index: number; text: string }> = []
  const t = String(title ?? '')
  if (t) targets.push({ index: -1, text: t })
  sections.forEach((s, index) => targets.push({ index, text: s.text ?? '' }))

  const push = (word: string, level: 'hard' | 'soft', category: string, fromPersona: boolean) => {
    if (!word.trim()) return
    for (const { index, text } of targets) {
      let from = 0
      for (;;) {
        const at = text.indexOf(word, from)
        if (at < 0) break
        from = at + word.length
        // 非承诺语境（否定 / 引述 / 疑问反问）视为合规表达，不计命中
        if (isNonClaim(text, at, at + word.length)) continue
        // Only exempt ordinal/list syntax. Claims such as 行业第一 / 第一名 remain flagged.
        if (!fromPersona && level === 'soft' && word === '第一') {
          const before = text.slice(0, at)
          const after = text.slice(at + word.length)
          if ((at === 0 || /[。！？；\n]\s*$/.test(before)) && (/^[、，,:：]/.test(after) || /^(步|点|项|段|条|章|节|次|个问题)/.test(after))) continue
        }
        hits.push({ word, level, category, sectionIndex: index, start: at, end: at + word.length, fromPersona })
        if (hits.length > 500) break
      }
    }
  }

  for (const w of words) {
    push(w.word, w.level, w.category ?? '词库', false)
  }
  for (const claim of forbiddenClaims) {
    for (const w of claimsToWords(String(claim ?? ''))) {
      push(w, 'hard', '人物禁用表述', true)
    }
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

