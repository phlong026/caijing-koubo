import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../../db/index.js'
import { config, paths } from '../../config.js'
import { err } from '../../errors.js'
import { logger } from '../../log.js'
import { newId } from '../../lib/util.js'
import { toDb, utcNow } from '../../lib/time.js'
import type { OutlineNode } from './repo.js'

/**
 * 文章转口播（W3 / FR-S2）。
 * 支持 .docx / .md / .txt / .pdf；上传只按**扩展名 + 魔数**双重校验（§7 安全），存临时目录、不执行宏。
 * 解析产出：纯文本 + 大纲（层级 / 层级标题 / 段落数 / 字数），供人工确认后创建选题与文案。
 */

/** 扩展名 → 允许的魔数签名 */
const MAGIC: Record<string, Array<{ offset: number; bytes: number[] }>> = {
  // docx / zip：PK\x03\x04
  '.docx': [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
  // pdf：%PDF
  '.pdf': [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }],
  // txt / md：无固定签名，按「无 NUL 字节」判定为文本
  '.txt': [],
  '.md': [],
}

const TEXT_EXT = new Set(['.txt', '.md', '.markdown'])

export interface ParsedArticle {
  plainText: string
  outline: OutlineNode[]
  wordCount: number
}

/* ── 校验 ─────────────────────────────────────────────────────────── */

export function validateFileMeta(filename: string, size: number, head: Buffer): string {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.doc') {
    throw err.articleUnsupported('暂不支持旧版 .doc，请用 Word 另存为 .docx 后重新上传', { ext })
  }
  if (!(ext in MAGIC)) {
    throw err.articleUnsupported(`不支持的文件类型 ${ext || '(无扩展名)'}，请上传 .docx / .pdf / .txt / .md`, {
      ext,
      allowed: ['.docx', '.pdf', '.txt', '.md'],
    })
  }
  if (size > config.copy.articleMaxBytes) {
    throw err.articleTooLarge(
      `文件超过 ${Math.round(config.copy.articleMaxBytes / 1024 / 1024)}MB，请压缩后上传`,
      { size, max: config.copy.articleMaxBytes },
    )
  }

  const sig = MAGIC[ext]!
  for (const rule of sig) {
    const slice = head.subarray(rule.offset, rule.offset + rule.bytes.length)
    const ok = rule.bytes.every((b, i) => slice[i] === b)
    if (!ok) {
      throw err.articleUnsupported(`文件内容与扩展名 ${ext} 不符（魔数校验未通过），请确认文件未损坏或被改名`, {
        ext,
      })
    }
  }
  if (TEXT_EXT.has(ext)) {
    // 纯文本文件不应包含 NUL 字节（二进制伪装）
    if (head.includes(0x00)) {
      throw err.articleUnsupported(`文件内容不像纯文本（检测到二进制字节），请确认扩展名`, { ext })
    }
  }
  // 旧版 word 文档伪装成 docx 的情况：PK 头仍会通过，但解析会失败并给出明确错误
  return ext
}

/* ── 入口：从缓冲区解析 ───────────────────────────────────────────── */

export async function parseArticleBuffer(ext: string, buffer: Buffer): Promise<ParsedArticle> {
  let text = ''
  if (ext === '.docx') {
    text = await parseDocx(buffer)
  } else if (ext === '.pdf') {
    text = await parsePdf(buffer)
  } else {
    text = buffer.toString('utf8')
  }
  return buildOutline(ext, text)
}

/* ── docx（mammoth，按标题样式 H1–H3 切分）────────────────────────── */

async function parseDocx(buffer: Buffer): Promise<string> {
  let mammoth: { convertToHtml: (o: { buffer: Buffer }) => Promise<{ value: string }> }
  try {
    mammoth = (await import('mammoth')) as unknown as typeof mammoth
  } catch {
    throw err.internal('docx 解析依赖 mammoth 未安装，请运行 npm install mammoth')
  }
  const { value: html } = await mammoth.convertToHtml({ buffer })
  // HTML → 带层级标记的纯文本（# 前缀复用 md 的解析路径）
  return htmlToMarkedText(html)
}

/**
 * 把 mammoth 输出的 HTML 转成「# 标题」+ 段落的中间格式。
 * 表格按行转文本（风险预案：表格丢失或乱序 → 至少在文本中保留）。
 */
function htmlToMarkedText(html: string): string {
  const out: string[] = []
  const re = /<(h[1-6]|p|li|tr)[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const tag = m[1]!.toLowerCase()
    const text = stripTags(m[2]!).trim()
    if (!text) continue
    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(3, Number(tag.slice(1)))
      out.push(`${'#'.repeat(level)} ${text}`)
    } else if (tag === 'tr') {
      out.push(`行：${text}`)
    } else {
      out.push(text)
    }
  }
  return out.join('\n\n')
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/* ── pdf（pdf-parse 2.x 的 PDFParse 类；扫描件返回 ARTICLE_NO_TEXT）──────── */

async function parsePdf(buffer: Buffer): Promise<string> {
  // P0-4：pdf-parse 2.x **没有 default 导出**，改为 PDFParse 类。
  // 之前 `mod.default(buffer)` 必然抛 TypeError 并被 catch 静默降级到 minimalPdfText，
  // 该兜底只能识别未压缩的 Tj/TJ，FlateDecode 压缩流与中文 CID 字体全部解析不出。
  let PDFParse: new (o: { data: Buffer }) => {
    getText: (params?: { pageJoiner?: string }) => Promise<{ text?: string }>
    destroy: () => Promise<void>
  }
  try {
    const mod = (await import('pdf-parse')) as unknown as { PDFParse: typeof PDFParse }
    PDFParse = mod.PDFParse
  } catch {
    throw err.articleUnsupported('pdf 解析依赖 pdf-parse 未安装，请运行 npm install pdf-parse')
  }
  const parser = new PDFParse({ data: buffer })
  try {
    // 默认会在每页后插入「-- 1 of 3 --」页码行，它会混进大纲与喂给模型的原文，这里关掉
    const r = await parser.getText({ pageJoiner: '' })
    return r.text ?? ''
  } catch (e) {
    // 加密 / 损坏 / 非真实 PDF：明确报错，不再静默兜底成「扫描件」
    throw err.articleUnsupported(
      `PDF 解析失败（文件可能已加密或损坏）：${(e as Error).message}`,
      { reason: 'parse_failed' },
    )
  } finally {
    await parser.destroy().catch(() => {})
  }
}

/* ── 大纲构建（md 按 # 层级；txt/pdf 按空行切段）──────────────────── */

export function buildOutline(ext: string, raw: string): ParsedArticle {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
  if (!text.trim()) {
    throw err.articleNoText('未识别到文字，请粘贴文本后重试（扫描版 PDF 请先转换为可复制文本）')
  }

  const isMd = ext === '.md' || ext === '.markdown' || ext === '.docx'
  const outline: OutlineNode[] = []
  const lines = text.split('\n')

  if (isMd) {
    // 按 # 标题切分；无标题时整体作为一个顶层节点
    let current: OutlineNode | null = null
    let buf: string[] = []
    let idx = 0
    const flush = () => {
      if (!current) return
      current.paragraphs = buf.filter((s) => s.trim()).length
      current.chars = buf.join('').replace(/\s/g, '').length
      outline.push(current)
      buf = []
    }
    for (const line of lines) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line.trim())
      if (h) {
        flush()
        const level = Math.min(3, h[1]!.length)
        current = { index: idx++, level, title: h[2]!.trim().slice(0, 80), paragraphs: 0, chars: 0 }
        buf = []
        continue
      }
      if (!current) {
        current = { index: idx++, level: 1, title: '正文', paragraphs: 0, chars: 0 }
      }
      buf.push(line)
    }
    flush()
  }

  if (!outline.length) {
    // txt / pdf：按空行切段，无层级
    const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
    const chunkSize = Math.max(1, Math.ceil(paras.length / 12)) // 最多 12 个节点
    for (let i = 0; i < paras.length; i += chunkSize) {
      const slice = paras.slice(i, i + chunkSize)
      outline.push({
        index: outline.length,
        level: 0,
        title: (slice[0] ?? '').slice(0, 40) || `段落组 ${outline.length + 1}`,
        paragraphs: slice.length,
        chars: slice.join('').replace(/\s/g, '').length,
      })
    }
  }

  // 正文 ≤20000 字，超出拒绝并提示拆分（FR-S2）
  const plainText = text.trim()
  const charCount = plainText.replace(/\s/g, '').length
  if (charCount > config.copy.articleMaxChars) {
    throw err.articleTooLarge(`正文 ${charCount} 字，超过 ${config.copy.articleMaxChars} 字上限，请拆分后上传`, {
      chars: charCount,
      max: config.copy.articleMaxChars,
    })
  }

  return { plainText, outline, wordCount: charCount }
}

/* ── 落库与临时文件 ───────────────────────────────────────────────── */

export async function saveArticle(
  input: {
    filename: string | null
    mime: string | null
    size: number
    storagePath: string | null
    parsed: ParsedArticle
    operator: string
  },
): Promise<{ articleId: string; outline: OutlineNode[]; wordCount: number }> {
  const db = getDb()
  const id = newId('art')
  await db.run(
    `INSERT INTO \`article_source\`
      (\`id\`, \`filename\`, \`mime\`, \`size\`, \`storage_path\`, \`outline\`, \`plain_text\`, \`word_count\`, \`status\`, \`error\`, \`created_by\`, \`created_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'parsed', NULL, ?, ?)`,
    [
      id,
      input.filename,
      input.mime,
      input.size,
      input.storagePath,
      JSON.stringify(input.parsed.outline),
      input.parsed.plainText,
      input.parsed.wordCount,
      input.operator,
      toDb(utcNow()),
    ],
  )
  return { articleId: id, outline: input.parsed.outline, wordCount: input.parsed.wordCount }
}

/** 临时目录（30 天清理由运维策略执行，此处仅负责写入） */
export function articleTempDir(): string {
  const dir = path.join(paths.tempDir, 'articles')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function writeTempFile(name: string, buffer: Buffer): string {
  const dir = articleTempDir()
  const safe = `${Date.now()}_${newId('f')}${path.extname(name || '').slice(0, 8)}`
  const full = path.join(dir, safe)
  fs.writeFileSync(full, buffer)
  logger.debug({ full, size: buffer.length }, 'article.temp_written')
  return full
}

/** 解析纯文本粘贴（FR-S2 粘贴路径） */
export function parsePastedText(text: string): ParsedArticle {
  const t = String(text ?? '')
  if (!t.trim()) throw err.articleNoText('粘贴内容为空')
  return buildOutline('.txt', t)
}
