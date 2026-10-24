import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../config.js'
import { checkFfmpeg } from '../../media/pipeline.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { resolveDefaultFontFile } from '../material/fonts.js'

/**
 * 剪辑渲染引擎（任务书 EC2）：
 *  - ffmpeg：完整链路（ASS 字幕烧录 + drawtext 风险尾页），要求环境带 libass/freetype；
 *  - mock：仅降级文字渲染（字幕直过、尾页纯黑片段），剪气口 / BGM 照跑——
 *    保证无 libass 环境（含 smoke）全链路可跑。
 * 引擎选择：环境完备 → ffmpeg；缺滤镜或字体且 MOCK_FALLBACK → mock；否则拒绝。
 */

export interface MediaEnv {
  ffmpeg: boolean
  ass: boolean
  drawtext: boolean
  silencedetect: boolean
  amix: boolean
  concat: boolean
  /** fontsDir 下首个可用字体文件（default 字体）；无则 null */
  fontFile: string | null
  fontFiles: string[]
}

let envCache: MediaEnv | null = null

async function listFilters(): Promise<Set<string>> {
  const names = new Set<string>()
  await new Promise<void>((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-filters'], { windowsHide: true }, (e, stdout) => {
      if (e) return resolve()
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/^\s*[. ]{3}\s+(\S+)\s+/)
        if (m) names.add(m[1]!)
      }
      resolve()
    })
  })
  return names
}

/**
 * default 字体文件（FR-F4）：素材库启用集中文件名排序首个；
 * 无启用字体时保持历史行为（fontsDir 目录首个文件）——手工放置场景不回归。
 */
export async function resolveFontFile(): Promise<string | null> {
  return resolveDefaultFontFile()
}

export async function detectMediaEnv(force = false): Promise<MediaEnv> {
  if (envCache && !force) return envCache
  const ffmpegOk = await checkFfmpeg().then(
    () => true,
    () => false,
  )
  const filters = ffmpegOk ? await listFilters() : new Set<string>()
  const fontFile = await resolveFontFile()
  const fontsDir = path.resolve(config.cut.fontsDir)
  let fontFiles: string[] = []
  try {
    fontFiles = (await fsp.readdir(fontsDir)).filter((f) => /\.(otf|ttf|ttc)$/i.test(f)).sort()
  } catch {
    fontFiles = []
  }
  envCache = {
    ffmpeg: ffmpegOk,
    ass: filters.has('ass') || filters.has('subtitles'),
    drawtext: filters.has('drawtext'),
    silencedetect: filters.has('silencedetect'),
    amix: filters.has('amix'),
    concat: filters.has('concat'),
    fontFile,
    fontFiles,
  }
  if (!envCache.ass || !envCache.drawtext || !envCache.fontFile) {
    logger.warn(
      {
        ass: envCache.ass,
        drawtext: envCache.drawtext,
        font: envCache.fontFile,
        hint: '部署环境请安装带 libass/freetype 的 ffmpeg，并将 OFL 字体放入 ' + fontsDir,
      },
      'cut.media_env_incomplete_engine_will_degrade_to_mock',
    )
  }
  return envCache
}

export type CutEngine = 'ffmpeg' | 'mock'

/** 引擎解析（AC-0.2）：环境完备 → ffmpeg；缺失且 MOCK_FALLBACK → mock；否则 503 */
export async function resolveCutEngine(): Promise<CutEngine> {
  const env = await detectMediaEnv()
  if (env.ffmpeg && env.ass && env.drawtext && env.fontFile) return 'ffmpeg'
  if (config.mockFallback) return 'mock'
  throw err.cutEngineUnavailable('渲染环境不满足要求', { env })
}

/** 环境是否具备真实渲染能力（前端展示用） */
export async function engineCapability(): Promise<{ engine: CutEngine; env: MediaEnv }> {
  const engine = await resolveCutEngine()
  return { engine, env: await detectMediaEnv() }
}

/** ffmpeg 运行器（照抄 mixcut/compose.runFfmpeg 模式：argv 拼装 + stderr 尾部报错 + 超时） */
export function runFfmpeg(args: string[], timeoutMs = config.cut.stepTimeoutMs, label = '剪辑渲染'): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawnFfmpeg(args)
    let stderr = ''
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error(`${label}超时`))
    }, timeoutMs)
    p.stderr.on('data', (d) => (stderr += String(d)))
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`ffmpeg 不可用：${e.message}`))
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${label}失败（code=${code}）：${stderr.slice(-400)}`))
    })
  })
}

function spawnFfmpeg(args: string[]) {
  return spawn('ffmpeg', ['-y', '-v', 'error', '-nostdin', ...args], { windowsHide: true })
}

/** 字体目录（存在性惰性创建，供部署初始化提示） */
export async function ensureFontsDir(): Promise<string> {
  const dir = path.resolve(config.cut.fontsDir)
  await fs.promises.mkdir(dir, { recursive: true }).catch(() => undefined)
  return dir
}
