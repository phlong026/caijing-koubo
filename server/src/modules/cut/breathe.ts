import type { SilenceSpan, KeepSpan } from './types.js'
import type { TimelineItem } from '../video/types.js'

/**
 * 剪气口（任务书 FR-R / CE2，平移 AI-Studio VideoProcess.ts 并修正）：
 *  - silencedetect 阈值参数化；keepSegments = 全长补集（句间隙至少保留 keepGapMs）；
 *  - 分段重编码切片（弃 stream copy，避关键帧误差）+ concat 拼回；
 *  - remapTimeline 纯函数（vitest 单测：无静音 / 全静音 / 句中静音 / 边界重合）。
 */

/** 解析 silencedetect stderr 输出（R5 平移） */
export function parseSilences(stderr: string): SilenceSpan[] {
  const starts: number[] = []
  const spans: SilenceSpan[] = []
  for (const m of stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    if (m[1] === 'start') starts.push(Number(m[2]))
    else if (starts.length) spans.push({ startSec: starts.shift()!, endSec: Number(m[2]) })
  }
  // 未闭合的 silence_start（静音到片尾）
  if (starts.length) spans.push({ startSec: starts[0]!, endSec: Number.MAX_SAFE_INTEGER })
  return spans
}

/**
 * 保留段计算（§3.5）：静音段若 ≥ minSilenceMs 才剪，且相邻保留段之间至少留 keepGapMs。
 * durationMs 为视频总时长。
 */
export function buildKeepSegments(durationMs: number, silences: SilenceSpan[], minSilenceMs: number, keepGapMs: number): KeepSpan[] {
  const total = Math.max(0, durationMs)
  // ① 过滤短静音并夹到 [0, total]
  const cuts = silences
    .map((s) => ({ start: s.startSec * 1000, end: Math.min(s.endSec * 1000, total) }))
    .filter((s) => s.end - s.start >= minSilenceMs && s.end > s.start)
    .sort((a, b) => a.start - b.start)
  // ② 两侧收 keepGapMs/2（贴片头 / 片尾的一侧不收——片尾静音应剪到底）
  const gap = Math.max(0, Math.min(keepGapMs / 2, minSilenceMs / 2))
  const trimmed = cuts
    .map((c) => ({
      start: c.start <= 0 ? c.start : c.start + gap,
      end: c.end >= total ? c.end : c.end - gap,
    }))
    .filter((c) => c.end > c.start)
  // ③ 取补集
  const keeps: KeepSpan[] = []
  let cursor = 0
  for (const c of trimmed) {
    if (c.start > cursor) keeps.push({ startMs: cursor, endMs: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < total) keeps.push({ startMs: cursor, endMs: total })
  return keeps.filter((k) => k.endMs - k.startMs > 1)
}

/** 时间轴重映射（§3.5 纯函数）：句级 TimelineItem 整体落位到剪后坐标系 */
export function remapTimeline(timeline: TimelineItem[], keeps: KeepSpan[]): TimelineItem[] {
  if (!keeps.length) return timeline.map((t) => ({ ...t, startMs: 0, endMs: 0 }))
  // 新坐标系下各保留段的起点 = 前面保留段的累计时长
  const offsets: number[] = []
  let acc = 0
  for (const k of keeps) {
    offsets.push(acc)
    acc += k.endMs - k.startMs
  }
  return timeline.map((item) => {
    const startMs = mapPoint(item.startMs, keeps, offsets)
    const endMs = Math.max(startMs + 1, mapPoint(item.endMs, keeps, offsets))
    return { ...item, startMs, endMs }
  })
}

function mapPoint(t: number, keeps: KeepSpan[], offsets: number[]): number {
  for (let i = 0; i < keeps.length; i++) {
    const k = keeps[i]!
    if (t < k.startMs) {
      // 落在被剪掉的间隙里：归到前一个保留段末尾（= 当前段新起点）
      return i === 0 ? 0 : offsets[i]!
    }
    if (t <= k.endMs) return offsets[i]! + (t - k.startMs)
  }
  const last = keeps[keeps.length - 1]!
  return offsets[keeps.length - 1]! + (last.endMs - last.startMs)
}

/** silencedetect 参数构造 */
export function silencedetectArgs(noiseDb: number, minSilenceMs: number): string[] {
  const d = Math.max(0.05, minSilenceMs / 1000)
  return ['-af', `silencedetect=noise=${noiseDb}dB:d=${d}`, '-f', 'null', '-']
}

/** 分段切片参数（重编码，弃 stream copy） */
export function segmentCutArgs(input: string, keep: KeepSpan, out: string): string[] {
  return ['-i', input, '-ss', (keep.startMs / 1000).toFixed(3), '-to', (keep.endMs / 1000).toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-avoid_negative_ts', 'make_zero', out]
}

/** concat 列表文件内容（R6 转义） */
export function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}
