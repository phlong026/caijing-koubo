import axios, { type AxiosInstance } from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import { config, hasHifly } from '../../config.js'
import { err } from '../../errors.js'
import { logApiCall } from '../../modules/metrics/call-log.js'
import { newId } from '../../lib/util.js'

/**
 * 飞影 HiFly 开放平台 V2 客户端（R1~R4 平移众墅之家 hifly.py，已在生产跑通）。
 *  - 全部端点：avatar / voice / video / audio / tool / account；
 *  - Bearer 鉴权；信封解析（code 可为数字或数字字符串；上传凭证接口无 code）；
 *  - 状态码 1/2/3/4 → WAITING/PROCESSING/DONE/FAILED；video_Url 拼写兼容；
 *  - 标题 ≤20 字、TTS 文本 ≤10000 字；JSON 60s / 二进制 300s 双超时；
 *  - 创建类请求只要没拿到飞影业务码即判「提交结果未知」（HiflySubmissionUncertain，L9）。
 *
 * 端点路径集中在 PATHS：PL4a 真实账号探活时逐项核对（§10 风险「飞影接口变化」），
 * 契约测试（scripts/test-hifly-protocol.ts）固定请求体与响应样例，接口变化先改测试。
 */

/* ── 端点路径（与众墅之家生产实现逐字对齐：/api/v2/hifly 前缀）───────── */
export const PATHS = {
  avatarCreateByVideo: '/api/v2/hifly/avatar/create_by_video',
  avatarCreateByImage: '/api/v2/hifly/avatar/create_by_image',
  avatarTask: '/api/v2/hifly/avatar/task',
  avatarList: '/api/v2/hifly/avatar/list',
  voiceCreate: '/api/v2/hifly/voice/create',
  voiceEdit: '/api/v2/hifly/voice/edit',
  voiceTask: '/api/v2/hifly/voice/task',
  voiceList: '/api/v2/hifly/voice/list',
  videoCreateByTts: '/api/v2/hifly/video/create_by_tts',
  videoCreateByAudio: '/api/v2/hifly/video/create_by_audio',
  videoTask: '/api/v2/hifly/video/task',
  audioCreateByTts: '/api/v2/hifly/audio/create_by_tts',
  toolCreateUploadUrl: '/api/v2/hifly/tool/create_upload_url',
  accountCredit: '/api/v2/hifly/account/credit',
}

export type HiflyTaskState = 'WAITING' | 'PROCESSING' | 'DONE' | 'FAILED'

export interface HiflyAccept {
  taskId: string
  raw: Record<string, unknown>
}

export interface HiflyTaskResult {
  state: HiflyTaskState
  taskId: string | null
  /** DONE 时的产出标识 */
  avatarId?: string | null
  voiceId?: string | null
  demoUrl?: string | null
  videoUrl?: string | null
  audioUrl?: string | null
  /** 飞影报告的成片时长（秒；video/task 返回 duration，FR-P4 时长校验用） */
  durationSec?: number | null
  failReason?: string | null
  vendorCode?: number | null
  raw: Record<string, unknown>
}

export interface HiflyListItem {
  id: string | null
  title: string | null
  status: string | null
  raw: Record<string, unknown>
}

export interface HiflyUploadTicket {
  uploadUrl: string
  /** 上传成功后的文件标识（create_* 的 file_id 入参） */
  fileId: string
  contentType: string
  headers: Record<string, string>
  raw: Record<string, unknown>
}

/* ── 错误类型（R2）───────────────────────────────────────────────── */

/** 创建类请求拿到飞影业务码后的明确失败（可映射为 §5.2 错误码） */
export class HiflyVendorError extends Error {
  constructor(
    readonly vendorCode: number,
    message: string,
    readonly raw: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'HiflyVendorError'
  }
}

/** 创建类请求未拿到业务码（网络异常 / 超时）→ 提交结果未知，禁自动重提（L9） */
export class HiflySubmissionUncertain extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'HiflySubmissionUncertain'
  }
}

/** 查询类（轮询 / 列表 / 余额）的网络异常：不判失败，由调用方继续等待 */
export class HiflyQueryError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'HiflyQueryError'
  }
}

/** R3：飞影业务码 → 中文可读文案 */
export const VENDOR_CODE_MESSAGES: Record<number, string> = {
  11: '请求参数不合法（飞影业务码 11）',
  14: '请求参数不合法（飞影业务码 14）',
  1001: '飞影并发或提交数已达上限，请稍后重试',
  1002: '飞影积分不足，请先充值',
  1005: '当前飞影套餐不支持该能力（业务码 1005）',
  1006: '当前飞影套餐不支持该能力（业务码 1006）',
  1009: '声音克隆数量已达套餐上限',
  1011: '该素材未通过数字人服务合规校验',
  1013: '飞影任务数量已达上限，请先清理或升级套餐',
  1015: '飞影并发数已达上限，请稍后重试',
  2003: '飞影侧未配置（账号或套餐未开通，业务码 2003）',
}

/** 业务码 → 统一错误码（L14） */
export function vendorErrorOf(vendorCode: number, fallbackMessage?: string): ReturnType<typeof err.badRequest> {
  // 已知业务码用本地中文映射（L14，界面可读）；厂商原话保留在 details.vendorMessage 供排查；未知业务码才直接展示厂商原话
  const message = VENDOR_CODE_MESSAGES[vendorCode] || fallbackMessage || `飞影服务返回错误（业务码 ${vendorCode}）`
  const details = { vendorCode, ...(fallbackMessage && fallbackMessage !== message ? { vendorMessage: fallbackMessage } : {}) }
  switch (vendorCode) {
    case 1002:
      return err.hiflyInsufficientCredit(message, details)
    case 1005:
    case 1006:
      return err.hiflyPlanUnsupported(message, details)
    case 1009:
    case 1001:
    case 1013:
    case 1015:
      return err.hiflyQuotaExceeded(message, details)
    case 1011:
      return err.hiflyComplianceRejected(message, details)
    case 2003:
      return err.hiflyNotConfigured(message, details)
    default:
      return err.hiflyBadRequest(message, details)
  }
}

/* ── 信封解析 ────────────────────────────────────────────────────── */

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

interface Envelope {
  code: number | null
  message: string
  data: Record<string, unknown>
  hasCode: boolean
}

/** 信封解析：code 可为数字 / 数字字符串 / 布尔（true=成功）；上传凭证接口无 code */
export function parseEnvelope(body: unknown): Envelope {
  const o = (body ?? {}) as Record<string, unknown>
  const rawCode = o.code
  const hasCode = rawCode !== undefined && rawCode !== null
  let code: number | null = null
  if (typeof rawCode === 'boolean') code = rawCode ? 0 : -1
  else code = toNum(rawCode)
  return {
    code,
    message: String(o.message ?? o.msg ?? ''),
    data: (o.data ?? {}) as Record<string, unknown>,
    hasCode,
  }
}

/** 任务状态码 1/2/3/4 → WAITING/PROCESSING/DONE/FAILED（兼容字符串写法） */
export function mapTaskState(v: unknown): HiflyTaskState {
  if (typeof v === 'string') {
    const s = v.toUpperCase()
    if (s === 'DONE' || s === 'SUCCESS' || s === 'FINISHED') return 'DONE'
    if (s === 'FAILED' || s === 'FAIL' || s === 'ERROR') return 'FAILED'
    if (s === 'PROCESSING' || s === 'RUNNING') return 'PROCESSING'
    return 'WAITING'
  }
  switch (toNum(v)) {
    case 2:
      return 'PROCESSING'
    case 3:
      return 'DONE'
    case 4:
      return 'FAILED'
    default:
      return 'WAITING'
  }
}

/** 结果 URL 字段拼写兼容：video_Url / video_url / audio_Url … */
function pickUrl(data: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = data[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

/** 标题截断（飞影 ≤20 字） */
export function clipTitle(title: string, max = 20): string {
  const t = String(title ?? '').trim()
  return t.length > max ? t.slice(0, max) : t
}

/** TTS 文本上限（飞影 ≤10000 字） */
export const MAX_TTS_CHARS = 10000

/* ── 客户端 ──────────────────────────────────────────────────────── */

export interface HiflyClient {
  /** mock 客户端为 true（不打真实上传 / 下载，供无密钥联调） */
  readonly mock: boolean
  createAvatarByVideo(input: {
    title: string
    videoUrl?: string
    fileId?: string
    aigcFlag?: number
  }): Promise<HiflyAccept>
  createAvatarByImage(input: {
    title: string
    imageUrl?: string
    fileId?: string
    aigcFlag?: number
  }): Promise<HiflyAccept>
  avatarTask(taskId: string): Promise<HiflyTaskResult>
  avatarList(opts?: { page?: number; pageSize?: number; kind?: number }): Promise<HiflyListItem[]>
  createVoice(input: {
    title: string
    audioUrl?: string
    fileId?: string
    voiceType?: number
    languages?: string | null
  }): Promise<HiflyAccept>
  editVoice(input: { voiceId: string; speechRate?: number; volume?: number; pitch?: number }): Promise<void>
  voiceTask(taskId: string): Promise<HiflyTaskResult>
  voiceList(opts?: { page?: number; pageSize?: number }): Promise<HiflyListItem[]>
  createVideoByTts(input: {
    title: string
    avatarId: string
    voiceId: string
    text: string
    speechRate?: number
    volume?: number
    pitch?: number
    aigcFlag?: number
    /** 字幕参数白名单（V14）：视频创作模块只允许 st_show=0（字幕在剪辑模块添加） */
    stShow?: 0
    /** 调用归属覆盖（FR-P8：视频任务传 { refType: 'video_job', refId: jobId }，缺省 persona_avatar） */
    callRef?: { refType?: string; refId?: string }
  }): Promise<HiflyAccept>
  createVideoByAudio(input: {
    title: string
    avatarId: string
    audioUrl?: string
    fileId?: string
    aigcFlag?: number
  }): Promise<HiflyAccept>
  videoTask(taskId: string, callRef?: { refType?: string; refId?: string }): Promise<HiflyTaskResult>
  createAudioByTts(input: {
    voiceId: string
    text: string
    speechRate?: number
    volume?: number
    pitch?: number
  }): Promise<HiflyAccept>
  createUploadUrl(input: { fileExtension: string }): Promise<HiflyUploadTicket>
  /** PUT 原始字节到厂商上传地址（自上传路径，二进制超时） */
  uploadFile(ticket: HiflyUploadTicket, localPath: string): Promise<void>
  /** 下载到本地文件（仅接受 https；设大小上限） */
  download(url: string, destPath: string, maxBytes?: number): Promise<void>
  credit(): Promise<number>
}

/** 二进制下载大小上限（试听归档，50MB 足够） */
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024

class HttpHiflyClient implements HiflyClient {
  readonly mock = false
  private http: AxiosInstance

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: config.hifly.timeoutMs,
      headers: { Authorization: `Bearer ${apiKey}` },
      // 飞影请求只发往配置的官方域名（§7 安全），显式不走环境 HTTP 代理：
      // 代理会把请求目标改写为绝对 URL，且固定域名直连更可控
      proxy: false,
    })
  }

  /* ── 内部：JSON 请求 + 调用记录 ─────────────────────────────── */

  private async postJson(
    pathName: string,
    body: Record<string, unknown>,
    opts: { kind: 'create' | 'query'; refType?: string; refId?: string; binary?: boolean; ticket?: boolean },
  ): Promise<Record<string, unknown>> {
    const started = Date.now()
    const requestId = newId('hifly')
    let httpStatus: number | null = null
    try {
      const res = await this.http.post(pathName, body, {
        timeout: opts.binary ? config.hifly.binaryTimeoutMs : config.hifly.timeoutMs,
      })
      httpStatus = res.status
      const env = parseEnvelope(res.data)
      // 上传凭证接口（ticket）：字段在信封顶层（无 code、无 data 包裹），
      // 与众墅之家生产实现一致：有 upload_url 即成功（R1）
      const ok = opts.ticket
        ? !!pickUrl(res.data as Record<string, unknown>, 'upload_url', 'url', 'put_url', 'uploadUrl')
        : env.hasCode
          ? env.code === 0
          : Object.keys(env.data).length > 0
      if (!ok) {
        const vendorCode = env.code ?? 0
        const message = env.message || VENDOR_CODE_MESSAGES[vendorCode] || `飞影服务错误（code=${vendorCode}）`
        await logApiCall({
          provider: 'hifly',
          endpoint: pathName,
          refType: opts.refType ?? null,
          refId: opts.refId ?? null,
          ok: false,
          httpStatus,
          durationMs: Date.now() - started,
          error: `code=${vendorCode} ${message}`,
          requestId,
        })
        throw new HiflyVendorError(vendorCode, message, { body: res.data as Record<string, unknown> })
      }
      await logApiCall({
        provider: 'hifly',
        endpoint: pathName,
        refType: opts.refType ?? null,
        refId: opts.refId ?? null,
        ok: true,
        httpStatus,
        durationMs: Date.now() - started,
        requestId,
      })
      return opts.ticket ? (res.data as Record<string, unknown>) : env.data
    } catch (e) {
      if (e instanceof HiflyVendorError) throw e
      await logApiCall({
        provider: 'hifly',
        endpoint: pathName,
        refType: opts.refType ?? null,
        refId: opts.refId ?? null,
        ok: false,
        httpStatus,
        durationMs: Date.now() - started,
        error: (e as Error).message,
        requestId,
      })
      // R2：创建类请求没拿到业务码 → 提交结果未知；查询类 → 查询异常（继续等待）
      if (opts.kind === 'create') {
        throw new HiflySubmissionUncertain(`飞影创建请求未获得明确结果：${(e as Error).message}`, e)
      }
      throw new HiflyQueryError(`飞影查询失败：${(e as Error).message}`, e)
    }
  }

  /* ── avatar ─────────────────────────────────────────────────── */

  async createAvatarByVideo(input: {
    title: string
    videoUrl?: string
    fileId?: string
    aigcFlag?: number
  }): Promise<HiflyAccept> {
    const data = await this.postJson(
      PATHS.avatarCreateByVideo,
      {
        title: clipTitle(input.title),
        aigc_flag: input.aigcFlag ?? config.hifly.aigcFlag,
        ...(input.fileId ? { file_id: input.fileId } : { video_url: input.videoUrl }),
      },
      { kind: 'create', refType: 'persona_avatar' },
    )
    return { taskId: String(data.task_id ?? data.taskId ?? ''), raw: data }
  }

  async createAvatarByImage(input: {
    title: string
    imageUrl?: string
    fileId?: string
    aigcFlag?: number
  }): Promise<HiflyAccept> {
    const data = await this.postJson(
      PATHS.avatarCreateByImage,
      {
        title: clipTitle(input.title),
        aigc_flag: input.aigcFlag ?? config.hifly.aigcFlag,
        ...(input.fileId ? { file_id: input.fileId } : { image_url: input.imageUrl }),
      },
      { kind: 'create', refType: 'persona_avatar' },
    )
    return { taskId: String(data.task_id ?? data.taskId ?? ''), raw: data }
  }

  async avatarTask(taskId: string): Promise<HiflyTaskResult> {
    const data = await this.postJson(PATHS.avatarTask, { task_id: taskId }, { kind: 'query', refType: 'persona_avatar' })
    return this.mapTask(data, taskId)
  }

  async avatarList(opts: { page?: number; pageSize?: number; kind?: number } = {}): Promise<HiflyListItem[]> {
    const data = await this.postJson(
      PATHS.avatarList,
      { page: opts.page ?? 1, page_size: opts.pageSize ?? 20, kind: opts.kind ?? 2 },
      { kind: 'query' },
    )
    return this.mapList(data, ['avatar_id', 'avatarId', 'id'])
  }

  /* ── voice ──────────────────────────────────────────────────── */

  async createVoice(input: {
    title: string
    audioUrl?: string
    fileId?: string
    voiceType?: number
    languages?: string | null
  }): Promise<HiflyAccept> {
    const body: Record<string, unknown> = {
      title: clipTitle(input.title),
      voice_type: input.voiceType ?? 8,
      ...(input.fileId ? { file_id: input.fileId } : { audio_url: input.audioUrl }),
    }
    // R14：普通话不传 languages（不进 hash 的兼容写法）
    if (input.languages && input.languages !== 'zh') body.languages = input.languages
    const data = await this.postJson(PATHS.voiceCreate, body, { kind: 'create', refType: 'persona_voice' })
    return { taskId: String(data.task_id ?? data.taskId ?? ''), raw: data }
  }

  async editVoice(input: { voiceId: string; speechRate?: number; volume?: number; pitch?: number }): Promise<void> {
    await this.postJson(
      PATHS.voiceEdit,
      {
        voice_id: input.voiceId,
        ...(input.speechRate !== undefined ? { speech_rate: input.speechRate } : {}),
        ...(input.volume !== undefined ? { volume: input.volume } : {}),
        ...(input.pitch !== undefined ? { pitch: input.pitch } : {}),
      },
      { kind: 'create', refType: 'persona_voice' },
    )
  }

  async voiceTask(taskId: string): Promise<HiflyTaskResult> {
    const data = await this.postJson(PATHS.voiceTask, { task_id: taskId }, { kind: 'query', refType: 'persona_voice' })
    return this.mapTask(data, taskId)
  }

  async voiceList(opts: { page?: number; pageSize?: number } = {}): Promise<HiflyListItem[]> {
    const data = await this.postJson(
      PATHS.voiceList,
      { page: opts.page ?? 1, page_size: opts.pageSize ?? 20 },
      { kind: 'query' },
    )
    return this.mapList(data, ['voice_id', 'voiceId', 'id'])
  }

  /* ── video（M3 消费）────────────────────────────────────────── */

  async createVideoByTts(input: {
    title: string
    avatarId: string
    voiceId: string
    text: string
    speechRate?: number
    volume?: number
    pitch?: number
    aigcFlag?: number
    stShow?: 0
    callRef?: { refType?: string; refId?: string }
  }): Promise<HiflyAccept> {
    if (input.text.length > MAX_TTS_CHARS) {
      throw err.hiflyBadRequest(`口播文本超过 ${MAX_TTS_CHARS} 字上限`, { length: input.text.length })
    }
    // validate_oral_subtitle 白名单（V14）：仅放行 st_show=0，其余值一律拒绝
    if (input.stShow !== undefined && input.stShow !== 0) {
      throw err.hiflyBadRequest('字幕参数仅支持 st_show=0（字幕在剪辑模块添加）', { stShow: input.stShow })
    }
    const data = await this.postJson(
      PATHS.videoCreateByTts,
      {
        title: clipTitle(input.title),
        avatar_id: input.avatarId,
        voice_id: input.voiceId,
        text: input.text,
        speech_rate: input.speechRate ?? 1.0,
        volume: input.volume ?? 1.0,
        pitch: input.pitch ?? 1.0,
        aigc_flag: input.aigcFlag ?? config.hifly.aigcFlag,
        st_show: input.stShow ?? 0,
      },
      { kind: 'create', refType: input.callRef?.refType ?? 'persona_avatar', refId: input.callRef?.refId },
    )
    return { taskId: String(data.task_id ?? data.taskId ?? ''), raw: data }
  }

  async createVideoByAudio(input: {
    title: string
    avatarId: string
    audioUrl?: string
    fileId?: string
    aigcFlag?: number
  }): Promise<HiflyAccept> {
    const data = await this.postJson(
      PATHS.videoCreateByAudio,
      {
        title: clipTitle(input.title),
        avatar_id: input.avatarId,
        aigc_flag: input.aigcFlag ?? config.hifly.aigcFlag,
        ...(input.fileId ? { file_id: input.fileId } : { audio_url: input.audioUrl }),
      },
      { kind: 'create', refType: 'persona_avatar' },
    )
    return { taskId: String(data.task_id ?? data.taskId ?? ''), raw: data }
  }

  async videoTask(taskId: string, callRef?: { refType?: string; refId?: string }): Promise<HiflyTaskResult> {
    const data = await this.postJson(
      PATHS.videoTask,
      { task_id: taskId },
      { kind: 'query', refType: callRef?.refType ?? 'persona_avatar', refId: callRef?.refId },
    )
    return this.mapTask(data, taskId)
  }

  /* ── audio（任意文本试听）────────────────────────────────────── */

  async createAudioByTts(input: {
    voiceId: string
    text: string
    speechRate?: number
    volume?: number
    pitch?: number
  }): Promise<HiflyAccept> {
    if (input.text.length > MAX_TTS_CHARS) {
      throw err.hiflyBadRequest(`试听文本超过 ${MAX_TTS_CHARS} 字上限`, { length: input.text.length })
    }
    const data = await this.postJson(
      PATHS.audioCreateByTts,
      {
        voice_id: input.voiceId,
        text: input.text,
        speech_rate: input.speechRate ?? 1.0,
        volume: input.volume ?? 1.0,
        pitch: input.pitch ?? 1.0,
      },
      { kind: 'create', refType: 'persona_voice' },
    )
    return { taskId: String(data.task_id ?? data.taskId ?? ''), raw: data }
  }

  /* ── tool / account ─────────────────────────────────────────── */

  async createUploadUrl(input: { fileExtension: string }): Promise<HiflyUploadTicket> {
    const extension = String(input.fileExtension ?? '').replace(/^\.+/, '')
    const data = await this.postJson(
      PATHS.toolCreateUploadUrl,
      { file_extension: extension },
      { kind: 'create', ticket: true },
    )
    const uploadUrl = pickUrl(data, 'upload_url', 'url', 'put_url', 'uploadUrl')
    if (!uploadUrl) throw new HiflySubmissionUncertain('上传凭证响应缺少 upload_url 字段', { body: data })
    const fileId = (data.file_id ?? data.fileId ?? null) as string | null
    if (!fileId) throw new HiflySubmissionUncertain('上传凭证响应缺少 file_id 字段', { body: data })
    const contentType = ((data.content_type ?? data.contentType) as string) || 'application/octet-stream'
    const headers = (data.headers ?? {}) as Record<string, string>
    return { uploadUrl, fileId, contentType, headers, raw: data }
  }

  /** PUT 原始字节（二进制超时；不走代理） */
  async uploadFile(ticket: HiflyUploadTicket, localPath: string): Promise<void> {
    // P2-2：流式上传并显式带 Content-Length（预签名 PUT 需要），不整份读入内存
    const { size } = await fs.promises.stat(localPath)
    await axios.put(ticket.uploadUrl, fs.createReadStream(localPath), {
      headers: { 'Content-Type': ticket.contentType, 'Content-Length': String(size), ...ticket.headers },
      timeout: config.hifly.binaryTimeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      proxy: false,
    })
  }

  async download(url: string, destPath: string, maxBytes = DOWNLOAD_MAX_BYTES): Promise<void> {
    if (!/^https:\/\//i.test(url)) {
      throw new Error(`飞影下载地址必须为 https（当前 ${url.slice(0, 32)}…）`)
    }
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: config.hifly.binaryTimeoutMs,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      proxy: false,
    })
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true })
    const writer = fs.createWriteStream(destPath)
    await new Promise<void>((resolve, reject) => {
      ;(res.data as NodeJS.ReadableStream).pipe(writer)
      writer.on('finish', () => resolve())
      writer.on('error', reject)
    })
  }

  async credit(): Promise<number> {
    const data = await this.postJson(PATHS.accountCredit, {}, { kind: 'query' })
    const v = toNum(data.credit ?? data.credits ?? data.balance ?? data.remain)
    return v ?? 0
  }

  /* ── 响应映射 ───────────────────────────────────────────────── */

  private mapTask(data: Record<string, unknown>, taskId: string): HiflyTaskResult {
    const state = mapTaskState(data.status ?? data.state)
    const durationRaw = Number(data.duration ?? data.duration_sec ?? data.durationSec)
    return {
      state,
      taskId: String(data.task_id ?? taskId),
      avatarId: (data.avatar_id as string) ?? (data.avatarId as string) ?? null,
      voiceId: (data.voice_id as string) ?? (data.voiceId as string) ?? null,
      demoUrl: pickUrl(data, 'demo_url', 'demoUrl', 'audio_url', 'audioUrl', 'audio_Url'),
      videoUrl: pickUrl(data, 'video_url', 'videoUrl', 'video_Url'),
      audioUrl: pickUrl(data, 'audio_url', 'audioUrl', 'audio_Url'),
      durationSec: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null,
      failReason: (data.fail_reason as string) ?? (data.failReason as string) ?? (data.message as string) ?? null,
      vendorCode: toNum(data.code),
      raw: data,
    }
  }

  private mapList(data: Record<string, unknown>, idKeys: string[]): HiflyListItem[] {
    const list = Array.isArray(data.list) ? data.list : Array.isArray(data.items) ? data.items : []
    return list.map((item) => {
      const o = (item ?? {}) as Record<string, unknown>
      const id = idKeys.map((k) => o[k]).find((v) => typeof v === 'string' && v) ?? null
      return {
        id: id ? String(id) : null,
        title: typeof o.title === 'string' ? o.title : null,
        status: typeof o.status === 'string' || typeof o.status === 'number' ? String(o.status) : null,
        raw: o,
      }
    })
  }
}

/* ── 导出 ────────────────────────────────────────────────────────── */

let realClient: HiflyClient | null = null

/** 真实客户端（懒加载）；未配置密钥时抛 HIFLY_NOT_CONFIGURED */
export function getHiflyClient(): HiflyClient {
  if (!hasHifly()) {
    throw err.hiflyNotConfigured('飞影未配置（HIFLY_API_KEY 缺失）。配置后重试，或开发联调时启用 MOCK_FALLBACK。')
  }
  if (!realClient) realClient = new HttpHiflyClient(config.hifly.baseUrl, config.hifly.apiKey)
  return realClient
}

/** 供 M3 与探活脚本使用 */
export function createHttpHiflyClient(baseUrl = config.hifly.baseUrl, apiKey = config.hifly.apiKey): HiflyClient {
  return new HttpHiflyClient(baseUrl, apiKey)
}

/** 当前飞影配置状态（options 接口用，不回显密钥） */
export function hiflyStatus(): { configured: boolean; baseUrl: string; mock: boolean } {
  return { configured: hasHifly(), baseUrl: config.hifly.baseUrl, mock: !hasHifly() && config.mockFallback }
}

export function describeHifly(): string {
  return hasHifly() ? `hifly@${config.hifly.baseUrl}` : 'hifly=mock（MOCK_FALLBACK）'
}
