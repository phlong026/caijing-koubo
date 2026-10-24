import type { Db } from './index.js'
import { logger } from '../log.js'

/**
 * 发布管理：存量人物绑定回填 platform_account_id（任务书 008 / AC-0.2）。
 *
 * PU0 盘点结论：`persona_account_binding.account_key` 是自由短标识（如 `douyin_wanglicai`），
 * 不是主页链接，可与 `platform_account.uid` 精确匹配。
 *
 * 回填规则：活跃绑定（released_at IS NULL 且 platform_account_id IS NULL）按
 * `platform + account_key = platform.uid` 匹配；匹配上回填外键，匹配不上保留
 * account_key 降级读取（不报错、不造账号——账号由运营在发布管理创建并扫码确认后才有 uid）。
 * 同键多条绑定（KOS 共享 ≤5 人物）都指向同一条账号记录，无需去重。
 */
export async function migratePublishAccounts(db: Db): Promise<void> {
  const rows = await db.all<{ id: string; platform: string; account_key: string }>(
    "SELECT `b`.`id`, `b`.`platform`, `b`.`account_key` FROM `persona_account_binding` `b` " +
      'LEFT JOIN `platform_account` `a` ON `a`.`platform` = `b`.`platform` AND `a`.`uid` = `b`.`account_key` AND `a`.`deleted_at` IS NULL ' +
      "WHERE `b`.`released_at` IS NULL AND `b`.`platform_account_id` IS NULL AND `a`.`id` IS NOT NULL",
  )
  let filled = 0
  for (const r of rows) {
    const account = await db.get<{ id: string }>(
      'SELECT `id` FROM `platform_account` WHERE `platform` = ? AND `uid` = ? AND `deleted_at` IS NULL LIMIT 1',
      [r.platform, r.account_key],
    )
    if (!account) continue
    await db.run('UPDATE `persona_account_binding` SET `platform_account_id` = ? WHERE `id` = ?', [account.id, r.id])
    filled += 1
  }
  logger.info({ filled }, 'db.migration.publish_account_backfill')
}
