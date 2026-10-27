import { getDb } from '../../db/index.js'
import { fromDb } from '../../lib/time.js'

/**
 * 声音库只读聚合（ML6 / FR-V1）。
 *
 * 不建表、不复制资产：声音档案的所有权与授权核验都在人物库（persona_voice + 授权材料），
 * 本模块只按线聚合出「谁有什么声音、核验到哪一步」，试听与管理链回人物库。
 * 素材库不接管 BGM（BGM 属剪辑模块 `bgm_item`，A5）。
 */

export interface VoiceLibraryItem {
  voiceId: string
  personaId: string
  personaName: string
  line: string
  voiceName: string
  /** 声音状态（人物库口径：pending|cloning|ready|failed|...） */
  status: string
  isSample: boolean
  /** 人工试听确认 */
  confirmed: boolean
  /** 是否已绑定授权同意（consent_id 非空） */
  consentBound: boolean
  authorizationId: string | null
  /** 试听文件键（人物库 demo_key，经 /media 回放） */
  demoKey: string | null
  createdAt: string | null
}

/** 授权状态归纳（供列表展示；核验动作仍在人物库） */
export function licenseStateOf(v: Pick<VoiceLibraryItem, 'confirmed' | 'consentBound'>): 'verified' | 'pending' | 'unbound' {
  if (v.confirmed && v.consentBound) return 'verified'
  if (v.consentBound) return 'pending'
  return 'unbound'
}

export async function listVoiceLibrary(filter: { line?: string; personaId?: string } = {}): Promise<VoiceLibraryItem[]> {
  const db = getDb()
  const where: string[] = ['p.`archived_at` IS NULL']
  const params: unknown[] = []
  if (filter.line) {
    where.push('p.`line` = ?')
    params.push(filter.line)
  }
  if (filter.personaId) {
    where.push('v.`persona_id` = ?')
    params.push(filter.personaId)
  }
  const rows = await db.all<Record<string, unknown>>(
    'SELECT v.`id`, v.`persona_id`, v.`name`, v.`status`, v.`is_sample`, v.`confirmed`, v.`consent_id`, v.`authorization_id`, v.`demo_key`, v.`sample_key`, v.`created_at`, ' +
      'p.`name` AS `persona_name`, p.`line` AS `line` ' +
      'FROM `persona_voice` v JOIN `persona` p ON p.`id` = v.`persona_id` ' +
      `WHERE ${where.join(' AND ')} ` +
      'ORDER BY p.`line` ASC, p.`name` ASC, v.`created_at` ASC',
    params,
  )
  return rows.map((r) => ({
    voiceId: String(r.id),
    personaId: String(r.persona_id),
    personaName: String(r.persona_name ?? '未命名人物'),
    line: String(r.line ?? ''),
    voiceName: String(r.name ?? ''),
    status: String(r.status ?? 'pending'),
    isSample: Number(r.is_sample ?? 0) === 1,
    confirmed: Number(r.confirmed ?? 0) === 1,
    consentBound: Boolean(r.consent_id),
    authorizationId: (r.authorization_id as string) ?? null,
    // 试听优先归档 demo，未归档时回退克隆样本（人物库口径）
    demoKey: (r.demo_key as string) ?? (r.sample_key as string) ?? null,
    createdAt: fromDb(r.created_at as string),
  }))
}
