import { getDb } from '../../db/index.js'
import { newId, parsePaging, pageResult, type PageResult } from '../../lib/util.js'
import { toDb, utcNow, fromDb } from '../../lib/time.js'
import { err } from '../../errors.js'
import { recordOperation } from '../audit/repo.js'
import { requireAccount } from './accounts.js'
import { mapLog } from './records-mapper.js'
import type { Platform, PublishLog, PublishLogView } from './types.js'

/**
 * 发布记录查询与手动补录（FR-S5 / PB14）。
 */

export interface ListLogFilters {
  planId?: string
  platform?: string
  status?: string
  accountId?: string
  page?: number
  pageSize?: number
}

export async function listLogs(f: ListLogFilters): Promise<PageResult<PublishLogView>> {
  const db = getDb()
  const where: string[] = ['1=1']
  const params: unknown[] = []
  if (f.planId) {
    where.push('`l`.`plan_id` = ?')
    params.push(f.planId)
  }
  if (f.platform) {
    where.push('`l`.`platform` = ?')
    params.push(f.platform)
  }
  if (f.status) {
    where.push('`l`.`status` = ?')
    params.push(f.status)
  }
  if (f.accountId) {
    where.push('`l`.`account_id` = ?')
    params.push(f.accountId)
  }
  const whereSql = `WHERE ${where.join(' AND ')}`
  const p = parsePaging({ page: f.page, pageSize: f.pageSize }, 20, 100)
  const total = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM \`publish_log\` \`l\` ${whereSql}`, params)
  const rows = await db.all<Record<string, any>>(
    'SELECT `l`.*, `a`.`display_name` AS `account_name`, `p`.`title` AS `plan_title` FROM `publish_log` `l` ' +
      'LEFT JOIN `platform_account` `a` ON `a`.`id` = `l`.`account_id` ' +
      'LEFT JOIN `publish_plan` `p` ON `p`.`id` = `l`.`plan_id` ' +
      `${whereSql} ORDER BY \`l\`.\`created_at\` DESC LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  )
  return pageResult(rows.map((r) => ({ ...mapLog(r), accountName: r.account_name ?? null, planTitle: r.plan_title ?? null })), Number(total?.n ?? 0), p)
}

export interface ManualLogInput {
  platform: Platform
  accountId: string
  title: string
  videoUrl: string | null
  externalVideoId: string | null
}

/** 手动补录：source=manual、attempt=0、直接 published（不参与自动重试与每日额度） */
export async function createManualLog(input: ManualLogInput, operator: string): Promise<PublishLog> {
  const account = await requireAccount(input.accountId)
  if (account.platform !== input.platform) throw err.badRequest('账号与平台不匹配')
  if (!input.title.trim()) throw err.badRequest('标题不能为空')
  const db = getDb()
  const id = newId('plog')
  const now = toDb(utcNow())
  await db.run(
    'INSERT INTO `publish_log` (`id`, `plan_id`, `platform`, `account_id`, `source`, `status`, `attempt`, `title`, `video_url`, `external_video_id`, `finished_at`, `created_at`, `updated_at`) VALUES (?, NULL, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
    [id, input.platform, input.accountId, 'manual', 'published', input.title.slice(0, 255), input.videoUrl, input.externalVideoId, now, now, now],
  )
  await recordOperation({
    operator,
    action: 'publish.log.manual_record',
    targetType: 'publish_log',
    targetId: id,
    detail: { platform: input.platform, accountId: input.accountId, title: input.title },
  })
  const row = await db.get<Record<string, any>>('SELECT * FROM `publish_log` WHERE `id` = ?', [id])
  return mapLog(row!)
}
