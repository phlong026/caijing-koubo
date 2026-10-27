import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getDb } from '../../db/index.js'
import { config } from '../../config.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { newId } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'

/**
 * 字体域（素材库 ML1，任务书 §3.1 字体生命周期 / §4 数据模型 / FR-F1~F5）。
 *
 * 设计要点：
 *  - 文件仍落 `CUT_FONTS_DIR`（剪辑 fontsdir 直接读目录，渲染链路零改动），`font_item` 只存元数据；
 *  - 上传默认 `enabled=0`（A3 / PRD 7.8：上传→手动启用→进入剪辑字体下拉）；
 *  - `other` 授权必须填出处才能启用（A7：字幕烧录属商用场景）；
 *  - default 字体 = 启用集中文件名排序首个，无启用字体时保持历史行为（目录首个文件）；
 *  - 启动扫描手工放置的存量字体为未启用记录，幂等（FR-F5）。
 */

export const FONT_EXTENSIONS = ['.otf', '.ttf', '.ttc'] as const
export const LICENSE_TYPES = ['ofl', 'commercial', 'other'] as const
export type LicenseType = (typeof LICENSE_TYPES)[number]

export interface FontItem {
  id: string
  fileName: string
  displayName: string
  fileHash: string
  sizeBytes: number
  licenseType: LicenseType
  licenseNote: string | null
  enabled: boolean
  /** 被未归档成片字幕样式显式引用的版本数（FR-F3 守卫依据） */
  inUseCount: number
  createdAt: string | null
  updatedAt: string | null
}

export function fontsDir(): string {
  return path.resolve(config.cut.fontsDir)
}

function isFontFile(name: string): boolean {
  return (FONT_EXTENSIONS as readonly string[]).includes(path.extname(name).toLowerCase())
}

/** 落盘名清洗：去目录 / 路径穿越 / 控制字符，保留中英文与常见符号 */
export function safeFontFileName(input: string): string {
  const base = path.basename(String(input ?? '').replace(/\\/g, '/'))
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').replace(/^\.+/, '')
  if (!cleaned) throw err.fontFormatInvalid('文件名不合法')
  if (!isFontFile(cleaned)) throw err.fontFormatInvalid(`仅支持 ${FONT_EXTENSIONS.join(' / ')} 格式`)
  return cleaned
}

/** 字体容器魔数校验（AC-F1：伪字体必须被拒） */
export function assertFontMagic(head: Buffer): void {
  if (head.length < 4) throw err.fontFormatInvalid('文件过小，不是有效字体')
  const sig = head.subarray(0, 4).toString('latin1')
  const ok = sig === 'OTTO' || sig === 'ttcf' || sig === 'true' || head.readUInt32BE(0) === 0x00010000
  if (!ok) throw err.fontFormatInvalid('文件魔数不符，不是有效的 otf/ttf/ttc 字体')
}

export function fontBaseName(fileName: string): string {
  return path.parse(fileName).name
}

async function fileHashOf(buf: Buffer): Promise<string> {
  return createHash('sha256').update(buf).digest('hex')
}

function mapFont(r: Record<string, unknown>, inUseCount = 0): FontItem {
  const license = String(r.license_type ?? 'other')
  return {
    id: String(r.id),
    fileName: String(r.file_name),
    displayName: String(r.display_name ?? r.file_name),
    fileHash: String(r.file_hash ?? ''),
    sizeBytes: Number(r.size_bytes ?? 0),
    licenseType: (LICENSE_TYPES as readonly string[]).includes(license) ? (license as LicenseType) : 'other',
    licenseNote: (r.license_note as string) ?? null,
    enabled: Number(r.enabled ?? 0) === 1,
    inUseCount,
    createdAt: (r.created_at as string) ?? null,
    updatedAt: (r.updated_at as string) ?? null,
  }
}

/**
 * 成片字幕样式里显式引用各字体的版本数（按 base 名匹配，与 ASS Style 命名口径一致）。
 * 注：`video_cut` 无归档字段（归档语义只在 `copy.archived_at`），故按全部版本计数——
 * 宁可拦住删除，也不让在渲染中的历史版本失去字体文件（FR-F3）。
 */
async function fontUsageCounts(): Promise<Map<string, number>> {
  const rows = await getDb().all<Record<string, unknown>>('SELECT `subtitle_style` FROM `video_cut` WHERE `subtitle_style` IS NOT NULL')
  const counts = new Map<string, number>()
  for (const r of rows) {
    let style: unknown = r.subtitle_style
    try {
      if (typeof style === 'string') style = JSON.parse(style)
    } catch {
      continue
    }
    const name = (style as { fontName?: unknown } | null)?.fontName
    if (typeof name !== 'string' || !name || name === 'default') continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

export async function listFonts(): Promise<FontItem[]> {
  const rows = await getDb().all<Record<string, unknown>>('SELECT * FROM `font_item` ORDER BY `enabled` DESC, `file_name` ASC')
  const usage = await fontUsageCounts()
  return rows.map((r) => mapFont(r, usage.get(fontBaseName(String(r.file_name))) ?? 0))
}

export async function getFont(id: string): Promise<FontItem> {
  const row = await getDb().get<Record<string, unknown>>('SELECT * FROM `font_item` WHERE `id` = ?', [id])
  if (!row) throw err.fontNotFound()
  const usage = await fontUsageCounts()
  return mapFont(row, usage.get(fontBaseName(String(row.file_name))) ?? 0)
}

export interface UploadFontMeta {
  displayName?: string
  licenseType?: string
  licenseNote?: string
}

/**
 * 上传字体（FR-F1）：校验扩展名 / 大小 / 魔数 → 幂等（hash 相同返回既有记录）→ 落盘 + 入库（enabled=0）。
 * `filePath` 为 multipart 落下的临时文件，调用方负责清理。
 */
export async function uploadFont(
  file: { filePath: string; fileName: string; sizeBytes: number },
  meta: UploadFontMeta,
  operator: string,
): Promise<FontItem> {
  const fileName = safeFontFileName(file.fileName)
  const maxBytes = config.cut.fontMaxMb * 1024 * 1024
  if (file.sizeBytes > maxBytes) throw err.fontFormatInvalid(`字体文件不得超过 ${config.cut.fontMaxMb}MB`)

  const buf = await fsp.readFile(file.filePath)
  if (buf.byteLength > maxBytes) throw err.fontFormatInvalid(`字体文件不得超过 ${config.cut.fontMaxMb}MB`)
  assertFontMagic(buf.subarray(0, 4))
  const hash = await fileHashOf(buf)

  const db = getDb()
  const byHash = await db.get<Record<string, unknown>>('SELECT * FROM `font_item` WHERE `file_hash` = ?', [hash])
  if (byHash) return mapFont(byHash) // 幂等：同内容重复上传

  const byName = await db.get<Record<string, unknown>>('SELECT * FROM `font_item` WHERE `file_name` = ?', [fileName])
  if (byName) throw err.conflict(`已存在同名但内容不同的字体：${fileName}，请重命名后再上传`)

  const licenseType = (LICENSE_TYPES as readonly string[]).includes(String(meta.licenseType)) ? (meta.licenseType as LicenseType) : 'other'
  const licenseNote = (meta.licenseNote ?? '').trim() || null
  if (licenseType === 'other' && !licenseNote) {
    // 允许入库（enabled=0），但此时不能启用；提示放在 PATCH 启用时（A7）。此处仅记 warn
    logger.warn({ fileName }, 'material.font.license_missing')
  }

  const dir = fontsDir()
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, fileName), buf)

  const id = newId('font')
  const now = toDb(utcNow())
  await db.run(
    'INSERT INTO `font_item` (`id`, `file_name`, `display_name`, `file_hash`, `size_bytes`, `license_type`, `license_note`, `enabled`, `created_by`, `created_at`, `updated_at`) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
    [id, fileName, (meta.displayName ?? '').trim() || fontBaseName(fileName), hash, buf.byteLength, licenseType, licenseNote, operator, now, now],
  )
  return getFont(id)
}

/** 启用 / 停用 / 元数据编辑（FR-F2）。启用前置校验授权标记（A7）。 */
export async function patchFont(
  id: string,
  patch: { enabled?: boolean; displayName?: string; licenseType?: string; licenseNote?: string | null },
  operator: string,
): Promise<FontItem> {
  const current = await getFont(id)
  const sets: string[] = []
  const params: unknown[] = []

  if (patch.displayName !== undefined) {
    sets.push('`display_name` = ?')
    params.push(String(patch.displayName).trim() || current.displayName)
  }
  if (patch.licenseType !== undefined) {
    if (!(LICENSE_TYPES as readonly string[]).includes(String(patch.licenseType))) throw err.badRequest('licenseType 须为 ofl / commercial / other')
    sets.push('`license_type` = ?')
    params.push(patch.licenseType)
  }
  if (patch.licenseNote !== undefined) {
    sets.push('`license_note` = ?')
    params.push((patch.licenseNote ?? '').trim() || null)
  }

  const nextLicense = patch.licenseType !== undefined ? String(patch.licenseType) : current.licenseType
  const nextNote = patch.licenseNote !== undefined ? (patch.licenseNote ?? '').trim() : (current.licenseNote ?? '')
  if (patch.enabled === true) {
    if (nextLicense === 'other' && !nextNote) throw err.fontLicenseRequired()
    const dir = fontsDir()
    const exists = await fsp.access(path.join(dir, current.fileName)).then(
      () => true,
      () => false,
    )
    if (!exists) throw err.fontNotFound(`字体文件已从 ${dir} 丢失，请重新上传`)
    sets.push('`enabled` = 1')
  } else if (patch.enabled === false) {
    sets.push('`enabled` = 0')
  }

  if (sets.length) {
    sets.push('`updated_at` = ?')
    params.push(toDb(utcNow()))
    await getDb().run(`UPDATE \`font_item\` SET ${sets.join(', ')} WHERE \`id\` = ?`, [...params, id])
    void operator
  }
  return getFont(id)
}

/** 删除（FR-F3）：被成片引用 409；否则删库记录 + 目录文件 */
export async function deleteFont(id: string): Promise<void> {
  const font = await getFont(id)
  if (font.inUseCount > 0) throw err.fontInUse(`字体 ${font.displayName} 已被 ${font.inUseCount} 个成片版本引用`)
  await getDb().run('DELETE FROM `font_item` WHERE `id` = ?', [id])
  await fsp.rm(path.join(fontsDir(), font.fileName), { force: true })
}

/** 启用集文件名（排序后），剪辑下拉与校验共用 */
export async function enabledFontFileNames(): Promise<string[]> {
  const rows = await getDb().all<Record<string, unknown>>('SELECT `file_name` FROM `font_item` WHERE `enabled` = 1 ORDER BY `file_name` ASC')
  return rows.map((r) => String(r.file_name))
}

/** 启用集（含 displayName），前端下拉用 */
export async function enabledFonts(): Promise<{ id: string; fileName: string; displayName: string; licenseType: string }[]> {
  const rows = await getDb().all<Record<string, unknown>>(
    'SELECT `id`, `file_name`, `display_name`, `license_type` FROM `font_item` WHERE `enabled` = 1 ORDER BY `file_name` ASC',
  )
  return rows.map((r) => ({
    id: String(r.id),
    fileName: String(r.file_name),
    displayName: String(r.display_name ?? r.file_name),
    licenseType: String(r.license_type ?? 'other'),
  }))
}

/**
 * default 字体文件（FR-F4）：启用集中文件名排序首个；无启用字体时保持历史行为（目录首个）。
 */
export async function resolveDefaultFontFile(): Promise<string | null> {
  const dir = fontsDir()
  const enabled = await enabledFontFileNames().catch(() => [] as string[])
  for (const name of enabled) {
    const full = path.join(dir, name)
    if (await fsp.access(full).then(() => true, () => false)) return full
  }
  try {
    const files = (await fsp.readdir(dir)).filter(isFontFile).sort()
    return files.length ? path.join(dir, files[0]!) : null
  } catch {
    return null
  }
}

/** 按字体名（= 文件 base 名）解析成字体文件（ML4：字幕样式 fontName → 渲染文件） */
export async function resolveFontFileByName(name: string | null | undefined): Promise<string | null> {
  if (!name || name === 'default') return resolveDefaultFontFile()
  const enabled = await enabledFontFileNames()
  const hit = enabled.find((f) => fontBaseName(f) === name)
  if (!hit) return null
  const full = path.join(fontsDir(), hit)
  return (await fsp.access(full).then(() => true, () => false)) ? full : null
}

/** 草稿保存校验（FR-F4）：fontName ∈ 启用集 ∪ {default}；越界由剪辑侧抛 CUT_STYLE_INVALID */
export async function isFontNameAllowed(name: string): Promise<boolean> {
  if (!name || name === 'default') return true
  const enabled = await enabledFontFileNames()
  return enabled.some((f) => fontBaseName(f) === name)
}

/**
 * 启动扫描（FR-F5）：手工放置的字体同步为未启用记录；文件被替换按 hash 对账；文件已删则清脏记录。
 * 幂等——每次启动都可安全执行。
 */
export async function bootstrapFonts(): Promise<{ added: number; updated: number; removed: number }> {
  const dir = fontsDir()
  await fsp.mkdir(dir, { recursive: true })
  const files = (await fsp.readdir(dir).catch(() => [] as string[])).filter(isFontFile).sort()
  const db = getDb()
  const rows = await db.all<Record<string, unknown>>('SELECT * FROM `font_item`')
  const byName = new Map(rows.map((r) => [String(r.file_name), r]))
  const now = toDb(utcNow())
  let added = 0
  let updated = 0
  let removed = 0

  for (const fileName of files) {
    const full = path.join(dir, fileName)
    const buf = await fsp.readFile(full).catch(() => null)
    if (!buf) continue
    const hash = await fileHashOf(buf)
    const row = byName.get(fileName)
    if (!row) {
      await db.run(
        'INSERT INTO `font_item` (`id`, `file_name`, `display_name`, `file_hash`, `size_bytes`, `license_type`, `license_note`, `enabled`, `created_by`, `created_at`, `updated_at`) ' +
          'VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)',
        [newId('font'), fileName, fontBaseName(fileName), hash, buf.byteLength, 'other', 'bootstrap', now, now],
      )
      added += 1
    } else if (String(row.file_hash ?? '') !== hash) {
      // 手工替换了同名字体文件：更新 hash / 体积，保持现有启用状态（避免静默改变可用字体集）
      await db.run('UPDATE `font_item` SET `file_hash` = ?, `size_bytes` = ?, `updated_at` = ? WHERE `id` = ?', [
        hash,
        buf.byteLength,
        now,
        String(row.id),
      ])
      logger.warn({ fileName }, 'material.font.file_changed_out_of_band')
      updated += 1
    }
  }

  const present = new Set(files)
  for (const row of rows) {
    const fileName = String(row.file_name)
    if (present.has(fileName)) continue
    await db.run('DELETE FROM `font_item` WHERE `id` = ?', [String(row.id)])
    logger.warn({ fileName }, 'material.font.record_removed_file_missing')
    removed += 1
  }

  if (added || updated || removed) logger.info({ added, updated, removed, dir }, 'material.font.bootstrap_done')
  return { added, updated, removed }
}
