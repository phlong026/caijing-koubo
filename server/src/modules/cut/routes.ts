import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { newId } from '../../lib/util.js'
import { config, paths } from '../../config.js'
import { getCut, listVersions } from './repo.js'
import { subtitleDiff } from './review.js'
import {
  getCutConfig,
  saveCutConfig,
  createCutVersion,
  cancelCut,
  retryRender,
  getFinalVideo,
} from './service.js'
import { getLatestSubmission, submitCutReview, decideCutReview, listCutReviewQueue } from './review.js'
import { listBgm, createBgm, deleteBgm } from './bgm-store.js'
import { signMediaUrl } from '../video/routes.js'
import type { CutConfigInput } from './types.js'

/**
 * 剪辑模块路由（任务书 §6 / CE0~CE6）。
 * 前缀沿用视频模块斜杠风格（/video/jobs/:id/cut-config）；BGM 走 /cut/bgm 独立前缀
 * （避开 /media/* 通配遮蔽歧义）。角色限制见 auth/guard.ROLE_RULES。
 */

async function cutView(cutId: string) {
  const cut = await getCut(cutId)
  if (!cut) throw err.notFound('成片版本不存在')
  const { isOssEnabled, signedUrl } = await import('../../integrations/aliyun-oss/client.js')
  const oss = isOssEnabled()
  const url = cut.resultKey ? (oss ? await signedUrl(cut.resultKey) : signMediaUrl(cut.resultKey)) : null
  const coverUrl = cut.coverKey ? (oss ? await signedUrl(cut.coverKey) : signMediaUrl(cut.coverKey)) : null
  const submission = await getLatestSubmission(cutId)
  return { cut, url, coverUrl, submission }
}

export function registerCutRoutes(app: FastifyInstance): void {
  /* ── 配置与草稿 ── */
  app.get('/video/jobs/:id/cut-config', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await getCutConfig(id))
  })

  app.put('/video/jobs/:id/cut-config', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as CutConfigInput
    return ok(await saveCutConfig(id, body, operatorOf(req)))
  })

  app.post('/video/jobs/:id/cut-versions', async (req) => {
    const { id } = req.params as { id: string }
    // 幂等（AC-C4）：同操作者 30 秒内重复点击且草稿未变 → 返回同一活跃版本
    const versions = await listVersions(id)
    const active = versions.find((v) => ['queued', 'rendering', 'cancelling'].includes(v.status))
    if (active) {
      const age = active.createdAt ? Date.now() - new Date(active.createdAt.replace(' ', 'T') + 'Z').getTime() : Infinity
      if (age < 30000) return ok({ cut: active, idempotent: true })
    }
    const version = await createCutVersion(id, operatorOf(req))
    return ok({ cut: version, idempotent: false })
  })

  app.get('/video/jobs/:id/cut-versions', async (req) => {
    const { id } = req.params as { id: string }
    const versions = await listVersions(id)
    return ok({ versions: versions.filter((v) => v.versionNo > 0) })
  })

  /* ── 版本详情与动作 ── */
  app.get('/video/cuts/:id', async (req) => ok(await cutView((req.params as { id: string }).id)))

  app.post('/video/cuts/:id/cancel', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await cancelCut(id, operatorOf(req)))
  })

  app.post('/video/cuts/:id/retry-render', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await retryRender(id, operatorOf(req)))
  })

  /* ── 成片复审 ── */
  app.post('/video/cuts/:id/review', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await submitCutReview(id, operatorOf(req)))
  })

  app.get('/video/cuts/:id/review', async (req) => {
    const { id } = req.params as { id: string }
    const view = await cutView(id)
    const baseTimelineTexts = await baseTextsOf(view.cut.videoJobId)
    return ok({ submission: view.submission, diff: subtitleDiff(view.cut, baseTimelineTexts) })
  })

  app.post('/video/cuts/:id/review/decision', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { result?: 'approved' | 'rejected'; reason?: string }
    if (body.result !== 'approved' && body.result !== 'rejected') throw err.badRequest('result 须为 approved | rejected')
    return ok(await decideCutReview(id, { result: body.result, reason: body.reason }, operatorOf(req)))
  })

  app.get('/cut-review/queue', async (req) => {
    const q = (req.query ?? {}) as { status?: string; line?: string }
    const items = await listCutReviewQueue(q)
    const { isOssEnabled, signedUrl } = await import('../../integrations/aliyun-oss/client.js')
    const oss = isOssEnabled()
    const enriched = await Promise.all(
      items.map(async (it) => ({
        ...it,
        url: it.cut.resultKey ? (oss ? await signedUrl(it.cut.resultKey) : signMediaUrl(it.cut.resultKey)) : null,
      })),
    )
    return ok({ items: enriched })
  })

  /* ── 发布取用契约（FR-X1）── */
  app.get('/video/cuts/:id/final', async (req) => ok(await getFinalVideo((req.params as { id: string }).id)))

  /* ── 轻量 BGM 库（FR-B3）── */
  app.get('/cut/bgm', async () => ok({ items: await listBgm() }))

  app.post('/cut/bgm', async (req) => {
    const uploaded = await readAudioUpload(req)
    const item = await createBgm(uploaded, operatorOf(req))
    await fsPromises.rm(uploaded.path, { force: true }).catch(() => undefined)
    return ok({ item })
  })

  app.delete('/cut/bgm/:id', async (req) => {
    const { id } = req.params as { id: string }
    await deleteBgm(id)
    return ok({ deleted: true })
  })
}

function operatorOf(req: FastifyRequest): string {
  const u = (req as unknown as { user?: { username?: string; id?: string } }).user
  return u?.username || u?.id || config.defaultOperator
}

async function baseTextsOf(videoJobId: string): Promise<string[]> {
  const { getVideoJob } = await import('../video/repo.js')
  const job = await getVideoJob(videoJobId)
  return (job?.timeline ?? []).map((t) => t.text)
}

/** BGM 上传（简化版单趟读取：仅单音频文件，≤20MB） */
async function readAudioUpload(req: FastifyRequest): Promise<{ path: string; originalname?: string }> {
  const parts = (
    req as unknown as {
      parts: () => AsyncIterableIterator<{
        type: string
        fieldname?: string
        value?: unknown
        filename?: string
        file?: NodeJS.ReadableStream & { truncated?: boolean }
      }>
    }
  ).parts()
  const max = config.cut.bgmMaxMb * 1024 * 1024
  for await (const part of parts) {
    if (part.type !== 'file') continue
    const ext = path.extname(part.filename || '').slice(0, 8) || '.mp3'
    if (!/\.(mp3|m4a|wav)$/i.test(ext)) throw err.badRequest('仅支持 mp3 / m4a / wav')
    await fsPromises.mkdir(paths.tempDir, { recursive: true }).catch(() => undefined)
    const dest = path.join(paths.tempDir, `${newId('bgmup')}${ext}`)
    let size = 0
    const ws = fs.createWriteStream(dest)
    const stream = part.file as unknown as NodeJS.ReadableStream & { destroy?: () => void }
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > max) {
          stream.destroy?.()
          ws.close()
          reject(err.badRequest(`BGM 文件不得超过 ${config.cut.bgmMaxMb}MB`))
          return
        }
        ws.write(chunk)
      })
      stream.on('end', () => {
        ws.end()
        resolve()
      })
      stream.on('error', (e: Error) => reject(e))
    })
    return { path: dest, originalname: part.filename }
  }
  throw err.badRequest('缺少音频文件')
}

