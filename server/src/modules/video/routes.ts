import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHmac } from 'node:crypto'
import { ok } from '../../app.js'
import { config, hasDashScope } from '../../config.js'
import { err } from '../../errors.js'
import { hiflyStatus } from '../../integrations/hifly/client.js'
import { getObjectStream } from '../../integrations/aliyun-oss/client.js'
import { checkFfmpeg } from '../../media/pipeline.js'
import { getDb } from '../../db/index.js'
import { buildVideoOptions } from './options.js'
import { runPrecheck } from './precheck.js'
import { createVideoJob, type CreateVideoJobInput } from './create.js'
import { getJobDetail, getCopyContext, listJobsView, putCopyConfig } from './service.js'
import { refreshJob, cancelJob, resumeJob, retryDownload, queryOriginal, bindRemoteTaskId, confirmResubmit, realignJob, archiveJob } from './actions.js'

/**
 * 视频创作模块路由（任务书 §6.1 / §6.2）。
 * 装配入口：registerVideoRoutes(app)；worker / sweep / reconcile 在 registerVideoModule()。
 */

/** 飞影积分缓存（FR-A4：与人物库同源，5 分钟） */
let creditCache: { at: number; value: number | null } = { at: 0, value: null }

async function creditCached(): Promise<{ value: number | null; error: string | null }> {
  try {
    if (!config.hifly.apiKey && !config.mockFallback) return { value: null, error: null }
    const now = Date.now()
    if (now - creditCache.at > config.hifly.creditCacheMs) {
      const { resolveHiflyClient } = await import('../../integrations/hifly/index.js')
      const credit = await resolveHiflyClient().credit()
      creditCache = { at: now, value: credit }
      return { value: credit, error: null }
    }
    return { value: creditCache.value, error: null }
  } catch (e) {
    return { value: creditCache.value, error: (e as Error).message }
  }
}

function operatorOf(req: FastifyRequest): string {
  const u = (req as unknown as { user?: { username?: string; id?: string } }).user
  return u?.username || u?.id || config.defaultOperator
}

function idempotencyKeyOf(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key']
  const v = Array.isArray(raw) ? raw[0] : raw
  return (v && String(v).trim()) || ''
}

/** AC-0.5：health 的视频创作段（ffmpeg/ffprobe、飞影与 ASR 配置状态，脱敏） */
let ffprobeCache: { at: number; ok: boolean } = { at: 0, ok: false }

export async function videoHealth(): Promise<Record<string, unknown>> {
  const ffmpeg = await checkFfmpeg()
  if (Date.now() - ffprobeCache.at > config.hifly.creditCacheMs) {
    const { spawn } = await import('node:child_process')
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn('ffprobe', ['-version'])
      p.on('error', () => resolve(false))
      p.on('close', (code) => resolve(code === 0))
    })
    ffprobeCache = { at: Date.now(), ok }
  }
  return {
    ffmpeg: ffmpeg.ok,
    ffprobe: ffprobeCache.ok,
    hifly: hiflyStatus(),
    asr: { configured: hasDashScope() },
  }
}

/* ── /media/* 本地兜底回放（V12：Range、token 校验、仅限视频/素材前缀）── */

function mediaToken(key: string, exp: number): string {
  return createHmac('sha256', config.auth.jwtSecret || 'media-local').update(`${key}:${exp}`).digest('hex').slice(0, 32)
}

function verifyMediaToken(key: string, token: string, exp: number): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false
  return mediaToken(key, exp) === token
}

export function signMediaUrl(key: string, ttlSeconds = 7200): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  return `/api/media/${key}?token=${mediaToken(key, exp)}&exp=${exp}`
}

async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/video/options', async () => {
    const credit = await creditCached()
    return ok(await buildVideoOptions(credit))
  })

  // 可用于视频创作的文案（FR-C1：只列 approved_version_id 非空）
  app.get('/video/copies', async (req) => {
    const q = (req.query ?? {}) as { personaId?: string; line?: string; keyword?: string; page?: string; pageSize?: string }
    const db = getDb()
    const where: string[] = ['`approved_version_id` IS NOT NULL', '`archived_at` IS NULL']
    const params: unknown[] = []
    if (q.personaId) {
      where.push('`persona_id` = ?')
      params.push(q.personaId)
    }
    if (q.line) {
      where.push('`line` = ?')
      params.push(q.line)
    }
    if (q.keyword) {
      where.push('`title` LIKE ?')
      params.push(`%${q.keyword}%`)
    }
    const whereSql = `WHERE ${where.join(' AND ')}`
    const page = Math.max(1, Number(q.page ?? 1))
    const pageSize = Math.min(50, Math.max(1, Number(q.pageSize ?? 20)))
    const total = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM \`copy\` ${whereSql}`, params)
    const rows = await db.all(
      `SELECT \`id\`, \`title\`, \`persona_id\`, \`line\`, \`status\`, \`approved_version_id\`, \`updated_at\` FROM \`copy\` ${whereSql} ORDER BY \`updated_at\` DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    )
    return ok({ items: rows, total: Number(total?.n ?? 0), page, pageSize })
  })

  app.get('/video/copies/:copyId/context', async (req) => {
    const { copyId } = req.params as { copyId: string }
    return ok(await getCopyContext(copyId))
  })

  app.put('/video/copies/:copyId/config', async (req) => {
    const { copyId } = req.params as { copyId: string }
    const body = (req.body ?? {}) as Partial<CreateVideoJobInput>
    await putCopyConfig(
      copyId,
      {
        copyId,
        mode: body.mode ?? 'avatar',
        avatarId: body.avatarId ?? null,
        mixcutPackIds: body.mixcutPackIds,
        voiceSource: body.voiceSource,
        publicVoiceId: body.publicVoiceId,
        display: body.display,
      },
      operatorOf(req),
    )
    return ok({ saved: true })
  })

  app.post('/video/precheck', async (req) => {
    const body = (req.body ?? {}) as { copyId?: string; mode?: string; avatarId?: string; mixcutPackIds?: string[] }
    if (!body.copyId || !body.mode) throw err.badRequest('缺少 copyId 或 mode')
    const result = await runPrecheck({
      copyId: body.copyId,
      mode: body.mode === 'mixcut' ? 'mixcut' : 'avatar',
      avatarId: body.avatarId ?? null,
      mixcutPackIds: body.mixcutPackIds,
    })
    return ok(result)
  })

  // FR-M2 匹配预览：纯计算，不调用飞影与 ASR（生成时以对齐结果为准）
  app.post('/video/mixcut/preview', async (req) => {
    const body = (req.body ?? {}) as { copyId?: string; keywordGroupIds?: string[]; backgroundAssetId?: string | null }
    if (!body.copyId) throw err.badRequest('缺少 copyId')
    const { getApprovedCopy } = await import('../copy/review.js')
    const { buildTextSnapshot } = await import('./text-snapshot.js')
    const { previewMixcut } = await import('./mixcut/service.js')
    const ap = await getApprovedCopy(body.copyId)
    const snap = buildTextSnapshot(ap.sections, ap.riskHint)
    return ok(await previewMixcut(snap.segments, snap.estSeconds, { keywordGroupIds: body.keywordGroupIds, backgroundAssetId: body.backgroundAssetId ?? null }))
  })

  // 任务创建（FR-A6：Idempotency-Key 幂等）
  app.post('/video/jobs', async (req) => {
    const body = (req.body ?? {}) as Partial<CreateVideoJobInput>
    if (!body.copyId || !body.mode) throw err.badRequest('缺少 copyId 或 mode')
    const result = await createVideoJob(
      {
        copyId: body.copyId,
        mode: body.mode === 'mixcut' ? 'mixcut' : 'avatar',
        avatarId: body.avatarId ?? null,
        mixcutPackIds: body.mixcutPackIds,
        voiceSource: body.voiceSource,
        publicVoiceId: body.publicVoiceId,
        display: body.display,
      },
      { idempotencyKey: idempotencyKeyOf(req) || null, operator: operatorOf(req) },
    )
    return ok(result)
  })

  app.get('/video/jobs', async (req) => {
    const q = (req.query ?? {}) as { copyId?: string; personaId?: string; phase?: string; ids?: string; page?: string; pageSize?: string }
    return ok(
      await listJobsView({
        copyId: q.copyId,
        personaId: q.personaId,
        phase: q.phase,
        ids: q.ids ? q.ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        page: q.page ? Number(q.page) : undefined,
        pageSize: q.pageSize ? Number(q.pageSize) : undefined,
      }),
    )
  })

  app.get('/video/jobs/:id', async (req) => {
    const { id } = req.params as { id: string }
    const detail = await getJobDetail(id)
    if (!detail) throw err.notFound('视频任务不存在')
    return ok(detail)
  })

  // FR-X1：基础视频取用（给视频剪辑模块）
  app.get('/video/jobs/:id/base', async (req) => {
    const { id } = req.params as { id: string }
    const { getBaseVideo } = await import('./base.js')
    return ok(await getBaseVideo(id))
  })

  const jobAction = (name: string, fn: (jobId: string, req: FastifyRequest) => Promise<unknown>) => {
    app.post(`/video/jobs/:id/${name}`, async (req) => {
      const { id } = req.params as { id: string }
      const result = await fn(id, req)
      return ok(result ?? { done: true })
    })
  }

  jobAction('refresh', (id, req) => refreshJob(id, operatorOf(req)))
  jobAction('cancel', (id, req) => cancelJob(id, operatorOf(req)))
  jobAction('resume', (id, req) => resumeJob(id, operatorOf(req)))
  jobAction('retry-download', (id, req) => retryDownload(id, operatorOf(req)))
  jobAction('query-original', (id, req) => queryOriginal(id, operatorOf(req)))
  jobAction('bind-remote', (id, req) => {
    const body = (req.body ?? {}) as { remoteTaskId?: string }
    if (!body.remoteTaskId) throw err.badRequest('缺少 remoteTaskId（在飞影后台按标题短引用检索后填入）')
    return bindRemoteTaskId(id, body.remoteTaskId, operatorOf(req))
  })
  jobAction('confirm-resubmit', (id, req) => {
    const body = (req.body ?? {}) as { confirm?: boolean }
    return confirmResubmit(id, body.confirm === true, operatorOf(req))
  })
  jobAction('realign', (id, req) => realignJob(id, operatorOf(req)))
  jobAction('archive', (id, req) => archiveJob(id, operatorOf(req)))

  /* ── /media/* 本地兜底回放（V12）── */
  app.get('/media/*', async (req, reply) => {
    const raw = (req.params as Record<string, string>)['*'] ?? ''
    const key = raw.replace(/^\/+/, '')
    if (!/^(.*\/)?(video-jobs|material|bgm)\//.test(key)) throw err.forbidden('仅允许访问视频任务、素材与 BGM 对象')
    const q = (req.query ?? {}) as { token?: string; exp?: string }
    if (!verifyMediaToken(key, String(q.token ?? ''), Number(q.exp ?? Number.NaN))) {
      throw err.unauthorized('媒体链接无效或已过期，请刷新页面重新获取')
    }
    const range = req.headers.range
    const res = await getObjectStream(key, range)
    if (!res) throw err.notFound('文件不存在或已被清理')
    const headers: Record<string, string> = {
      'Content-Type': res.contentType ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
    }
    if (res.status === 416) {
      return reply.status(416).headers({ 'Content-Range': res.contentRange ?? '', 'Accept-Ranges': 'bytes' }).send()
    }
    if (res.contentRange) {
      headers['Content-Range'] = res.contentRange
      headers['Content-Length'] = String(res.contentLength ?? 0)
      reply.status(206).headers(headers)
    } else {
      if (res.contentLength != null) headers['Content-Length'] = String(res.contentLength)
      reply.headers(headers)
    }
    return reply.send(res.stream as never)
  })
}

export { registerVideoRoutes }
