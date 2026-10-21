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
