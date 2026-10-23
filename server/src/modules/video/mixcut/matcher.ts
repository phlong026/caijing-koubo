import type { MaterialReplacement, TimelineItem } from '../types.js'

/** 混剪匹配（FR-M2 / §3.5；🔧 R5 KeywordModeProcessor 平移，宿主数据模型换成本模块） */

export interface MixcutKeywordGroup {
  id: string
  name: string
  keywords: string[]
  packIds: string[]
  durationMinMs: number
  durationMaxMs: number
  selectionMode: 'random' | 'sequential'
  /** 查询层已按 enabled=1 过滤；保留字段便于直接构造调用 */
  enabled?: boolean
}

export interface MixcutMaterialItem {
  id: string
  packId: string
  storageKey: string
  isImage: boolean
  durationMs: number | null
}

export interface MatchInput {
  timeline: TimelineItem[]
  groups: MixcutKeywordGroup[]
  /** 组 → 素材条目池（仅 enabled） */
  itemsByPack: Map<string, MixcutMaterialItem[]>
}

/**
 * 关键词匹配规则（§3.5）：
 *  1. 每句命中关键词按「最长关键词优先」取一个组；
 *  2. 片段时长 = min(句时长, 组 durationMax) 且 ≥ durationMin，不足顺延下一句（不跨越风险段）；
 *  3. 同一素材同视频内不重复（素材不足允许重复并在结果中提示）；
 *  4. 风险段（kind=risk）不覆盖素材。
 */
export function matchReplacements(input: MatchInput): { replacements: MaterialReplacement[]; reused: boolean } {
  const { timeline, groups, itemsByPack } = input
  const enabledGroups = groups.filter((g) => g.enabled !== false && g.keywords.length && g.packIds.length)
  // 关键词索引：keyword → 组（同词多组时取 id 排序稳定的一个）
  const keywordIndex = new Map<string, MixcutKeywordGroup>()
  for (const g of enabledGroups) {
    for (const kw of g.keywords) {
      const k = kw.trim()
      if (!k) continue
      const existing = keywordIndex.get(k)
      if (!existing || g.id < existing.id) keywordIndex.set(k, g)
    }
  }

  const usedItemIds = new Set<string>()
  const replacements: MaterialReplacement[] = []
  let reused = false
  let sequentialCursor = new Map<string, number>()

  for (let si = 0; si < timeline.length; si++) {
    const seg = timeline[si]!
    if (seg.kind === 'risk') continue // 风险段保持底板（§3.5-4）

    // 最长关键词优先取一个组
    let best: { keyword: string; group: MixcutKeywordGroup } | null = null
    for (const [kw, group] of keywordIndex) {
      if (!seg.text.includes(kw)) continue
      if (!best || kw.length > best.keyword.length || (kw.length === best.keyword.length && group.id < best.group.id)) {
        best = { keyword: kw, group }
      }
    }
    if (!best) continue

    const pool = best.group.packIds.flatMap((pid) => itemsByPack.get(pid) ?? [])
    if (!pool.length) continue

    // 选素材：优先未用过的；按选择方式轮转
    const fresh = pool.filter((m) => !usedItemIds.has(m.id))
    const candidatePool = fresh.length ? fresh : pool
    if (!fresh.length) reused = true
    let item: MixcutMaterialItem
    if (best.group.selectionMode === 'sequential') {
      const cursor = sequentialCursor.get(best.group.id) ?? 0
      item = candidatePool[cursor % candidatePool.length]!
      sequentialCursor.set(best.group.id, cursor + 1)
    } else {
      item = candidatePool[Math.floor(Math.random() * candidatePool.length)]!
    }
    usedItemIds.add(item.id)

    // 片段时长：min(句时长, durationMax)，且 ≥ durationMin（不足则顺延下一句）
    const segDur = Math.max(1, seg.endMs - seg.startMs)
    let durationMs = Math.min(segDur, best.group.durationMaxMs)
    let endMs = seg.startMs + durationMs
    // 顺延：不跨越风险段与下一命中句
    if (durationMs < best.group.durationMinMs) {
      let nextBound = seg.endMs
      for (let j = si + 1; j < timeline.length; j++) {
        nextBound = timeline[j]!.startMs
        if (timeline[j]!.kind === 'risk') break // 不跨越风险段
        if (durationMs >= best.group.durationMinMs) break
        durationMs = Math.min(timeline[j]!.endMs - seg.startMs, best.group.durationMaxMs)
      }
      endMs = Math.min(seg.startMs + durationMs, nextBound)
      if (endMs - seg.startMs < best.group.durationMinMs) {
        durationMs = segDur
        endMs = seg.endMs
      }
    }

    replacements.push({
      index: seg.index,
      keyword: best.keyword,
      groupName: best.group.name,
      itemId: item.id,
      startMs: seg.startMs,
      endMs,
    })
    void durationMs
  }

  replacements.sort((a, b) => a.startMs - b.startMs)
  return { replacements, reused }
}
