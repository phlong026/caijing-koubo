import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import axios from 'axios'
import { paths } from '../config.js'
import { logger } from '../log.js'

/** D9：server 运行环境须具备 ffmpeg 与可写临时目录 */
export async function ensureTempDir(): Promise<string> {
  await fsp.mkdir(paths.tempDir, { recursive: true })
  return paths.tempDir
}

let ffmpegChecked = false
let ffmpegOk = false

export async function checkFfmpeg(): Promise<{ ok: boolean; version?: string; error?: string }> {
  if (ffmpegChecked) return { ok: ffmpegOk, version: ffmpegOk ? 'cached' : undefined }
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'])
    let out = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.on('error', (e) => {
      ffmpegChecked = true
      ffmpegOk = false
      logger.error({ err: e.message }, 'ffmpeg.missing')
      resolve({ ok: false, error: `ffmpeg 不可用：${e.message}` })
    })
    p.on('close', (code) => {
      ffmpegChecked = true
      ffmpegOk = code === 0
      const version = /ffmpeg version (\S+)/.exec(out)?.[1]
      resolve({ ok: ffmpegOk, version })
    })
  })
}

/** 下载到临时目录（D11 基线第一步） */
export async function downloadToTemp(url: string, filename: string): Promise<string> {
  await ensureTempDir()
  const dest = path.join(paths.tempDir, filename)
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 180_000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Referer: 'https://www.douyin.com/',
    },
  })
  const writer = fs.createWriteStream(dest)
  await new Promise<void>((resolve, reject) => {
    ;(res.data as NodeJS.ReadableStream).pipe(writer)
    writer.on('finish', () => resolve())
    writer.on('error', reject)
  })
  return dest
}

/** ffmpeg 抽音轨：16kHz 单声道（D11） */
export async function extractAudio(videoPath: string, outName: string): Promise<string> {
  const chk = await checkFfmpeg()
  if (!chk.ok) throw new Error(chk.error ?? 'ffmpeg 不可用')
  await ensureTempDir()
  const dest = path.join(paths.tempDir, outName)
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      dest,
    ])
    let err = ''
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 抽音轨失败（code=${code}）：${err.slice(-300)}`))
    })
  })
  return dest
}

/** 清理临时文件（OSS 对象按生命周期规则自动清理） */
export async function cleanup(files: Array<string | null | undefined>): Promise<void> {
  for (const f of files) {
    if (!f) continue
    try {
      await fsp.unlink(f)
    } catch {
      /* 已删除则忽略 */
    }
  }
}

export async function readFileBuffer(p: string): Promise<Buffer> {
  return fsp.readFile(p)
}
