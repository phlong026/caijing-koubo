import type { FastifyInstance, FastifyRequest } from 'fastify'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ok } from '../../app.js'
import { err } from '../../errors.js'
import { paths } from '../../config.js'
import { newId } from '../../lib/util.js'
import {
  bootstrapFonts,
  deleteFont,
  enabledFonts,
  getFont,
  listFonts,
  patchFont,
  uploadFont,
} from './fonts.js'
import { listVoiceLibrary } from './voices.js'
import { isOssEnabled, signedUrl } from '../../integrations/aliyun-oss/client.js'
import { signMediaUrl } from '../video/routes.js'
import {
  createKeywordGroup,
  deleteKeywordGroup,
  deleteMaterialPack,
  getMaterialPack,
  importMaterialPack,
  importMaterialPackFromBuffer,
  listKeywordGroups,
  listMaterialItems,
  listMaterialPacks,
  patchKeywordGroup,
  patchMaterialItem,
  patchMaterialPack,
} from '../video/material.js'

/**
 * 素材库路由（任务书 §6）。路径与视频创作 V1 交付时**完全一致**（`/material-packs*`、
 * `/material-keyword-groups*`），本次仅代码归位到素材库模块；`/fonts`、`/voice-library` 为本模块新增。
 *
 * 写接口的角色限制在 `auth/guard.ts ROLE_RULES`（A6：上传与管理仅管理员，ops 只读）。
 */

const operatorOf = (req: FastifyRequest): string => req.operator

async function readMultipart(req: FastifyRequest): Promise<{ files: Array<{ filename: string; data: Buffer; filePath?: string }>; fields: Record<string, string> }> {
  const files: Array<{ filename: string; data: Buffer; filePath?: string }> = []
  const fields: Record<string, string> = {}
  const parts = (req as unknown as { parts: () => AsyncIterable<Record<string, unknown>> }).parts
  for await (const part of parts.call(req)) {
    if (part.type === 'file') {
      const buf = await (part.toBuffer as () => Promise<Buffer>)()
      files.push({ filename: String(part.filename ?? 'file'), data: buf })
    } else {
      fields[String(part.fieldname)] = String(part.value ?? '')
    }
  }
  return { files, fields }
}

export function registerMaterialRoutes(app: FastifyInstance): void {
  /* ── 字体库（ML1）────────────────────────────────────────────── */

  app.get('/fonts', async () => ok({ items: await listFonts(), enabled: await enabledFonts() }))

  app.get('/fonts/:id', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await getFont(id))
  })

  app.post('/fonts', async (req) => {
    const ctype = String(req.headers['content-type'] ?? '')
    if (!ctype.includes('multipart/form-data')) throw err.badRequest('请使用 multipart/form-data 上传字体文件')
    const { files, fields } = await readMultipart(req)
    const file = files[0]
    if (!file) throw err.badRequest('缺少字体文件')
    if (files.length > 1) throw err.badRequest('一次只能上传一个字体文件')

    const tempDir = path.join(paths.tempDir, 'font-upload')
    await fsp.mkdir(tempDir, { recursive: true })
    const tempPath = path.join(tempDir, `${newId('fup')}.bin`)
    await fsp.writeFile(tempPath, file.data)
    try {
      const font = await uploadFont(
        { filePath: tempPath, fileName: file.filename, sizeBytes: file.data.byteLength },
        { displayName: fields.displayName, licenseType: fields.licenseType, licenseNote: fields.licenseNote },
        operatorOf(req),
      )
      return ok(font)
    } finally {
      await fsp.rm(tempPath, { force: true })
    }
  })

  app.patch('/fonts/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { enabled?: boolean; displayName?: string; licenseType?: string; licenseNote?: string | null }
    return ok(await patchFont(id, body, operatorOf(req)))
  })

  app.delete('/fonts/:id', async (req) => {
    const { id } = req.params as { id: string }
    await deleteFont(id)
    return ok({ deleted: true })
  })

  /** 启动扫描亦可手动触发（运维核对目录用，幂等） */
  app.post('/fonts/bootstrap', async () => ok(await bootstrapFonts()))

  /* ── 素材包（既有接口平移，路径不变）──────────────────────────── */

  app.get('/material-packs', async () => ok(await listMaterialPacks()))

  app.get('/material-packs/:id', async (req) => {
    const { id } = req.params as { id: string }
    return ok(await getMaterialPack(id))
  })

  app.get('/material-packs/:id/items', async (req) => {
    const { id } = req.params as { id: string }
    await getMaterialPack(id)
    const items = await listMaterialItems(id)
    // 缩略图走签名 URL（OSS 直链 / 本地 /media 兜底），与剪辑、成片回放同一口径
    const oss = isOssEnabled()
    const withUrls = await Promise.all(
      items.map(async (it) => ({
        ...it,
        thumbUrl: it.thumbKey ? (oss ? await signedUrl(it.thumbKey) : signMediaUrl(it.thumbKey)) : null,
      })),
    )
    return ok(withUrls)
  })

  app.post('/material-packs', async (req) => {
    const ctype = String(req.headers['content-type'] ?? '')
    if (ctype.includes('multipart/form-data')) {
      const { files, fields } = await readMultipart(req)
      if (!files.length) throw err.materialPackEmpty('未收到任何素材文件')
      if (files.length > 20) throw err.badRequest('一次最多上传 20 个文件，更多素材请打包成 zip 上传')
      return ok(
        await importMaterialPackFromBuffer(
          { name: fields.name || '素材包', line: fields.line || null, files, licenseNote: fields.licenseNote ?? null },
          operatorOf(req),
        ),
      )
    }
    const body = (req.body ?? {}) as { name?: string; line?: string; sourcePath?: string; licenseNote?: string | null }
    if (!body.sourcePath) throw err.badRequest('缺少 sourcePath（服务器目录或 zip 路径），或以 multipart 上传文件')
    return ok(
      await importMaterialPack(
        { name: body.name || '素材包', line: body.line ?? null, sourcePath: body.sourcePath, licenseNote: body.licenseNote ?? null },
        operatorOf(req),
      ),
    )
  })

  app.patch('/material-packs/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { name?: string; enabled?: boolean; line?: string | null; licenseNote?: string | null }
    return ok(await patchMaterialPack(id, body, operatorOf(req)))
  })

  app.delete('/material-packs/:id', async (req) => {
    const { id } = req.params as { id: string }
    await deleteMaterialPack(id)
    return ok({ deleted: true })
  })

  /** FR-P4：item 手动补标 */
  app.patch('/material-packs/:id/items/:itemId', async (req) => {
    const { id, itemId } = req.params as { id: string; itemId: string }
    const body = (req.body ?? {}) as { tags?: unknown }
    return ok(await patchMaterialItem(id, itemId, body.tags ?? []))
  })

  /* ── 关键词组（既有接口平移）────────────────────────────────── */

  app.get('/material-keyword-groups', async () => ok(await listKeywordGroups()))

  app.post('/material-keyword-groups', async (req) => {
    const body = (req.body ?? {}) as {
      name?: string
      keywords?: string[]
      packIds?: string[]
      durationMinMs?: number
      durationMaxMs?: number
      selectionMode?: 'random' | 'sequential'
      enabled?: boolean
      sort?: number
    }
    const name = String(body.name ?? '').trim()
    if (!name) throw err.badRequest('缺少组名')
    const keywords = Array.isArray(body.keywords) ? body.keywords.map((k) => String(k).trim()).filter(Boolean) : []
    return ok(
      await createKeywordGroup(
        {
          name,
          keywords,
          packIds: Array.isArray(body.packIds) ? body.packIds.map(String) : undefined,
          durationMinMs: body.durationMinMs !== undefined ? Number(body.durationMinMs) : undefined,
          durationMaxMs: body.durationMaxMs !== undefined ? Number(body.durationMaxMs) : undefined,
          selectionMode: body.selectionMode === 'sequential' ? 'sequential' : body.selectionMode === 'random' ? 'random' : undefined,
          enabled: body.enabled,
          sort: body.sort !== undefined ? Number(body.sort) : undefined,
        },
        operatorOf(req),
      ),
    )
  })

  app.patch('/material-keyword-groups/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as Record<string, unknown>
    return ok(
      await patchKeywordGroup(
        id,
        {
          ...(body.name !== undefined ? { name: String(body.name) } : {}),
          ...(Array.isArray(body.keywords) ? { keywords: body.keywords.map(String).filter(Boolean) } : {}),
          ...(Array.isArray(body.packIds) ? { packIds: body.packIds.map(String) } : {}),
          ...(body.durationMinMs !== undefined ? { durationMinMs: Number(body.durationMinMs) } : {}),
          ...(body.durationMaxMs !== undefined ? { durationMaxMs: Number(body.durationMaxMs) } : {}),
          ...(body.selectionMode === 'random' || body.selectionMode === 'sequential' ? { selectionMode: body.selectionMode } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
          ...(body.sort !== undefined ? { sort: Number(body.sort) } : {}),
        },
        operatorOf(req),
      ),
    )
  })

  app.delete('/material-keyword-groups/:id', async (req) => {
    const { id } = req.params as { id: string }
    await deleteKeywordGroup(id)
    return ok({ deleted: true })
  })

  /* ── 声音库聚合（FR-V1）─────────────────────────────────────── */

  app.get('/voice-library', async (req) => {
    const q = (req.query ?? {}) as { line?: string; personaId?: string }
    return ok(await listVoiceLibrary({ line: q.line || undefined, personaId: q.personaId || undefined }))
  })
}

export function registerMaterialModule(): void {
  // 无 worker / sweep：字体与素材均为同步管理操作（渲染侧由剪辑 worker 消费）
}
