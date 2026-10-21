import { getDb, type Db } from '../../db/index.js'
import { jdec, likeContains, newId, uniq } from '../../lib/util.js'
import { fromDb, toDb, utcNow } from '../../lib/time.js'
import { err } from '../../errors.js'
import { isDuplicateKey } from '../../db/index.js'
import { deriveStatus, isAuthorizationValid, normalizeNameKey, type DerivedStatus } from './policy.js'
import { normalizeProfileInput, profileHash, profileToDb } from './profile.js'
import { LINE_RULES, type AuthorizationScope, type PersonaLine, type BindingMode } from './types.js'

/** 对外统一 camelCase（前端 Persona.ipProfile 契约，A3：只增不改） */
export interface IpProfile {
  role: string
  serviceScope: string
  targetAudience: string
  expressionStyle: string
  forbiddenClaims: string[]
  /** 文案工坊可选扩展（§4.3）：受众需求，用于提示词人物档案块 */
  audienceNeeds?: string
  /** 文案工坊可选扩展：事实背景（仅按相关性引用，不得扩写为个人经历） */
  factualBackground?: string
  /** 文案工坊可选扩展：代表口播样稿（只学句式语气） */
  sampleScript?: string
  /** 人物库新增（FR-I1）：内容方向 */
  contentDirections?: string[]
  /** 人物库新增（FR-I1）：内容配比 */
  contentMix?: Array<{ label: string; ratio?: number }>
}

export interface Persona {
  id: string
  name: string
  line: PersonaLine
  enabled: boolean
  ipProfile: IpProfile
  isStub: boolean
  createdAt: string | null
  updatedAt: string | null
  // ── 人物库扩展（FR-X1：只增字段）──
  ownerSubject: string | null
  description: string | null
  bindingMode: BindingMode
  coverAssetId: string | null
  defaultAvatarId: string | null
  defaultVoiceId: string | null
  profileRevision: number
  rev: number
  currentVersionId: string | null
  archivedAt: string | null
  createdBy: string | null
  updatedBy: string | null
}

const EMPTY_PROFILE: IpProfile = {
  role: '',
  serviceScope: '',
  targetAudience: '',
  expressionStyle: '',
  forbiddenClaims: [],
}

/** 库内存的是 snake_case，对外统一转 camelCase；两种写法都兼容读取 */
export function readProfile(raw: unknown): IpProfile {
  const ip = (raw ?? {}) as Record<string, any>
  const pick = (a: string, b: string) => {
    const v = ip[a] ?? ip[b]
    return v === undefined || v === null ? undefined : String(v)
  }
  const directions = ip.contentDirections ?? ip.content_directions
  const mix = ip.contentMix ?? ip.content_mix
  return {
    role: String(ip.role ?? ''),
    serviceScope: String(ip.serviceScope ?? ip.service_scope ?? ''),
    targetAudience: String(ip.targetAudience ?? ip.target_audience ?? ''),
    expressionStyle: String(ip.expressionStyle ?? ip.expression_style ?? ''),
    forbiddenClaims: Array.isArray(ip.forbiddenClaims ?? ip.forbidden_claims)
      ? (ip.forbiddenClaims ?? ip.forbidden_claims).map(String)
      : [],
    // §4.3 文案工坊可选扩展：与上面的基础字段走同一套读取，避免两处口径不一致
    audienceNeeds: pick('audienceNeeds', 'audience_needs'),
    factualBackground: pick('factualBackground', 'factual_background'),
    sampleScript: pick('sampleScript', 'sample_script'),
    // 人物库新增：缺省为空数组，不污染存量读取
    contentDirections: Array.isArray(directions) ? directions.map(String) : [],
    contentMix: Array.isArray(mix)
      ? mix.map((x: any) => ({
          label: String(x?.label ?? ''),
          ...(x?.ratio !== undefined && x?.ratio !== null ? { ratio: Number(x.ratio) } : {}),
        }))
      : [],
  }
}

export function mapRow(r: Record<string, any>): Persona {
  return {
    id: r.id,
    name: r.name,
    line: r.line,
    enabled: !!r.enabled,
    ipProfile: readProfile(jdec<unknown>(r.ip_profile, null)),
    isStub: !!r.is_stub,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
    ownerSubject: r.owner_subject ?? null,
    description: r.description ?? null,
    bindingMode: (r.binding_mode as BindingMode) ?? 'exclusive',
    coverAssetId: r.cover_asset_id ?? null,
    defaultAvatarId: r.default_avatar_id ?? null,
    defaultVoiceId: r.default_voice_id ?? null,
    profileRevision: Number(r.profile_revision ?? 0),
    rev: Number(r.rev ?? 0),
    currentVersionId: r.current_version_id ?? null,
    archivedAt: fromDb(r.archived_at),
    createdBy: r.created_by ?? null,
    updatedBy: r.updated_by ?? null,
  }
}

const SELECT = 'SELECT * FROM `persona`'

export interface PersonaFilter {
  line?: PersonaLine
  keyword?: string
  /** 状态筛选：usable / incomplete / disabled / archived（FR-L1） */
  status?: 'usable' | 'incomplete' | 'disabled' | 'archived'
  includeDisabled?: boolean
  includeArchived?: boolean
}

/**
 * 列表（FR-L1 / FR-X1）。
 * 默认只返回未归档且 enabled=1（usable 语义由调用方按 statusReasons 再过滤）；
 * includeDisabled=1 返回全部未归档；includeArchived=1 含归档。
 * 按更新时间倒序；≤500 人一次返回，不分页。
 */
export async function listPersonas(f: PersonaFilter = {}): Promise<Persona[]> {
  const db = getDb()
  const where: string[] = []
  const params: unknown[] = []
  if (!f.includeArchived) where.push('`archived_at` IS NULL')
  if (!f.includeDisabled) where.push('`enabled` = 1')
  if (f.line) {
    where.push('`line` = ?')
    params.push(f.line)
  }
  if (f.keyword) {
    // 包含匹配，转义 % _（lib/util.likeContains + ESCAPE '!'）
    where.push('`name` LIKE ? ESCAPE \'!\'')
    params.push(likeContains(f.keyword))
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = await db.all<Record<string, any>>(
    `${SELECT} ${whereSql} ORDER BY ` +
      (db.kind === 'mysql' ? 'COALESCE(`updated_at`, `created_at`)' : 'COALESCE(`updated_at`, `created_at`)') +
      ' DESC, `id` ASC LIMIT 500',
    params,
  )
  return rows.map(mapRow)
}

/** 单个人物（includeDisabled=true 时含已停用 / 已归档，供提交硬项判定） */
export async function getPersonaById(id: string, includeDisabled = false): Promise<Persona | null> {
  const row = await getDb().get<Record<string, any>>(`${SELECT} WHERE \`id\` = ?`, [id])
  if (!row) return null
  if (!includeDisabled && (!row.enabled || row.archived_at)) return null
  return mapRow(row)
}

export async function getPersonasByIds(ids: string[], db = getDb()): Promise<Persona[]> {
  if (!ids.length) return []
  const ph = ids.map(() => '?').join(', ')
  const rows = await db.all<Record<string, any>>(`${SELECT} WHERE \`id\` IN (${ph}) ORDER BY \`line\`, \`name\``, ids)
  return rows.map(mapRow)
}

/* ── 写操作 ─────────────────────────────────────────────────────── */

export interface CreatePersonaInput {
  name: string
  line: PersonaLine
  ownerSubject?: string
  description?: string
  bindingMode?: BindingMode
  ipProfile?: unknown
  operator: string
}

/** 新建人物（FR-L2）：重名拦截、线规则绑定方式、状态「待完善」 */
export async function createPersona(input: CreatePersonaInput): Promise<Persona> {
  const db = getDb()
  const name = String(input.name ?? '').trim()
  if (!name) throw err.badRequest('人物名称必填')
  if (name.length > 40) throw err.badRequest('人物名称不能超过 40 字', { length: name.length })
  const line = input.line
  if (!LINE_RULES[line]) throw err.badRequest(`不支持的生产线：${line}`, { allowed: Object.keys(LINE_RULES) })
  const rule = LINE_RULES[line]
  const bindingMode: BindingMode = input.bindingMode && rule.bindingModes.includes(input.bindingMode)
    ? input.bindingMode
    : rule.defaultBindingMode
  const ownerSubject = String(input.ownerSubject ?? '').trim() || name
  if (ownerSubject.length > 60) throw err.badRequest('归属主体不能超过 60 字')
  const description = String(input.description ?? '').trim().slice(0, 120) || null

  const now = toDb(utcNow())
  const id = newId('ps')
  const profile = input.ipProfile !== undefined ? normalizeProfileInput(input.ipProfile) : { ...EMPTY_PROFILE }
  try {
    await db.run(
      `INSERT INTO \`persona\`
        (\`id\`, \`name\`, \`line\`, \`enabled\`, \`ip_profile\`, \`is_stub\`, \`created_at\`, \`updated_at\`,
         \`owner_subject\`, \`description\`, \`binding_mode\`, \`profile_revision\`, \`rev\`,
         \`active_name_key\`, \`created_by\`, \`updated_by\`)
       VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      [
        id,
        name,
        line,
        JSON.stringify(profileToDb(profile)),
        now,
        now,
        ownerSubject,
        description,
        bindingMode,
        normalizeNameKey(name),
        input.operator,
        input.operator,
      ],
    )
  } catch (e) {
    if (isDuplicateKey(e)) {
      const existing = await db.get<{ id: string; name: string }>(
        'SELECT `id`, `name` FROM `persona` WHERE `active_name_key` = ?',
        [normalizeNameKey(name)],
      )
      throw err.personaNameDuplicate(`已存在同名人物「${existing?.name ?? name}」，请更换名称`, {
        name,
        existingId: existing?.id ?? null,
        existingName: existing?.name ?? null,
      })
    }
    throw e
  }
  return (await getPersonaById(id, true))!
}

export interface UpdatePersonaInput {
  name?: string
  ownerSubject?: string
  description?: string
  bindingMode?: BindingMode
  /** 仅用于拒绝改线：与当前不一致即 400（生产线创建后不可改） */
  line?: string
  rev: number
  operator: string
}

/** 编辑基本信息（FR-L3）：生产线不可改；rev 乐观锁 */
export async function updatePersona(id: string, input: UpdatePersonaInput): Promise<Persona> {
  const db = getDb()
  const current = await getPersonaById(id, true)
  if (!current) throw err.personaNotFound()
  if (current.archivedAt) throw err.personaArchived()
  if (Number(input.rev) !== current.rev) {
    throw err.personaConflict('该人物已在其他页面修改，请载入最新数据后重试', {
      expectedRev: current.rev,
      providedRev: Number(input.rev),
    })
  }
  if (input.line !== undefined && input.line !== current.line) {
    throw err.badRequest('生产线创建后不可修改，如需换线请新建人物', { line: current.line, requested: input.line })
  }
  const sets: string[] = []
  const params: unknown[] = []
  if (input.name !== undefined) {
    const name = String(input.name).trim()
    if (!name) throw err.badRequest('人物名称必填')
    if (name.length > 40) throw err.badRequest('人物名称不能超过 40 字')
    sets.push('`name` = ?', '`active_name_key` = ?')
    params.push(name, normalizeNameKey(name))
  }
  if (input.ownerSubject !== undefined) {
    const v = String(input.ownerSubject).trim() || current.name
    if (v.length > 60) throw err.badRequest('归属主体不能超过 60 字')
    sets.push('`owner_subject` = ?')
    params.push(v)
  }
  if (input.description !== undefined) {
    sets.push('`description` = ?')
    params.push(String(input.description).trim().slice(0, 120) || null)
  }
  if (input.bindingMode !== undefined) {
    const rule = LINE_RULES[current.line]
    if (!rule.bindingModes.includes(input.bindingMode)) {
      throw err.badRequest(`${rule.label}生产线不支持「${input.bindingMode === 'shared' ? '共享' : '一对一'}」绑定方式`, {
        line: current.line,
        allowed: rule.bindingModes,
      })
    }
    sets.push('`binding_mode` = ?')
    params.push(input.bindingMode)
  }
  if (!sets.length) return current
  sets.push('`rev` = `rev` + 1', '`updated_at` = ?', '`updated_by` = ?')
  params.push(toDb(utcNow()), input.operator, id, current.rev)
  try {
    const r = await db.run(
      `UPDATE \`persona\` SET ${sets.join(', ')} WHERE \`id\` = ? AND \`rev\` = ?`,
      params,
    )
    if (!r.affectedRows) throw err.personaConflict()
  } catch (e) {
    if (isDuplicateKey(e)) {
      const existing = input.name
        ? await db.get<{ id: string; name: string }>('SELECT `id`, `name` FROM `persona` WHERE `active_name_key` = ?', [normalizeNameKey(String(input.name))])
        : null
      throw err.personaNameDuplicate(`已存在同名人物${existing ? `「${existing.name}」` : ''}，请更换名称`, {
        name: input.name,
        existingId: existing?.id ?? null,
        existingName: existing?.name ?? null,
      })
    }
    throw e
  }
  return (await getPersonaById(id, true))!
}

/** 保存 IP 定位（FR-I5）：hash 未变不升 revision；变化则 revision+1 并由调用方产生版本 */
export async function saveProfile(
  id: string,
  rawProfile: unknown,
  rev: number | undefined,
  operator: string,
): Promise<{ persona: Persona; changed: boolean; hash: string }> {
  const db = getDb()
  const current = await getPersonaById(id, true)
  if (!current) throw err.personaNotFound()
  if (current.archivedAt) throw err.personaArchived()
  if (rev !== undefined && Number(rev) !== current.rev) {
    throw err.personaConflict('该人物已在其他页面修改，请载入最新数据后重试', {
      expectedRev: current.rev,
      providedRev: Number(rev),
    })
  }
  const profile = normalizeProfileInput(rawProfile)
  const hash = profileHash(profile)
  const oldHash = profileHash(current.ipProfile)
  const changed = hash !== oldHash
  const now = toDb(utcNow())
  await db.run(
    `UPDATE \`persona\` SET \`ip_profile\` = ?, \`profile_revision\` = \`profile_revision\` + ?, \`rev\` = \`rev\` + ?, \`updated_at\` = ?, \`updated_by\` = ? WHERE \`id\` = ?`,
    [JSON.stringify(profileToDb(profile)), changed ? 1 : 0, changed ? 1 : 0, now, operator, id],
  )
  return { persona: (await getPersonaById(id, true))!, changed, hash }
}

/** 启停（FR-L4）：启用时可用性硬项不满足返回 409 并列出缺项 */
export async function setPersonaEnabled(id: string, enabled: boolean, operator: string): Promise<Persona> {
  const db = getDb()
  const current = await getPersonaById(id, true)
  if (!current) throw err.personaNotFound()
  if (current.archivedAt) throw err.personaArchived()
  if (enabled) {
    // 按「启用之后」的状态判定：否则已停用的人物永远带着「人物已停用」这条原因，无法重新启用
    const derived = await derivePersonaStatus({ ...current, enabled: true })
    if (!derived.usable) {
      throw err.conflict(`人物当前不可用，不能启用：${derived.reasons.map((r) => r.message).join('；')}`, {
        reasons: derived.reasons,
        status: derived.status,
      })
    }
  }
  await db.run('UPDATE `persona` SET `enabled` = ?, `updated_at` = ?, `updated_by` = ? WHERE `id` = ?', [
    enabled ? 1 : 0,
    toDb(utcNow()),
    operator,
    id,
  ])
  return (await getPersonaById(id, true))!
}

/** 归档（FR-L5）：软归档，名称占用释放；阻断条件由调用方（routes）先校验 */
export async function archivePersona(id: string, operator: string): Promise<Persona> {
  const db = getDb()
  const current = await getPersonaById(id, true)
  if (!current) throw err.personaNotFound()
  if (current.archivedAt) throw err.personaArchived('该人物已归档')
  const now = toDb(utcNow())
  await db.run(
    'UPDATE `persona` SET `archived_at` = ?, `enabled` = 0, `active_name_key` = NULL, `updated_at` = ?, `updated_by` = ? WHERE `id` = ?',
    [now, now, operator, id],
  )
  return (await getPersonaById(id, true))!
}

/* ── 可用性判定（FR-X2：统一走 policy）───────────────────────────── */

/** 授权记录（策略判定用） */
export async function listAuthorizationsForPolicy(
  personaId: string,
  db: Db = getDb(),
): Promise<Array<{ id: string; status: string; scopes: AuthorizationScope[]; expiresAt: string | null }>> {
  const rows = await db.all<Record<string, any>>(
    'SELECT `id`, `status`, `scopes`, `expires_at` FROM `persona_authorization` WHERE `persona_id` = ?',
    [personaId],
  )
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    scopes: jdec<string[]>(r.scopes, []) as AuthorizationScope[],
    expiresAt: fromDb(r.expires_at),
  }))
}

/** 派生人物有效状态（含授权维度） */
export async function derivePersonaStatus(
  persona: Persona,
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<DerivedStatus> {
  const auths = await listAuthorizationsForPolicy(persona.id, db)
  const [avatars, voices] = await Promise.all([
    db.all<Record<string, any>>(
      'SELECT `status`, `deleted_at` FROM `persona_avatar` WHERE `persona_id` = ?',
      [persona.id],
    ),
    db.all<Record<string, any>>(
      // is_sample=1 的声音样本不参与克隆态派生（FR-V1）
      'SELECT `status`, `confirmed`, `deleted_at` FROM `persona_voice` WHERE `persona_id` = ? AND `is_sample` = 0',
      [persona.id],
    ),
  ])
  const rule = LINE_RULES[persona.line]
  return deriveStatus(
    {
      line: persona.line,
      enabled: persona.enabled,
      archivedAt: persona.archivedAt,
      authRequired: rule.authRequired,
    },
    auths,
    {
      avatars: avatars.map((a) => ({ status: a.status, deletedAt: fromDb(a.deleted_at) })),
      voices: voices.map((v) => ({ status: v.status, confirmed: !!v.confirmed, deletedAt: fromDb(v.deleted_at) })),
      hasDefaultAvatar: !!persona.defaultAvatarId,
      hasConfirmedDefaultVoice: !!persona.defaultVoiceId,
      configured: false, // readiness 维度由 readiness.ts 计算后回填
    },
    now,
  )
}

/**
 * 写入 persona_id 前的校验（FR-X2）：不存在 / 归档 / 停用 / 授权失效分别给出原因。
 * 签名保持兼容（topics / copy / benchmark 调用方不变），新增 purpose 仅作日志语义。
 */
export async function assertPersonasUsable(
  ids: string[],
  db: Db = getDb(),
  purpose: 'copy' | 'topic' | 'benchmark' = 'copy',
): Promise<void> {
  const uniqIds = uniq(ids)
  if (!uniqIds.length) return
  const found = new Map((await getPersonasByIds(uniqIds, db)).map((p) => [p.id, p]))
  for (const id of uniqIds) {
    const p = found.get(id)
    if (!p) throw err.personaNotFound(`人物不存在：${id}`)
    if (p.archivedAt) throw err.personaArchived(`人物「${p.name}」已归档，不能${purpose === 'copy' ? '用于文案' : '使用'}`)
    if (!p.enabled) throw err.conflict(`人物「${p.name}」已停用，不能${purpose === 'copy' ? '用于文案' : '使用'}`, {
      personaId: id,
    })
    const derived = await derivePersonaStatus(p, db)
    if (!derived.usable) {
      const msg = derived.reasons.map((r) => r.message).join('；')
      throw purpose === 'copy'
        ? err.conflict(`人物「${p.name}」当前不可用：${msg}`, { personaId: id, status: derived.status, reasons: derived.reasons })
        : err.conflict(`人物「${p.name}」当前不可用：${msg}`, { personaId: id, status: derived.status, reasons: derived.reasons })
    }
  }
}

/** 授权是否有效（供 clone / readiness 复用） */
export { isAuthorizationValid }
