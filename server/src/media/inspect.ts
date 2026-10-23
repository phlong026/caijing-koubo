import { spawn } from 'node:child_process'
import path from 'node:path'
import { ensureTempDir, checkFfmpeg } from './pipeline.js'

/**
 * 素材质检与规范化（R21 平移众墅之家 media_tools）。
 * ffprobe / ffmpeg 只处理本地文件并设超时（任务书 §7 安全）。
 */

export interface MediaProbe {
  kind: 'video' | 'audio' | 'image' | 'unknown'
  durationMs: number | null
  width: number | null
  height: number | null
  fps: number | null
  hasVideo: boolean
  hasAudio: boolean
  format: string | null
  sizeBytes: number | null
}

const PROBE_TIMEOUT_MS = 60_000
const FFMPEG_TIMEOUT_MS = 180_000

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      p.kill()
      reject(new Error(`${bin} 执行超时（${timeoutMs / 1000}s）`))
    }, timeoutMs)
    p.stdout.on('data', (d) => (stdout += String(d)))
    p.stderr.on('data', (d) => (stderr += String(d)))
    p.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`${bin} 不可用：${e.message}`))
    })
    p.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** ffprobe 探测媒体元数据 */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const { code, stdout, stderr } = await run(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    PROBE_TIMEOUT_MS,
  )
  if (code !== 0) throw new Error(`ffprobe 失败（code=${code}）：${stderr.slice(-300)}`)
  let info: any = {}
  try {
    info = JSON.parse(stdout)
  } catch {
    throw new Error('ffprobe 输出解析失败')
  }
  const streams: any[] = Array.isArray(info.streams) ? info.streams : []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  const kind: MediaProbe['kind'] = video ? 'video' : audio ? 'audio' : streams.length ? 'unknown' : 'unknown'
  const fps = video?.avg_frame_rate
    ? (() => {
        const [num, den] = String(video.avg_frame_rate).split('/').map(Number)
        return den ? num / den : Number.isFinite(num) ? num : null
      })()
    : null
  return {
    kind,
    durationMs: info.format?.duration ? Math.round(Number(info.format.duration) * 1000) : null,
    width: video?.width ? Number(video.width) : null,
    height: video?.height ? Number(video.height) : null,
    fps: fps !== null && Number.isFinite(fps) ? Math.round(fps * 100) / 100 : null,
    hasVideo: !!video,
    hasAudio: !!audio,
    format: info.format?.format_name ?? null,
    sizeBytes: info.format?.size ? Number(info.format.size) : null,
  }
}

/** 图片结构信息（R27：伪造扩展名由魔数层拦截，这里取真实尺寸与格式） */
export async function probeImage(filePath: string): Promise<{ width: number; height: number; format: string | null }> {
  const probe = await probeMedia(filePath)
  if (!probe.width || !probe.height) throw new Error('无法解析图片尺寸（文件可能损坏）')
  return { width: probe.width, height: probe.height, format: probe.format }
}

/** 音频转单声道 mp3（R21 normalize_audio_to_mp3：5–180 秒样本规范化） */
export async function normalizeAudioToMp3(srcPath: string, destName: string): Promise<string> {
  const chk = await checkFfmpeg()
  if (!chk.ok) throw new Error(chk.error ?? 'ffmpeg 不可用')
  await ensureTempDir()
  const dest = path.join(path.dirname(srcPath), destName)
  const { code, stderr } = await run(
    'ffmpeg',
    ['-y', '-i', srcPath, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '128k', '-f', 'mp3', dest],
    FFMPEG_TIMEOUT_MS,
  )
  if (code !== 0) throw new Error(`音频规范化失败（code=${code}）：${stderr.slice(-300)}`)
  return dest
}

/** 分身素材兼容版本（R20：H.264 mp4 + faststart，交付飞影） */
export async function transcodeCompatVideo(srcPath: string, destName: string): Promise<string> {
  const chk = await checkFfmpeg()
  if (!chk.ok) throw new Error(chk.error ?? 'ffmpeg 不可用')
  await ensureTempDir()
  const dest = path.join(path.dirname(srcPath), destName)
  const { code, stderr } = await run(
    'ffmpeg',
    [
      '-y',
      '-i',
      srcPath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      dest,
    ],
    FFMPEG_TIMEOUT_MS,
  )
  if (code !== 0) throw new Error(`兼容转码失败（code=${code}）：${stderr.slice(-300)}`)
  return dest
}

/** 抽帧封面（FR-A2：分身素材封面帧；默认取 1 秒处，短视频取中点） */
export async function extractCoverFrame(srcPath: string, destName: string, durationMs?: number | null): Promise<string> {
  const chk = await checkFfmpeg()
  if (!chk.ok) throw new Error(chk.error ?? 'ffmpeg 不可用')
  await ensureTempDir()
  const dest = path.join(path.dirname(srcPath), destName)
  const at = durationMs && durationMs > 2000 ? 1 : 0.2
  const { code, stderr } = await run(
    'ffmpeg',
    ['-y', '-ss', String(at), '-i', srcPath, '-frames:v', '1', '-q:v', '3', dest],
    FFMPEG_TIMEOUT_MS,
  )
  if (code !== 0) throw new Error(`抽帧失败（code=${code}）：${stderr.slice(-300)}`)
  return dest
}

/** 图片缩略图（FR-A1：320px，保持比例） */
export async function makeThumb(srcPath: string, destName: string, width = 320): Promise<string> {
  const chk = await checkFfmpeg()
  if (!chk.ok) throw new Error(chk.error ?? 'ffmpeg 不可用')
  await ensureTempDir()
  const dest = path.join(path.dirname(srcPath), destName)
  const { code, stderr } = await run(
    'ffmpeg',
    ['-y', '-i', srcPath, '-vf', `scale=${width}:-2`, '-frames:v', '1', dest],
    FFMPEG_TIMEOUT_MS,
  )
  if (code !== 0) throw new Error(`缩略图生成失败（code=${code}）：${stderr.slice(-300)}`)
  return dest
}

/* ── 成片规范化（FR-P4；逻辑平移众墅之家 media_tools.py#normalize_generated_video）──────
 * 等比缩放不裁切、补边到目标竖屏画布、SAR 归一、H.264/AAC、+faststart；
 * 几何/编码已达标时透传不重编码。调用方负责归档与计费，本函数不设时长上限。
 */

export class MediaValidationFailed extends Error {}

const NORMALIZE_TIMEOUT_MS = 600_000

interface GeneratedGeometry {
  videoCodec: string
  pixelFormat: string
  colorTransfer: string
  width: number
  height: number
  sar: number
  dar: number
  rotation: number
  durationSec: number
  audioCodecs: string[]
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

/** '1:1' / 'N/A' / '0:1' → 数值；越界视为无效 */
function parseRatio(text: string | undefined): number {
  if (!text || text === 'N/A' || text === '0:1') return 1
  const [n, d] = text.split(':').map(Number)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) throw new MediaValidationFailed('成片画幅或时长信息无效')
  const v = n / d
  if (!(v >= 0.01 && v <= 100)) throw new MediaValidationFailed('成片画幅或时长信息无效')
  return v
}

async function probeGeneratedGeometry(filePath: string): Promise<GeneratedGeometry> {
  const { code, stdout } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_entries',
      'stream=codec_type,codec_name,pix_fmt,color_transfer,width,height,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:format=duration,format_name',
      '-of',
      'json',
      filePath,
    ],
    NORMALIZE_TIMEOUT_MS,
  )
  if (code !== 0) throw new MediaValidationFailed('成片画幅或时长信息无效')
  let payload: any
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new MediaValidationFailed('成片画幅或时长信息无效')
  }
  try {
    const streams: any[] = payload.streams
    if (!Array.isArray(streams) || streams.length === 0 || streams.length > 8) throw new Error('invalid streams')
    const video = streams.find((s) => s.codec_type === 'video')
    if (!video || !['h264', 'hevc', 'av1', 'vp9', 'mpeg4'].includes(String(video.codec_name))) {
      throw new Error('unsupported video stream')
    }
    const width = Number(video.width)
    const height = Number(video.height)
    if (!(width >= 2 && height >= 2 && width <= 8192 && height <= 8192 && width * height <= 33554432)) {
      throw new Error('invalid dimensions')
    }
    const durationSec = Number(payload.format?.duration)
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('invalid duration')
    const sar = parseRatio(video.sample_aspect_ratio)
    let dar = (width / height) * sar
    let rotation = 0
    const rotRaw = video.tags?.rotate ?? video.side_data_list?.find((d: any) => 'rotation' in d)?.rotation ?? 0
    const rotNum = Number(rotRaw)
    if (!Number.isFinite(rotNum) || rotNum % 90 !== 0) throw new Error('unsupported rotation')
    rotation = ((Math.trunc(rotNum) % 360) + 360) % 360
    if (rotation === 90 || rotation === 270) dar = 1 / dar
    const audioCodecs = streams.filter((s) => s.codec_type === 'audio').map((s) => String(s.codec_name))
    const pixelFormat = String(video.pix_fmt ?? '')
    if (!pixelFormat) throw new Error('missing pixel format')
    return {
      videoCodec: String(video.codec_name),
      pixelFormat,
      colorTransfer: String(video.color_transfer ?? 'unknown').toLowerCase(),
      width,
      height,
      sar,
      dar,
      rotation,
      durationSec,
      audioCodecs,
    }
  } catch (e) {
    if (e instanceof MediaValidationFailed) throw e
    throw new MediaValidationFailed('成片画幅或时长信息无效')
  }
}

/** 等比缩放适配目标画布（不裁切；偶数对齐），补边由 pad 完成 */
function fitDisplay(dar: number, width: number, height: number): [number, number] {
  const fitted: [number, number] =
    dar >= width / height
      ? [width, Math.floor(width / dar / 2) * 2]
      : [Math.floor(height * dar / 2) * 2, height]
  if (Math.min(...fitted) < 2) throw new MediaValidationFailed('成片显示比例无法适配目标尺寸')
  return fitted
}

export interface NormalizeResult {
  transformed: boolean
  width: number
  height: number
  durationMs: number
  audioCodecs: string[]
}

/**
 * 成片规范化（FR-P4）：fit + pad 到 targetWidth×targetHeight，H.264 CRF18 / AAC / 30fps / +faststart。
 * srcPath 为下载好的成片，规范化结果写 destPath；几何与编码已达标时直接透传（不重编码）。
 * 额外跑一次全量解码（-f null）以暴露截断与坏包。
 */
export async function normalizeGeneratedVideo(
  srcPath: string,
  destPath: string,
  opts: { targetWidth: number; targetHeight: number; fps?: number },
): Promise<NormalizeResult> {
  const { targetWidth, targetHeight, fps } = opts
  if (!(targetWidth >= 2 && targetWidth <= 4096 && targetWidth % 2 === 0)) {
    throw new MediaValidationFailed('目标视频尺寸必须为有效的偶数尺寸')
  }
  if (!(targetHeight >= 2 && targetHeight <= 4096 && targetHeight % 2 === 0)) {
    throw new MediaValidationFailed('目标视频尺寸必须为有效的偶数尺寸')
  }
  const source = await probeGeneratedGeometry(srcPath)
  const isHdr = source.colorTransfer === 'smpte2084' || source.colorTransfer === 'arib-std-b67'
  // 旋转 90/270 的源视频显示像素与编码像素互换：目标画布随之旋转，避免竖屏素材被硬拉横
  let displayTargetWidth = targetWidth
  let displayTargetHeight = targetHeight
  if ((source.rotation === 90 || source.rotation === 270) && targetWidth === source.width && targetHeight === source.height) {
    ;[displayTargetWidth, displayTargetHeight] = [targetHeight, targetWidth]
  }
  const transformed =
    source.width !== displayTargetWidth ||
    source.height !== displayTargetHeight ||
    Math.abs(source.sar - 1) > 1e-9 ||
    source.rotation !== 0 ||
    source.videoCodec !== 'h264' ||
    source.pixelFormat !== 'yuv420p' ||
    isHdr ||
    (source.audioCodecs.length > 0 && source.audioCodecs.some((c) => c !== 'aac'))

  const probeOf = (p: string) => probeGeneratedGeometry(p)
  if (transformed) {
    const [fitW, fitH] = fitDisplay(source.dar, displayTargetWidth, displayTargetHeight)
    const toneMap = isHdr
      ? 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p,'
      : ''
    const filters =
      toneMap +
      // out_range=tv：JPEG 等全范围源显式转 limited-range（对已有限制范围输入为无操作），
      // 否则 x264 会带 fullrange 标记产出 yuvj420p，过不了 pix_fmt 校验
      `scale=w=${fitW}:h=${fitH}:flags=lanczos:out_range=tv,setsar=1,pad=${displayTargetWidth}:${displayTargetHeight}:(ow-iw)/2:(oh-ih)/2:color=black`
    const args = [
      '-y',
      '-v',
      'error',
      '-nostdin',
      '-xerror',
      '-threads',
      '2',
      '-filter_threads',
      '1',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      srcPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      filters,
      ...(fps ? ['-r', String(fps)] : []),
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-c:a',
      'aac',
      '-metadata:s:v:0',
      'rotate=0',
      '-movflags',
      '+faststart',
      destPath,
    ]
    const { code, stderr } = await run('ffmpeg', args, NORMALIZE_TIMEOUT_MS)
    if (code !== 0) throw new MediaValidationFailed(`成片无法完整解码或规范化：${stderr.slice(-300)}`)
    const result = await probeOf(destPath)
    if (
      result.width !== displayTargetWidth ||
      result.height !== displayTargetHeight ||
      Math.abs(result.sar - 1) > 1e-9 ||
      result.rotation !== 0 ||
      result.videoCodec !== 'h264' ||
      result.pixelFormat !== 'yuv420p' ||
      result.colorTransfer === 'smpte2084' ||
      result.colorTransfer === 'arib-std-b67' ||
      (source.audioCodecs.length > 0 && result.audioCodecs.some((c) => c !== 'aac')) ||
      Math.abs(result.durationSec - source.durationSec) > 0.05
    ) {
      throw new MediaValidationFailed(
        `规范化成片的画幅、时长或音轨校验失败：结果 ${result.width}x${result.height}@${result.durationSec.toFixed(3)}s ` +
          `${result.videoCodec}/${result.pixelFormat}/sar${result.sar}/audio=${result.audioCodecs.join(',')}，` +
          `目标 ${displayTargetWidth}x${displayTargetHeight}，源时长 ${source.durationSec.toFixed(3)}s`,
      )
    }
  }

  // 全量解码校验：probe 只读元数据，发现不了截断包与解码错误
  const decode = await run(
    'ffmpeg',
    ['-v', 'error', '-nostdin', '-xerror', '-threads', '2', '-protocol_whitelist', 'file,pipe', '-i', transformed ? destPath : srcPath, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'],
    NORMALIZE_TIMEOUT_MS,
  )
  if (decode.code !== 0) throw new MediaValidationFailed('成片无法完整解码')

  const final = transformed ? await probeOf(destPath) : source
  return {
    transformed,
    width: final.width,
    height: final.height,
    durationMs: Math.round(final.durationSec * 1000),
    audioCodecs: final.audioCodecs,
  }
}
