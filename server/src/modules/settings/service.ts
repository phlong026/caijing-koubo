/**
 * 系统设置读写（用户中心 → 系统设置）。
 *
 * 值以「环境变量等价的字符串」存 app_setting，语义与 .env 完全一致；
 * 保存成功后同步热写入 config 对象，所有读 config 的代码立即拿到新值
 * （连接类 / 调度类字段见 catalog 的 restart / readonly 标记）。
 * 优先级：app_setting（界面保存）> .env > 代码默认值。
 */
import { upsert, type Db } from '../../db/index.js'
import { config } from '../../config.js'
import { logger } from '../../log.js'
import { toDb, utcNow } from '../../lib/time.js'
import { SETTING_DEFS, SETTING_GROUPS, SETTING_BY_KEY, type SettingDef } from './catalog.js'
import { err } from '../../errors.js'

export interface SettingItem {
  key: string
  group: string
  label: string
  desc?: string
  type: SettingDef['type']
  /** 当前生效值；password 为脱敏回显（••••） */
  value: string
  /** 当前值非空（密钥已配置） */
  hasValue: boolean
  /** 界面保存过、覆盖 .env 的项 */
  isSet: boolean
  restart?: boolean
  readonly?: boolean
}

export interface SettingsDoc {
  groups: typeof SETTING_GROUPS
  items: SettingItem[]
}

/** 密钥脱敏：保留首尾各 4 位；太短时全遮 */
export function maskSecret(v: string): string {
  const s = String(v ?? '')
  if (!s) return ''
  return s.length > 12 ? `${s.slice(0, 4)}••••${s.slice(-4)}` : '••••••••'
}

/** .env 等价字符串 → config 字段类型 */
export function coerceValue(def: SettingDef, raw: string): string | number | boolean {
  if (def.type === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw err.badRequest(`「${def.label}」需要数字，收到：${raw}`)
    return n
  }
  if (def.type === 'boolean') {
    if (/^(true|false)$/i.test(raw.trim())) return raw.trim().toLowerCase() === 'true'
    throw err.badRequest(`「${def.label}」需要 true/false，收到：${raw}`)
  }
  return raw
}

function getPath(root: unknown, path: (string | number)[]): unknown {
  let cur: any = root
  for (const p of path) {
    if (cur == null) return undefined
    cur = cur[p as any]
  }
  return cur
}

function setPath(root: unknown, path: (string | number)[], value: unknown): void {
  let cur: any = root
  for (let i = 0; i < path.length - 1; i++) {
    if (cur?.[path[i] as any] == null) return
    cur = cur[path[i] as any]
  }
  cur[path[path.length - 1] as any] = value
}

function currentRaw(def: SettingDef): string {
  const v = getPath(config, def.path)
  if (v == null) return ''
  if (def.type === 'boolean') return String(!!v)
  return String(v)
}

async function loadOverrides(db: Db): Promise<Map<string, string>> {
  const rows = await db.all<{ k: string; v: string | null }>('SELECT `k`, `v` FROM `app_setting`')
  return new Map(rows.map((r) => [r.k, r.v ?? '']))
}

export async function listSettings(db: Db): Promise<SettingsDoc> {
  const overrides = await loadOverrides(db)
  const items: SettingItem[] = SETTING_DEFS.map((def) => {
    const raw = currentRaw(def)
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      desc: def.desc,
      type: def.type,
      value: def.type === 'password' ? maskSecret(raw) : raw,
      hasValue: !!raw,
      isSet: overrides.has(def.key),
      restart: def.restart,
      readonly: def.readonly,
    }
  })
  return { groups: SETTING_GROUPS, items }
}

export interface SaveEntry {
  key: string
  value: string
}

/**
 * 保存设置：白名单校验 → 写库 → 热写 config。
 * password 项提交值等于脱敏回显（含 ••）时视为未修改，跳过，避免把掩码存成密钥。
 */
export async function saveSettings(
  db: Db,
  entries: SaveEntry[],
  operator: string,
): Promise<{ applied: string[]; skipped: string[] }> {
  if (!Array.isArray(entries) || !entries.length) throw err.badRequest('缺少 settings 数组')
  const overrides = await loadOverrides(db)
  const applied: string[] = []
  const skipped: string[] = []
  const now = toDb(utcNow())

  for (const e of entries) {
    const def = SETTING_BY_KEY.get(String(e?.key ?? ''))
    if (!def) throw err.badRequest(`未知配置项：${e?.key}（不在可编辑清单内）`)
    if (def.readonly) throw err.badRequest(`「${def.label}」（${def.key}）属于部署配置，请在 .env 修改后重启服务`)
    const raw = String(e.value ?? '').trim()

    if (def.type === 'password' && (raw.includes('••') || raw === maskSecret(currentRaw(def)))) {
      skipped.push(def.key)
      continue
    }

    const typed = coerceValue(def, raw)
    // 存 .env 等价字符串，与启动加载的解析口径一致
    const stored = def.type === 'boolean' ? String(typed) : String(raw)
    if (overrides.get(def.key) === stored) {
      skipped.push(def.key)
      continue
    }
    await upsert(db, {
      table: 'app_setting',
      row: { k: def.key, v: stored, updated_by: operator, updated_at: now },
      uniqueCols: ['k'],
      updateCols: ['v', 'updated_by', 'updated_at'],
    })
    setPath(config, def.path, typed)
    applied.push(def.key)
  }

  if (applied.length) {
    logger.info({ operator, keys: applied }, 'settings.updated')
  }
  return { applied, skipped }
}

/** 启动时把界面保存过的设置应用到 config（在 initDb 之后、一切消费方之前调用） */
export async function loadStartupSettings(db: Db): Promise<void> {
  try {
    const overrides = await loadOverrides(db)
    let n = 0
    for (const def of SETTING_DEFS) {
      const raw = overrides.get(def.key)
      if (raw === undefined || def.readonly) continue
      try {
        setPath(config, def.path, coerceValue(def, raw))
        n++
      } catch {
        logger.warn({ key: def.key, raw: raw.slice(0, 20) }, 'settings.startup_skip_invalid')
      }
    }
    if (n) logger.info({ count: n }, 'settings.applied_from_db')
  } catch (e) {
    // 设置表不可用不应阻断启动：按 .env 原值继续
    logger.warn({ err: (e as Error).message }, 'settings.load_failed')
  }
}
