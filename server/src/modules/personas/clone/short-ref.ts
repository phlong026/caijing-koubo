import crypto from 'node:crypto'
import { getDb } from '../../../db/index.js'
import { err } from '../../../errors.js'

/**
 * 飞影标题与短引用（R11，平移众墅之家 oral_vendor_title + task_diagnostic_refs）。
 *
 * 飞影没有独立的透传编号字段，title 是唯一会原样回传的载体：
 * 标题 = 名称截断 + '-' + 短引用，总长 ≤20 字；
 * 短引用 = 记录 id 派生的 6 位 base32，库内唯一，
 * uncertain 核对时按标题尾部的短引用在 avatar/list / voice/list 中匹配。
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const REF_LEN = 6

/** 从种子派生 6 位 base32 短引用（确定性） */
export function deriveShortRef(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest()
  let out = ''
  for (let i = 0; i < REF_LEN; i++) out += BASE32[hash[i] % 32]
  return out
}

export type RefTable = 'persona_avatar' | 'persona_voice'

/** 生成库内唯一的短引用（确定性派生，冲突时加盐重试，兜底随机） */
export async function uniqueShortRef(table: RefTable, recordId: string): Promise<string> {
  const db = getDb()
  for (let attempt = 0; attempt < 6; attempt++) {
    const ref = deriveShortRef(attempt === 0 ? recordId : `${recordId}#salt${attempt}`)
    const row = await db.get<{ id: string }>(`SELECT \`id\` FROM \`${table}\` WHERE \`short_ref\` = ? LIMIT 1`, [ref])
    if (!row) return ref
  }
  // 极端冲突（概率 ~2^-30 量级仍不命中）：随机兜底并再次校验
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = Array.from({ length: REF_LEN }, () => BASE32[crypto.randomInt(32)]).join('')
    const row = await db.get<{ id: string }>(`SELECT \`id\` FROM \`${table}\` WHERE \`short_ref\` = ? LIMIT 1`, [ref])
    if (!row) return ref
  }
  throw err.conflict('短引用生成失败（库内冲突过于频繁），请重试')
}

/**
 * 飞影标题：名称截到 (20 - 1 - 6) = 13 字 + '-' + 6 位短引用。
 * 短引用永不被截掉，保证 uncertain 核对时可按标题尾部匹配（FR-C3 / FR-V4）。
 */
export function buildVendorTitle(name: string, shortRef: string): string {
  const base = String(name ?? '').trim()
  const namePart = base.length > 13 ? base.slice(0, 13) : base
  return `${namePart}-${shortRef}`
}
