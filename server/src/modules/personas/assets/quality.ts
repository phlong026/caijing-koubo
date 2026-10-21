import type { MediaProbe } from '../../../media/inspect.js'

/**
 * 素材质检（R26/R27 平移众墅之家 character_asset_quality + 图片结构校验）。
 * 纯函数：硬性质检不过即 failed；软性仅提示（FR-A1/A2）。
 */

export interface QualityIssue {
  code: string
  message: string
}

export interface QualityResult {
  schemaVersion: number
  hard: QualityIssue[]
  soft: QualityIssue[]
  metrics: Record<string, unknown>
  pass: boolean
}

const SCHEMA_VERSION = 1

/** issue code 规范（R28）：^[A-Z][A-Z0-9_]{1,63}$ */
export function isValidIssueCode(code: string): boolean {
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
}

/* ── 图片结构校验（R27：截断 / 尾随数据）────────────────────────── */

/** JPEG：必须以 FFD9 结尾（允许尾部填充空白） */
export function checkJpegStructure(buf: Buffer): QualityIssue | null {
  if (buf.length < 125) return { code: 'IMG_TRUNCATED', message: '文件过小，可能已截断' }
  // 从尾部往前找 FFD9（跳过最多 32 字节的填充 / 元数据）
  const scan = Math.min(buf.length, 32)
  let found = false
  for (let i = buf.length - 2; i >= buf.length - scan; i--) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
      found = true
      break
    }
  }
  if (!found) return { code: 'IMG_TRUNCATED', message: 'JPEG 缺少结束标记，文件可能截断' }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return { code: 'IMG_BAD_HEADER', message: 'JPEG 头标识不符' }
  return null
}

/** PNG：必须含 IEND 块 */
export function checkPngStructure(buf: Buffer): QualityIssue | null {
  const IEND = Buffer.from('IEND')
  const tail = buf.subarray(Math.max(0, buf.length - 64))
  if (!tail.includes(IEND)) return { code: 'IMG_TRUNCATED', message: 'PNG 缺少 IEND 结束块，文件可能截断' }
  return null
}

/** WebP：RIFF 头 + 文件长度声明与真实长度一致 */
export function checkWebpStructure(buf: Buffer): QualityIssue | null {
  if (buf.length < 12) return { code: 'IMG_TRUNCATED', message: '文件过小，可能已截断' }
  const riffSize = buf.readUInt32LE(4)
  if (riffSize + 8 > buf.length) return { code: 'IMG_TRUNCATED', message: 'WebP 长度声明与文件大小不符，可能截断' }
  return null
}

export function checkImageStructure(ext: string, buf: Buffer): QualityIssue | null {
  if (ext === '.png') return checkPngStructure(buf)
  if (ext === '.webp') return checkWebpStructure(buf)
  return checkJpegStructure(buf)
}

/* ── 尺寸 / 视频质检 ────────────────────────────────────────────── */

/** 形象照片 / 背景图质检：最短边 ≥720（硬）；清晰度仅提示（软） */
export function checkImageQuality(
  dims: { width: number; height: number },
  minShortEdge = 720,
): QualityResult {
  const hard: QualityIssue[] = []
  const soft: QualityIssue[] = []
  const shortEdge = Math.min(dims.width, dims.height)
  if (shortEdge < minShortEdge) {
    hard.push({
      code: 'IMG_TOO_SMALL',
      message: `图片短边 ${shortEdge}px 低于 ${minShortEdge}px 要求，请上传更高清晰度的照片`,
    })
  }
  if (dims.width < 400 || dims.height < 400) {
    soft.push({ code: 'IMG_LOW_RES', message: `当前分辨率 ${dims.width}×${dims.height}，放大后可能模糊` })
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    hard,
    soft,
    metrics: { width: dims.width, height: dims.height, shortEdge },
    pass: hard.length === 0,
  }
}

/** 分身素材质检（FR-A2）：硬性 = 可解码 / 有视频流 / 时长区间 / 短边 ≥720 */
export function checkAvatarSourceQuality(
  probe: MediaProbe,
  opts: { minDurationMs?: number; maxDurationMs?: number; minShortEdge?: number } = {},
): QualityResult {
  const hard: QualityIssue[] = []
  const soft: QualityIssue[] = []
  const minDurationMs = opts.minDurationMs ?? 10_000
  const maxDurationMs = opts.maxDurationMs ?? 600_000
  const minShortEdge = opts.minShortEdge ?? 720
  const durationMs = probe.durationMs ?? 0
  const shortEdge = probe.width && probe.height ? Math.min(probe.width, probe.height) : 0

  if (!probe.hasVideo) {
    hard.push({ code: 'VID_NO_STREAM', message: '未检测到视频流，文件可能损坏或不是视频' })
  }
  if (durationMs < minDurationMs) {
    hard.push({
      code: 'VID_TOO_SHORT',
      message: `时长 ${(durationMs / 1000).toFixed(1)} 秒不足 ${minDurationMs / 1000} 秒下限`,
    })
  }
  if (durationMs > maxDurationMs) {
    hard.push({
      code: 'VID_TOO_LONG',
      message: `时长 ${(durationMs / 1000).toFixed(1)} 秒超过 ${maxDurationMs / 1000} 秒上限`,
    })
  }
  if (shortEdge > 0 && shortEdge < minShortEdge) {
    hard.push({
      code: 'VID_TOO_SMALL',
      message: `短边 ${shortEdge}px 低于 ${minShortEdge}px 要求，请上传更清晰的素材`,
    })
  }
  // 软性提示：非 9:16、帧率 <24、码率过低
  if (probe.width && probe.height) {
    const ratio = probe.width / probe.height
    if (Math.abs(ratio - 9 / 16) > 0.02) {
      soft.push({ code: 'VID_NOT_PORTRAIT', message: `当前 ${probe.width}×${probe.height} 非 9:16 竖屏，建议裁剪` })
    }
  }
  if (probe.fps !== null && probe.fps < 24) {
    soft.push({ code: 'VID_LOW_FPS', message: `帧率 ${probe.fps}fps 低于 24fps，口播可能不流畅` })
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    hard,
    soft,
    metrics: {
      width: probe.width,
      height: probe.height,
      durationMs,
      fps: probe.fps,
      shortEdge,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
    },
    pass: hard.length === 0,
  }
}

/** 背景 / 空镜视频质检：软性为主（时长 ≤60 秒由上传层强校验） */
export function checkVideoQuality(probe: MediaProbe, maxDurationMs = 60_000): QualityResult {
  const hard: QualityIssue[] = []
  const soft: QualityIssue[] = []
  const durationMs = probe.durationMs ?? 0
  if (!probe.hasVideo) {
    hard.push({ code: 'VID_NO_STREAM', message: '未检测到视频流，文件可能损坏或不是视频' })
  }
  if (durationMs > maxDurationMs) {
    hard.push({ code: 'VID_TOO_LONG', message: `时长 ${(durationMs / 1000).toFixed(1)} 秒超过上限` })
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    hard,
    soft,
    metrics: { width: probe.width, height: probe.height, durationMs, fps: probe.fps },
    pass: hard.length === 0,
  }
}

/** 声音样本质检（FR-V1）：时长 5–180 秒 */
export function checkVoiceSampleQuality(
  probe: MediaProbe,
  opts: { minDurationMs?: number; maxDurationMs?: number } = {},
): QualityResult {
  const hard: QualityIssue[] = []
  const soft: QualityIssue[] = []
  const minDurationMs = opts.minDurationMs ?? 5_000
  const maxDurationMs = opts.maxDurationMs ?? 180_000
  const durationMs = probe.durationMs ?? 0
  if (!probe.hasAudio) {
    hard.push({ code: 'AUD_NO_STREAM', message: '未检测到音频流，文件可能损坏' })
  }
  if (durationMs < minDurationMs) {
    hard.push({
      code: 'AUD_TOO_SHORT',
      message: `样本时长 ${(durationMs / 1000).toFixed(1)} 秒不足 ${minDurationMs / 1000} 秒（建议 30–60 秒清晰人声）`,
    })
  }
  if (durationMs > maxDurationMs) {
    hard.push({
      code: 'AUD_TOO_LONG',
      message: `样本时长 ${(durationMs / 1000).toFixed(1)} 秒超过 ${maxDurationMs / 1000} 秒上限`,
    })
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    hard,
    soft,
    metrics: { durationMs, hasAudio: probe.hasAudio },
    pass: hard.length === 0,
  }
}
