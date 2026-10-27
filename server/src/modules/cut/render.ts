import fs from 'node:fs/promises'
import path from 'node:path'
import { config, paths } from '../../config.js'
import { logger } from '../../log.js'
import { downloadObjectToFile, putObjectFromFile } from '../../integrations/aliyun-oss/client.js'
import { normalizeGeneratedVideo, extractCoverFrame, probeMedia } from '../../media/inspect.js'
import { runFfmpeg, resolveCutEngine, detectMediaEnv } from './engine.js'
import { buildAss, buildSubtitleFilter } from './subtitle.js'
import { buildKeepSegments, parseSilences, remapTimeline, silencedetectArgs, segmentCutArgs, concatList } from './breathe.js'
import { resolveFontFileByName } from '../material/fonts.js'
import type { CutStage, KeepSpan } from './types.js'
import type { TimelineItem } from '../video/types.js'
import type { VideoCut } from './types.js'

/**
 * 渲染流水线（任务书 §3.4 / CE1~CE4）：
 * download → breathe(可选) → subtitle(可选) → bgm(可选) → tail(可选) → normalize → upload。
 * 一期分段实现（≤5 次重编码）；取消检查点在各步之间；任一步失败抛错由 worker 落 failed。
 */

/** 口播音轨提取：48kHz 立体声（EC6——不复用 pipeline.extractAudio 的 16kHz 单声道 ASR 版本） */
async function extractAudioStereo(input: string, out: string, timeoutMs: number): Promise<void> {
  await runFfmpeg(['-i', input, '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out], timeoutMs, '提取口播音轨')
}

/** silencedetect 静音检测：跑 ffmpeg 收集 stderr */
async function detectSilences(input: string, noiseDb: number, minSilenceMs: number, timeoutMs: number): Promise<ReturnType<typeof parseSilences>> {
  const { spawn } = await import('node:child_process')
  const args = ['-i', input, ...silencedetectArgs(noiseDb, minSilenceMs)]
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', ...args], { windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error('静音检测超时'))
    }, timeoutMs)
    p.stderr.on('data', (d) => (stderr += String(d)))
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`ffmpeg 不可用：${e.message}`))
    })
    p.on('close', () => {
      clearTimeout(timer)
      resolve(parseSilences(stderr))
    })
  })
}

/** 剪气口步骤：keepSegments 分段重编码 + concat 拼回；返回新文件路径与重映射后时间轴 */
async function runBreathe(
  input: string,
  workDir: string,
  timeline: TimelineItem[],
  params: { noiseDb: number; minSilenceMs: number; keepGapMs: number },
  durationMs: number,
  onProgress: () => Promise<void> | void,
): Promise<{ file: string; timeline: TimelineItem[]; keeps: KeepSpan[] }> {
  const silences = await detectSilences(input, params.noiseDb, params.minSilenceMs, config.cut.stepTimeoutMs)
  const keeps = buildKeepSegments(durationMs, silences, params.minSilenceMs, params.keepGapMs)
  // 全长保留（无有效裁剪）→ 原样返回
  if (keeps.length === 1 && keeps[0]!.startMs <= 1 && keeps[0]!.endMs >= durationMs - 1) {
    return { file: input, timeline, keeps }
  }
  const segFiles: string[] = []
  for (let i = 0; i < keeps.length; i++) {
    const f = path.join(workDir, `breathe_${String(i).padStart(4, '0')}.mp4`)
    await runFfmpeg(segmentCutArgs(input, keeps[i]!, f), config.cut.stepTimeoutMs, `剪气口分段 ${i + 1}/${keeps.length}`)
    segFiles.push(f)
    void onProgress
  }
  const listFile = path.join(workDir, 'breathe_list.txt')
  await fs.writeFile(listFile, concatList(segFiles), 'utf8')
  const out = path.join(workDir, 'breathe.mp4')
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out], config.cut.stepTimeoutMs, '剪气口拼接')
  await onProgress()
  return { file: out, timeline: remapTimeline(timeline, keeps), keeps }
}

/** 字幕烧录步骤（mock 引擎跳过） */
async function runSubtitle(cut: VideoCut, input: string, workDir: string, timeline: TimelineItem[], fontFile: string | null): Promise<string> {
  const assPath = path.join(workDir, 'subs.ass')
  const segments = cut.segments.map((s, i) => ({
    index: s.index,
    text: s.text,
    kind: s.kind,
    edited: s.edited,
    startMs: timeline[i]?.startMs ?? s.startMs,
    endMs: timeline[i]?.endMs ?? s.endMs,
  }))
  const width = cut.width || config.video.outputWidth
  const height = cut.height || config.video.outputHeight
  await fs.writeFile(assPath, buildAss(segments, cut.subtitleStyle, { width, height, fontFile: fontFile ?? 'default' }), 'utf8')
  const out = path.join(workDir, 'subtitled.mp4')
  const filter = buildSubtitleFilter(assPath, fontFile ?? 'default', true)
  await runFfmpeg(['-i', input, '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'copy', out], config.cut.stepTimeoutMs, '字幕烧录')
  return out
}

/** BGM 混音步骤（EC6 / R4 修正版） */
async function runBgm(cut: VideoCut, input: string, bgmPath: string, workDir: string): Promise<string> {
  const probe = await probeMedia(input)
  const durSec = (probe.durationMs ?? 0) / 1000
  const looped = path.join(workDir, 'bgm_loop.wav')
  // 循环：amovie 滤镜自循环不如 stream_loop 直观；用 -stream_loop -1 + -t 裁剪
  await runFfmpeg(
    ['-stream_loop', '-1', '-i', bgmPath, '-t', durSec.toFixed(3), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', looped],
    config.cut.stepTimeoutMs,
    'BGM 循环对齐',
  )
  const fadeInSec = (cut.bgmFadeIn / 1000).toFixed(3)
  const fadeOutStart = Math.max(0, durSec - cut.bgmFadeOut / 1000).toFixed(3)
  const fadeOutSec = (cut.bgmFadeOut / 1000).toFixed(3)
  const mixed = path.join(workDir, 'mixed.m4a')
  await runFfmpeg(
    [
      '-i', input,
      '-i', looped,
      '-filter_complex',
      `[1:a]volume=${cut.bgmVolume},afade=t=in:st=0:d=${fadeInSec},afade=t=out:st=${fadeOutStart}:d=${fadeOutSec}[bgm];` +
        `[0:a][bgm]amix=inputs=2:normalize=0,alimiter=limit=0.95[a]`,
      '-map', '0:v:0', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      mixed,
    ],
    config.cut.stepTimeoutMs,
    'BGM 混音',
  )
  return mixed
}

/** 风险尾页步骤（FR-K2 / EC7；mock 引擎纯黑片段） */
async function runTail(cut: VideoCut, input: string, workDir: string, mock: boolean, fontFile: string | null): Promise<string> {
  const probe = await probeMedia(input)
  const width = cut.width || config.video.outputWidth
  const height = cut.height || config.video.outputHeight
  const fps = 30
  const tailSec = Math.min(Math.max(1, cut.riskTailSeconds), config.cut.riskTailMaxSeconds)
  const tail = path.join(workDir, 'tail.mp4')
  if (mock) {
    await runFfmpeg(
      ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${tailSec}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', tail],
      config.cut.stepTimeoutMs,
      '风险尾页（mock）',
    )
  } else {
    const lines = wrapTailText(cut.riskTailText ?? '')
    const drawtext = lines
      .map((line, i) => {
        const y = `(h-text_h)/2+${(i - (lines.length - 1) / 2) * Math.round(cut.subtitleStyle.fontSize * 1.4)}`
        return `drawtext=fontfile='${fontFile!.replace(/\\/g, '/').replace(/:/g, '\\:')}':text='${line.replace(/'/g, '')}':fontcolor=white:fontsize=${cut.subtitleStyle.fontSize}:x=(w-text_w)/2:y=${y}`
      })
      .join(',')
    await runFfmpeg(
      ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${tailSec}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-vf', drawtext, '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', tail],
      config.cut.stepTimeoutMs,
      '风险尾页渲染',
    )
  }
  const listFile = path.join(workDir, 'tail_list.txt')
  await fs.writeFile(listFile, concatList([input, tail]), 'utf8')
  const out = path.join(workDir, 'with_tail.mp4')
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-pix_fmt', 'yuv420p', out], config.cut.stepTimeoutMs, '尾页拼接')
  return out
}

/** 尾页文案换行（每行 ≤ 18 字，最多 6 行） */
function wrapTailText(text: string, maxChars = 18, maxLines = 6): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  const lines: string[] = []
  let rest = clean
  while (rest && lines.length < maxLines) {
    lines.push(rest.slice(0, maxChars))
    rest = rest.slice(maxChars)
  }
  if (rest) lines[maxLines - 1] = lines[maxLines - 1]! + '…'
  return lines.length ? lines : ['']
}

export interface RenderOutcome {
  resultKey: string
  coverKey: string | null
  durationMs: number
  width: number
  height: number
  sizeBytes: number
  timeline: TimelineItem[]
  contentHash: string
  isMock: boolean
}

/**
 * 流水线主入口（§3.4）：输入 base 本地文件路径与 cut 行；输出归档产物。
 * baseSourcePath 由 worker 预下载（download 阶段）。
 */
export async function renderCut(
  cut: VideoCut,
  baseSourcePath: string,
  bgmLocalPath: string | null,
  workDir: string,
  contentHash: string,
  hooks: { onStage: (stage: CutStage, progress: number) => Promise<void> | void; isCancelled: () => Promise<boolean> | boolean },
): Promise<RenderOutcome> {
  const engine = await resolveCutEngine()
  const mock = engine === 'mock'
  const env = await detectMediaEnv()
  let current = baseSourcePath
  let timeline: TimelineItem[] = cut.segments.map((s, i) => ({ index: s.index, kind: s.kind, text: s.text, startMs: s.startMs, endMs: s.endMs }))
  await hooks.onStage('download', 5)

  // 1 breathe（mock 下照跑——AC-R1/R2 可自动化）
  if (cut.breatheEnabled && cut.breatheParams) {
    await hooks.onStage('breathe', 8)
    const r = await runBreathe(current, workDir, timeline, cut.breatheParams, cut.durationMs, async () => {
      await hooks.onStage('breathe', 18)
    })
    current = r.file
    timeline = r.timeline
  }
  if (await hooks.isCancelled()) throw new CancelledError()

  // ML4：按字幕样式 fontName 选字体文件；停用 / 丢失时回退 default 并 warn（§3.2 即时生效矩阵）
  const selectedFont = await resolveFontFileByName(cut.subtitleStyle.fontName)
  if (!selectedFont && cut.subtitleStyle.fontName && cut.subtitleStyle.fontName !== 'default') {
    logger.warn({ cutId: cut.id, fontName: cut.subtitleStyle.fontName }, 'cut.font_unavailable_fallback_default')
  }
  const fontFile = selectedFont ?? env.fontFile

  // 2 subtitle（mock 降级：直过）
  if (cut.subtitleEnabled) {
    await hooks.onStage('subtitle', 20)
    if (!mock && fontFile) {
      current = await runSubtitle(cut, current, workDir, timeline, fontFile)
    } else {
      logger.info({ cutId: cut.id }, 'cut.subtitle_skipped_mock_engine')
    }
  }
  if (await hooks.isCancelled()) throw new CancelledError()

  // 3 bgm（mock 下照跑）
  if (cut.bgmEnabled && bgmLocalPath) {
    await hooks.onStage('bgm', 55)
    current = await runBgm(cut, current, bgmLocalPath, workDir)
  }
  if (await hooks.isCancelled()) throw new CancelledError()

  // 4 tail（mock 降级纯黑）
  if (cut.riskTailEnabled && cut.riskTailText) {
    await hooks.onStage('tail', 75)
    current = await runTail(cut, current, workDir, mock, fontFile)
  }
  if (await hooks.isCancelled()) throw new CancelledError()

  // 5 normalize + cover（达标透传时不写目标文件，直接用当前产物）
  await hooks.onStage('normalize', 85)
  const normalized = path.join(workDir, 'final.mp4')
  const result = await normalizeGeneratedVideo(current, normalized, {
    targetWidth: cut.width || config.video.outputWidth,
    targetHeight: cut.height || config.video.outputHeight,
  })
  const finalFile = result.transformed ? normalized : current
  const probe = await probeMedia(finalFile)
  const durationMs = result.durationMs || probe.durationMs || 0
  const coverPath = path.join(workDir, 'cover.jpg')
  let coverKey: string | null = null
  try {
    // extractCoverFrame 的 destName 相对源文件目录拼接：只传文件名
    await extractCoverFrame(finalFile, 'cover.jpg', probe.durationMs ?? undefined)
  } catch (e) {
    logger.warn({ err: (e as Error).message, cutId: cut.id }, 'cut.cover_extract_failed')
  }

  // 6 upload
  await hooks.onStage('uploading', 92)
  const resultKey = `video-jobs/${cut.videoJobId}/cuts/${cut.versionNo}/final.mp4`
  const put = await putObjectFromFile(finalFile, resultKey)
  if (coverPath && (await fs.stat(coverPath).then(() => true, () => false))) {
    const coverKeyPath = `video-jobs/${cut.videoJobId}/cuts/${cut.versionNo}/cover.jpg`
    const coverPut = await putObjectFromFile(coverPath, coverKeyPath)
    coverKey = coverPut.key
  }
  const stat = await fs.stat(finalFile)

  return {
    resultKey: put.key,
    coverKey,
    durationMs,
    width: result.width,
    height: result.height,
    sizeBytes: stat.size,
    timeline,
    contentHash,
    isMock: mock,
  }
}

export class CancelledError extends Error {
  constructor() {
    super('渲染已取消')
  }
}

/** 渲染输入的 base 下载（download 阶段由 worker 调用） */
export async function downloadBase(jobId: string, resultKey: string, workDir: string): Promise<string> {
  const dest = path.join(workDir, 'base.mp4')
  const { isOssEnabled } = await import('../../integrations/aliyun-oss/client.js')
  if (isOssEnabled()) {
    await downloadObjectToFile(resultKey, dest)
  } else {
    await fs.copyFile(path.join(paths.dataDir, 'oss', resultKey), dest)
  }
  void jobId
  return dest
}

export async function makeWorkDir(cutId: string): Promise<string> {
  const dir = path.join(paths.tempDir, 'video-cuts', cutId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function cleanupWorkDir(cutId: string): Promise<void> {
  await fs.rm(path.join(paths.tempDir, 'video-cuts', cutId), { recursive: true, force: true }).catch(() => undefined)
}
