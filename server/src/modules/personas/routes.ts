import type { FastifyInstance, FastifyRequest } from 'fastify'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { config, paths } from '../../config.js'
import { newId } from '../../lib/util.js'
import { recordOperation } from '../audit/repo.js'
import { ensureTempDir } from '../../media/pipeline.js'
import { getObjectStream, isOssEnabled } from '../../integrations/aliyun-oss/client.js'
import { getMockHiflyClient } from '../../integrations/hifly/index.js'
import {
  createPersona,
  getPersonaById,
  listPersonas,
  saveProfile,
  setPersonaEnabled,
  archivePersona,
  updatePersona,
  derivePersonaStatus,
  type Persona,
} from './repo.js'
import { listVersions, getVersion, ensurePersonaVersion } from './versions.js'
import {
  getAssetById,
  listAssets,
  patchAsset,
  reviewAsset,
  setCoverAsset,
  softDeleteAsset,
  uploadAsset,
  assetFileTarget,
} from './assets.js'
import {
  decideAuthorization,
  getAuthorizationById,
  listAuthorizations,
  revokeAuthorization,
  uploadAuthorization,
  authorizationFileTarget,
} from './authorizations.js'
import { createConsent } from './consent.js'
import { listBindings, setBindings } from './bindings.js'
import { countUnread, listReminders, markAllRead } from './reminders.js'
import {
  createAvatar,
  getAvatarById,
  listAvatarsWithAsset,
  patchAvatar,
  setDefaultAvatar,
  softDeleteAvatar,
} from './clone/avatars.js'
import {
  confirmVoice,
  createVoice,
  createVoicePreview,
  getVoiceById,
  getVoicePreview,
  listVoiceSamples,
  listVoices,
  patchVoice,
  previewAudioTarget,
  setDefaultVoice,
  softDeleteVoice,
  updateVoiceSettings,
  uploadVoiceSample,
} from './clone/voices.js'
import { pollAvatar, pollVoice, reconcileAvatar, reconcileVoice } from './clone/worker.js'
import { checkReadiness, getProductionProfile } from './readiness.js'
import {
  ASSET_KIND_LABELS,
  ASSET_LIMITS,
  LINE_LABELS,
  LINE_RULES,
  PLATFORM_LABELS,
  UPLOAD_LIMITS,
  VOICE_LANGUAGES,
  type AssetKind,
  type AuthorizationScope,
  type PersonaLine,
} from './types.js'
import {
  CONSENT_TEXT_VERSION,
  CONSENT_TEXTS,
  CONTENT_MIX_PRESETS,
  IP_OPTIONS,
  LINE_DEFAULT_DIRECTIONS,
  LINE_DEFAULT_FORBIDDEN,
} from './options.js'

/**
 * 人物库 HTTP 层（任务书 §5.1）。
 * 约定：统一信封 ok(data)；写操作取登录账号（auth/guard 已注入 req.operator）；
 * 文件经后端流式代理（Range 支持），不暴露存储真实路径 / 长期公网 URL；
 * 授权材料 / 素材原件 / 声音样本原件的查看下载落 persona.sensitive_access 审计（FR-U6）。
 */

/* ── multipart 单趟读取（流式落临时文件，避免大文件进内存）───────────
 *
 * 约束（@fastify/multipart 10.x）：
 *  - req.parts() 与 req.file() 各自新建 busboy 挂到同一条 raw 请求流上，混用会互相抢流，
 *    因此字段与文件必须在**同一次 parts() 迭代**里取完；
 *  - 插件级 limits.fileSize 会覆盖每次调用传入的 limits，全局上限见 app.ts，
 *    各素材类型的细分上限在这里按 size 早停判定。
 */

/** 计数 Transform 超限时抛出，pipeline 会据此销毁两端流并 reject */
class UploadTooLarge extends Error {}

interface UploadedFile {
  filePath: string
  filename: string
  size: number
  head: Buffer
}

interface MultipartInput {
  fields: Record<string, string>
  file: UploadedFile
}

/**
 * 单趟读取 multipart。maxBytes 为默认上限；resolveMaxBytes 可在文件 part 到达时
 * 按已收集到的字段（如 kind）给出更精确的上限——字段在流中先于文件，故可早停。
 */
async function readMultipart(
  req: FastifyRequest,
  maxBytes: number,
  tooLargeMsg: string,
  resolveMaxBytes?: (fields: Record<string, string>) => number | undefined,
): Promise<MultipartInput> {
  const fields: Record<string, string> = {}
  let uploaded: UploadedFile | null = null
  await ensureTempDir()

  const parts = (req as unknown as {
    parts: () => AsyncIterableIterator<{
      type: string
      fieldname?: string
      value?: unknown
      filename?: string
      file?: (NodeJS.ReadableStream & { truncated?: boolean; destroy?: () => void }) | undefined
    }>
  }).parts()

  for await (const part of parts) {
    if (part.type === 'field') {
      if (part.fieldname) fields[part.fieldname] = String(part.value ?? '')
      continue
    }
    if (part.type !== 'file') continue
    if (uploaded) {
      // 额外文件：排空避免背压挂住（files:1 限制下正常不会出现）
      for await (const chunk of part.file!) {
        void chunk
      }
      continue
    }
    const effectiveMax = resolveMaxBytes?.(fields) ?? maxBytes
    const effectiveMsg =
      resolveMaxBytes && effectiveMax !== maxBytes ? `文件超过 ${Math.round(effectiveMax / 1024 / 1024)}MB 上限` : tooLargeMsg
    const ext = path.extname(part.filename || '').slice(0, 8)
    const dest = path.join(paths.tempDir, `${newId('up')}${ext}`)
    const headChunks: Buffer[] = []
    let size = 0
    let headLen = 0
    // P1-1：用 pipeline + 计数 Transform 早停。原实现超限时直接 destroy 两端流，
    // destroy 不触发 finish / end，Promise 永不返回，请求挂住且临时文件残留。
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length
        if (headLen < 16) {
          headChunks.push(chunk)
          headLen += chunk.length
        }
        if (size > effectiveMax) {
          cb(new UploadTooLarge())
          return
        }
        cb(null, chunk)
      },
    })
    try {
      await pipeline(part.file!, counter, fs.createWriteStream(dest))
    } catch (e) {
      await fsp.unlink(dest).catch(() => undefined)
      if (e instanceof UploadTooLarge) throw err.assetTooLarge(effectiveMsg, { max: effectiveMax, size })
      throw e
    }
    if (part.file?.truncated || size > effectiveMax) {
      await fsp.unlink(dest).catch(() => undefined)
      throw err.assetTooLarge(effectiveMsg, { max: effectiveMax, size })
    }
    uploaded = { filePath: dest, filename: part.filename ?? '', size, head: Buffer.concat(headChunks).subarray(0, 16) }
  }

  if (!uploaded) throw err.badRequest('请上传文件（字段名 file）')
  return { fields, file: uploaded }
}

/* ── 文件流式代理（Range；敏感访问审计）────────────────────────── */

async function streamStorage(
  reply: import('fastify').FastifyReply,
  storageKey: string,
  filename: string,
  range: string | undefined,
  audit: { action: string; targetType: string; targetId: string; operator: string; detail?: Record<string, unknown> } | null,
): Promise<void> {
  const res = await getObjectStream(storageKey, range)
  if (!res) throw err.notFound('文件不存在或已被清理')
  if (audit) {
    await recordOperation({ operator: audit.operator, action: audit.action, targetType: audit.targetType, targetId: audit.targetId, detail: audit.detail ?? null })
  }
  const headers: Record<string, string> = {
    'Content-Type': res.contentType ?? 'application/octet-stream',
    'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  }
  if (res.contentRange) {
    headers['Content-Range'] = res.contentRange
    headers['Content-Length'] = String(res.contentLength ?? 0)
    reply.status(206).headers(headers)
  } else {
    if (res.contentLength != null) headers['Content-Length'] = String(res.contentLength)
    reply.headers(headers)
  }
  reply.send(res.stream as any)
}

/* ── 工具 ──────────────────────────────────────────────────────── */

function q(req: FastifyRequest): Record<string, string> {
  return (req.query ?? {}) as Record<string, string>
}

function idempotencyKeyOf(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key']
  const v = Array.isArray(raw) ? raw[0] : raw
  return (v && String(v).trim()) || ''
}

const ASSET_KINDS: AssetKind[] = ['photo', 'avatar_source', 'background_image', 'background_video', 'broll_video']

/** 取人物，不存在即 404（避免 `await x!` 断言不到 Promise 内部的 null） */
async function mustGetPersona(id: string): Promise<Persona> {
  const p = await getPersonaById(id, true)
  if (!p) throw err.personaNotFound()
  return p
}

/** 列表项：人物 + 派生有效状态 + 计数（FR-L1 / FR-X1） */
async function decoratePersona(p: Persona) {
  const db = (await import('../../db/index.js')).getDb()
  const derived = await derivePersonaStatus(p, db)
  const [photoCount, avatarCount, voiceCount, bindingCount] = await Promise.all([
    db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM `persona_asset` WHERE `persona_id` = ? AND `kind` = ? AND `status` = ? AND `deleted_at` IS NULL',
      [p.id, 'photo', 'approved'],
    ),
    db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM `persona_avatar` WHERE `persona_id` = ? AND `status` = ? AND `deleted_at` IS NULL',
      [p.id, 'ready'],
    ),
    db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM `persona_voice` WHERE `persona_id` = ? AND `is_sample` = 0 AND `status` = ? AND `confirmed` = 1 AND `deleted_at` IS NULL',
      [p.id, 'ready'],
    ),
    db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM `persona_account_binding` WHERE `persona_id` = ? AND `released_at` IS NULL',
      [p.id],
    ),
  ])
  const cover = p.coverAssetId
    ? await db.get<{ thumb_key: string | null }>('SELECT `thumb_key` FROM `persona_asset` WHERE `id` = ?', [p.coverAssetId])
    : null
  return {
    ...p,
    status: derived.status,
    statusLabel: derived.label,
    usable: derived.usable,
    statusReasons: derived.reasons,
    extraTags: derived.extraTags,
    counts: {
      photos: Number(photoCount?.c ?? 0),
      avatars: Number(avatarCount?.c ?? 0),
      voices: Number(voiceCount?.c ?? 0),
      bindings: Number(bindingCount?.c ?? 0),
    },
    coverUrl: cover?.thumb_key ? `/api/persona-assets/${p.coverAssetId}/file?variant=thumb` : null,
    currentVersionId: p.currentVersionId,
  }
}

export function registerPersonaRoutes(app: FastifyInstance): void {
  /* ── 人物 ───────────────────────────────────────────────────── */

  app.get('/personas', async (req) => {
    const query = q(req)
    const line = query.line && ['manager', 'kos', 'persona'].includes(query.line) ? (query.line as PersonaLine) : undefined
    const includeDisabled = query.includeDisabled === '1' || query.includeDisabled === 'true'
    const includeArchived = query.includeArchived === '1' || query.includeArchived === 'true'
    const status = query.status as 'usable' | 'incomplete' | 'disabled' | 'archived' | undefined
    // includeArchived 需联动放开 enabled 过滤：归档同时会停用，否则 SQL 层仍被 enabled=1 挡掉
    const personas = await listPersonas({
      line,
      keyword: query.keyword,
      includeDisabled: includeDisabled || includeArchived,
      includeArchived,
    })
    const items = []
    for (const p of personas) {
      const d = await decoratePersona(p)
      // 默认只返回 usable（FR-X1：桩期「enabled only」的等价语义）；
      // includeArchived=1 时放行归档人物（usable 恒 false，否则被 usable 过滤挡掉）
      if (!includeDisabled && !includeArchived && !d.usable) continue
      if (status === 'usable' && !d.usable) continue
      if (status === 'incomplete' && !(d.usable && d.extraTags.includes('incomplete'))) continue
      if (status === 'disabled' && d.status !== 'disabled') continue
      if (status === 'archived' && d.status !== 'archived') continue
      items.push(d)
    }
    return ok({ items, total: items.length })
  })

  app.get('/personas/stats', async () => {
    const db = (await import('../../db/index.js')).getDb()
    const rows = await db.all<{ line: string; c: number }>(
      'SELECT `line`, COUNT(*) AS c FROM `persona` WHERE `archived_at` IS NULL GROUP BY `line`',
    )
    const byLine: Record<string, number> = { manager: 0, kos: 0, persona: 0 }
    for (const r of rows) byLine[r.line] = Number(r.c)
    const unread = await countUnread()
    return ok({
      lines: byLine,
      total: byLine.manager + byLine.kos + byLine.persona,
      unreadReminders: unread,
    })
  })

  // 飞影积分缓存（L14：5 分钟，避免 options 被高频轮询时反复打厂商接口）
  let creditCache: { at: number; value: number | null } = { at: 0, value: null }

  app.get('/personas/options', async () => {
    let credit: number | null = null
    let creditError: string | null = null
    try {
      if (config.hifly.apiKey || config.mockFallback) {
        const now = Date.now()
        if (now - creditCache.at > config.hifly.creditCacheMs) {
          const client = config.hifly.apiKey
            ? (await import('../../integrations/hifly/client.js')).createHttpHiflyClient()
            : getMockHiflyClient()
          credit = await client.credit()
          creditCache = { at: now, value: credit }
        } else {
          credit = creditCache.value
        }
      }
    } catch (e) {
      creditError = (e as Error).message
    }
    return ok({
      ipOptions: IP_OPTIONS,
      lineLabels: LINE_LABELS,
      lineRules: LINE_RULES,
      lineDefaultDirections: LINE_DEFAULT_DIRECTIONS,
      lineDefaultForbidden: LINE_DEFAULT_FORBIDDEN,
      contentMixPresets: CONTENT_MIX_PRESETS,
      uploadLimits: UPLOAD_LIMITS,
      assetLimits: ASSET_LIMITS,
      assetKindLabels: ASSET_KIND_LABELS,
      platformLabels: PLATFORM_LABELS,
      voiceLanguages: VOICE_LANGUAGES,
      consentTextVersion: CONSENT_TEXT_VERSION,
      consentTexts: CONSENT_TEXTS,
      hifly: {
        configured: !!config.hifly.apiKey,
        mock: !config.hifly.apiKey && config.mockFallback,
        baseUrl: config.hifly.baseUrl,
        credit,
        creditError,
      },
      storage: { oss: isOssEnabled(), mode: isOssEnabled() ? 'oss' : 'local' },
    })
  })

  app.get('/personas/:id', async (req) => {
    const { id } = req.params as { id: string }
    const db = (await import('../../db/index.js')).getDb()
    const persona = await getPersonaById(id, true)
    if (!persona) throw err.personaNotFound()
    const derived = await derivePersonaStatus(persona, db)
    const [auths, bindings, assets, avatars, voices, samples] = await Promise.all([
      listAuthorizations(id, db),
      listBindings(id),
      listAssets(id, {}, db),
      listAvatarsWithAsset(id),
      listVoices(id),
      listVoiceSamples(id),
    ])
    const versions = await listVersions(id, db)
    return ok({
      ...persona,
      status: derived.status,
      statusLabel: derived.label,
      usable: derived.usable,
      statusReasons: derived.reasons,
      extraTags: derived.extraTags,
      authorizations: auths,
      bindings,
      assets,
      avatars,
      voices,
      voiceSamples: samples,
      versions,
      coverUrl: persona.coverAssetId
        ? `/api/persona-assets/${persona.coverAssetId}/file?variant=thumb`
        : null,
    })
  })

  app.post('/personas', async (req) => {
    const body = (req.body ?? {}) as {
      name?: string
      line?: PersonaLine
      ownerSubject?: string
      description?: string
      bindingMode?: 'exclusive' | 'shared'
      ipProfile?: unknown
    }
    if (!body.name || !String(body.name).trim()) throw err.badRequest('人物名称必填')
    if (!body.line) throw err.badRequest('生产线必填（manager / kos / persona）')
    const persona = await createPersona({
      name: String(body.name),
      line: body.line,
      ownerSubject: body.ownerSubject,
      description: body.description,
      bindingMode: body.bindingMode,
      ipProfile: body.ipProfile,
      operator: req.operator,
    })
    await recordOperation({
      operator: req.operator,
      action: 'persona.create',
      targetType: 'persona',
      targetId: persona.id,
      detail: { name: persona.name, line: persona.line },
    })
    // 新建后按线预填定位默认值（FR-I2 / FR-I4）由前端拉 options 后合并，这里只落基础信息
    return ok(await decoratePersona(await mustGetPersona(persona.id)))
  })

  app.patch('/personas/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as {
      name?: string
      ownerSubject?: string
      description?: string
      bindingMode?: 'exclusive' | 'shared'
      rev?: number
    }
    if (body.rev === undefined) throw err.badRequest('rev 必填（乐观锁）')
    const persona = await updatePersona(id, { ...body, rev: Number(body.rev), operator: req.operator })
    await recordOperation({
      operator: req.operator,
      action: 'persona.update',
      targetType: 'persona',
      targetId: id,
      detail: { fields: Object.keys(body).filter((k) => k !== 'rev') },
    })
    return ok(await decoratePersona(await mustGetPersona(id)))
  })

  app.put('/personas/:id/profile', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { ipProfile?: unknown; rev?: number }
    if (body.ipProfile === undefined) throw err.badRequest('ipProfile 必填')
    const r = await saveProfile(id, body.ipProfile, body.rev === undefined ? undefined : Number(body.rev), req.operator)
    await recordOperation({
      operator: req.operator,
      action: 'persona.profile_save',
      targetType: 'persona',
      targetId: id,
      detail: { changed: r.changed, profileRevision: r.persona.profileRevision },
    })
    let versionId: string | null = null
    if (r.changed) {
      // 规范化 hash 变化 → 产生人物版本（L7）
      const v = await ensurePersonaVersion(r.persona, 'profile', req.operator)
      versionId = v?.id ?? null
    }
    return ok({
      profileRevision: r.persona.profileRevision,
      versionId,
      changed: r.changed,
      persona: await decoratePersona(await mustGetPersona(id)),
    })
  })

  app.post('/personas/:id/enable', async (req) => {
    const { id } = req.params as { id: string }
    const persona = await setPersonaEnabled(id, true, req.operator)
    await recordOperation({ operator: req.operator, action: 'persona.enable', targetType: 'persona', targetId: id })
    return ok(await decoratePersona(await mustGetPersona(persona.id)))
  })

  app.post('/personas/:id/disable', async (req) => {
    const { id } = req.params as { id: string }
    const persona = await setPersonaEnabled(id, false, req.operator)
    await recordOperation({ operator: req.operator, action: 'persona.disable', targetType: 'persona', targetId: id })
    return ok(await decoratePersona(await mustGetPersona(persona.id)))
  })

  app.post('/personas/:id/archive', async (req) => {
    const { id } = req.params as { id: string }
    const db = (await import('../../db/index.js')).getDb()
    const body = (req.body ?? {}) as { force?: boolean }
    // P0-1：强制归档会绕过进行中任务的保护，只允许管理员
    if (body.force && req.user?.role !== 'admin') throw err.forbidden('强制归档仅限管理员')
    // 阻断条件（R29）：进行中的克隆任务；审核中的文案
    const [avatarBusy, voiceBusy, copyBusy] = await Promise.all([
      db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM `persona_avatar` WHERE `persona_id` = ? AND `status` IN (?, ?, ?, ?) AND `deleted_at` IS NULL',
        [id, 'pending', 'submitting', 'running', 'uncertain'],
      ),
      db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM `persona_voice` WHERE `persona_id` = ? AND `is_sample` = 0 AND `status` IN (?, ?, ?, ?) AND `deleted_at` IS NULL',
        [id, 'pending', 'submitting', 'running', 'uncertain'],
      ),
      db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM `copy` WHERE `persona_id` = ? AND `status` = ?',
        [id, 'in_review'],
      ).catch(() => ({ c: 0 })),
    ])
    const blockers: string[] = []
    if (Number(avatarBusy?.c ?? 0)) blockers.push(`存在 ${avatarBusy!.c} 个进行中的分身制作`)
    if (Number(voiceBusy?.c ?? 0)) blockers.push(`存在 ${voiceBusy!.c} 个进行中的声音克隆`)
    if (Number(copyBusy?.c ?? 0)) blockers.push(`存在 ${copyBusy!.c} 个审核中的文案`)
    if (blockers.length && !body.force) {
      throw err.personaInUse(`不能归档：${blockers.join('；')}`, { blockers })
    }
    const persona = await archivePersona(id, req.operator)
    await recordOperation({
      operator: req.operator,
      action: 'persona.archive',
      targetType: 'persona',
      targetId: id,
      detail: { force: !!body.force, blockers },
    })
    return ok(await decoratePersona(await mustGetPersona(persona.id)))
  })

  app.get('/personas/:id/versions', async (req) => {
    const { id } = req.params as { id: string }
    const persona = await getPersonaById(id, true)
    if (!persona) throw err.personaNotFound()
    return ok(await listVersions(id))
  })

  app.get('/persona-versions/:versionId', async (req) => {
    const { versionId } = req.params as { versionId: string }
    const v = await getVersion(versionId)
    if (!v) throw err.notFound('版本不存在')
    return ok(v)
  })

  app.get('/personas/:id/readiness', async (req) => {
    const { id } = req.params as { id: string }
    const purpose = (q(req).purpose ?? 'copy') as 'copy' | 'avatar_video' | 'mixcut'
    if (!['copy', 'avatar_video', 'mixcut'].includes(purpose)) throw err.badRequest('purpose 仅支持 copy / avatar_video / mixcut')
    return ok(await checkReadiness(id, purpose))
  })

  app.get('/personas/:id/production-profile', async (req) => {
    const { id } = req.params as { id: string }
    const avatarId = q(req).avatarId
    return ok(await getProductionProfile(id, avatarId))
  })

  /* ── 素材 ───────────────────────────────────────────────────── */

  app.post('/personas/:id/assets', async (req) => {
    const { id } = req.params as { id: string }
    const persona = await getPersonaById(id, true)
    if (!persona) throw err.personaNotFound()
    // 字段（含 kind）在流中先于文件：读到文件 part 时按 kind 动态判定上限并早停
    const looseMax = Math.max(...Object.values(UPLOAD_LIMITS).map((l) => l.maxBytes))
    const { fields, file } = await readMultipart(req, looseMax, '文件超过上限', (f) => {
      const k = f.kind as AssetKind | undefined
      return k && ASSET_KINDS.includes(k) ? UPLOAD_LIMITS[k].maxBytes : undefined
    })
    // P1-2：所有校验都放在 try 内，任何分支报错都由 finally 删除临时文件
    try {
      const kind = (fields.kind ?? 'photo') as AssetKind
      if (!ASSET_KINDS.includes(kind)) throw err.badRequest(`不支持的素材类型：${kind}`, { allowed: ASSET_KINDS })
      const maxBytes = UPLOAD_LIMITS[kind].maxBytes
      if (file.size > maxBytes) {
        throw err.assetTooLarge(`${ASSET_KIND_LABELS[kind]}超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, { max: maxBytes, size: file.size })
      }
      const tags = fields.tags ? String(fields.tags).split(',').map((t) => t.trim()).filter(Boolean) : []
      const r = await uploadAsset({
        personaId: id,
        kind,
        name: fields.name,
        backgroundLabel: fields.backgroundLabel,
        tags,
        filePath: file.filePath,
        filename: file.filename,
        size: file.size,
        head: file.head,
        operator: req.operator,
      })
      await recordOperation({
        operator: req.operator,
        action: 'persona.asset_upload',
        targetType: 'persona',
        targetId: id,
        detail: { assetId: r.asset.id, kind, filename: file.filename, size: file.size, deduplicated: r.deduplicated },
      })
      return ok({ assetId: r.asset.id, status: r.asset.status, deduplicated: r.deduplicated, asset: r.asset })
    } finally {
      await fsp.unlink(file.filePath).catch(() => undefined)
    }
  })

  app.get('/personas/:id/assets', async (req) => {
    const { id } = req.params as { id: string }
    const query = q(req)
    const kind = query.kind as AssetKind | undefined
    if (kind && !ASSET_KINDS.includes(kind)) throw err.badRequest(`不支持的素材类型：${kind}`)
    const status = query.status as 'uploaded' | 'processing' | 'pending_review' | 'approved' | 'rejected' | 'failed' | undefined
    return ok(await listAssets(id, { kind, status }))
  })

  app.patch('/persona-assets/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { name?: string; backgroundLabel?: string; tags?: string[]; sort?: number }
    const asset = await patchAsset(id, body, req.operator)
    await recordOperation({ operator: req.operator, action: 'persona.asset_patch', targetType: 'persona', targetId: asset.personaId, detail: { assetId: id } })
    return ok(asset)
  })

  app.post('/persona-assets/:id/review', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { decision?: 'approved' | 'rejected'; reason?: string; issueCodes?: string[] }
    if (body.decision !== 'approved' && body.decision !== 'rejected') throw err.badRequest('decision 仅支持 approved / rejected')
    const asset = await reviewAsset(id, { decision: body.decision, reason: body.reason, issueCodes: body.issueCodes, operator: req.operator })
    await recordOperation({
      operator: req.operator,
      action: 'persona.asset_review',
      targetType: 'persona',
      targetId: asset.personaId,
      detail: { assetId: id, decision: body.decision, reason: body.reason ?? null },
    })
    return ok(asset)
  })

  app.post('/persona-assets/:id/set-cover', async (req) => {
    const { id } = req.params as { id: string }
    const asset = await getAssetById(id)
    if (!asset) throw err.notFound('素材不存在')
    await setCoverAsset(asset.personaId, id, req.operator)
    await recordOperation({ operator: req.operator, action: 'persona.asset_set_cover', targetType: 'persona', targetId: asset.personaId, detail: { assetId: id } })
    return ok({ coverAssetId: id })
  })

  app.delete('/persona-assets/:id', async (req) => {
    const { id } = req.params as { id: string }
    const asset = await getAssetById(id)
    if (!asset) throw err.notFound('素材不存在')
    await softDeleteAsset(id, req.operator)
    await recordOperation({ operator: req.operator, action: 'persona.asset_delete', targetType: 'persona', targetId: asset.personaId, detail: { assetId: id } })
    return ok({ deleted: true })
  })

  app.get('/persona-assets/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string }
    const variant = (q(req).variant ?? 'original') as 'thumb' | 'compat' | 'original'
    if (!['thumb', 'compat', 'original'].includes(variant)) throw err.badRequest('variant 仅支持 thumb / compat / original')
    const asset = await getAssetById(id)
    if (!asset) throw err.notFound('素材不存在')
    const target = assetFileTarget(asset, variant)
    const range = req.headers.range
    // 敏感访问审计：原件与兼容版本（FR-U6）；缩略图不记
    const audit =
      variant === 'thumb'
        ? null
        : {
            action: 'persona.sensitive_access',
            targetType: 'persona',
            targetId: asset.personaId,
            operator: req.operator,
            detail: { assetId: id, kind: asset.kind, variant },
          }
    await streamStorage(reply, target.storageKey, target.filename, range, audit)
  })

  /* ── 授权与 consent ─────────────────────────────────────────── */

  app.post('/personas/:id/authorizations', async (req) => {
    const { id } = req.params as { id: string }
    const persona = await getPersonaById(id, true)
    if (!persona) throw err.personaNotFound()
    const limits = UPLOAD_LIMITS.authorization
    const { fields, file } = await readMultipart(
      req,
      limits.maxBytes,
      `授权材料超过 ${Math.round(limits.maxBytes / 1024 / 1024)}MB 上限`,
    )
    try {
      const scopes = String(fields.scopes ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as AuthorizationScope[]
      const auth = await uploadAuthorization({
        personaId: id,
        grantorName: fields.grantorName ?? '',
        scopes,
        effectiveFrom: fields.effectiveFrom ?? '',
        expiresAt: fields.expiresAt ?? '',
        note: fields.note,
        filePath: file.filePath,
        filename: file.filename,
        size: file.size,
        head: file.head,
        operator: req.operator,
      })
      return ok(auth)
    } finally {
      await fsp.unlink(file.filePath).catch(() => undefined)
    }
  })

  app.get('/personas/:id/authorizations', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await listAuthorizations(id))
  })

  app.post('/persona-authorizations/:id/verify', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { decision?: 'verified' | 'rejected'; reason?: string }
    if (body.decision !== 'verified' && body.decision !== 'rejected') throw err.badRequest('decision 仅支持 verified / rejected')
    return ok(await decideAuthorization(id, { decision: body.decision, reason: body.reason, operator: req.operator }))
  })

  app.post('/persona-authorizations/:id/revoke', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { reason?: string }
    return ok(await revokeAuthorization(id, String(body.reason ?? ''), req.operator))
  })

  app.get('/persona-authorizations/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string }
    const auth = await getAuthorizationById(id)
    if (!auth) throw err.notFound('授权记录不存在')
    const target = authorizationFileTarget(auth)
    await streamStorage(reply, target.storageKey, target.filename, req.headers.range, {
      action: 'persona.sensitive_access',
      targetType: 'persona',
      targetId: auth.personaId,
      operator: req.operator,
      detail: { authorizationId: id, grantorName: auth.grantorName },
    })
  })

  app.post('/personas/:id/consents', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as {
      authorizationId?: string
      purpose?: 'AVATAR_CLONE' | 'VOICE_CLONE'
      sourceKind?: 'avatar_source' | 'voice_sample'
      sourceId?: string
      consentTextVersion?: string
    }
    if (!body.authorizationId) throw err.badRequest('authorizationId 必填')
    if (body.purpose !== 'AVATAR_CLONE' && body.purpose !== 'VOICE_CLONE') throw err.badRequest('purpose 仅支持 AVATAR_CLONE / VOICE_CLONE')
    if (body.sourceKind !== 'avatar_source' && body.sourceKind !== 'voice_sample') throw err.badRequest('sourceKind 仅支持 avatar_source / voice_sample')
    if (!body.sourceId) throw err.badRequest('sourceId 必填')
    const consent = await createConsent({
      personaId: id,
      authorizationId: body.authorizationId,
      purpose: body.purpose,
      sourceKind: body.sourceKind,
      sourceId: body.sourceId,
      consentTextVersion: String(body.consentTextVersion ?? ''),
      operator: req.operator,
    })
    return ok({ consentId: consent.id, consent })
  })

  /* ── 口播分身 ───────────────────────────────────────────────── */

  app.post('/personas/:id/avatars', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as {
      name?: string
      sourceAssetId?: string
      consentId?: string
      confirmDuplicate?: boolean
    }
    if (!body.sourceAssetId) throw err.badRequest('sourceAssetId 必填')
    if (!body.consentId) throw err.badRequest('consentId 必填（授权确认）')
    const r = await createAvatar({
      personaId: id,
      name: body.name,
      sourceAssetId: body.sourceAssetId,
      consentId: body.consentId,
      idempotencyKey: idempotencyKeyOf(req),
      confirmDuplicate: !!body.confirmDuplicate,
      operator: req.operator,
    })
    return ok({ avatarId: r.avatar.id, status: r.avatar.status, replayed: r.replayed, avatar: r.avatar })
  })

  app.get('/personas/:id/avatars', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await listAvatarsWithAsset(id))
  })

  app.get('/persona-avatars/:id', async (req) => {
    const { id } = req.params as { id: string }
    const avatar = await getAvatarById(id)
    if (!avatar) throw err.notFound('分身不存在')
    return ok(avatar)
  })

  app.post('/persona-avatars/:id/refresh', async (req) => {
    const { id } = req.params as { id: string }
    const avatar = await getAvatarById(id)
    if (!avatar) throw err.notFound('分身不存在')
    if (avatar.status !== 'running') {
      throw err.invalidState(`当前状态（${avatar.status}）不可刷新，仅「制作中」可立即查询`, { status: avatar.status })
    }
    const updated = await pollAvatar(id)
    return ok(updated)
  })

  app.post('/persona-avatars/:id/reconcile', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await reconcileAvatar(id, req.operator))
  })

  app.patch('/persona-avatars/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { name?: string }
    return ok(await patchAvatar(id, { name: body.name }, req.operator))
  })

  app.post('/persona-avatars/:id/set-default', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await setDefaultAvatar(id, req.operator))
  })

  app.delete('/persona-avatars/:id', async (req) => {
    const { id } = req.params as { id: string }
    await softDeleteAvatar(id, req.operator)
    return ok({ deleted: true })
  })

  /* ── 声音 ───────────────────────────────────────────────────── */

  app.post('/personas/:id/voice-samples', async (req) => {
    const { id } = req.params as { id: string }
    const persona = await getPersonaById(id, true)
    if (!persona) throw err.personaNotFound()
    const limits = UPLOAD_LIMITS.voice_sample
    const { file } = await readMultipart(req, limits.maxBytes, `声音样本超过 ${Math.round(limits.maxBytes / 1024 / 1024)}MB 上限`)
    try {
      const sample = await uploadVoiceSample({
        personaId: id,
        filePath: file.filePath,
        filename: file.filename,
        size: file.size,
        head: file.head,
        operator: req.operator,
      })
      return ok({
        sampleId: sample.id,
        durationMs: sample.sampleDurationMs,
        sha256: sample.sampleSha256,
        sample,
      })
    } finally {
      await fsp.unlink(file.filePath).catch(() => undefined)
    }
  })

  app.post('/personas/:id/voices', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as {
      name?: string
      sampleId?: string
      consentId?: string
      language?: string
    }
    if (!body.sampleId) throw err.badRequest('sampleId 必填')
    if (!body.consentId) throw err.badRequest('consentId 必填（授权确认）')
    const r = await createVoice({
      personaId: id,
      name: body.name,
      sampleId: body.sampleId,
      consentId: body.consentId,
      language: body.language,
      idempotencyKey: idempotencyKeyOf(req),
      operator: req.operator,
    })
    return ok({ voiceId: r.voice.id, status: r.voice.status, replayed: r.replayed, voice: r.voice })
  })

  app.get('/personas/:id/voices', async (req) => {
    const { id } = req.params as { id: string }
    const [voices, samples] = await Promise.all([listVoices(id), listVoiceSamples(id)])
    return ok({ voices, samples })
  })

  app.get('/persona-voices/:id', async (req) => {
    const { id } = req.params as { id: string }
    const voice = await getVoiceById(id)
    if (!voice) throw err.notFound('声音不存在')
    return ok(voice)
  })

  app.post('/persona-voices/:id/refresh', async (req) => {
    const { id } = req.params as { id: string }
    const voice = await getVoiceById(id)
    if (!voice) throw err.notFound('声音不存在')
    if (voice.status !== 'running') {
      throw err.invalidState(`当前状态（${voice.status}）不可刷新，仅「克隆中」可立即查询`, { status: voice.status })
    }
    return ok(await pollVoice(id))
  })

  app.post('/persona-voices/:id/reconcile', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await reconcileVoice(id, req.operator))
  })

  app.post('/persona-voices/:id/confirm', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await confirmVoice(id, req.operator))
  })

  app.put('/persona-voices/:id/settings', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { speechRate?: number; volume?: number; pitch?: number }
    const voice = await getVoiceById(id)
    if (!voice) throw err.notFound('声音不存在')
    // R17 三段式：飞影先改，成功后落库（editVendor 由路由层注入客户端）
    const client = config.hifly.apiKey
      ? (await import('../../integrations/hifly/client.js')).createHttpHiflyClient()
      : getMockHiflyClient()
    return ok(
      await updateVoiceSettings(id, body, req.operator, async (vendorVoiceId, settings) => {
        await client.editVoice({
          voiceId: vendorVoiceId,
          speechRate: settings.speechRate,
          volume: settings.volume,
          pitch: settings.pitch,
        })
      }),
    )
  })

  app.post('/persona-voices/:id/preview', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { text?: string }
    if (!body.text || !String(body.text).trim()) throw err.badRequest('试听文本不能为空')
    const r = await createVoicePreview(id, String(body.text), req.operator)
    return ok({ previewId: r.preview.id, status: r.preview.status, cached: r.cached, preview: r.preview })
  })

  app.get('/persona-voice-previews/:id', async (req) => {
    const { id } = req.params as { id: string }
    const preview = await getVoicePreview(id)
    if (!preview) throw err.notFound('试听记录不存在')
    return ok(preview)
  })

  app.get('/persona-voice-previews/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string }
    const preview = await getVoicePreview(id)
    if (!preview) throw err.notFound('试听记录不存在')
    const target = previewAudioTarget(preview)
    await streamStorage(reply, target.storageKey, target.filename, req.headers.range, null)
  })

  app.get('/persona-voices/:id/demo', async (req, reply) => {
    const { id } = req.params as { id: string }
    const voice = await getVoiceById(id)
    if (!voice) throw err.notFound('声音不存在')
    if (!voice.demoKey) throw err.notFound('试听音频尚未归档')
    await streamStorage(reply, voice.demoKey, `${voice.name || '试听'}.mp3`, req.headers.range, null)
  })

  app.patch('/persona-voices/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { name?: string }
    return ok(await patchVoice(id, { name: body.name }, req.operator))
  })

  app.post('/persona-voices/:id/set-default', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await setDefaultVoice(id, req.operator))
  })

  app.delete('/persona-voices/:id', async (req) => {
    const { id } = req.params as { id: string }
    await softDeleteVoice(id, req.operator)
    return ok({ deleted: true })
  })

  /* ── 绑定与提醒 ─────────────────────────────────────────────── */

  app.get('/personas/:id/accounts', async (req) => {
    const { id } = req.params as { id: string }
    const persona = await getPersonaById(id, true)
    if (!persona) throw err.personaNotFound()
    return ok(await listBindings(id))
  })

  app.put('/personas/:id/accounts', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as {
      accounts?: Array<{ platform?: string; accountKey?: string; displayName?: string }>
    }
    const accounts = (body.accounts ?? []).map((a) => ({
      platform: a.platform as 'douyin' | 'xiaohongshu' | 'kuaishou' | 'shipinhao',
      accountKey: String(a.accountKey ?? ''),
      displayName: String(a.displayName ?? ''),
    }))
    return ok(await setBindings(id, accounts, req.operator))
  })

  app.get('/persona-reminders', async (req) => {
    const unread = q(req).unread === '1'
    const [items, unreadCount] = await Promise.all([listReminders({ unread }), countUnread()])
    return ok({ items, unread: unreadCount })
  })

  app.post('/persona-reminders/read-all', async (req) => {
    const n = await markAllRead(req.operator)
    return ok({ read: n })
  })
}
