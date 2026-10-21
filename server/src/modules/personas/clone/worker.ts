import fsp from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../../../db/index.js'
import { memEnqueue } from '../../../queue/memory.js'
import { enqueue, QUEUE_NAMES, dedupOpts, getQueueBackend, registerWorker } from '../../../queue/index.js'
import { config, paths } from '../../../config.js'
import { logger } from '../../../log.js'
import { err } from '../../../errors.js'
import { toDb, utcNow } from '../../../lib/time.js'
import { recordOperation } from '../../audit/repo.js'
import { getObjectStream, isOssEnabled, putObjectFromFile } from '../../../integrations/aliyun-oss/client.js'
import {
  HiflySubmissionUncertain,
  HiflyVendorError,
  resolveHiflyClient,
  vendorErrorOf,
} from '../../../integrations/hifly/index.js'
import { probeMedia } from '../../../media/inspect.js'
import { ensureTempDir, cleanup } from '../../../media/pipeline.js'
import { getAssetById } from '../assets.js'
import { createReminder } from '../reminders.js'
import { getVoiceById, type PersonaVoice } from './voices.js'
import { getAvatarById, type PersonaAvatar } from './avatars.js'
import { deliverMaterial } from './transfer.js'

/**
 * persona-clone 队列 worker（R8/R9/R10 / FR-C2/C3 / FR-V3/V4 / FR-V7）。
 *
 * 职责：提交（submit）→ 轮询（poll）→ 归档；不确定态核对（reconcile）。
 * 规则：
 *  - 提交步骤**不自动重试**：失败即 failed / uncertain（L9）；
 *  - 轮询按 next_poll_at 重新入队，15s 起指数退避至 2min；
 *  - 轮询超过 2 小时（config.hifly.pollMaxAgeMs）→ uncertain；
 *  - 飞影调用一律在事务外（db.tx 不可嵌套）；
 *  - 状态推进全部带 WHERE status 守卫（CAS），影响行数 ≠1 时回查判定。
 */

type CloneJob =
  | { kind: 'avatar'; recordId: string }
  | { kind: 'voice'; recordId: string }
  | { kind: 'preview'; recordId: string }

/* ── 轮询调度（BullMQ delay / 内存队列 setTimeout）──────────────── */

/**
 * `step` 并入 BullMQ 的去重键：轮询任务在自己运行期间重新入队时，同一 dedup id 仍被「运行中的自己」占用，
 * 会被静默丢弃、轮询链断掉；按轮询序号区分后，同一步仍去重，下一步不会被挡住。内存队列用 setTimeout 延后投递，不受影响。
 */
async function scheduleJob(jobName: string, data: CloneJob, dedupId: string, delayMs: number, step: number | string): Promise<void> {
  if (getQueueBackend() === 'memory') {
    const timer = setTimeout(() => {
      try {
        memEnqueue(QUEUE_NAMES.personaClone, jobName, data, { deduplication: { id: dedupId } })
      } catch {
        /* 内存队列投递失败：等下次轮询兜底 */
      }
    }, Math.max(0, Math.min(delayMs, 120_000)))
    timer.unref?.()
    return
  }
  await enqueue(QUEUE_NAMES.personaClone, jobName, data, { ...dedupOpts(`${dedupId}:${step}`), delay: Math.max(0, delayMs) })
}

/** 轮询退避：15s 起，按 attempts 指数退避，上限 2min（FR-C2） */
function pollDelayOf(attempts: number): number {
  const base = config.hifly.pollInitialMs
  const delay = base * 2 ** Math.max(0, attempts - 1)
  return Math.min(delay, config.hifly.pollMaxMs)
}

/* ── 存储取件（OSS 流式下载 / 本地兜底复制）────────────────────── */

async function fetchToLocal(storageKey: string, destName: string): Promise<string> {
  await ensureTempDir()
  const dest = path.join(paths.tempDir, destName)
  if (isOssEnabled()) {
    const res = await getObjectStream(storageKey)
    if (!res) throw new Error(`存储对象不存在或读取失败：${storageKey}`)
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      ;(res.stream as NodeJS.ReadableStream).on('data', (c: Buffer) => chunks.push(c))
      ;(res.stream as NodeJS.ReadableStream).on('end', () => resolve())
      ;(res.stream as NodeJS.ReadableStream).on('error', reject)
    })
    await fsp.writeFile(dest, Buffer.concat(chunks))
  } else {
    const local = path.join(paths.dataDir, 'oss', storageKey)
    await fsp.copyFile(local, dest)
  }
  return dest
}

/** 本地兜底路径（无 OSS 时素材在 .data/oss 下） */
function localPathOf(storageKey: string): string | null {
  return isOssEnabled() ? null : path.join(paths.dataDir, 'oss', storageKey)
}

/* ── 状态推进（CAS）────────────────────────────────────────────── */

async function casStatus(
  table: 'persona_avatar' | 'persona_voice',
  id: string,
  from: string,
  to: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const sets = ['`status` = ?', '`updated_at` = ?', ...Object.keys(extra).map((k) => `\`${k}\` = ?`)]
  const params = [to, toDb(utcNow()), ...Object.values(extra), id, from]
  const r = await getDb().run(
    `UPDATE \`${table}\` SET ${sets.join(', ')} WHERE \`id\` = ? AND \`status\` = ?`,
    params,
  )
  return r.affectedRows > 0
}

async function bumpAttempts(table: 'persona_avatar' | 'persona_voice', id: string): Promise<number> {
  await getDb().run(`UPDATE \`${table}\` SET \`attempts\` = \`attempts\` + 1, \`updated_at\` = ? WHERE \`id\` = ?`, [
    toDb(utcNow()),
    id,
  ])
  const row = await getDb().get<{ attempts: number }>(`SELECT \`attempts\` FROM \`${table}\` WHERE \`id\` = ?`, [id])
  return Number(row?.attempts ?? 1)
}

async function notifyCloneState(
  personaId: string,
  kind: 'clone_uncertain' | 'clone_failed',
  refId: string,
  message: string,
): Promise<void> {
  await createReminder({ personaId, kind, refId, message, operator: 'system' }).catch((e) => {
    logger.debug({ err: (e as Error).message }, 'persona.clone.reminder_skipped')
  })
}

/** 厂商错误 → 可读文案（业务码映射 + vendorCode 保留） */
function vendorMessage(e: unknown): string {
  if (e instanceof HiflyVendorError) {
    return vendorErrorOf(e.vendorCode, e.message).message
  }
  return (e as Error).message || '飞影服务异常'
}

/* ── 分身：提交 ────────────────────────────────────────────────── */

export async function submitAvatar(avatarId: string): Promise<void> {
  const avatar = await getAvatarById(avatarId, true)
  if (!avatar || avatar.deletedAt) return
  if (avatar.status !== 'pending') {
    logger.debug({ avatarId, status: avatar.status }, 'persona.clone.avatar_submit_skip')
    return
  }
  // 单消费者持有 submitting：dedupOpts 去重 + 状态守卫双保险
  const claimed = await casStatus('persona_avatar', avatarId, 'pending', 'submitting')
  if (!claimed) return

  const client = resolveHiflyClient()
  const tempFiles: string[] = []
  try {
    const asset = await getAssetById(avatar.sourceAssetId)
    if (!asset || asset.status !== 'approved') {
      throw new Error('分身素材不存在或未审核通过')
    }
    // R20：优先交付兼容版本（H.264 mp4）
    const storageKey = asset.compatKey ?? asset.storageKey
    const ext = path.extname(storageKey) || '.mp4'
    const handover = await deliverMaterial(client, {
      storageKey,
      localPath: localPathOf(storageKey),
      fileExtension: ext.replace(/^\./, ''),
      mockSeed: `${avatar.sourceAssetId}:${asset.compatSha256 ?? asset.sha256}`,
    })

    const accept =
      handover.kind === 'url'
        ? await client.createAvatarByVideo({ title: avatar.vendorTitle, videoUrl: handover.url })
        : await client.createAvatarByVideo({ title: avatar.vendorTitle, fileId: handover.fileId })

    if (!accept.taskId) {
      // 拿到业务码但没有 task_id：提交结果未知（R2）
      throw new HiflySubmissionUncertain('飞影未返回克隆任务凭证')
    }
    const attempts = await bumpAttempts('persona_avatar', avatarId)
    await casStatus('persona_avatar', avatarId, 'submitting', 'running', {
      vendor_task_id: accept.taskId,
      submitted_at: toDb(utcNow()),
      error: null,
    })
    await recordOperation({
      operator: 'system',
      action: 'persona.avatar_submitted',
      targetType: 'persona',
      targetId: avatar.personaId,
      detail: { avatarId, vendorTaskId: accept.taskId, mode: handover.mode, attempts },
    })
    logger.info({ avatarId, vendorTaskId: accept.taskId, mode: handover.mode }, 'persona.clone.avatar_submitted')
    await scheduleJob('avatar_poll', { kind: 'avatar', recordId: avatarId }, `avatar-poll-${avatarId}`, pollDelayOf(attempts), `s${attempts}`)
  } catch (e) {
    if (e instanceof HiflyVendorError) {
      // 明确业务码失败：failed（原因经业务码映射，FR-C2）
      await casStatus('persona_avatar', avatarId, 'submitting', 'failed', { error: vendorMessage(e) })
      await notifyCloneState(avatar.personaId, 'clone_failed', avatarId, `分身「${avatar.name}」制作失败：${vendorMessage(e)}`)
      logger.warn({ avatarId, vendorCode: e.vendorCode }, 'persona.clone.avatar_failed')
    } else {
      // 无业务码的异常 / 超时：提交结果未知 → uncertain，禁自动重提（L9）
      await casStatus('persona_avatar', avatarId, 'submitting', 'uncertain', {
        error: (e as Error).message.slice(0, 2000),
      })
      await notifyCloneState(
        avatar.personaId,
        'clone_uncertain',
        avatarId,
        `分身「${avatar.name}」提交结果未知，请核对状态，勿重复创建`,
      )
      logger.warn({ avatarId, err: (e as Error).message }, 'persona.clone.avatar_uncertain')
    }
  } finally {
    await cleanup(tempFiles)
  }
}

/* ── 分身：轮询 ────────────────────────────────────────────────── */

export async function pollAvatar(avatarId: string): Promise<PersonaAvatar> {
  const avatar = await getAvatarById(avatarId, true)
  if (!avatar || avatar.deletedAt) return avatar!
  if (avatar.status !== 'running' || !avatar.vendorTaskId) return avatar

  // 超过 2 小时仍非终态 → uncertain（R9）
  const startedAt = avatar.submittedAt ? new Date(avatar.submittedAt).getTime() : Date.now()
  if (Date.now() - startedAt > config.hifly.pollMaxAgeMs) {
    await casStatus('persona_avatar', avatarId, 'running', 'uncertain', {
      error: `轮询超过 ${Math.round(config.hifly.pollMaxAgeMs / 3600000)} 小时仍未完成，已转入人工核对`,
      last_polled_at: toDb(utcNow()),
    })
    await notifyCloneState(
      avatar.personaId,
      'clone_uncertain',
      avatarId,
      `分身「${avatar.name}」制作超过 ${Math.round(config.hifly.pollMaxAgeMs / 3600000)} 小时未完成，请核对状态`,
    )
    return (await getAvatarById(avatarId, true))!
  }

  const client = resolveHiflyClient()
  try {
    const snap = await client.avatarTask(avatar.vendorTaskId)
    const attempts = await bumpAttempts('persona_avatar', avatarId)
    await getDb().run('UPDATE `persona_avatar` SET `last_polled_at` = ?, `updated_at` = ? WHERE `id` = ?', [
      toDb(utcNow()),
      toDb(utcNow()),
      avatarId,
    ])
    if (snap.state === 'DONE' && snap.avatarId) {
      await casStatus('persona_avatar', avatarId, 'running', 'ready', {
        vendor_avatar_id: snap.avatarId,
        ready_at: toDb(utcNow()),
        error: null,
      })
      await recordOperation({
        operator: 'system',
        action: 'persona.avatar_ready',
        targetType: 'persona',
        targetId: avatar.personaId,
        detail: { avatarId, vendorAvatarId: snap.avatarId },
      })
      logger.info({ avatarId, vendorAvatarId: snap.avatarId }, 'persona.clone.avatar_ready')
    } else if (snap.state === 'FAILED') {
      const message = snap.failReason ? vendorErrorOf(snap.vendorCode ?? 0, snap.failReason).message : '分身制作失败，未附原因'
      await casStatus('persona_avatar', avatarId, 'running', 'failed', { error: message })
      await notifyCloneState(avatar.personaId, 'clone_failed', avatarId, `分身「${avatar.name}」制作失败：${message}`)
      logger.warn({ avatarId, message }, 'persona.clone.avatar_failed')
    } else {
      // DONE 但缺标识 → 继续等待（R15）；WAITING / PROCESSING → 退避轮询
      await getDb().run('UPDATE `persona_avatar` SET `next_poll_at` = ?, `updated_at` = ? WHERE `id` = ?', [
        toDb(new Date(Date.now() + pollDelayOf(attempts))),
        toDb(utcNow()),
        avatarId,
      ])
      await scheduleJob('avatar_poll', { kind: 'avatar', recordId: avatarId }, `avatar-poll-${avatarId}`, pollDelayOf(attempts), attempts)
    }
  } catch (e) {
    if (e instanceof HiflyVendorError) {
      const message = vendorMessage(e)
      await casStatus('persona_avatar', avatarId, 'running', 'failed', { error: message })
      await notifyCloneState(avatar.personaId, 'clone_failed', avatarId, `分身「${avatar.name}」制作失败：${message}`)
    } else {
      // 查询类网络异常：不判失败，继续等待（R2）
      const attempts = await bumpAttempts('persona_avatar', avatarId)
      await scheduleJob('avatar_poll', { kind: 'avatar', recordId: avatarId }, `avatar-poll-${avatarId}`, pollDelayOf(attempts), attempts)
      logger.debug({ avatarId, err: (e as Error).message }, 'persona.clone.avatar_poll_retry')
    }
  }
  return (await getAvatarById(avatarId, true))!
}

/* ── 分身：核对（FR-C3）───────────────────────────────────────── */

export async function reconcileAvatar(avatarId: string, operator: string): Promise<PersonaAvatar> {
  const avatar = await getAvatarById(avatarId, true)
  if (!avatar || avatar.deletedAt) throw err.notFound('分身不存在')
  if (avatar.status !== 'uncertain') {
    throw err.invalidState(`当前状态（${avatar.status}）不可核对，仅「待核对」分身可操作`, { status: avatar.status })
  }
  const client = resolveHiflyClient()
  const evidence: Record<string, unknown> = { avatarId, shortRef: avatar.shortRef, operator }

  // ① 列表按短引用匹配（分页扫描，kind=2）
  let matched: { id: string; title: string } | null = null
  try {
    for (let page = 1; page <= 10 && !matched; page++) {
      const items = await client.avatarList({ page, pageSize: 50, kind: 2 })
      if (!items.length) break
      const hit = items.find((it) => (it.title ?? '').endsWith(`-${avatar.shortRef}`))
      if (hit?.id) matched = { id: hit.id, title: hit.title ?? '' }
      if (items.length < 50) break
    }
  } catch (e) {
    evidence.listError = (e as Error).message
    logger.warn({ avatarId, err: (e as Error).message }, 'persona.clone.avatar_reconcile_list_failed')
  }

  if (matched) {
    // 查到：补写厂商标识直接 ready
    await casStatus('persona_avatar', avatarId, 'uncertain', 'ready', {
      vendor_avatar_id: matched.id,
      ready_at: toDb(utcNow()),
      error: null,
    })
    await recordOperation({
      operator,
      action: 'persona.avatar_reconciled',
      targetType: 'persona',
      targetId: avatar.personaId,
      detail: { ...evidence, result: 'ready', vendorAvatarId: matched.id, matchedTitle: matched.title },
    })
    logger.info({ avatarId, vendorAvatarId: matched.id }, 'persona.clone.avatar_reconciled_ready')
    return (await getAvatarById(avatarId, true))!
  }

  // ② 列表无且有任务号：再查一次任务
  if (avatar.vendorTaskId) {
    try {
      const snap = await client.avatarTask(avatar.vendorTaskId)
      if (snap.state === 'DONE' && snap.avatarId) {
        await casStatus('persona_avatar', avatarId, 'uncertain', 'ready', {
          vendor_avatar_id: snap.avatarId,
          ready_at: toDb(utcNow()),
          error: null,
        })
        await recordOperation({
          operator,
          action: 'persona.avatar_reconciled',
          targetType: 'persona',
          targetId: avatar.personaId,
          detail: { ...evidence, result: 'ready', vendorAvatarId: snap.avatarId, via: 'task' },
        })
        return (await getAvatarById(avatarId, true))!
      }
      if (snap.state === 'FAILED') {
        const message = snap.failReason ? vendorErrorOf(snap.vendorCode ?? 0, snap.failReason).message : '分身制作失败，未附原因'
        await casStatus('persona_avatar', avatarId, 'uncertain', 'failed', { error: message })
        await recordOperation({
          operator,
          action: 'persona.avatar_reconciled',
          targetType: 'persona',
          targetId: avatar.personaId,
          detail: { ...evidence, result: 'failed', message },
        })
        await notifyCloneState(avatar.personaId, 'clone_failed', avatarId, `分身「${avatar.name}」核对后确认失败：${message}`)
        return (await getAvatarById(avatarId, true))!
      }
      // 任务仍在进行：保持 uncertain，等下次核对（不自动轮询，避免与 2 小时窗口口径冲突）
      await recordOperation({
        operator,
        action: 'persona.avatar_reconciled',
        targetType: 'persona',
        targetId: avatar.personaId,
        detail: { ...evidence, result: 'still_uncertain', taskState: snap.state },
      })
      return (await getAvatarById(avatarId, true))!
    } catch (e) {
      evidence.taskError = (e as Error).message
    }
  }

  // ③ 确认不存在：failed 并允许重新制作（新 Idempotency-Key 新记录）
  await casStatus('persona_avatar', avatarId, 'uncertain', 'failed', {
    error: '核对确认飞影侧无此分身（列表与任务均未找到），可重新制作',
  })
  await recordOperation({
    operator,
    action: 'persona.avatar_reconciled',
    targetType: 'persona',
    targetId: avatar.personaId,
    detail: { ...evidence, result: 'not_found' },
  })
  logger.info({ avatarId }, 'persona.clone.avatar_reconciled_not_found')
  return (await getAvatarById(avatarId, true))!
}

/* ── 声音：提交 ────────────────────────────────────────────────── */

export async function submitVoice(voiceId: string): Promise<void> {
  const voice = await getVoiceById(voiceId, true)
  if (!voice || voice.deletedAt || voice.isSample) return
  if (voice.status !== 'pending') return
  const claimed = await casStatus('persona_voice', voiceId, 'pending', 'submitting')
  if (!claimed) return

  const client = resolveHiflyClient()
  try {
    // 样本已在上传时规范化为单声道 mp3（FR-V1）；交付样本存储对象
    const handover = await deliverMaterial(client, {
      storageKey: voice.sampleKey,
      localPath: localPathOf(voice.sampleKey),
      fileExtension: 'mp3',
      mockSeed: voice.sampleSha256,
    })
    const accept =
      handover.kind === 'url'
        ? await client.createVoice({
            title: voice.vendorTitle,
            audioUrl: handover.url,
            voiceType: voice.voiceType,
            languages: voice.language === 'zh' ? null : voice.language,
          })
        : await client.createVoice({
            title: voice.vendorTitle,
            fileId: handover.fileId,
            voiceType: voice.voiceType,
            languages: voice.language === 'zh' ? null : voice.language,
          })
    if (!accept.taskId) throw new HiflySubmissionUncertain('飞影未返回声音克隆任务凭证')
    const attempts = await bumpAttempts('persona_voice', voiceId)
    await casStatus('persona_voice', voiceId, 'submitting', 'running', {
      vendor_task_id: accept.taskId,
      submitted_at: toDb(utcNow()),
      error: null,
    })
    await recordOperation({
      operator: 'system',
      action: 'persona.voice_submitted',
      targetType: 'persona',
      targetId: voice.personaId,
      detail: { voiceId, vendorTaskId: accept.taskId, mode: handover.mode, attempts },
    })
    logger.info({ voiceId, vendorTaskId: accept.taskId, mode: handover.mode }, 'persona.clone.voice_submitted')
    await scheduleJob('voice_poll', { kind: 'voice', recordId: voiceId }, `voice-poll-${voiceId}`, pollDelayOf(attempts), `s${attempts}`)
  } catch (e) {
    if (e instanceof HiflyVendorError) {
      await casStatus('persona_voice', voiceId, 'submitting', 'failed', { error: vendorMessage(e) })
      await notifyCloneState(voice.personaId, 'clone_failed', voiceId, `声音「${voice.name}」克隆失败：${vendorMessage(e)}`)
      logger.warn({ voiceId, vendorCode: e.vendorCode }, 'persona.clone.voice_failed')
    } else {
      await casStatus('persona_voice', voiceId, 'submitting', 'uncertain', {
        error: (e as Error).message.slice(0, 2000),
      })
      await notifyCloneState(voice.personaId, 'clone_uncertain', voiceId, `声音「${voice.name}」提交结果未知，请核对状态，勿重复创建`)
      logger.warn({ voiceId, err: (e as Error).message }, 'persona.clone.voice_uncertain')
    }
  }
}

/* ── 声音：轮询（R8：下载试听 → ffprobe 校验 → 归档）────────── */

export async function pollVoice(voiceId: string): Promise<PersonaVoice> {
  const voice = await getVoiceById(voiceId, true)
  if (!voice || voice.deletedAt || voice.isSample) return voice!
  if (voice.status !== 'running' || !voice.vendorTaskId) return voice

  const startedAt = voice.submittedAt ? new Date(voice.submittedAt).getTime() : Date.now()
  if (Date.now() - startedAt > config.hifly.pollMaxAgeMs) {
    await casStatus('persona_voice', voiceId, 'running', 'uncertain', {
      error: `轮询超过 ${Math.round(config.hifly.pollMaxAgeMs / 3600000)} 小时仍未完成，已转入人工核对`,
      last_polled_at: toDb(utcNow()),
    })
    await notifyCloneState(
      voice.personaId,
      'clone_uncertain',
      voiceId,
      `声音「${voice.name}」克隆超过 ${Math.round(config.hifly.pollMaxAgeMs / 3600000)} 小时未完成，请核对状态`,
    )
    return (await getVoiceById(voiceId, true))!
  }

  const client = resolveHiflyClient()
  const tempFiles: string[] = []
  try {
    const snap = await client.voiceTask(voice.vendorTaskId)
    const attempts = await bumpAttempts('persona_voice', voiceId)
    await getDb().run('UPDATE `persona_voice` SET `last_polled_at` = ?, `updated_at` = ? WHERE `id` = ?', [
      toDb(utcNow()),
      toDb(utcNow()),
      voiceId,
    ])
    if (snap.state === 'DONE' && snap.voiceId && snap.demoUrl) {
      // R8：下载试听 → 校验 → 归档（demo_key）
      await ensureTempDir()
      const dest = path.join(paths.tempDir, `${voiceId}_demo.mp3`)
      tempFiles.push(dest)
      await client.download(snap.demoUrl, dest)
      const probe = await probeMedia(dest)
      if (!probe.hasAudio) throw new Error('试听文件校验失败：不是有效音频')
      const demoKey = `persona/${voice.personaId}/voice/${voiceId}_demo.mp3`
      await putObjectFromFile(dest, demoKey, '')
      await casStatus('persona_voice', voiceId, 'running', 'ready', {
        vendor_voice_id: snap.voiceId,
        demo_key: demoKey,
        ready_at: toDb(utcNow()),
        error: null,
      })
      await recordOperation({
        operator: 'system',
        action: 'persona.voice_ready',
        targetType: 'persona',
        targetId: voice.personaId,
        detail: { voiceId, vendorVoiceId: snap.voiceId, demoKey },
      })
      logger.info({ voiceId, vendorVoiceId: snap.voiceId }, 'persona.clone.voice_ready')
    } else if (snap.state === 'FAILED') {
      const message = snap.failReason ? vendorErrorOf(snap.vendorCode ?? 0, snap.failReason).message : '声音克隆失败，未附原因'
      await casStatus('persona_voice', voiceId, 'running', 'failed', { error: message })
      await notifyCloneState(voice.personaId, 'clone_failed', voiceId, `声音「${voice.name}」克隆失败：${message}`)
      logger.warn({ voiceId, message }, 'persona.clone.voice_failed')
    } else {
      // DONE 但缺 voice / demo_url → 继续等待（R15）
      await getDb().run('UPDATE `persona_voice` SET `next_poll_at` = ?, `updated_at` = ? WHERE `id` = ?', [
        toDb(new Date(Date.now() + pollDelayOf(attempts))),
        toDb(utcNow()),
        voiceId,
      ])
      await scheduleJob('voice_poll', { kind: 'voice', recordId: voiceId }, `voice-poll-${voiceId}`, pollDelayOf(attempts), attempts)
    }
  } catch (e) {
    if (e instanceof HiflyVendorError) {
      const message = vendorMessage(e)
      await casStatus('persona_voice', voiceId, 'running', 'failed', { error: message })
      await notifyCloneState(voice.personaId, 'clone_failed', voiceId, `声音「${voice.name}」克隆失败：${message}`)
    } else {
      const attempts = await bumpAttempts('persona_voice', voiceId)
      await scheduleJob('voice_poll', { kind: 'voice', recordId: voiceId }, `voice-poll-${voiceId}`, pollDelayOf(attempts), attempts)
      logger.debug({ voiceId, err: (e as Error).message }, 'persona.clone.voice_poll_retry')
    }
  } finally {
    await cleanup(tempFiles)
  }
  return (await getVoiceById(voiceId, true))!
}

/* ── 声音：核对（FR-V4）───────────────────────────────────────── */

export async function reconcileVoice(voiceId: string, operator: string): Promise<PersonaVoice> {
  const voice = await getVoiceById(voiceId, true)
  if (!voice || voice.deletedAt || voice.isSample) throw err.notFound('声音不存在')
  if (voice.status !== 'uncertain') {
    throw err.invalidState(`当前状态（${voice.status}）不可核对，仅「待核对」声音可操作`, { status: voice.status })
  }
  const client = resolveHiflyClient()
  const evidence: Record<string, unknown> = { voiceId, shortRef: voice.shortRef, operator }

  let matched: { id: string; title: string } | null = null
  try {
    for (let page = 1; page <= 10 && !matched; page++) {
      const items = await client.voiceList({ page, pageSize: 50 })
      if (!items.length) break
      const hit = items.find((it) => (it.title ?? '').endsWith(`-${voice.shortRef}`))
      if (hit?.id) matched = { id: hit.id, title: hit.title ?? '' }
      if (items.length < 50) break
    }
  } catch (e) {
    evidence.listError = (e as Error).message
  }

  if (matched) {
    // 查到：补写厂商标识，转 running 继续轮询（FR-V4：试听地址由轮询获取）
    await casStatus('persona_voice', voiceId, 'uncertain', 'running', {
      vendor_voice_id: matched.id,
      submitted_at: toDb(utcNow()),
      error: null,
    })
    await recordOperation({
      operator,
      action: 'persona.voice_reconciled',
      targetType: 'persona',
      targetId: voice.personaId,
      detail: { ...evidence, result: 'running', vendorVoiceId: matched.id, matchedTitle: matched.title },
    })
    await scheduleJob('voice_poll', { kind: 'voice', recordId: voiceId }, `voice-poll-${voiceId}`, pollDelayOf(1), 's1')
    return (await getVoiceById(voiceId, true))!
  }

  if (voice.vendorTaskId) {
    try {
      const snap = await client.voiceTask(voice.vendorTaskId)
      if (snap.state === 'FAILED') {
        const message = snap.failReason ? vendorErrorOf(snap.vendorCode ?? 0, snap.failReason).message : '声音克隆失败，未附原因'
        await casStatus('persona_voice', voiceId, 'uncertain', 'failed', { error: message })
        await recordOperation({
          operator,
          action: 'persona.voice_reconciled',
          targetType: 'persona',
          targetId: voice.personaId,
          detail: { ...evidence, result: 'failed', message },
        })
        await notifyCloneState(voice.personaId, 'clone_failed', voiceId, `声音「${voice.name}」核对后确认失败：${message}`)
        return (await getVoiceById(voiceId, true))!
      }
      await recordOperation({
        operator,
        action: 'persona.voice_reconciled',
        targetType: 'persona',
        targetId: voice.personaId,
        detail: { ...evidence, result: 'still_uncertain', taskState: snap.state },
      })
      return (await getVoiceById(voiceId, true))!
    } catch (e) {
      evidence.taskError = (e as Error).message
    }
  }

  await casStatus('persona_voice', voiceId, 'uncertain', 'failed', {
    error: '核对确认飞影侧无此声音（列表与任务均未找到），可重新克隆',
  })
  await recordOperation({
    operator,
    action: 'persona.voice_reconciled',
    targetType: 'persona',
    targetId: voice.personaId,
    detail: { ...evidence, result: 'not_found' },
  })
  return (await getVoiceById(voiceId, true))!
}

/* ── 试听：提交与轮询（FR-V7）─────────────────────────────────── */

export async function submitPreview(previewId: string): Promise<void> {
  const db = getDb()
  const row = await db.get<Record<string, any>>('SELECT * FROM `persona_voice_preview` WHERE `id` = ?', [previewId])
  if (!row || row.status !== 'running' || row.vendor_task_id) return
  const voice = await getVoiceById(row.voice_id)
  if (!voice || voice.status !== 'ready' || !voice.vendorVoiceId) {
    await db.run('UPDATE `persona_voice_preview` SET `status` = ?, `error` = ? WHERE `id` = ?', [
      'failed',
      '声音不可用（未就绪或已删除）',
      previewId,
    ])
    return
  }
  const client = resolveHiflyClient()
  try {
    const accept = await client.createAudioByTts({
      voiceId: voice.vendorVoiceId,
      text: String(row.text ?? ''),
      speechRate: voice.speechRate,
      volume: voice.volume,
      pitch: voice.pitch,
    })
    if (!accept.taskId) throw new HiflySubmissionUncertain('飞影未返回试听任务凭证')
    await db.run('UPDATE `persona_voice_preview` SET `vendor_task_id` = ?, `error` = NULL WHERE `id` = ?', [
      accept.taskId,
      previewId,
    ])
    await recordOperation({
      operator: 'system',
      action: 'persona.voice_preview_submitted',
      targetType: 'persona',
      targetId: voice.personaId,
      detail: { previewId, voiceId: voice.id, vendorTaskId: accept.taskId },
    })
    await scheduleJob('preview_poll', { kind: 'preview', recordId: previewId }, `preview-poll-${previewId}`, pollDelayOf(1), 's1')
  } catch (e) {
    if (e instanceof HiflyVendorError) {
      await db.run('UPDATE `persona_voice_preview` SET `status` = ?, `error` = ? WHERE `id` = ?', [
        'failed',
        vendorMessage(e),
        previewId,
      ])
    } else {
      // 提交结果未知：保留 running 由下次发起重试（试听不消耗克隆配额，允许重试）
      await db.run('UPDATE `persona_voice_preview` SET `error` = ? WHERE `id` = ?', [
        (e as Error).message.slice(0, 2000),
        previewId,
      ])
      logger.warn({ previewId, err: (e as Error).message }, 'persona.clone.preview_submit_uncertain')
    }
  }
}

export async function pollPreview(previewId: string): Promise<void> {
  const db = getDb()
  const row = await db.get<Record<string, any>>('SELECT * FROM `persona_voice_preview` WHERE `id` = ?', [previewId])
  if (!row || row.status !== 'running' || !row.vendor_task_id) return
  const client = resolveHiflyClient()
  const tempFiles: string[] = []
  try {
    // 试听音频任务经 video/task 轮询（飞影无独立 audio/task），结果地址在 video_Url
    const snap = await client.videoTask(row.vendor_task_id)
    const audioUrl = snap.videoUrl ?? snap.audioUrl
    if (snap.state === 'DONE' && audioUrl) {
      await ensureTempDir()
      const dest = path.join(paths.tempDir, `${previewId}.mp3`)
      tempFiles.push(dest)
      await client.download(audioUrl, dest)
      const probe = await probeMedia(dest)
      if (!probe.hasAudio) throw new Error('试听文件校验失败：不是有效音频')
      const voice = await getVoiceById(row.voice_id, true)
      const audioKey = `persona/${voice?.personaId ?? 'unknown'}/voice_preview/${previewId}.mp3`
      await putObjectFromFile(dest, audioKey, '')
      await db.run('UPDATE `persona_voice_preview` SET `status` = ?, `audio_key` = ?, `error` = NULL WHERE `id` = ?', [
        'ready',
        audioKey,
        previewId,
      ])
      logger.info({ previewId, audioKey }, 'persona.clone.preview_ready')
    } else if (snap.state === 'FAILED') {
      const message = snap.failReason ? vendorErrorOf(snap.vendorCode ?? 0, snap.failReason).message : '试听生成失败'
      await db.run('UPDATE `persona_voice_preview` SET `status` = ?, `error` = ? WHERE `id` = ?', ['failed', message, previewId])
    } else {
      const attempts = Number(row.attempts ?? 0) + 1
      await db.run('UPDATE `persona_voice_preview` SET `attempts` = ?, `updated_at` = ? WHERE `id` = ?', [
        attempts,
        toDb(utcNow()),
        previewId,
      ])
      await scheduleJob('preview_poll', { kind: 'preview', recordId: previewId }, `preview-poll-${previewId}`, pollDelayOf(attempts), attempts)
    }
  } catch (e) {
    logger.debug({ previewId, err: (e as Error).message }, 'persona.clone.preview_poll_retry')
    await scheduleJob('preview_poll', { kind: 'preview', recordId: previewId }, `preview-poll-${previewId}`, pollDelayOf(2), `r${Date.now()}`)
  } finally {
    await cleanup(tempFiles)
  }
}

/* ── 启动扫描：submitting → uncertain（R9，不重提）────────────── */

export async function resumeUncertainSubmissions(): Promise<{ avatars: number; voices: number }> {
  const db = getDb()
  const avatars = await db.all<Record<string, any>>(
    'SELECT `id`, `persona_id`, `name` FROM `persona_avatar` WHERE `status` = ? AND `deleted_at` IS NULL',
    ['submitting'],
  )
  const voices = await db.all<Record<string, any>>(
    'SELECT `id`, `persona_id`, `name` FROM `persona_voice` WHERE `status` = ? AND `deleted_at` IS NULL AND `is_sample` = 0',
    ['submitting'],
  )
  const now = toDb(utcNow())
  for (const a of avatars) {
    await db.run(
      'UPDATE `persona_avatar` SET `status` = ?, `error` = ?, `updated_at` = ? WHERE `id` = ? AND `status` = ?',
      ['uncertain', '进程重启时停留在提交中，已转入待核对（不自动重提）', now, a.id, 'submitting'],
    )
    await createReminder({
      personaId: a.persona_id,
      kind: 'clone_uncertain',
      refId: a.id,
      message: `分身「${a.name}」提交中断（进程重启），请核对状态，勿重复创建`,
      operator: 'system',
    }).catch(() => undefined)
    await recordOperation({
      operator: 'system',
      action: 'persona.clone_submission_interrupted',
      targetType: 'persona',
      targetId: a.persona_id,
      detail: { avatarId: a.id, name: a.name },
    })
  }
  for (const v of voices) {
    await db.run(
      'UPDATE `persona_voice` SET `status` = ?, `error` = ?, `updated_at` = ? WHERE `id` = ? AND `status` = ?',
      ['uncertain', '进程重启时停留在提交中，已转入待核对（不自动重提）', now, v.id, 'submitting'],
    )
    await createReminder({
      personaId: v.persona_id,
      kind: 'clone_uncertain',
      refId: v.id,
      message: `声音「${v.name}」提交中断（进程重启），请核对状态，勿重复创建`,
      operator: 'system',
    }).catch(() => undefined)
    await recordOperation({
      operator: 'system',
      action: 'persona.clone_submission_interrupted',
      targetType: 'persona',
      targetId: v.persona_id,
      detail: { voiceId: v.id, name: v.name },
    })
  }
  if (avatars.length || voices.length) {
    logger.warn({ avatars: avatars.length, voices: voices.length }, 'persona.clone.resume_uncertain')
  }
  return { avatars: avatars.length, voices: voices.length }
}

/* ── worker 注册 ───────────────────────────────────────────────── */

const JOB_HIFLY: Record<string, (recordId: string) => Promise<unknown>> = {
  avatar_submit: (id) => submitAvatar(id),
  avatar_poll: (id) => pollAvatar(id),
  voice_submit: (id) => submitVoice(id),
  voice_poll: (id) => pollVoice(id),
  preview_submit: (id) => submitPreview(id),
  preview_poll: (id) => pollPreview(id),
}

export function registerCloneWorker(): void {
  registerWorker(
    QUEUE_NAMES.personaClone,
    async (job) => {
      const name = job.name
      const data = (job.data ?? {}) as CloneJob
      const fn = JOB_HIFLY[name]
      if (!fn) {
        logger.warn({ queue: QUEUE_NAMES.personaClone, name }, 'persona.clone.unknown_job')
        return
      }
      if (!data.recordId) return
      await fn(data.recordId)
    },
    { concurrency: 2 },
  )
}
