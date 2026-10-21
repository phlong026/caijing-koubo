import { getDb, isDuplicateKey } from '../../db/index.js'
import { newId } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { recordOperation } from '../../modules/audit/repo.js'
import { getPersonaById } from './repo.js'
import { LINE_RULES, PLATFORM_LABELS, type Platform } from './types.js'

/**
 * 账号绑定（L11 / FR-U5）。
 * 规则：经理一对一 ≤1，且同一账号只能绑 1 个经理人物；KOS 共享 ≤5；KOS 一对一、素人 ≤1。
 * 一期只存「平台 + 账号标识 + 显示名」，M4 落地后迁 platform_account 外键。
 * 约束口径：同一平台账号同时只能有一个活跃绑定（unique active_key）；
 * 经理线的「一号一人物」额外在代码中显式校验并给出可读原因。
 */

export interface AccountBinding {
  id: string
  personaId: string
  platform: Platform
  accountKey: string
  displayName: string
  createdBy: string | null
  createdAt: string | null
  releasedAt: string | null
}

function mapRow(r: Record<string, any>): AccountBinding {
  return {
    id: r.id,
    personaId: r.persona_id,
    platform: r.platform,
    accountKey: r.account_key,
    displayName: r.display_name,
    createdBy: r.created_by ?? null,
    createdAt: fromDb(r.created_at),
    releasedAt: fromDb(r.released_at),
  }
}

const PLATFORMS: Platform[] = ['douyin', 'xiaohongshu', 'kuaishou', 'shipinhao']

export async function listBindings(personaId: string): Promise<AccountBinding[]> {
  const db = getDb()
  const rows = await db.all<Record<string, any>>(
    'SELECT * FROM `persona_account_binding` WHERE `persona_id` = ? AND `released_at` IS NULL ORDER BY `created_at` ASC',
    [personaId],
  )
  return rows.map(mapRow)
}

export interface AccountInput {
  platform: Platform
  accountKey: string
  displayName: string
}

/** 全量替换绑定（PUT 语义：传空数组 = 全部解绑） */
export async function setBindings(personaId: string, accounts: AccountInput[], operator: string): Promise<AccountBinding[]> {
  const db = getDb()
  const persona = await getPersonaById(personaId, true)
  if (!persona) throw err.personaNotFound()
  if (persona.archivedAt) throw err.personaArchived()
  const rule = LINE_RULES[persona.line]

  // 归一化与校验
  const cleaned: AccountInput[] = []
  const seen = new Set<string>()
  for (const a of accounts ?? []) {
    const platform = a.platform
    if (!PLATFORMS.includes(platform)) {
      throw err.badRequest(`不支持的平台：${platform}`, { allowed: PLATFORMS })
    }
    const accountKey = String(a.accountKey ?? '').trim()
    const displayName = String(a.displayName ?? '').trim() || accountKey
    if (!accountKey) throw err.badRequest('账号标识不能为空')
    if (accountKey.length > 128) throw err.badRequest('账号标识过长')
    if (displayName.length > 60) throw err.badRequest('显示名不能超过 60 字')
    const key = `${platform}:${accountKey}`
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push({ platform, accountKey, displayName })
  }

  // 数量上限（按绑定方式）
  const limit = persona.bindingMode === 'shared' ? rule.accountLimit : 1
  if (cleaned.length > limit) {
    throw err.bindingRule(
      `${rule.label}${persona.bindingMode === 'shared' ? '共享' : '一对一'}人物最多绑定 ${limit} 个账号`,
      { line: persona.line, bindingMode: persona.bindingMode, limit, received: cleaned.length },
    )
  }

  const current = await listBindings(personaId)
  const now = toDb(utcNow())

  await db.tx(async (tx) => {
    // 1) 先释放不在新集合中的绑定
    for (const b of current) {
      const still = cleaned.find((c) => c.platform === b.platform && c.accountKey === b.accountKey)
      if (!still) {
        await tx.run(
          'UPDATE `persona_account_binding` SET `released_at` = ?, `active_key` = NULL WHERE `id` = ?',
          [now, b.id],
        )
      }
    }
    // 2) 新增
    for (const c of cleaned) {
      const exists = current.find((b) => b.platform === c.platform && b.accountKey === c.accountKey)
      if (exists) continue
      // 经理线：同一账号不能绑第 2 个经理人物（FR-U5）
      if (persona.line === 'manager') {
        const clash = await tx.get<{ persona_id: string }>(
          `SELECT \`persona_id\` FROM \`persona_account_binding\`
           WHERE \`active_key\` = ? AND \`persona_id\` != ? AND \`released_at\` IS NULL LIMIT 1`,
          [`${c.platform}:${c.accountKey}`, personaId],
        )
        if (clash) {
          const other = await getPersonaById(clash.persona_id, true)
          throw err.bindingRule(
            `该${PLATFORM_LABELS[c.platform]}账号已绑定经理人物「${other?.name ?? clash.persona_id}」，同一账号只能绑定一位经理人物`,
            { platform: c.platform, accountKey: c.accountKey, boundPersonaId: clash.persona_id },
          )
        }
      }
      const id = newId('bind')
      try {
        await tx.run(
          `INSERT INTO \`persona_account_binding\`
            (\`id\`, \`persona_id\`, \`platform\`, \`account_key\`, \`display_name\`, \`created_by\`, \`created_at\`, \`active_key\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, personaId, c.platform, c.accountKey, c.displayName, operator, now, `${c.platform}:${c.accountKey}`],
        )
      } catch (e) {
        // 同一平台账号已有活跃绑定（唯一键 active_key）→ 可读的规则错误
        if (isDuplicateKey(e)) {
          throw err.bindingRule(
            `该${PLATFORM_LABELS[c.platform]}账号已绑定其他人物，同一账号同时只能绑定一个活跃人物`,
            { platform: c.platform, accountKey: c.accountKey },
          )
        }
        throw e
      }
    }
  })

  await recordOperation({
    operator,
    action: 'persona.account_binding_update',
    targetType: 'persona',
    targetId: personaId,
    detail: { accounts: cleaned.map((c) => `${c.platform}:${c.accountKey}`) },
  })
  return listBindings(personaId)
}
