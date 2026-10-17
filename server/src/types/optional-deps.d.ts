/**
 * 可选依赖的类型声明（任务书 W3：docx 用 mammoth、pdf 用 pdf-parse）。
 * 这两个包按需安装；未安装时 article.ts 走内置兜底并给出可执行的错误提示，
 * 因此这里只声明最小可用签名，避免把整包类型当作硬依赖。
 */
declare module 'mammoth' {
  export function convertToHtml(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>
  export function extractRawText(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>
}

declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string
    numpages: number
    info?: Record<string, unknown>
  }
  function pdfParse(buffer: Buffer): Promise<PdfParseResult>
  export default pdfParse
}
