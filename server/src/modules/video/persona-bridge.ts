import { getDb } from '../../db/index.js'
import { checkReadiness, getProductionProfile, type ProductionProfile, type ReadinessResult } from '../personas/readiness.js'
import { getPersonaById, type Persona } from '../personas/repo.js'
import { listAvatarsWithAsset } from '../personas/clone/avatars.js'
import type { PersonaAvatar } from '../personas/clone/avatars.js'

/**
 * 人物取用桥接层（FR-S1，🧩 P6；模式照 copy/persona-bridge.ts：服务内直接调用人物库 service，
 * 不走 HTTP，不缓存人物资产、不做授权判定，结果以人物库为准）。
 * 同时提供删除守卫（FR-S3）：供人物库软删分身 / 声音前调用。
 */

export type { ProductionProfile, ReadinessResult }

export async function getPersonaReadiness(personaId: string, purpose: 'avatar_video' | 'mixcut'): Promise<ReadinessResult> {
  return checkReadiness(personaId, purpose)
}

export async function getPersonaProductionProfile(
  personaId: string,
  opts: { avatarId?: string; purpose?: 'avatar_video' | 'mixcut' } = {},
): Promise<ProductionProfile> {
  return getProductionProfile(personaId, opts)
}

export interface AvatarOption {
  avatarId: string
  name: string
  status: string
  statusLabel: string
  selectable: boolean
  blockedReason: string | null
  backgroundLabel: string | null
  coverUrl: string | null
  sourceWidth: number | null
  sourceHeight: number | null
  isDefault: boolean
  fromLibrary: true
}

const AVATAR_STATUS_LABELS: Record<string, string> = {
  ready: '已就绪',
  running: '分身制作中',
  uncertain: '状态待核对',
  failed: '制作失败',
}

/** FR-A2：分身（背景）列表。只有 ready 分身可选；其余可见不可选并注明原因。 */
export async function listPersonaAvatarOptions(
  personaId: string,
  defaultAvatarId?: string | null,
): Promise<AvatarOption[]> {
  let defaultId = defaultAvatarId ?? null
  if (defaultId == null) {
    const p = await getPersonaById(personaId, true)
    defaultId = p?.defaultAvatarId ?? null
  }
  const avatars = (await listAvatarsWithAsset(personaId)) as Array<
    PersonaAvatar & { coverUrl: string | null; sourceWidth: number | null; sourceHeight: number | null }
  >
  return avatars.map((a) => {
    const ready = a.status === 'ready'
    return {
      avatarId: a.id,
      name: a.name,
      status: a.status,
      statusLabel: AVATAR_STATUS_LABELS[a.status] ?? a.status,
      selectable: ready,
      blockedReason: ready ? null : (AVATAR_STATUS_LABELS[a.status] ?? '状态不可用'),
      backgroundLabel: a.backgroundLabel ?? null,
      coverUrl: a.coverUrl ?? null,
      sourceWidth: a.sourceWidth ?? null,
      sourceHeight: a.sourceHeight ?? null,
      isDefault: a.id === defaultId,
      fromLibrary: true,
    }
  })
}

/** FR-A2 前置：人物是否存在（含已归档，供 context 展示；status 为读时派生） */
export async function getPersonaBrief(personaId: string) {
  const p: Persona | null = await getPersonaById(personaId, true)
  if (!p) return null
  const { derivePersonaStatus } = await import('../personas/repo.js')
  const status = await derivePersonaStatus(p)
  return { id: p.id, name: p.name, line: p.line, status: status.status }
}

/** FR-S3：分身是否被非终态视频任务引用（人物库删除守卫） */
export async function isAvatarInUse(avatarId: string): Promise<boolean> {
  const db = getDb()
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM `video_job` WHERE `avatar_id` = ? AND `archived_at` IS NULL AND `phase` NOT IN ('completed', 'failed', 'cancelled')",
    [avatarId],
  )
  return Number(row?.n ?? 0) > 0
}

/** FR-S3：声音是否被非终态视频任务引用 */
export async function isVoiceInUse(voiceId: string): Promise<boolean> {
  const db = getDb()
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM `video_job` WHERE `voice_id` = ? AND `archived_at` IS NULL AND `phase` NOT IN ('completed', 'failed', 'cancelled')",
    [voiceId],
  )
  return Number(row?.n ?? 0) > 0
}
