import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { paths } from '../../config.js'
import { err } from '../../errors.js'
import { getDb } from '../../db/index.js'
import { newId } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { putObjectFromFile } from '../../integrations/aliyun-oss/client.js'
import { makeThumb, probeImage, probeMedia } from '../../media/inspect.js'

/**
 * 素材包桩（FR-S4；🔧 R5 MaterialManager 扫描逻辑 + 🔧 R6 关键词组结构，宿主改 fs）。
 * 导入：服务器目录扫描（或 zip 先解压）；每个素材探测时长 / 是否图片 / 缩略图后上传 OSS。
 * 所有权归素材库（一期为桩，素材库就绪后下线写接口，§6.2）。
 */

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v']
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

export interface MaterialPackRow {
  id: string
  name: string
  line: string | null
  sourcePath: string | null
  itemCount: number
  enabled: number
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export async function listMaterialPacks() {
  const db = getDb()
  const rows = await db.all('SELECT * FROM `material_pack` ORDER BY `created_at` DESC')
  return rows.map(mapPack)
}

function mapPack(r: Record<string, unknown>): MaterialPackRow {
  return {
    id: String(r.id),
    name: String(r.name),
    line: (r.line as string) ?? null,
    sourcePath: (r.source_path as string) ?? null,
    itemCount: Number(r.item_count ?? 0),
    enabled: Number(r.enabled ?? 1),
    createdBy: (r.created_by as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

export async function getMaterialPack(packId: string) {
  const db = getDb()
  const row = await db.get('SELECT * FROM `material_pack` WHERE `id` = ?', [packId])
  if (!row) throw err.notFound('素材包不存在')
  return mapPack(row)
}

export async function listMaterialItems(packId: string) {
  const db = getDb()
  const rows = await db.all('SELECT * FROM `material_item` WHERE `pack_id` = ? ORDER BY `id` ASC', [packId])
  return rows.map((r) => ({
    id: String(r.id),
    packId: String(r.pack_id),
    storageKey: String(r.storage_key),
    isImage: Number(r.is_image ?? 0) === 1,
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    thumbKey: (r.thumb_key as string) ?? null,
    enabled: Number(r.enabled ?? 1),
  }))
}

/** 从服务器目录（或 zip）导入素材包（R5 scanMaterialFolder 逻辑平移） */
export async function importMaterialPack(
  input: { name: string; line?: string | null; sourcePath: string },
  operator: string,
): Promise<MaterialPackRow> {
  let dir = path.resolve(String(input.sourcePath ?? ''))
  if (dir.toLowerCase().endsWith('.zip')) {
    dir = await unzipToTemp(dir)
  }
  const st = await fsp.stat(dir).catch(() => null)
  if (!st || !st.isDirectory()) throw err.badRequest(`素材目录不存在或不可读：${input.sourcePath}`)

  const files = await walkMediaFiles(dir)
  if (!files.length) throw err.materialPackEmpty('目录中没有可识别的素材文件（支持 mp4/mov/webm/jpg/png 等）')

  const db = getDb()
  const now = toDb(utcNow())
  const packId = newId('mpack')
  await db.run(
    'INSERT INTO `material_pack` (`id`, `name`, `line`, `source_path`, `item_count`, `enabled`, `created_by`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
    [packId, input.name || path.basename(dir), input.line ?? null, input.sourcePath, files.length, operator, now, now],
  )

  let imported = 0
  for (const file of files) {
    try {
      await importItem(packId, file)
      imported += 1
    } catch (e) {
      // 单个素材失败不阻断导入（记录条目数差异供排查）
      void e
    }
  }
  await db.run('UPDATE `material_pack` SET `item_count` = ?, `updated_at` = ? WHERE `id` = ?', [imported, toDb(utcNow()), packId])
  return getMaterialPack(packId)
}

/** multipart 逐文件导入：先落临时目录，再走同一扫描链路 */
export async function importMaterialPackFromBuffer(
  input: { name: string; line?: string | null; files: Array<{ filename: string; data: Buffer }> },
  operator: string,
): Promise<MaterialPackRow> {
  if (!input.files.length) throw err.materialPackEmpty('未收到任何素材文件')
  const dir = path.join(paths.tempDir, 'material-import', newId('mi'))
  await fsp.mkdir(dir, { recursive: true })
  for (const f of input.files) {
    const safe = path.basename(f.filename).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_')
    await fsp.writeFile(path.join(dir, `${newId('f')}_${safe}`), f.data)
  }
  return importMaterialPack({ name: input.name, line: input.line, sourcePath: dir }, operator)
}

async function importItem(packId: string, file: string): Promise<void> {
  const db = getDb()
  const ext = path.extname(file).toLowerCase()
  const isImage = IMAGE_EXTENSIONS.includes(ext)
  const key = `material/${packId}/${newId('mi')}${ext}`
  await putObjectFromFile(file, key, '')
  let durationMs: number | null = null
  let width: number | null = null
  let height: number | null = null
  let thumbKey: string | null = null
  if (isImage) {
    const img = await probeImage(file)
    width = img.width
    height = img.height
  } else {
    const probe = await probeMedia(file)
    durationMs = probe.durationMs
    width = probe.width
    height = probe.height
    try {
      const thumbPath = `${file}.thumb.jpg`
      await makeThumb(file, thumbPath, 320)
      thumbKey = `${key}.thumb.jpg`
      await putObjectFromFile(thumbPath, thumbKey, '')
      await fsp.rm(thumbPath, { force: true })
    } catch {
      // 缩略图失败不阻断
    }
  }
  await db.run(
    'INSERT INTO `material_item` (`id`, `pack_id`, `storage_key`, `is_image`, `duration_ms`, `width`, `height`, `thumb_key`, `enabled`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
    [newId('mitem'), packId, key, isImage ? 1 : 0, durationMs, width, height, thumbKey],
  )
}

async function walkMediaFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkMediaFiles(full, depth + 1)))
    else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase()
      if (VIDEO_EXTENSIONS.includes(ext) || IMAGE_EXTENSIONS.includes(ext)) out.push(full)
    }
  }
  return out.sort()
}

async function unzipToTemp(zipPath: string): Promise<string> {
  const dir = path.join(paths.tempDir, 'material-import', newId('mz'))
  await fsp.mkdir(dir, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const p = spawn('unzip', ['-o', '-q', zipPath, '-d', dir])
    p.on('error', () => reject(new Error('服务器缺少 unzip 命令，无法解压导入；请改用目录导入或逐文件上传')))
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`zip 解压失败（code=${code}）`))))
  })
  return dir
}

export async function patchMaterialPack(packId: string, patch: { name?: string; enabled?: boolean; line?: string | null }, operator: string) {
  const db = getDb()
  await getMaterialPack(packId)
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    sets.push('`name` = ?')
    params.push(patch.name)
  }
  if (patch.enabled !== undefined) {
    sets.push('`enabled` = ?')
    params.push(patch.enabled ? 1 : 0)
  }
  if (patch.line !== undefined) {
    sets.push('`line` = ?')
    params.push(patch.line)
  }
  if (!sets.length) return getMaterialPack(packId)
  sets.push('`updated_at` = ?')
  params.push(toDb(utcNow()))
  await db.run(`UPDATE \`material_pack\` SET ${sets.join(', ')} WHERE \`id\` = ?`, [...params, packId])
  void operator
  return getMaterialPack(packId)
}

export async function deleteMaterialPack(packId: string): Promise<void> {
  const db = getDb()
  await db.run('DELETE FROM `material_item` WHERE `pack_id` = ?', [packId])
  await db.run('DELETE FROM `material_pack` WHERE `id` = ?', [packId])
}

/* ── 关键词组（🔧 R6 KeywordGroupService 结构平移）────────────────── */

export interface KeywordGroupRow {
  id: string
  name: string
  keywords: string[]
  packIds: string[]
  durationMinMs: number
  durationMaxMs: number
  selectionMode: 'random' | 'sequential'
  enabled: number
  sort: number
}

function mapGroup(r: Record<string, unknown>): KeywordGroupRow {
  const parse = (v: unknown): string[] => {
    try {
      const arr = typeof v === 'string' ? JSON.parse(v) : v
      return Array.isArray(arr) ? arr.map(String) : []
    } catch {
      return []
    }
  }
  return {
    id: String(r.id),
    name: String(r.name),
    keywords: parse(r.keywords),
    packIds: parse(r.pack_ids),
    durationMinMs: Number(r.duration_min_ms ?? 800),
    durationMaxMs: Number(r.duration_max_ms ?? 3000),
    selectionMode: r.selection_mode === 'sequential' ? 'sequential' : 'random',
    enabled: Number(r.enabled ?? 1),
    sort: Number(r.sort ?? 0),
  }
}

export async function listKeywordGroups() {
  const rows = await getDb().all('SELECT * FROM `material_keyword_group` ORDER BY `sort` ASC, `id` ASC')
  return rows.map(mapGroup)
}

export async function createKeywordGroup(
  input: { name: string; keywords: string[]; packIds?: string[]; durationMinMs?: number; durationMaxMs?: number; selectionMode?: 'random' | 'sequential'; enabled?: boolean; sort?: number },
  operator: string,
) {
  const db = getDb()
  const id = newId('mkg')
  await db.run(
    'INSERT INTO `material_keyword_group` (`id`, `name`, `keywords`, `pack_ids`, `duration_min_ms`, `duration_max_ms`, `selection_mode`, `enabled`, `sort`, `updated_by`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      input.name,
      JSON.stringify(input.keywords ?? []),
      JSON.stringify(input.packIds ?? []),
      input.durationMinMs ?? 800,
      input.durationMaxMs ?? 3000,
      input.selectionMode ?? 'random',
      input.enabled === false ? 0 : 1,
      input.sort ?? 100,
      operator,
      toDb(utcNow()),
    ],
  )
  const row = await db.get('SELECT * FROM `material_keyword_group` WHERE `id` = ?', [id])
  return mapGroup(row!)
}

export interface KeywordGroupPatch {
  name?: string
  keywords?: string[]
  packIds?: string[]
  durationMinMs?: number
  durationMaxMs?: number
  selectionMode?: 'random' | 'sequential'
  enabled?: boolean
  sort?: number
}

export async function patchKeywordGroup(id: string, patch: KeywordGroupPatch, operator: string) {
  const db = getDb()
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    sets.push('`name` = ?')
    params.push(patch.name)
  }
  if (patch.keywords !== undefined) {
    sets.push('`keywords` = ?')
    params.push(JSON.stringify(patch.keywords))
  }
  if (patch.packIds !== undefined) {
    sets.push('`pack_ids` = ?')
    params.push(JSON.stringify(patch.packIds))
  }
  if (patch.durationMinMs !== undefined) {
    sets.push('`duration_min_ms` = ?')
    params.push(patch.durationMinMs)
  }
  if (patch.durationMaxMs !== undefined) {
    sets.push('`duration_max_ms` = ?')
    params.push(patch.durationMaxMs)
  }
  if (patch.selectionMode !== undefined) {
    sets.push('`selection_mode` = ?')
    params.push(patch.selectionMode)
  }
  if (patch.enabled !== undefined) {
    sets.push('`enabled` = ?')
    params.push(patch.enabled ? 1 : 0)
  }
  if (patch.sort !== undefined) {
    sets.push('`sort` = ?')
    params.push(patch.sort)
  }
  if (sets.length) {
    sets.push('`updated_by` = ?', '`updated_at` = ?')
    params.push(operator, toDb(utcNow()))
    await db.run(`UPDATE \`material_keyword_group\` SET ${sets.join(', ')} WHERE \`id\` = ?`, [...params, id])
  }
  const row = await db.get('SELECT * FROM `material_keyword_group` WHERE `id` = ?', [id])
  if (!row) throw err.notFound('关键词组不存在')
  return mapGroup(row)
}

export async function deleteKeywordGroup(id: string): Promise<void> {
  await getDb().run('DELETE FROM `material_keyword_group` WHERE `id` = ?', [id])
}

/** 混剪匹配用：取启用的素材条目（去重后的本地缓存路径交给合成阶段，V5） */
export async function listEnabledItemsOfPacks(packIds: string[]) {
  if (!packIds.length) return []
  const db = getDb()
  return db.all(
    `SELECT * FROM \`material_item\` WHERE \`pack_id\` IN (${packIds.map(() => '?').join(',')}) AND \`enabled\` = 1 ORDER BY \`id\` ASC`,
    packIds,
  )
}
