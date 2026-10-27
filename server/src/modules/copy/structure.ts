import { getDb } from '../../db/index.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { jdec, jenc } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { chat, currentModelLabel } from '../../integrations/copy-llm/index.js'
import {
  buildStructurePrompt,
  normalizeStructureUse,
  parseStructureJson,
  readStructure,
  type ScriptStructure,
  type StructureRef,
  type StructureUse,
  type TranscriptSentence,
} from './structure-core.js'
import type { CopyRow } from './repo.js'

/**
 * 对标视频结构拆解：读逐字稿 → 模型拆钩子 / 段落分工 / 可借鉴 / 不可挪用 → 缓存在提取缓存行上。
 * 同一视频送给多位人物时共用一份拆解，只调用一次模型。
 */

interface CacheRow {
  id: string
  status: string
  sentences: TranscriptSentence[]
  structure: ScriptStructure | null
}

async function loadCache(copy: CopyRow): Promise<CacheRow> {
  if (copy.sourceRefType !== 'benchmark_video' || !copy.extractCacheId) {
    throw err.invalidState('只有对标视频来源的文案可以拆解结构')
  }
  const r = await getDb().get<Record<string, any>>('SELECT * FROM `script_extract_cache` WHERE `id` = ?', [
    copy.extractCacheId,
  ])
  if (!r) throw err.notFound('提取记录不存在，请回到爆款选题重新提取')
  const sentences = jdec<TranscriptSentence[]>(r.sentences, []).filter((s) => String(s?.text ?? '').trim())
  return { id: r.id, status: String(r.status), sentences, structure: readStructure(jdec<unknown>(r.structure, null)) }
}

/** 同一提取记录并发拆解时共用一次模型调用 */
const inflight = new Map<string, Promise<ScriptStructure>>()

export async function analyzeStructure(
  copy: CopyRow,
  opts: { refresh?: boolean } = {},
): Promise<{ structure: ScriptStructure; cached: boolean }> {
  const cache = await loadCache(copy)
  if (cache.structure && !opts.refresh) return { structure: cache.structure, cached: true }
  if (cache.status !== 'done' || !cache.sentences.length) {
    throw err.invalidState('素材还没有提取完成，提取完成后再拆解结构')
  }

  let job = inflight.get(cache.id)
  if (!job) {
    job = runAnalysis(cache).finally(() => inflight.delete(cache.id))
    inflight.set(cache.id, job)
  }
  return { structure: await job, cached: false }
}

async function runAnalysis(cache: CacheRow): Promise<ScriptStructure> {
  const prompt = buildStructurePrompt(cache.sentences)
  // 非法输出自动重试 1 次（同整稿生成的 FR-G4），仍失败才报错，不落半截结果
  let parsed: ScriptStructure | null = null
  for (let attempt = 0; attempt <= 1 && !parsed; attempt++) {
    const r = await chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      { temperature: 0.2, maxTokens: 2000 },
      { type: 'script_structure', id: cache.id },
    )
    parsed = parseStructureJson(r.content, cache.sentences, {
      model: r.model ?? currentModelLabel(),
      analyzedAt: utcNow().toISOString(),
    })
  }
  if (!parsed) throw err.upstream('结构拆解失败：模型返回的内容无法解析，请重试')
  await getDb().run('UPDATE `script_extract_cache` SET `structure` = ?, `updated_at` = ? WHERE `id` = ?', [
    jenc(parsed),
    toDb(utcNow()),
    cache.id,
  ])
  logger.info({ cacheId: cache.id, sections: parsed.sections.length, hook: parsed.hook.type }, 'copy.structure.done')
  return parsed
}

/** 文案页面展示用：已有的拆解结果与当前勾选 */
export async function getStructureView(
  copy: CopyRow,
): Promise<{ structure: ScriptStructure | null; use: StructureUse }> {
  const use = normalizeStructureUse(copy.settings?.structureUse)
  if (copy.sourceRefType !== 'benchmark_video' || !copy.extractCacheId) return { structure: null, use }
  const r = await getDb().get<{ structure: unknown }>('SELECT `structure` FROM `script_extract_cache` WHERE `id` = ?', [
    copy.extractCacheId,
  ])
  return { structure: readStructure(jdec<unknown>(r?.structure, null)), use }
}

/** 生成提示词用：有拆解结果且至少勾选一项才返回 */
export async function structureRefFor(copy: CopyRow): Promise<StructureRef | null> {
  if (copy.source !== 'benchmark') return null
  const { structure, use } = await getStructureView(copy)
  if (!structure || (!use.hook && !use.sections && !use.rhythm)) return null
  return { structure, use }
}
