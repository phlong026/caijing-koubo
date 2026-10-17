/**
 * 时间工具：统一以 UTC 存储，前端按 Asia/Shanghai 展示（P2-4）。
 * 数据库里的时间列一律写成 'YYYY-MM-DD HH:mm:ss'（UTC），字符串可直接比较与排序。
 */
const CST = 'Asia/Shanghai'

export function utcNow(): Date {
  return new Date()
}

/** Date → 数据库存储字符串（UTC） */
export function toDb(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** 数据库字符串（UTC）→ ISO8601（前端消费） */
export function fromDb(s: string | null | undefined): string | null {
  if (!s) return null
  const t = s.replace(' ', 'T')
  const hasZone = /[Zz]|[+-]\d{2}:\d{2}$/.test(t)
  const iso = hasZone ? t : `${t}Z`
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function iso(d: Date): string {
  return d.toISOString()
}

export function fromIso(s: string | null | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3600_000)
}
export function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000)
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000)
}

/** 按 CST 展示用（日志、告警 payload 文案） */
export function fmtCst(d: Date | string | null | undefined): string {
  if (!d) return '-'
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: CST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/** 毫秒 → mm:ss（句级时间戳展示） */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 随机抖动：用于抓取完成后重排 next_check_at（FR-B3） */
export function jitter(ratio: number): number {
  // 返回 [0, ratio) 的比例系数
  return Math.random() * ratio
}
