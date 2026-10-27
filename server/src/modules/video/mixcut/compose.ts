import { spawn } from 'node:child_process'
import { config } from '../../../config.js'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { normalizeGeneratedVideo } from '../../../media/inspect.js'
import type { MaterialReplacement } from '../types.js'

/**
 * 混剪合成（FR-M3；🔧 R5 FFmpegCommandBuilder.buildOverlayCommand 平移）：
 * 底板（人物背景循环 / 纯色兜底）+ 按时间轴 overlay 素材 + 合入配音整轨 → 规范化 1080×1920。
 */

interface ComposeItem {
  itemId: string
  localPath: string
  isImage: boolean
  /** 视频素材时长（毫秒）；图片为 null */
  durationMs: number | null
}

interface ComposeInput {
  /** 配音整轨（已归档的本地 wav/mp3） */
  audioPath: string
  audioDurationMs: number
  /** 底板：背景图 / 背景视频 / 空镜（可空，纯色兜底） */
  baseItem: { localPath: string; isImage: boolean } | null
  replacements: MaterialReplacement[]
  items: Map<string, ComposeItem>
  display: 'fullscreen' | 'pip'
  workDir: string
}

const TIMEOUT_MS = 600_000

function runFfmpeg(args: string[], timeoutMs = TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpegPath, ['-y', '-v', 'error', '-nostdin', ...args], { windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error('混剪合成超时'))
    }, timeoutMs)
    p.stderr.on('data', (d) => (stderr += String(d)))
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`ffmpeg 不可用：${e.message}`))
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`混剪合成失败（code=${code}）：${stderr.slice(-400)}`))
    })
  })
}

/** 重叠处理（R5）：每个替换点的实际结束时间不越过下一个替换点的开始 */
function adjustedSpans(replacements: MaterialReplacement[]): Array<MaterialReplacement & { actualEndMs: number }> {
  const sorted = [...replacements].sort((a, b) => a.startMs - b.startMs)
  return sorted.map((r, i) => {
    let actualEndMs = r.endMs
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j]!.startMs < actualEndMs) actualEndMs = sorted[j]!.startMs
    }
    return { ...r, actualEndMs }
  })
}

function pipPosition(position: string, w: number, h: number, pw: number, ph: number): { x: number; y: number } {
  const padding = 20
  switch (position) {
    case 'top-left':
      return { x: padding, y: padding }
    case 'top-right':
      return { x: w - pw - padding, y: padding }
    case 'bottom-left':
      return { x: padding, y: h - ph - padding }
    case 'center':
      return { x: Math.round((w - pw) / 2), y: Math.round((h - ph) / 2) }
    default:
      return { x: w - pw - padding, y: h - ph - padding }
  }
}

/** 合成主入口：产出 normalized.mp4（1080×1920 / H.264 / AAC / +faststart） */
export async function composeMixcut(input: ComposeInput): Promise<{ path: string; durationMs: number; transformed: boolean }> {
  const { width, height } = { width: config.video.outputWidth, height: config.video.outputHeight }
  const durSec = (input.audioDurationMs / 1000).toFixed(3)
  const used = input.replacements.filter((r) => input.items.has(r.itemId))
  if (!used.length) throw new Error('没有可合成的素材替换点')

  // 输入：0=底板（含音轨的占位为静音）…n=素材，最后单独挂配音
  const args: string[] = []
  // 底板
  if (input.baseItem) {
    if (input.baseItem.isImage) args.push('-loop', '1', '-t', durSec, '-i', input.baseItem.localPath)
    else args.push('-stream_loop', '-1', '-i', input.baseItem.localPath)
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=0x101820:s=${width}x${height}:r=${config.video.outputFps}:d=${durSec}`)
  }
  // 素材（图片 -loop 1 限时；视频原样——片段窗口由 overlay enable 控制，素材短于窗口时定格末帧）
  for (const r of used) {
    const item = input.items.get(r.itemId)!
    if (item.isImage) args.push('-loop', '1', '-t', ((r.endMs - r.startMs) / 1000).toFixed(3), '-i', item.localPath)
    else args.push('-i', item.localPath)
  }
  // 配音
  args.push('-i', input.audioPath)

  // filter_complex：底板 [0:v] 逐层 overlay
  const spans = adjustedSpans(used)
  let filter = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[base];`
  let current = '[base]'
  spans.forEach((r, i) => {
    // adjustedSpans 保持与 used 相同的排序（均按 startMs），输入序号按位置对应
    const inputIndex = 1 + i
    const startSec = (r.startMs / 1000).toFixed(3)
    const endSec = (r.actualEndMs / 1000).toFixed(3)
    const enable = `gte(t,${startSec})*lt(t,${endSec})`
    if (input.display === 'pip') {
      const pw = Math.round(width * 0.3)
      const ph = Math.round(height * 0.3)
      const { x, y } = pipPosition('bottom-right', width, height, pw, ph)
      filter += `[${inputIndex}:v]scale=${pw}:${ph}:force_original_aspect_ratio=decrease,pad=${pw}:${ph}:(ow-iw)/2:(oh-ih)/2,setsar=1[m${i}];`
      filter += `${current}[m${i}]overlay=${x}:${y}:enable='${enable}'[v${i}];`
    } else {
      filter += `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[m${i}];`
      filter += `${current}[m${i}]overlay=0:0:enable='${enable}'[v${i}];`
    }
    current = `[v${i}]`
  })
  // 图片素材（JPEG 全范围）会把输出带成 yuvj420p：末级强制 limited-range yuv420p
  filter = `${filter.slice(0, -1)};${current}format=yuv420p[fout]`
  current = '[fout]'

  const composedRaw = path.join(input.workDir, 'composed-raw.mp4')
  args.push(
    '-filter_complex',
    filter,
    '-map',
    current,
    '-map',
    `${1 + used.length}:a`,
    '-t',
    durSec,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    composedRaw,
  )
  await runFfmpeg(args)

  // 规范化到 1080×1920（等比补边；混剪产物本身即目标规格，通常透传）
  const normalized = path.join(input.workDir, 'composed.mp4')
  const norm = await normalizeGeneratedVideo(composedRaw, normalized, {
    targetWidth: width,
    targetHeight: height,
    fps: config.video.outputFps,
  })
  if (!norm.transformed) await fsp.copyFile(composedRaw, normalized)
  await fsp.rm(composedRaw, { force: true })
  if (!fs.existsSync(normalized)) throw new Error('混剪成片未生成')

  // 时长校验（AC-M3：时长 = 配音整轨 ±0.5 秒）
  const durationTolerance = 500
  if (Math.abs(norm.durationMs - input.audioDurationMs) > durationTolerance) {
    throw new Error(`混剪成片时长 ${norm.durationMs}ms 与配音 ${input.audioDurationMs}ms 偏差超过 ${durationTolerance}ms`)
  }
  return { path: normalized, durationMs: norm.durationMs, transformed: norm.transformed }
}

/** 封面帧（混剪同样抽首帧；destName 相对成片目录，与 archive 阶段一致） */
export async function composeCover(videoPath: string, durationMs: number): Promise<string> {
  const { extractCoverFrame } = await import('../../../media/inspect.js')
  return extractCoverFrame(videoPath, 'cover.jpg', durationMs)
}
