import { buildTextSnapshot } from '../src/modules/video/text-snapshot.js'
import { alignTimeline, buildCharStream, buildEstimatedTimeline } from '../src/modules/video/align.js'

/** 切句与对齐算法单测（FR-P1 / §3.4；AC-T1 / AC-T2 样例集） */
function check(name: string, cond: boolean, detail?: unknown): void {
  if (!cond) {
    console.error(`❌ ${name}`, detail ?? '')
    process.exitCode = 1
  } else {
    console.log(`✅ ${name}`)
  }
}

// ── 切句 ─────────────────────────────────────────────────────────
const snap = buildTextSnapshot(
  [
    { label: '开场', text: '大家好，今天聊一个很多人忽略的问题。费用到底有多重要？先看规则！' },
    { label: '正文', text: '长期来看，费率每高一个百分点，收益差距会越拉越大。' },
  ],
  '市场有风险，投资须谨慎。',
)
check('段落数（3 + 1 + 1 = 5 句）', snap.segments.length === 5, snap.segments)
check('风险段在最后且 kind=risk', snap.segments.at(-1)?.kind === 'risk')
check(
  'submit_text 逐字等于原文+风险话术',
  snap.submitText ===
    '大家好，今天聊一个很多人忽略的问题。费用到底有多重要？先看规则！\n长期来看，费率每高一个百分点，收益差距会越拉越大。\n市场有风险，投资须谨慎。',
  snap.submitText,
)
check('同一输入两次切分 hash 一致', snap.textHash === buildTextSnapshot(
  [{ label: '开场', text: '大家好，今天聊一个很多人忽略的问题。费用到底有多重要？先看规则！' }, { label: '正文', text: '长期来看，费率每高一个百分点，收益差距会越拉越大。' }],
  '市场有风险，投资须谨慎。',
).textHash)

const longSentence = `这是一个特别长的句子${'，中间有很多逗号'.repeat(30)}。`
const longSnap = buildTextSnapshot([{ label: '正文', text: longSentence }], null)
check(
  '超长句按逗号二次切分（每段 ≤120）',
  longSnap.segments.every((s) => s.text.length <= 121),
  longSnap.segments.map((s) => s.text.length),
)

// ── 数字读法展开 ─────────────────────────────────────────────────
const stream35 = buildCharStream('收益3.5%，2026年规模达2万亿')
check('3.5% 展开含「百」', stream35.some((u) => u.ch === '百'), stream35.map((u) => u.ch).join(''))
check('2万亿展开含「万」', stream35.some((u) => u.ch === '万'))

// ── 对齐：完美 ASR ──────────────────────────────────────────────
const sentences = snap.segments.map((s) => s.text)
const dur = 30_000
const perfectAsr = {
  text: sentences.join(''),
  taskId: 't',
  sentences: sentences.map((text, i) => {
    const beginTime = i * 6000
    const endTime = beginTime + 5500
    const chars = [...text]
    const span = endTime - beginTime
    return {
      text,
      beginTime,
      endTime,
      words: chars.map((ch, k) => ({
        text: ch,
        beginTime: Math.round(beginTime + (span * k) / chars.length),
        endTime: Math.round(beginTime + (span * (k + 1)) / chars.length),
      })),
    }
  }),
}
const r1 = alignTimeline(snap.segments, perfectAsr, dur)
check('完美 ASR：source=aligned', r1.source === 'aligned', r1)
check('完美 ASR：score=1', Math.abs(r1.score - 1) < 1e-9, r1.score)
check('时间轴文本与原文逐字一致', r1.timeline.map((t) => t.text).join('|') === sentences.join('|'))
check('单调递增无重叠', r1.timeline.every((t, i, a) => i === 0 || t.startMs >= a[i - 1]!.endMs), r1.timeline)
check('末句 endMs=成片时长', r1.timeline.at(-1)?.endMs === dur)
check('首句 startMs=0', r1.timeline[0]?.startMs === 0)

// ── 对齐：ASR 错字 + 数字读法差异 ───────────────────────────────
const typoAsr = {
  text: sentences.join(''),
  taskId: 't2',
  sentences: sentences.map((text, i) => {
    // 每句替换一个字模拟 ASR 错字
    const typo = text.replace('的', '得').replace('风险', '分险')
    const beginTime = i * 6000
    const chars = [...typo]
    const span = 5500
    return {
      text: typo,
      beginTime,
      endTime: beginTime + span,
      words: chars.map((ch, k) => ({
        text: ch,
        beginTime: Math.round(beginTime + (span * k) / chars.length),
        endTime: Math.round(beginTime + (span * (k + 1)) / chars.length),
      })),
    }
  }),
}
const r2 = alignTimeline(snap.segments, typoAsr, dur)
check('错字 ASR：仍 aligned 且 score>0.9', r2.source === 'aligned' && r2.score > 0.9, r2.score)
check('错字不进入时间轴文本', r2.timeline.map((t) => t.text).join('') === sentences.join(''))

// ── 对齐：ASR 失败 → 估算 ───────────────────────────────────────
const r3 = alignTimeline(snap.segments, null, dur)
check('ASR 为空：estimated 且任务可用', r3.source === 'estimated' && r3.timeline.length === snap.segments.length)

const est = buildEstimatedTimeline(snap.segments, dur)
check('估算时间轴单调且全覆盖', est[0]!.startMs === 0 && est.at(-1)!.endMs === dur)

console.log(process.exitCode ? '\n存在失败项' : '\n全部通过')
