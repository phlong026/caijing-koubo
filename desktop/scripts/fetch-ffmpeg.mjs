#!/usr/bin/env node
/**
 * 下载随包分发的 ffmpeg（带 libass/freetype，字幕烧录与风险尾页必需）。
 *
 * 来源（均为官方静态构建，含 libass）：
 *   mac-arm64  yt-dlp/FFmpeg-Builds  ffmpeg-master-latest-macos-arm64.zip
 *   win-x64    BtbN/FFmpeg-Builds    ffmpeg-master-latest-win64-gpl.zip
 *
 * 国内网络可设镜像：FFMPEG_DL_MIRROR（默认直连 GitHub）
 * 也可跳过下载：把对应平台的 ffmpeg 可执行文件手动放到 desktop/resources/<平台>/ 下。
 */
import { mkdir, writeFile, rm, chmod, access } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const mirror = process.env.FFMPEG_DL_MIRROR || 'https://github.com'

const TARGETS = [
  {
    dir: 'mac-arm64',
    // osxexperts 不走 mirror；zip 内是顶层 ffmpeg 可执行文件
    url: 'https://www.osxexperts.net/ffmpeg9arm.zip',
    binary: 'ffmpeg',
  },
  {
    dir: 'win-x64',
    url: `${mirror}/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip`,
    binary: 'ffmpeg.exe',
  },
]

/** 下载（支持断点续传；慢源可反复执行本脚本直至完成） */
async function download(url, dest) {
  const { statSync } = await import('node:fs')
  let have = 0
  try {
    have = statSync(dest).size
  } catch {}
  console.log(`↓ ${url}${have ? `（续传自 ${(have / 1048576).toFixed(1)}MB）` : ''}`)
  const res = await fetch(url, { redirect: 'follow', headers: have ? { Range: `bytes=${have}-` } : {} })
  if (!res.ok && res.status !== 206) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const resumed = res.status === 206
  const total = Number(res.headers.get('content-length') ?? 0) + (resumed ? have : 0)
  let got = have
  const stream = createWriteStream(dest, { flags: resumed ? 'a' : 'w' })
  for await (const chunk of res.body) {
    stream.write(chunk)
    got += chunk.length
    if (total) process.stdout.write(`\r  ${((got / total) * 100).toFixed(1)}% (${(got / 1048576).toFixed(1)}MB)`)
  }
  await new Promise((r) => stream.end(r))
  console.log('')
  if (total && got < total) throw new Error(`下载不完整（${got}/${total}），请重跑脚本续传`)
}

async function unzip(zip, outDir) {
  if (process.platform === 'darwin') {
    spawnSync('unzip', ['-oq', zip, '-d', outDir], { stdio: 'inherit' })
    return
  }
  // Linux/CI：python 兜底解压
  spawnSync('python3', ['-c', `import zipfile;zipfile.ZipFile('${zip}').extractall('${outDir}')`], { stdio: 'inherit' })
}

async function findBinary(dir, name) {
  // zip 内是 bin/ffmpeg 或顶层 ffmpeg；递归找
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  const hit = entries.find((e) => e.isFile() && e.name === name)
  return hit ? path.join(e_path(hit)) : null
}
function e_path(e) {
  return path.join(e.parentPath ?? e.path, e.name)
}

const only = process.argv[2] // 可只跑一个平台：mac-arm64 / win-x64
for (const t of TARGETS) {
  if (only && t.dir !== only) continue
  const outDir = path.join(root, 'resources', t.dir)
  const finalPath = path.join(outDir, t.binary)
  if (existsSync(finalPath)) {
    console.log(`✓ ${t.dir} 已存在，跳过（如需重下请先删除 ${finalPath}）`)
    continue
  }
  await mkdir(outDir, { recursive: true })
  const zip = path.join(outDir, 'dl.zip')
  await download(t.url, zip).catch((e) => {
    console.error(`⚠ ${t.dir} 下载中断：${e.message}（dl.zip 已保留，重跑本脚本断点续传）`)
    process.exitCode = 1
    return 'SKIP'
  })
  if (process.exitCode) continue
  const extractDir = path.join(outDir, 'extracted')
  await rm(extractDir, { recursive: true, force: true })
  await mkdir(extractDir, { recursive: true })
  await unzip(zip, extractDir)
  const found = await findBinary(extractDir, t.binary)
  if (!found) throw new Error(`解压后未找到 ${t.binary}（在 ${extractDir}）`)
  const { copyFile } = await import('node:fs/promises')
  await copyFile(found, finalPath)
  await chmod(finalPath, 0o755)
  await rm(extractDir, { recursive: true, force: true })
  await rm(zip, { force: true })
  // libass 验证：subtitles 滤镜必须存在
  const chk = spawnSync(finalPath, ['-hide_banner', '-filters'], { encoding: 'utf8' })
  const hasAss = /\bsubtitles\b/.test(chk.stdout ?? '')
  console.log(`${hasAss ? '✅' : '❌'} ${t.dir}: ${finalPath} libass(subtitles)${hasAss ? '' : ' 缺失！'}`)
  if (!hasAss) process.exitCode = 1
}
console.log('fetch-ffmpeg done')
