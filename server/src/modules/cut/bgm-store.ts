import { getDb } from '../../db/index.js'
import { newId, toInt } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import { probeMedia } from '../../media/inspect.js'
import { putObjectFromFile } from '../../integrations/aliyun-oss/client.js'
import { err } from '../../errors.js'
import { config } from '../../config.js'
import type { BgmItem } from './types.js'

/**
 * 轻量 BGM 库（任务书 FR-B3 / EC6 过渡实现，素材库立项后迁移）。
 * 存储键统一 `bgm/` 前缀——`/media/*` 本地回放白名单已扩展放行（§4.2）。
 */

function rowToBgm(r: Record<string, unknown>): BgmItem {
  return {
    id: String(r.id),
    name: String(r.name),
    storageKey: String(r.storage_key),
    durationMs: Number(r.duration_ms ?? 0),
    sizeBytes: Number(r.size_bytes ?? 0),
    enabled: !!Number(r.enabled),
    createdAt: (r.created_at as string) ?? null,
  }
}

export async function getBgm(id: string): Promise<BgmItem | null> {
  const row = await getDb().get('SELECT * FROM `bgm_item` WHERE `id` = ? AND `deleted_at` IS NULL', [id])
  return row ? rowToBgm(row) : null
}

export async function listBgm(): Promise<BgmItem[]> {
  const rows = await getDb().all('SELECT * FROM `bgm_item` WHERE `deleted_at` IS NULL AND `enabled` = 1 ORDER BY `created_at` DESC')
  return rows.map(rowToBgm)
}

export async function createBgm(file: { path: string; originalname?: string }, operator: string): Promise<BgmItem> {
  const probe = await probeMedia(file.path).catch(() => null)
  if (!probe || probe.kind !== 'audio') throw err.badRequest('仅支持音频文件（mp3/m4a/wav）')
  const stat = await import('node:fs/promises').then((m) => m.stat(file.path))
  if (stat.size > config.cut.bgmMaxMb * 1024 * 1024) {
    throw err.badRequest(`BGM 文件不得超过 ${config.cut.bgmMaxMb}MB`)
  }
  const id = newId('bgm')
  const key = `bgm/${id}${/\.[a-z0-9]+$/i.test(file.originalname ?? '') ? '.' + (file.originalname!.split('.').pop() ?? 'mp3') : '.mp3'}`
  const put = await putObjectFromFile(file.path, key)
  const now = toDb(utcNow())
  await getDb().run(
    'INSERT INTO `bgm_item` (`id`, `name`, `storage_key`, `duration_ms`, `size_bytes`, `enabled`, `created_by`, `created_at`) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    [id, (file.originalname ?? 'bgm').slice(0, 120), put.key, toInt(probe.durationMs ?? 0), toInt(stat.size), operator, now],
  )
  return (await getBgm(id))!
}

export async function deleteBgm(id: string): Promise<void> {
  const item = await getBgm(id)
  if (!item) throw err.bgmNotFound()
  const used = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM `video_cut` WHERE `bgm_id` = ?', [id])
  if (Number(used?.n ?? 0) > 0) throw err.bgmInUse(`BGM 已被 ${used!.n} 个成片版本引用`)
  await getDb().run('UPDATE `bgm_item` SET `deleted_at` = ?, `enabled` = 0 WHERE `id` = ?', [toDb(utcNow()), id])
}
