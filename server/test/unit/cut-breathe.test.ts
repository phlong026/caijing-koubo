import { describe, expect, it } from 'vitest'
import { buildKeepSegments, parseSilences, remapTimeline } from '../../src/modules/cut/breathe.js'
import { extractLines } from '../../src/modules/cut/subtitle.js'
import type { TimelineItem } from '../../src/modules/video/types.js'

/**
 * 剪气口纯函数单测（任务书 AC-R2：无静音 / 全静音 / 句中静音 / 边界重合）。
 */

function item(index: number, startMs: number, endMs: number, text = `句${index}`): TimelineItem {
  return { index, kind: 'normal', text, startMs, endMs }
}

describe('parseSilences', () => {
  it('解析 silence_start/end 对', () => {
    const stderr = '[silencedetect @ 0x0] silence_start: 1.5\n' + '[silencedetect @ 0x0] silence_end: 2.5 | silence_duration: 1\n' + '[silencedetect @ 0x0] silence_start: 4\n'
    expect(parseSilences(stderr)).toEqual([
      { startSec: 1.5, endSec: 2.5 },
      { startSec: 4, endSec: Number.MAX_SAFE_INTEGER },
    ])
  })
  it('无静音输出返回空数组', () => {
    expect(parseSilences('no silence here')).toEqual([])
  })
})

describe('buildKeepSegments', () => {
  it('无静音 → 全长单段保留', () => {
    const keeps = buildKeepSegments(10000, [], 500, 120)
    expect(keeps).toEqual([{ startMs: 0, endMs: 10000 }])
  })
  it('长静音被剪除且两侧收 keepGapMs/2', () => {
    // 10s 视频，3~5s 静音（≥500ms 应剪）
    const keeps = buildKeepSegments(10000, [{ startSec: 3, endSec: 5 }], 500, 120)
    expect(keeps).toEqual([
      { startMs: 0, endMs: 3060 },
      { startMs: 4940, endMs: 10000 },
    ])
  })
  it('短于 minSilenceMs 的静音不剪', () => {
    const keeps = buildKeepSegments(10000, [{ startSec: 3, endSec: 3.3 }], 500, 120)
    expect(keeps).toEqual([{ startMs: 0, endMs: 10000 }])
  })
  it('片尾未闭合静音剪到片尾', () => {
    const keeps = buildKeepSegments(10000, [{ startSec: 8, endSec: Number.MAX_SAFE_INTEGER }], 500, 120)
    expect(keeps).toEqual([{ startMs: 0, endMs: 8060 }])
  })
})

describe('remapTimeline', () => {
  it('无裁剪时时间不变', () => {
    const keeps = [{ startMs: 0, endMs: 10000 }]
    const t = [item(0, 0, 2000), item(1, 2500, 5000)]
    expect(remapTimeline(t, keeps)).toEqual(t)
  })
  it('句前静音被剪后整体前移', () => {
    // keeps = [0,1000] + [5000,9000]：剪掉 4000ms
    const keeps = [
      { startMs: 0, endMs: 1000 },
      { startMs: 5000, endMs: 9000 },
    ]
    const t = [item(0, 100, 900), item(1, 5200, 8000), item(2, 8800, 8990)]
    const mapped = remapTimeline(t, keeps)
    expect(mapped[0]).toMatchObject({ startMs: 100, endMs: 900 })
    expect(mapped[1]).toMatchObject({ startMs: 1200, endMs: 4000 })
    expect(mapped[2]!.endMs).toBe(4990)
  })
  it('落在被剪间隙内的点归到前一保留段末尾', () => {
    const keeps = [
      { startMs: 0, endMs: 1000 },
      { startMs: 5000, endMs: 9000 },
    ]
    const t = [item(0, 2000, 3000)]
    const mapped = remapTimeline(t, keeps)
    expect(mapped[0]).toMatchObject({ startMs: 1000, endMs: 1001 })
  })
  it('空 keeps → 全部归零', () => {
    const t = [item(0, 100, 200)]
    expect(remapTimeline(t, [])).toEqual([{ index: 0, kind: 'normal', text: '句0', startMs: 0, endMs: 0 }])
  })
})

describe('extractLines（字幕换行）', () => {
  it('超长句按 20 字换行且最多 2 行', () => {
    const text = '一'.repeat(45)
    const lines = extractLines(text, 20, 2)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveLength(20)
    expect(lines[1]).toHaveLength(25)
  })
  it('短句单行', () => {
    expect(extractLines('你好世界', 20, 2)).toEqual(['你好世界'])
  })
})
