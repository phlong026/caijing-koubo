import Papa from 'papaparse'
import { err } from '../../errors.js'
import {
  CSV_HEADER_ALIASES,
  CSV_REQUIRED_ONE_OF,
  type CsvField,
  type MetricValues,
} from './types.js'

/**
 * CSV 解析与列归一化（FR-M1 / §3.2，Q8 已拍板引入 papaparse）。
 *
 * 各平台创作者中心导出的表头命名差异很大（视频ID / 作品ID / 笔记ID…），这里做两件事：
 *  1. 表头归一化后按「别名精确 → 关键词包含」两级匹配到标准字段；
 *  2. 单元格值按数字 / 百分比 / 时间三类解析，时间统一按北京时间解释后转 UTC 存储。
 */

export interface ParsedCsvRow {
  /** 文件中的物理行号（1 起，含表头行），用于 unmatched 明细 */
  lineNo: number
  externalVideoId: string | null
  title: string | null
  accountName: string | null
  publishedAt: Date | null
  metrics: MetricValues
}

export interface ParseResult {
  rows: ParsedCsvRow[]
  /** 行级拒收原因（缺定位字段 / 全部指标为空等） */
  rejected: Array<{ lineNo: number; reason: string }>
  /** 标准字段 → 命中的原始表头，用于返回给前端核对映射 */
  mapping: Partial<Record<CsvField, string>>
  total: number
}

/** 表头归一化：去空白 / 星号 / 括号注释 / 冒号，转小写 */
export function normalizeHeader(raw: string): string {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/[\s*:：、,，]/g, '')
    .trim()
    .toLowerCase()
}

/** 数值解析：支持千分位、万 / 亿 / w 单位、正负号；空值返回 null */
export function parseNumberCell(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  let s = String(raw).trim()
  if (!s || s === '-' || s === '—' || s === '/' || s === 'NA' || s === 'N/A' || s === 'null') return null
  s = s.replace(/[,，\s]/g, '')
  let scale = 1
  if (/亿$/.test(s)) {
    scale = 100_000_000
    s = s.slice(0, -1)
  } else if (/万$/.test(s)) {
    scale = 10_000
    s = s.slice(0, -1)
  } else if (/[wW]$/.test(s)) {
    scale = 10_000
    s = s.slice(0, -1)
  }
  if (s.endsWith('%')) return null // 计数列不应出现百分号，交给 parseRateCell
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return Math.round(n * scale)
}

/** 比率解析：「45.2%」→ 0.452；「0.45」→ 0.45；空 / — → null（Q5 不补 0） */
export function parseRateCell(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  let s = String(raw).trim()
  if (!s || s === '-' || s === '—' || s === '/' || s === 'NA' || s === 'N/A') return null
  s = s.replace(/[,，\s]/g, '')
  const isPercent = s.endsWith('%')
  if (isPercent) s = s.slice(0, -1)
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  const v = isPercent ? n / 100 : n > 1 ? n / 100 : n
  if (v < 0) return null
  return Math.min(1, Number(v.toFixed(4)))
}

/**
 * 时间解析：带时区的直接解析；不带时区的按北京时间（UTC+8）解释。
 * 支持 2026-10-20 / 2026/10/20 12:30 / 2026年10月20日 / Unix 秒或毫秒。
 */
export function parseDateCell(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  if (!s) return null
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000)
  if (/^\d{13}$/.test(s)) return new Date(Number(s))
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const direct = new Date(s.replace(' ', 'T'))
    return Number.isNaN(direct.getTime()) ? null : direct
  }
  const m = s.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const hh = Number(m[4] ?? 0)
  const mm = Number(m[5] ?? 0)
  const ss = Number(m[6] ?? 0)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss) - 8 * 3600_000)
}

/** 表头 → 标准字段：先精确命中别名，再按关键词包含（如「播放量(次)」） */
export function mapHeaders(headers: string[]): Partial<Record<CsvField, string>> {
  const normalized = headers.map((h) => ({ raw: h, key: normalizeHeader(h) }))
  const mapping: Partial<Record<CsvField, string>> = {}
  const used = new Set<string>()
  const fields = Object.keys(CSV_HEADER_ALIASES) as CsvField[]

  // 第一轮：精确匹配（避免「点赞率」抢走「点赞量」）
  for (const field of fields) {
    const aliases = CSV_HEADER_ALIASES[field]
    const hit = normalized.find((h) => !used.has(h.raw) && aliases.includes(h.key))
    if (hit) {
      mapping[field] = hit.raw
      used.add(hit.raw)
    }
  }
  // 第二轮：包含匹配，按别名长度降序，长别名优先（「新增粉丝」先于「粉丝」）
  for (const field of fields) {
    if (mapping[field]) continue
    const aliases = [...CSV_HEADER_ALIASES[field]].sort((a, b) => b.length - a.length)
    const hit = normalized.find((h) => !used.has(h.raw) && aliases.some((a) => a.length >= 2 && h.key.includes(a)))
    if (hit) {
      mapping[field] = hit.raw
      used.add(hit.raw)
    }
  }
  return mapping
}

function cell(row: string[], headers: string[], mapping: Partial<Record<CsvField, string>>, field: CsvField): string | null {
  const header = mapping[field]
  if (!header) return null
  const idx = headers.indexOf(header)
  if (idx < 0) return null
  const v = row[idx]
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s ? s : null
}

/**
 * 解析指标 CSV。
 * 失败条件（抛 CSV_PARSE_FAILED）：内容为空 / 无法解析出表格 / 缺定位列（视频ID 与标题都没有）。
 */
export function parseMetricsCsv(text: string, platform: string): ParseResult {
  const content = String(text ?? '').replace(/^\uFEFF/, '')
  if (!content.trim()) throw err.csvParseFailed('CSV 内容为空', { platform })

  const parsed = Papa.parse<string[]>(content, {
    skipEmptyLines: 'greedy',
    // 不交给 papaparse 做 header：需要保留原始表头用于映射回显与模板核对
  })
  const fatal = parsed.errors.find((e) => e.type === 'Quotes' || e.code === 'UndetectableDelimiter')
  if (fatal) throw err.csvParseFailed(`CSV 解析失败：${fatal.message}（第 ${(fatal.row ?? 0) + 1} 行）`, { platform })

  const table = (parsed.data ?? []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim()))
  if (table.length < 2) throw err.csvParseFailed('CSV 至少需要一行表头与一行数据', { platform })

  const headers = table[0]!.map((h) => String(h ?? ''))
  const mapping = mapHeaders(headers)

  // 定位列校验：视频ID 或（标题 + 账号）至少有一条路可走
  const hasId = !!mapping.externalVideoId
  const hasTitle = !!mapping.title
  if (!hasId && !hasTitle) {
    throw err.csvParseFailed('缺少可用于匹配的列：至少需要「视频ID/作品ID/笔记ID」或「标题」之一', {
      platform,
      detectedHeaders: headers.slice(0, 20),
      expected: CSV_REQUIRED_ONE_OF,
    })
  }

  const rows: ParsedCsvRow[] = []
  const rejected: ParseResult['rejected'] = []
  let total = 0

  for (let i = 1; i < table.length; i++) {
    const raw = table[i]!
    const lineNo = i + 1
    total += 1
    const metrics: MetricValues = {
      plays: parseNumberCell(cell(raw, headers, mapping, 'plays')) ?? 0,
      likes: parseNumberCell(cell(raw, headers, mapping, 'likes')) ?? 0,
      comments: parseNumberCell(cell(raw, headers, mapping, 'comments')) ?? 0,
      shares: parseNumberCell(cell(raw, headers, mapping, 'shares')) ?? 0,
      collects: parseNumberCell(cell(raw, headers, mapping, 'collects')) ?? 0,
      fansGained: parseNumberCell(cell(raw, headers, mapping, 'fansGained')) ?? 0,
      completionRate: parseRateCell(cell(raw, headers, mapping, 'completionRate')),
    }
    const row: ParsedCsvRow = {
      lineNo,
      externalVideoId: cell(raw, headers, mapping, 'externalVideoId'),
      title: cell(raw, headers, mapping, 'title'),
      accountName: cell(raw, headers, mapping, 'accountName'),
      publishedAt: parseDateCell(cell(raw, headers, mapping, 'publishedAt')),
      metrics,
    }
    // 既无 ID 也无标题 → 无法匹配，直接计入行级拒收
    if (!row.externalVideoId && !row.title) {
      rejected.push({ lineNo, reason: '缺少视频ID与标题，无法匹配发布记录' })
      continue
    }
    rows.push(row)
  }

  if (!rows.length) {
    throw err.csvParseFailed('没有可导入的数据行（全部缺少视频ID与标题）', {
      platform,
      rejected: rejected.slice(0, 20),
      detectedHeaders: headers.slice(0, 20),
    })
  }

  return { rows, rejected, mapping, total }
}

/** 平台模板 CSV（含表头与一行示例，供后台下载） */
export function buildTemplateCsv(platform: string, template: { headers: string[]; sample: string[] }): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  // 加 BOM：Excel 直接双击打开中文不乱码
  return `\uFEFF${[template.headers, template.sample].map((r) => r.map(esc).join(',')).join('\r\n')}\r\n`
}
