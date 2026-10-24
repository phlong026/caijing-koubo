import { config } from '../../config.js'
import { getApprovedCopy } from '../copy/review.js'
import { hiflyStatus } from '../../integrations/hifly/client.js'
import { getDb } from '../../db/index.js'
import { buildTextSnapshot } from './text-snapshot.js'
import { getPersonaReadiness, listPersonaAvatarOptions } from './persona-bridge.js'
import type { PrecheckItem, TextSegment } from './types.js'

/**
 * 配置检查（V10）：硬项全过才允许创建；软项只提示。
 * 人物相关项直接合并人物库 readiness 的 checks（key 加 persona. 前缀，前端据此跳人物库对应 Tab）。
 * 授权与声音确认以人物库判定为准，本模块不重复判断。
 * 任一硬项不过即提前返回（带已累计的检查项），创建接口复用同一套检查。
 */

export interface VideoPrecheckInput {
  copyId: string
  mode: 'avatar' | 'mixcut'
  avatarId?: string | null
  /** 混剪：素材包（多选）与配音来源 */
  mixcutPackIds?: string[]
  voiceSource?: 'persona' | 'public'
  publicVoiceId?: string | null
}

export interface VideoPrecheckResult {
  estSeconds: number
  estCredits: number
  segments: TextSegment[]
  checks: PrecheckItem[]
  /** 硬①通过时带出取稿结果（创建时直接复用，避免二次取稿） */
  approved: {
    copyId: string
    versionId: string
    versionNo: number
    title: string
    riskHint: string
    sections: Array<{ label: string; text: string }>
    personaId: string
    line: string
    revising: boolean
  } | null
}

/** 人物库 check key → 前端跳转入口（人物库对应 Tab） */
function personaActionOf(key: string): string {
  if (key.includes('auth')) return 'persona:authorization'
  if (key.includes('avatar')) return 'persona:avatar'
  if (key.includes('voice')) return 'persona:voice'
  return 'persona:basic'
}

/** 检查项累计器：硬项不过时提前结束 */
class Collector {
  checks: PrecheckItem[] = []
  segments: TextSegment[] = []
  estSeconds = 0
  approved: VideoPrecheckResult['approved'] = null

  add(item: PrecheckItem): boolean {
    this.checks.push(item)
    return !(item.level === 'hard' && !item.pass)
  }

  toResult(): VideoPrecheckResult {
    return {
      estSeconds: this.estSeconds,
      estCredits: Number((config.video.creditsPerSec * this.estSeconds).toFixed(2)),
      segments: this.segments,
      checks: this.checks,
      approved: this.approved,
    }
  }
}

export async function runPrecheck(input: VideoPrecheckInput): Promise<VideoPrecheckResult> {
  const c = new Collector()
  const db = getDb()

  // 硬① 文案已通过且取到版本（A1）
  try {
    const ap = await getApprovedCopy(input.copyId)
    const copyRow = await db.get<{ status: string }>('SELECT `status` FROM `copy` WHERE `id` = ?', [input.copyId])
    const revising = copyRow?.status === 'draft'
    c.approved = {
      copyId: ap.copyId,
      versionId: ap.versionId,
      versionNo: ap.versionNo,
      title: ap.title ?? '',
      riskHint: ap.riskHint ?? '',
      sections: ap.sections,
      personaId: ap.persona?.id ?? '',
      line: ap.persona?.line ?? '',
      revising,
    }
    c.add({ key: 'copy_approved', level: 'hard', pass: true, message: `文案 v${ap.versionNo} 已通过人工复核` })
    // 软⑨ 已通过版本不是最新提交（文案修订中，A3）
    c.checks.push({
      key: 'copy_latest',
      level: 'soft',
      pass: !revising,
      message: revising ? '文案修订中，当前使用已通过的版本；重提通过后新版本才生效' : '文案无进行中的修订',
    })
  } catch (e) {
    c.checks.push({ key: 'copy_approved', level: 'hard', pass: false, message: e instanceof Error ? e.message : '文案未通过审核', action: 'copy:review' })
    return c.toResult()
  }

  const { personaId, line } = { personaId: c.approved!.personaId, line: c.approved!.line }

  // 硬③ 模式允许（A5：素人矩阵不使用数字人口播）
  if (input.mode === 'avatar') {
    const allowed = line !== 'persona'
    if (!c.add({ key: 'mode_allowed', level: 'hard', pass: allowed, message: allowed ? '该人物线允许数字人口播' : '素人矩阵不使用数字人口播，请改用素材混剪' })) {
      return c.toResult()
    }
  }

  // 硬② 人物 readiness（合并人物库 checks，V10②）
  const purpose = input.mode === 'avatar' ? 'avatar_video' : 'mixcut'
  const readiness = await getPersonaReadiness(personaId, purpose)
  for (const item of readiness.checks) {
    c.checks.push({
      key: `persona.${item.key}`,
      level: item.level,
      pass: item.pass,
      message: item.message,
      ...(item.pass ? {} : { action: personaActionOf(item.key) }),
    })
  }
  if (!readiness.pass) return c.toResult()

  // 硬⑤ 口播文本与时长（FR-P1）
  try {
    const snap = buildTextSnapshot(c.approved!.sections, c.approved!.riskHint)
    c.segments = snap.segments
    c.estSeconds = snap.estSeconds
    c.add({ key: 'text_limit', level: 'hard', pass: true, message: `口播 ${snap.charCount} 字，预计 ${Math.round(snap.estSeconds)} 秒` })
  } catch (e) {
    c.checks.push({ key: 'text_limit', level: 'hard', pass: false, message: e instanceof Error ? e.message : '口播文本超限' })
    return c.toResult()
  }

  // 硬④ 所选分身属于该人物且 ready（口播模式）+ 软⑪ 源视频比例
  if (input.mode === 'avatar') {
    const avatars = await listPersonaAvatarOptions(personaId)
    const chosen = input.avatarId ? avatars.find((a) => a.avatarId === input.avatarId) : avatars.find((a) => a.isDefault)
    if (!c.add({
      key: 'avatar_ready',
      level: 'hard',
      pass: !!chosen?.selectable,
      message: chosen
        ? chosen.selectable
          ? `分身「${chosen.name}」已就绪`
          : `所选分身不可用：${chosen.blockedReason}`
        : input.avatarId
          ? '所选分身不属于该人物'
          : '人物缺少可用的默认分身',
      ...(chosen?.selectable ? {} : { action: 'persona:avatar' }),
    })) {
      return c.toResult()
    }
    const ratioOk = chosen?.sourceWidth && chosen?.sourceHeight
      ? Math.abs(chosen.sourceWidth / chosen.sourceHeight - 9 / 16) < 0.02
      : true
    c.checks.push({
      key: 'avatar_ratio',
      level: 'soft',
      pass: ratioOk,
      message: ratioOk ? '分身源视频为 9:16' : '分身源视频非 9:16，成片将等比补边',
    })
  }

  // 硬⑥ 飞影已配置（或 MOCK，V13）
  const engineReady = hiflyStatus().configured || config.mockFallback
  if (!c.add({
    key: 'engine_ready',
    level: 'hard',
    pass: engineReady,
    message: engineReady ? (hiflyStatus().mock ? '模拟引擎（MOCK），产物将带「模拟」标记' : '飞影已配置') : '飞影未配置且未开启 MOCK',
  })) {
    return c.toResult()
  }

  // 硬⑦ 混剪素材包可用
  if (input.mode === 'mixcut') {
    const packIds = input.mixcutPackIds ?? []
    let packOk = packIds.length > 0
    if (packOk) {
      const rows = await db.all<{ id: string; n: number }>(
        `SELECT p.\`id\`, COUNT(i.\`id\`) AS n FROM \`material_pack\` p LEFT JOIN \`material_item\` i ON i.\`pack_id\` = p.\`id\` AND i.\`enabled\` = 1
         WHERE p.\`id\` IN (${packIds.map(() => '?').join(',')}) AND p.\`enabled\` = 1 GROUP BY p.\`id\``,
        packIds,
      )
      packOk = rows.length === packIds.length && rows.every((r) => Number(r.n) > 0)
    }
    if (!c.add({
      key: 'material_ready',
      level: 'hard',
      pass: packOk,
      message: packOk ? '素材包可用' : '所选素材包不存在、已停用或没有可用素材',
      ...(packOk ? {} : { action: 'material:manage' }),
    })) {
      return c.toResult()
    }
  }

  // 软⑩ 已存在进行中的同 copy 任务（创建时为硬性 409 VIDEO_JOB_ACTIVE，这里只提示）
  if (await hasActiveJobForCopy(input.copyId)) {
    c.checks.push({ key: 'job_active', level: 'soft', pass: false, message: '该文案已有进行中的视频任务，生成前需等待其完成或取消' })
  }

  // 软⑧ 飞影积分余额低于本次预估消耗（Q8）
  if (hiflyStatus().configured) {
    try {
      const { resolveHiflyClient } = await import('../../integrations/hifly/index.js')
      const credit = await resolveHiflyClient().credit()
      const estCredits = Number((config.video.creditsPerSec * c.estSeconds).toFixed(2))
      c.checks.push({
        key: 'credit_enough',
        level: 'soft',
        pass: !(credit < estCredits),
        message: credit < estCredits ? `飞影余额 ${credit} 低于本次预估消耗 ${estCredits}，可能提交失败` : `飞影余额 ${credit}，本次预估消耗 ${estCredits}`,
      })
    } catch {
      // 余额查询失败只跳过软项提示
    }
  }

  return c.toResult()
}

/** 软⑩：同 copy 是否有非终态任务（§3.1：同一 copy 只允许一个非终态任务，半终态也算占用） */
export async function hasActiveJobForCopy(copyId: string): Promise<boolean> {
  const db = getDb()
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM `video_job` WHERE `copy_id` = ? AND `archived_at` IS NULL AND `phase` NOT IN ('completed', 'failed', 'cancelled')",
    [copyId],
  )
  return Number(row?.n ?? 0) > 0
}

/** 创建时的同 copy 非终态任务（409 返回任务 id，FR-A6） */
export async function getActiveJobForCopy(copyId: string): Promise<string | null> {
  const db = getDb()
  const row = await db.get<{ id: string }>(
    "SELECT `id` FROM `video_job` WHERE `copy_id` = ? AND `archived_at` IS NULL AND `phase` NOT IN ('completed', 'failed', 'cancelled') ORDER BY `created_at` DESC LIMIT 1",
    [copyId],
  )
  return row?.id ?? null
}
