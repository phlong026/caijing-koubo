import crypto from 'node:crypto'
import { err } from '../../errors.js'
import { canonicalJson } from '../../lib/util.js'
import type { IpProfile } from './repo.js'

/**
 * IP 档案字段校验与规范化（R25 平移众墅之家 _validated_ip_profile_field）。
 *  - 长度上限：角色 160、专业 / 受众 / 风格 / 需求 600、事实背景 / 样稿 2000；
 *  - 单行字段拒绝控制字符，多行字段允许换行（去其余控制字符）；
 *  - 内容方向 ≤8 项每项 ≤20 字；内容配比 ≤6 项，比例填则合计 100（FR-I3）；
 *  - 规范化后 hash 未变 → 不升 revision、不产生版本（FR-I5）。
 */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const LIMITS = {
  role: 160,
  serviceScope: 600,
  targetAudience: 600,
  expressionStyle: 600,
  audienceNeeds: 600,
  factualBackground: 2000,
  sampleScript: 2000,
  forbiddenClaim: 200,
  direction: 20,
  mixLabel: 20,
  refId: 40,
} as const

const MAX_DIRECTIONS = 8
const MAX_MIX = 6
const MAX_FORBIDDEN = 30

function singleLine(field: string, value: unknown, max: number): string {
  const raw = value === undefined || value === null ? '' : String(value)
  if (CONTROL.test(raw)) {
    throw err.badRequest(`「${field}」包含不允许的控制字符`, { field })
  }
  const v = raw.trim()
  if (v.length > max) {
    throw err.badRequest(`「${field}」长度不能超过 ${max} 字（当前 ${v.length}）`, { field, length: v.length, max })
  }
  return v
}

function multiLine(field: string, value: unknown, max: number): string {
  const raw = value === undefined || value === null ? '' : String(value)
  // 多行字段允许换行（\n \r），去掉其余控制字符
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const v = cleaned.trim()
  if (v.length > max) {
    throw err.badRequest(`「${field}」长度不能超过 ${max} 字（当前 ${v.length}）`, { field, length: v.length, max })
  }
  return v
}

function stringList(
  field: string,
  value: unknown,
  opts: { max: number; itemMax: number; dedup?: boolean },
): string[] {
  const arr = Array.isArray(value) ? value : []
  const out: string[] = []
  for (const item of arr) {
    const raw = item === undefined || item === null ? '' : String(item)
    if (CONTROL.test(raw)) {
      throw err.badRequest(`「${field}」包含不允许的控制字符`, { field })
    }
    const v = raw.trim()
    if (!v) continue
    if (v.length > opts.itemMax) {
      throw err.badRequest(`「${field}」每项不能超过 ${opts.itemMax} 字（当前 ${v.length}）`, {
        field,
        length: v.length,
        max: opts.itemMax,
      })
    }
    if (opts.dedup !== false && out.includes(v)) continue
    out.push(v)
    if (out.length > opts.max) {
      throw err.badRequest(`「${field}」最多 ${opts.max} 项`, { field, max: opts.max })
    }
  }
  return out
}

export interface ContentMixItem {
  label: string
  ratio?: number
  /** 引用的选题方法（topic_prompt_template.id）；旧数据没有，按 label 识别 */
  methodId?: string
}

function contentMix(value: unknown): ContentMixItem[] {
  const arr = Array.isArray(value) ? value : []
  const out: ContentMixItem[] = []
  let anyRatio = false
  for (const item of arr) {
    const o = (item ?? {}) as Record<string, unknown>
    const methodId = singleLine('选题方法', o.methodId ?? o.method_id, LIMITS.refId)
    // 引用选题方法的项，label 只是显示名（方法名可长达 128 字），截断即可；自由填写的旧标签仍严格校验
    const label = methodId
      ? singleLine('内容配比', String(o.label ?? '').trim().slice(0, LIMITS.mixLabel), LIMITS.mixLabel)
      : singleLine('内容配比', o.label, LIMITS.mixLabel)
    if (!label) continue
    const rawRatio = o.ratio
    let ratio: number | undefined
    if (rawRatio !== undefined && rawRatio !== null && rawRatio !== '') {
      const n = Number(rawRatio)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
        throw err.badRequest('内容配比比例必须是 1–100 的整数', { label, ratio: rawRatio })
      }
      ratio = n
      anyRatio = true
    }
    out.push({ label, ...(methodId ? { methodId } : {}), ...(ratio === undefined ? {} : { ratio }) })
    if (out.length > MAX_MIX) throw err.badRequest(`内容配比最多 ${MAX_MIX} 项`, { max: MAX_MIX })
  }
  if (anyRatio) {
    if (out.some((x) => x.ratio === undefined)) {
      throw err.badRequest('内容配比：任一项填写比例后，所有项都必须填写比例', { items: out })
    }
    const sum = out.reduce((s, x) => s + (x.ratio ?? 0), 0)
    if (sum !== 100) {
      throw err.badRequest(`内容配比合计必须等于 100（当前 ${sum}）`, { sum, items: out })
    }
  }
  return out
}

/** 规范化 ipProfile 输入（对外 camelCase，库内 snake 存储） */
export function normalizeProfileInput(raw: unknown): IpProfile {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    role: singleLine('角色类型', o.role, LIMITS.role),
    serviceScope: singleLine('专业方向', o.serviceScope ?? o.service_scope, LIMITS.serviceScope),
    targetAudience: singleLine('目标受众', o.targetAudience ?? o.target_audience, LIMITS.targetAudience),
    expressionStyle: singleLine('表达风格', o.expressionStyle ?? o.expression_style, LIMITS.expressionStyle),
    audienceNeeds: multiLine('受众需求', o.audienceNeeds ?? o.audience_needs, LIMITS.audienceNeeds) || undefined,
    factualBackground:
      multiLine('事实背景', o.factualBackground ?? o.factual_background, LIMITS.factualBackground) || undefined,
    sampleScript: multiLine('代表口播样稿', o.sampleScript ?? o.sample_script, LIMITS.sampleScript) || undefined,
    contentDirections: stringList('内容方向', o.contentDirections ?? o.content_directions, {
      max: MAX_DIRECTIONS,
      itemMax: LIMITS.direction,
    }),
    contentMix: contentMix(o.contentMix ?? o.content_mix),
    defaultStyleId: singleLine('默认表达风格', o.defaultStyleId ?? o.default_style_id, LIMITS.refId) || undefined,
    forbiddenClaims: stringList('禁用表达', o.forbiddenClaims ?? o.forbidden_claims, {
      max: MAX_FORBIDDEN,
      itemMax: LIMITS.forbiddenClaim,
    }),
  }
}

/** 规范化 JSON 的 SHA-256（键排序稳定，用于「内容未变不升版本」） */
export function profileHash(profile: IpProfile): string {
  // 必须用 canonicalJson：JSON.stringify 的数组参数是全层级白名单，
  // contentMix 数组元素的 label / ratio 不在顶层键里会被整个过滤，配比变化就不升版本了
  return crypto.createHash('sha256').update(canonicalJson(profile)).digest('hex')
}

/** camelCase 对外 → snake_case 入库 */
export function profileToDb(profile: IpProfile): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: profile.role,
    service_scope: profile.serviceScope,
    target_audience: profile.targetAudience,
    expression_style: profile.expressionStyle,
    forbidden_claims: profile.forbiddenClaims,
  }
  if (profile.audienceNeeds !== undefined) out.audience_needs = profile.audienceNeeds
  if (profile.factualBackground !== undefined) out.factual_background = profile.factualBackground
  if (profile.sampleScript !== undefined) out.sample_script = profile.sampleScript
  if (profile.contentDirections?.length) out.content_directions = profile.contentDirections
  if (profile.contentMix?.length) out.content_mix = profile.contentMix
  if (profile.defaultStyleId) out.default_style_id = profile.defaultStyleId
  return out
}

/** 规范化请求体 JSON 的 SHA-256（克隆幂等 request_hash） */
export function requestHash(body: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
}
