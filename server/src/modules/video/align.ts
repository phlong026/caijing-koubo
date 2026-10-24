import type { AsrResult } from '../../integrations/dashscope/asr.js'
import type { TextSegment, TimelineItem } from './types.js'

/**
 * 时间轴对齐算法（§3.4 / FR-P5，方案 A：成片后 ASR 对齐原文）。
 *
 * 关键原则：**字幕文本永远取过审原文，ASR 只提供时间不提供文字**。
 *  - 两侧字符流规范化：去标点与空白、全角转半角、英文转小写；
 *  - 数字按「原文写法 ↔ 读法」展开成中文读法（3.5% → 百分之三点五、2026年 → 二零二六年），
 *    展开字符全部映射回原文字符位置；
 *  - Needleman–Wunsch 全局对齐（替换 / 插入 / 删除代价 1，相等代价 0），
 *    对齐上的原文字符取 ASR 字符时间（含错字替换对，位置仍是最好的时间近似）；
 *  - 未映射原文字符按前后已映射字符线性插值；
 *  - 每句 startMs = 首字符时间、endMs = 末字符时间；相邻句重叠取中点，保证单调无重叠；
 *  - align_score = 对齐相等字符数 / 原文字符总数；低于阈值或 ASR 失败 → 按字数比例估算。
 */

/** NW 方阵上限（口播 ≤180 秒 ≈ 700 字，3000 已留 4 倍余量；超出直接走估算兜底） */
const MAX_ALIGN_UNITS = 3000

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const SMALL_UNITS = ['', '十', '百', '千']
const GROUP_UNITS = ['', '万', '亿']

/** 4 位组读法：1024 → 一千零二十四 */
function readGroup(g: string): string {
  let out = ''
  let zeroPending = false
  const n = g.length
  for (let i = 0; i < n; i++) {
    const d = Number(g[i])
    const unit = SMALL_UNITS[n - 1 - i]
    if (d === 0) {
      if (out) zeroPending = true
      continue
    }
    if (zeroPending) {
      out += '零'
      zeroPending = false
    }
    if (d === 1 && unit === '十' && !out) out += unit // 一十 → 十
    else out += DIGITS[d] + unit
  }
  return out
}

/** 整数读法：按 4 位分组带万 / 亿；2026 → 二千零二十六 */
function readInt(s: string): string {
  const t = s.replace(/^0+(?=\d)/, '')
  if (/^0*$/.test(t)) return '零'
  const groups: string[] = []
  for (let i = t.length; i > 0; i -= 4) groups.unshift(t.slice(Math.max(0, i - 4), i))
  let out = ''
  groups.forEach((g, gi) => {
    const base = readGroup(g)
    if (!base) return
    out += base + (GROUP_UNITS[groups.length - 1 - gi] ?? '')
  })
  return out
}

/** 逐位读法（年份 / 小数位）：2026 → 二零二六 */
function readDigits(s: string): string {
  return [...s].map((d) => DIGITS[Number(d)] ?? '').join('')
}

/** 小数读法：3.5 → 三点五、0.25 → 零点二五 */
function readDecimal(s: string): string {
  const [int, frac] = s.split('.')
  return readInt(int) + (frac ? '点' + readDigits(frac) : '')
}

interface NormUnit {
  ch: string
  /** 映射回原文（或 ASR 文本）的字符下标 */
  src: number
}

/** 数字读法展开规则（sticky 逐位匹配；不加 ^——sticky 本身锚定 lastIndex） */
const NUM_RULES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/(\d+(?:\.\d+)?)\s*%/y, (m) => '百分之' + readDecimal(m[1]!)],
  [/(\d{4})(?=\s*年)/y, (m) => readDigits(m[1]!)],
  [/\d+(?:\.\d+)?/y, (m) => (m[0].includes('.') ? readDecimal(m[0]) : readInt(m[0]))],
]

function normalizeChar(ch: string): string | null {
  let c = ch.codePointAt(0) ?? 0
  if (c === 0x3000) return null // 全角空格
  if (c >= 0xff01 && c <= 0xff5e) c -= 0xfee0 // 全角 → 半角
  const s = String.fromCodePoint(c).toLowerCase()
  if (!s || /[\s\p{P}\p{S}]/u.test(s)) return null // 标点与符号不参与对齐
  return s
}

/** 文本 → 规范化字符流（数字展开成读法，跳过标点；src 保留原下标） */
export function buildCharStream(text: string): NormUnit[] {
  const units: NormUnit[] = []
  let i = 0
  while (i < text.length) {
    let matched = false
    for (const [re, read] of NUM_RULES) {
      re.lastIndex = i
      const m = re.exec(text)
      if (m) {
        for (const ch of read(m)) {
          const n = normalizeChar(ch)
          if (n) units.push({ ch: n, src: i })
        }
        i += m[0].length
        matched = true
        break
      }
    }
    if (matched) continue
    const n = normalizeChar(text[i]!)
    if (n) units.push({ ch: n, src: i })
    i += 1
  }
  return units
}

/** ASR 字符流带时间：优先词级时间戳（词内按字符线性插值），否则句内均匀插值 */
function buildTimedAsrStream(asr: AsrResult): Array<NormUnit & { time: number }> {
  const out: Array<NormUnit & { time: number }> = []
  for (const s of asr.sentences) {
    const chars = [...s.text]
    const span = Math.max(1, s.endTime - s.beginTime)
    if (s.words?.length) {
      for (const w of s.words) {
        const wChars = [...w.text]
        const wSpan = Math.max(1, w.endTime - w.beginTime)
        wChars.forEach((ch, k) => {
          const n = normalizeChar(ch)
          if (!n) return
          // 词内按字符序插值；词级时间戳本身可能未覆盖全词，clamp 到句区间
          const t = w.beginTime + (wSpan * k) / Math.max(1, wChars.length)
          out.push({ ch: n, src: 0, time: Math.min(Math.max(t, s.beginTime), s.endTime) })
        })
      }
      continue
    }
    chars.forEach((ch, k) => {
      const n = normalizeChar(ch)
      if (!n) return
      out.push({ ch: n, src: 0, time: s.beginTime + (span * k) / Math.max(1, chars.length) })
    })
  }
  return out
}

interface AlignResult {
  /** 原文字符流下标 → ASR 时间（仅对齐上的项） */
  times: Map<number, number>
  score: number
}

/**
 * Needleman–Wunsch 全局对齐。代价：相等 0，替换 / 插入 / 删除 1。
 * 替换对（错字）也映射时间——位置近似仍优于插值，但不计入 score。
 */
function needlemanWunsch(a: NormUnit[], b: Array<NormUnit & { time: number }>): AlignResult {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dir = new Uint8Array((n + 1) * w) // 1=diag 2=up 3=left
  let prev = new Int32Array(w)
  let cur = new Int32Array(w)
  for (let j = 1; j <= m; j++) prev[j] = j
  for (let i = 1; i <= n; i++) {
    cur[0] = i
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (a[i - 1]!.ch === b[j - 1]!.ch ? 0 : 1)
      const del = prev[j] + 1
      const ins = cur[j - 1] + 1
      let d = 1
      let best = sub
      if (del < best) {
        best = del
        d = 2
      }
      if (ins < best) {
        best = ins
        d = 3
      }
      cur[j] = best
      dir[i * w + j] = d
    }
    ;[prev, cur] = [cur, prev]
  }
  const times = new Map<number, number>()
  let matches = 0
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const d = dir[i * w + j]
    if (d === 1) {
      if (a[i - 1]!.ch === b[j - 1]!.ch) matches += 1
      times.set(a[i - 1]!.src, b[j - 1]!.time)
      i -= 1
      j -= 1
    } else if (d === 2) {
      i -= 1
    } else {
      j -= 1
    }
  }
  return { times, score: n ? matches / n : 0 }
}

/** 相邻句重叠取中点，保证单调无重叠；并 clamp 到成片区间 */
export function resolveOverlaps(timeline: TimelineItem[], durationMs: number): TimelineItem[] {
  for (const t of timeline) {
    if (t.endMs < t.startMs) [t.startMs, t.endMs] = [t.endMs, t.startMs]
    t.startMs = Math.min(Math.max(t.startMs, 0), durationMs)
    t.endMs = Math.min(Math.max(t.endMs, 0), durationMs)
  }
  timeline.sort((x, y) => x.index - y.index)
  for (let i = 0; i < timeline.length - 1; i++) {
    const cur = timeline[i]!
    const next = timeline[i + 1]!
    if (next.startMs < cur.startMs) next.startMs = cur.startMs
    if (next.startMs < cur.endMs) {
      const mid = Math.round((cur.endMs + next.startMs) / 2)
      cur.endMs = Math.max(cur.startMs, mid)
      next.startMs = Math.max(cur.endMs, next.startMs)
    }
    if (next.endMs < next.startMs) next.endMs = Math.min(next.startMs + 40, durationMs)
  }
  if (timeline.length) {
    const first = timeline[0]!
    const last = timeline[timeline.length - 1]!
    first.startMs = 0
    last.endMs = durationMs
  }
  return timeline
}

/** 估算兜底：按各句归一化字数占比把 [0, durationMs] 切分（V6 / AC-T3） */
export function buildEstimatedTimeline(segments: TextSegment[], durationMs: number): TimelineItem[] {
  const weights = segments.map((s) => Math.max(1, buildCharStream(s.text).length))
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let cursor = 0
  const timeline = segments.map((s, i) => {
    const dur = (weights[i]! / total) * durationMs
    const startMs = Math.round(cursor)
    const endMs = Math.round(cursor + dur)
    cursor = endMs
    return { index: s.index, kind: s.kind, text: s.text, startMs, endMs }
  })
  return resolveOverlaps(timeline, durationMs)
}

export interface AlignOutcome {
  timeline: TimelineItem[]
  score: number
  source: 'aligned' | 'estimated'
}

/**
 * 主入口：segments 原文句 + ASR 结果 + 成片时长 → 时间轴。
 * 任何一步失败（空 ASR / 超出对齐上限 / 全部未映射）都退回估算，不让任务失败（V6）。
 */
export function alignTimeline(
  segments: TextSegment[],
  asr: AsrResult | null,
  durationMs: number,
): AlignOutcome {
  if (!asr || !asr.sentences.length || !segments.length) {
    return { timeline: buildEstimatedTimeline(segments, durationMs), score: 0, source: 'estimated' }
  }
  const origStream: NormUnit[] = []
  const ranges: Array<[number, number]> = []
  for (const seg of segments) {
    const start = origStream.length
    origStream.push(...buildCharStream(seg.text))
    ranges.push([start, origStream.length])
  }
  // NW 的 times 以 src 为键：统一改写为全局流下标，句映射直接按 ranges 查询
  origStream.forEach((u, idx) => {
    u.src = idx
  })
  if (!origStream.length || origStream.length > MAX_ALIGN_UNITS) {
    return { timeline: buildEstimatedTimeline(segments, durationMs), score: 0, source: 'estimated' }
  }
  const asrStream = buildTimedAsrStream(asr)
  if (!asrStream.length || asrStream.length > MAX_ALIGN_UNITS * 2) {
    return { timeline: buildEstimatedTimeline(segments, durationMs), score: 0, source: 'estimated' }
  }

  const { times, score } = needlemanWunsch(origStream, asrStream)

  const timeline: TimelineItem[] = segments.map((seg, si) => {
    const [s, e] = ranges[si]!
    const mapped: Array<{ pos: number; time: number }> = []
    for (let k = s; k < e; k++) {
      const t = times.get(k)
      if (t !== undefined) mapped.push({ pos: k - s, time: t })
    }
    // 按句内字符位置线性插值补齐未映射字符
    const posOf = (k: number): number => {
      const exact = mapped.find((x) => x.pos === k)
      if (exact) return exact.time
      const before = [...mapped].reverse().find((x) => x.pos < k)
      const after = mapped.find((x) => x.pos > k)
      if (before && after) {
        const ratio = (k - before.pos) / (after.pos - before.pos)
        return before.time + (after.time - before.time) * ratio
      }
      if (before) return before.time
      if (after) return after.time
      return Number.NaN
    }
    const startMs = posOf(0) // 句首
    const endMs = posOf(Math.max(0, e - s - 1)) // 句末
    return {
      index: seg.index,
      kind: seg.kind,
      text: seg.text,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
    }
  })

  // 个别句完全无映射字符（如纯标点被误切、ASR 大段漏听）→ 用估算段宽替换该句；
  // 超过一半的句失败说明整体错位，退回估算
  const fallback = buildEstimatedTimeline(segments, durationMs)
  let nanCount = 0
  const merged = timeline.map((t, i) => {
    if (Number.isNaN(t.startMs) || Number.isNaN(t.endMs)) {
      nanCount += 1
      return fallback[i]!
    }
    return t
  })
  if (nanCount * 2 > segments.length) {
    return { timeline: fallback, score, source: 'estimated' }
  }
  return { timeline: resolveOverlaps(merged, durationMs), score, source: 'aligned' }
}
