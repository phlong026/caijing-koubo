import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../../config.js'
import { err } from '../../errors.js'
import { logApiCall } from '../../modules/metrics/call-log.js'
import {
  PATHS,
  HiflyQueryError,
  HiflySubmissionUncertain,
  HiflyVendorError,
  clipTitle,
  type HiflyAccept,
  type HiflyClient,
  type HiflyListItem,
  type HiflyTaskResult,
  type HiflyUploadTicket,
} from './client.js'

/**
 * 飞影 mock 客户端（AC-H4 / §7 降级）。
 *  - 同一输入 hash 返回确定性标识（同素材恒定，便于幂等与回归）；
 *  - 可注入 uncertain / failed / 指定业务码（冒烟测试场景 4/5）；
 *  - 试听 demo 生成本地 WAV（PCM 正弦），download 支持 mock:// 协议。
 * 仅在无 HIFLY_API_KEY 且 MOCK_FALLBACK=true 时启用；真实密钥到位后自动切换真实客户端。
 */

export type MockBehavior = 'uncertain' | 'failed' | 'vendor_code'

export interface MockInjection {
  behavior: MockBehavior
  vendorCode?: number
  /** 生效次数（默认 1，一次性；Infinity 为常驻） */
  times?: number
}

const injections = new Map<string, MockInjection[]>()
const counters = new Map<string, number>()

/** 注入一次故障（按操作名：avatar.create / voice.create / voice.edit / video.create / audio.create / upload / download / credit） */
export function injectHifly(op: string, injection: MockInjection): void {
  const list = injections.get(op) ?? []
  list.push({ times: 1, ...injection })
  injections.set(op, list)
}

export function clearHiflyInjections(): void {
  injections.clear()
  counters.clear()
}

/** 取当前生效的注入（命中后按 times 递减，耗尽移除） */
function takeInjection(op: string): MockInjection | null {
  const list = injections.get(op)
  if (!list?.length) return null
  const idx = list.findIndex((i) => {
    const key = `${op}#${list.indexOf(i)}`
    return (counters.get(key) ?? 0) < (i.times ?? 1)
  })
  if (idx < 0) return null
  const inj = list[idx]
  const key = `${op}#${idx}`
  const used = (counters.get(key) ?? 0) + 1
  counters.set(key, used)
  if (used >= (inj.times ?? 1)) list.splice(idx, 1)
  if (!list.length) injections.delete(op)
  return inj
}

function detId(prefix: string, ...parts: unknown[]): string {
  const hash = crypto.createHash('sha256').update(parts.map(String).join('|')).digest('hex')
  return `${prefix}_${hash.slice(0, 12)}`
}

interface MockTask {
  taskId: string
  kind: 'avatar' | 'voice' | 'video' | 'audio'
  title: string
  polls: number
  state: 'WAITING' | 'PROCESSING' | 'DONE' | 'FAILED'
  result: { avatarId?: string; voiceId?: string; demoUrl?: string; videoUrl?: string; audioUrl?: string }
}

const tasks = new Map<string, MockTask>()
const POLLS_TO_DONE = Number(process.env.HIFLY_MOCK_POLLS_TO_DONE ?? 2)

function applyInjection(op: string): void {
  const inj = takeInjection(op)
  if (!inj) return
  if (inj.behavior === 'uncertain') throw new HiflySubmissionUncertain(`[mock] 注入提交结果未知（${op}）`)
  if (inj.behavior === 'failed') throw new HiflyVendorError(1011, '[mock] 注入失败：素材未通过数字人服务合规校验')
  if (inj.behavior === 'vendor_code' && inj.vendorCode) {
    throw new HiflyVendorError(inj.vendorCode, `[mock] 注入业务码 ${inj.vendorCode}`)
  }
}

function registerTask(kind: MockTask['kind'], title: string, result: MockTask['result']): string {
  const taskId = detId('task', kind, title, result.avatarId ?? result.voiceId ?? '')
  tasks.set(taskId, { taskId, kind, title, polls: 0, state: 'WAITING', result })
  return taskId
}

function queryTask(taskId: string): HiflyTaskResult {
  const t = tasks.get(taskId)
  if (!t) {
    throw new HiflyQueryError(`[mock] 任务不存在：${taskId}`)
  }
  t.polls += 1
  if (t.polls < POLLS_TO_DONE) t.state = 'PROCESSING'
  else t.state = 'DONE'
  return {
    state: t.state,
    taskId,
    avatarId: t.result.avatarId ?? null,
    voiceId: t.result.voiceId ?? null,
    demoUrl: t.result.demoUrl ?? null,
    videoUrl: t.result.videoUrl ?? null,
    audioUrl: t.result.audioUrl ?? null,
    failReason: null,
    vendorCode: null,
    raw: { mock: true, polls: t.polls },
  }
}

/** 生成本地试听音频（PCM WAV，正弦音，无需 ffmpeg） */
function writeDemoWav(destPath: string, seconds = 1.5): void {
  const sampleRate = 16000
  const samples = Math.floor(sampleRate * seconds)
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3 * 0x7fff
    buffer.writeInt16LE(Math.round(v), 44 + i * 2)
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, buffer)
}

class MockHiflyClient implements HiflyClient {
  readonly mock = true

  async createAvatarByVideo(input: {
    title: string
    videoUrl?: string
    fileId?: string
    aigcFlag?: number
  }): Promise<HiflyAccept> {
    applyInjection('avatar.create')
    const avatarId = detId('mock_avatar', input.videoUrl ?? input.fileId, input.title)
    const taskId = registerTask('avatar', clipTitle(input.title), { avatarId })
    return { taskId, raw: { mock: true, avatar_id: avatarId } }
  }

  async createAvatarByImage(input: {
    title: string
    imageUrl?: string
    fileId?: string
    aigcFlag?: number
  }): Promise<HiflyAccept> {
    applyInjection('avatar.create')
    const avatarId = detId('mock_avatar', input.imageUrl ?? input.fileId, input.title)
    const taskId = registerTask('avatar', clipTitle(input.title), { avatarId })
    return { taskId, raw: { mock: true, avatar_id: avatarId } }
  }

  async avatarTask(taskId: string): Promise<HiflyTaskResult> {
    applyInjection('avatar.task')
    return queryTask(taskId)
  }

  async avatarList(): Promise<HiflyListItem[]> {
    const out: HiflyListItem[] = []
    for (const t of tasks.values()) {
      if (t.kind !== 'avatar' || t.state !== 'DONE') continue
      out.push({ id: t.result.avatarId ?? null, title: t.title, status: '3', raw: { mock: true } })
    }
    return out
  }

  async createVoice(input: {
    title: string
    audioUrl?: string
    fileId?: string
    voiceType?: number
    languages?: string | null
  }): Promise<HiflyAccept> {
    applyInjection('voice.create')
    const voiceId = detId('mock_voice', input.audioUrl ?? input.fileId, input.title)
    const demoUrl = `mock://demo/${voiceId}.wav`
    const taskId = registerTask('voice', clipTitle(input.title), { voiceId, demoUrl })
    return { taskId, raw: { mock: true, voice_id: voiceId } }
  }

  async editVoice(input: { voiceId: string; speechRate?: number; volume?: number; pitch?: number }): Promise<void> {
    applyInjection('voice.edit')
    if (!input.voiceId) throw err.hiflyBadRequest('[mock] voice_id 不能为空')
  }

  async voiceTask(taskId: string): Promise<HiflyTaskResult> {
    applyInjection('voice.task')
    return queryTask(taskId)
  }

  async voiceList(): Promise<HiflyListItem[]> {
    const out: HiflyListItem[] = []
    for (const t of tasks.values()) {
      if (t.kind !== 'voice' || t.state !== 'DONE') continue
      out.push({ id: t.result.voiceId ?? null, title: t.title, status: '3', raw: { mock: true } })
    }
    return out
  }

  async createVideoByTts(input: {
    title: string
    avatarId: string
    voiceId: string
    text: string
    speechRate?: number
    volume?: number
    pitch?: number
    aigcFlag?: number
  }): Promise<HiflyAccept> {
    applyInjection('video.create')
    const videoUrl = `mock://video/${detId('mock_video', input.avatarId, input.voiceId, input.text)}.mp4`
    const taskId = registerTask('video', clipTitle(input.title), { videoUrl })
    return { taskId, raw: { mock: true } }
  }

  async createVideoByAudio(input: {
    title: string
    avatarId: string
    audioUrl?: string
    fileId?: string
    aigcFlag?: number
  }): Promise<HiflyAccept> {
    applyInjection('video.create')
    const videoUrl = `mock://video/${detId('mock_video', input.avatarId, input.audioUrl ?? input.fileId)}.mp4`
    const taskId = registerTask('video', clipTitle(input.title), { videoUrl })
    return { taskId, raw: { mock: true } }
  }

  async videoTask(taskId: string): Promise<HiflyTaskResult> {
    applyInjection('video.task')
    return queryTask(taskId)
  }

  async createAudioByTts(input: {
    voiceId: string
    text: string
    speechRate?: number
    volume?: number
    pitch?: number
  }): Promise<HiflyAccept> {
    applyInjection('audio.create')
    const audioUrl = `mock://audio/${detId('mock_audio', input.voiceId, input.text, input.speechRate ?? 1, input.volume ?? 1, input.pitch ?? 1)}.wav`
    const taskId = registerTask('audio', clipTitle(input.text.slice(0, 20)), { audioUrl })
    return { taskId, raw: { mock: true } }
  }

  async createUploadUrl(input: { fileExtension: string }): Promise<HiflyUploadTicket> {
    applyInjection('upload')
    const fileId = detId('file', input.fileExtension)
    return {
      uploadUrl: `https://mock.hifly.invalid/upload/${encodeURIComponent(fileId)}`,
      fileId,
      contentType: 'application/octet-stream',
      headers: {},
      raw: { mock: true },
    }
  }

  async uploadFile(_ticket: HiflyUploadTicket, _localPath: string): Promise<void> {
    applyInjection('upload')
    // mock 模式不打真实上传：素材经 mock:// URL 交付
  }

  async download(url: string, destPath: string): Promise<void> {
    applyInjection('download')
    if (url.startsWith('mock://')) {
      writeDemoWav(destPath)
      return
    }
    throw new Error(`[mock] 不支持的下载地址：${url}`)
  }

  async credit(): Promise<number> {
    applyInjection('credit')
    return 100000
  }
}

/**
 * 与真实客户端一致的调用留痕（AC-C7）：每次飞影调用写 api_call_log(provider=hifly, ref_type=…)，
 * 端点路径沿用真实 PATHS，便于断言「创建类调用只发出一次」。上传 / 下载与真实客户端一样不记。
 */
const TRACED: Record<string, { path: string; refType: string | null }> = {
  createAvatarByVideo: { path: PATHS.avatarCreateByVideo, refType: 'persona_avatar' },
  createAvatarByImage: { path: PATHS.avatarCreateByImage, refType: 'persona_avatar' },
  avatarTask: { path: PATHS.avatarTask, refType: 'persona_avatar' },
  avatarList: { path: PATHS.avatarList, refType: 'persona_avatar' },
  createVoice: { path: PATHS.voiceCreate, refType: 'persona_voice' },
  editVoice: { path: PATHS.voiceEdit, refType: 'persona_voice' },
  voiceTask: { path: PATHS.voiceTask, refType: 'persona_voice' },
  voiceList: { path: PATHS.voiceList, refType: 'persona_voice' },
  createVideoByTts: { path: PATHS.videoCreateByTts, refType: 'persona_avatar' },
  createVideoByAudio: { path: PATHS.videoCreateByAudio, refType: 'persona_avatar' },
  videoTask: { path: PATHS.videoTask, refType: 'persona_avatar' },
  createAudioByTts: { path: PATHS.audioCreateByTts, refType: 'persona_voice' },
  createUploadUrl: { path: PATHS.toolCreateUploadUrl, refType: null },
  credit: { path: PATHS.accountCredit, refType: null },
}

function withCallLog(target: MockHiflyClient): HiflyClient {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver)
      const meta = typeof prop === 'string' ? TRACED[prop] : undefined
      if (!meta || typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        const started = Date.now()
        try {
          const result = await value.apply(obj, args)
          await logApiCall({ provider: 'hifly', endpoint: meta.path, refType: meta.refType, ok: true, httpStatus: 200, durationMs: Date.now() - started })
          return result
        } catch (e) {
          await logApiCall({ provider: 'hifly', endpoint: meta.path, refType: meta.refType, ok: false, durationMs: Date.now() - started, error: (e as Error).message })
          throw e
        }
      }
    },
  }) as unknown as HiflyClient
}

let mockClient: HiflyClient | null = null

export function getMockHiflyClient(): HiflyClient {
  if (!mockClient) mockClient = withCallLog(new MockHiflyClient())
  return mockClient
}
