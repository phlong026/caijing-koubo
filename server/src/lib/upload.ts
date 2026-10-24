import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { err } from '../errors.js'

/**
 * 上传文件「扩展名 + 魔数」双重校验（R31，从 copy/article.ts 抽成共用）。
 * 人物库素材（照片 / 分身素材 / 背景 / 空镜 / 授权材料 / 声音样本）统一走这里；
 * 结构级校验（图片尺寸、视频流）在 media/inspect.ts 与素材处理队列里完成。
 */

export type MediaFamily = 'image' | 'video' | 'audio' | 'document'

export interface FileTypeRule {
  exts: string[]
  mimes: string[]
  family: MediaFamily
  /** 魔数签名：任一条命中即通过；空数组 = 无固定签名（调用方按家族补充判定） */
  magic: Array<{ offset: number; bytes: number[] }>
  maxBytes: number
}

const RULES: FileTypeRule[] = [
  {
    exts: ['.jpg', '.jpeg'],
    mimes: ['image/jpeg'],
    family: 'image',
    magic: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
    maxBytes: 10 * 1024 * 1024,
  },
  {
    exts: ['.png'],
    mimes: ['image/png'],
    family: 'image',
    magic: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
    maxBytes: 10 * 1024 * 1024,
  },
  {
    exts: ['.webp'],
    mimes: ['image/webp'],
    family: 'image',
    // RIFF....WEBP
    magic: [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }],
    maxBytes: 10 * 1024 * 1024,
  },
  {
    exts: ['.mp4', '.mov'],
    mimes: ['video/mp4', 'video/quicktime'],
    family: 'video',
    // ftyp 位于 offset 4（兼容部分 mov 变体）
    magic: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
    maxBytes: 200 * 1024 * 1024,
  },
  {
    exts: ['.wav'],
    mimes: ['audio/wav', 'audio/x-wav'],
    family: 'audio',
    magic: [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }],
    maxBytes: 20 * 1024 * 1024,
  },
  {
    exts: ['.mp3'],
    mimes: ['audio/mpeg'],
    family: 'audio',
    // ID3 或帧同步 0xFFEx
    magic: [
      { offset: 0, bytes: [0x49, 0x44, 0x33] },
      { offset: 0, bytes: [0xff, 0xfb] },
    ],
    maxBytes: 20 * 1024 * 1024,
  },
  {
    exts: ['.m4a'],
    mimes: ['audio/mp4', 'audio/x-m4a'],
    family: 'audio',
    magic: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
    maxBytes: 20 * 1024 * 1024,
  },
  {
    exts: ['.pdf'],
    mimes: ['application/pdf'],
    family: 'document',
    magic: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }],
    maxBytes: 20 * 1024 * 1024,
  },
]

export function ruleForExt(ext: string): FileTypeRule | undefined {
  return RULES.find((r) => r.exts.includes(ext.toLowerCase()))
}

export function ruleForFamily(family: MediaFamily): FileTypeRule[] {
  return RULES.filter((r) => r.family === family)
}

export interface ValidatedFileMeta {
  ext: string
  family: MediaFamily
  maxBytes: number
  mime: string
}

/**
 * 扩展名 + 大小 + 魔数校验。
 * 失败分别抛 ASSET_UNSUPPORTED_TYPE / ASSET_TOO_LARGE（与任务书 §5.2 对齐）。
 */
export function validateUploadFile(
  filename: string,
  size: number,
  head: Buffer,
  opts: { allowedExts?: string[]; maxBytes?: number } = {},
): ValidatedFileMeta {
  const ext = path.extname(filename).toLowerCase()
  if (!ext) {
    throw err.assetUnsupported('文件缺少扩展名，无法识别类型', { filename })
  }
  const rule = ruleForExt(ext)
  if (!rule) {
    throw err.assetUnsupported(`不支持的文件类型 ${ext}`, { ext, allowed: opts.allowedExts })
  }
  if (opts.allowedExts && !opts.allowedExts.includes(ext)) {
    throw err.assetUnsupported(`该素材仅支持 ${opts.allowedExts.join(' / ')} 格式`, { ext, allowed: opts.allowedExts })
  }
  const maxBytes = opts.maxBytes ?? rule.maxBytes
  if (size > maxBytes) {
    throw err.assetTooLarge(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, { size, maxBytes })
  }
  if (size === 0) {
    throw err.assetUnsupported('文件内容为空', { ext })
  }
  if (rule.magic.length) {
    const hit = rule.magic.some((m) => m.bytes.every((b, i) => head[m.offset + i] === b))
    if (!hit) {
      throw err.assetUnsupported(`文件内容与扩展名 ${ext} 不符（魔数校验未通过），请确认文件未损坏或被改名`, { ext })
    }
  }
  return { ext, family: rule.family, maxBytes, mime: rule.mimes[0] }
}

/** 读取文件头用于魔数校验（16 字节足够覆盖上述全部签名） */
export const MAGIC_HEAD_BYTES = 16

/** 流式计算文件 SHA-256（P2-2：分身素材最大 200MB，不能整份读入内存） */
export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest('hex')
}
