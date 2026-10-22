import axios from 'axios'
import { config, hasDashScope } from '../../config.js'
import { logger } from '../../log.js'
import { logApiCall } from '../../modules/metrics/call-log.js'

/**
 * 百炼文件转写（D5）：平移 AI-Studio electron/mapi/aliyun/transcription.ts 的逻辑
 * —— 提交（异步）→ 轮询 task → 下载 transcription_url → 解析 text + 句级时间戳，并修复时间轴重叠。
 */
export interface AsrSentence {
  text: string
  beginTime: number
  endTime: number
}

export interface AsrResult {
  text: string
  sentences: AsrSentence[]
  taskId: string
  mock?: boolean
}

const MIN_GAP_MS = 50

export async function submitTask(fileUrl: string, ref?: { type: string; id: string }): Promise<string> {
  const started = Date.now()
  const url = `${config.dashscope.nativeUrl}/services/audio/asr/transcription`
  if (!hasDashScope()) {
    if (!config.mockFallback) throw new Error('DASHSCOPE_API_KEY 未配置')
    const taskId = `mock-task-${Date.now()}`
    await logApiCall({
      provider: 'dashscope',
      endpoint: 'asr/transcription (mock)',
      refType: ref?.type,
      refId: ref?.id,
      ok: true,
      durationMs: Date.now() - started,
      cost: 0,
    })
    return taskId
  }
  try {
    const res = await axios.post(
      url,
      {
        model: config.dashscope.asrModel,
        input: { file_url: fileUrl },
        parameters: { channel_id: [0], enable_itn: false },
      },
      {
        headers: {
          Authorization: `Bearer ${config.dashscope.apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
        timeout: 30_000,
      },
    )
    const taskId: string | undefined = res.data?.output?.task_id
    if (!taskId) throw new Error(res.data?.message ?? '任务提交未返回 task_id')
    await logApiCall({
      provider: 'dashscope',
      endpoint: 'asr/transcription',
      refType: ref?.type,
      refId: ref?.id,
      ok: true,
      httpStatus: res.status,
      durationMs: Date.now() - started,
      // 按时长计价时提交时还不知道时长，成本在转写完成后按实际时长记一笔（extract.ts）
      cost: config.dashscope.asrPricePerSec > 0 ? 0 : config.dashscope.asrUnitPrice,
      requestId: res.headers?.['x-request-id'] ? String(res.headers['x-request-id']) : null,
    })
    return taskId
  } catch (e: any) {
    const msg = e?.response?.data?.message ?? e?.message ?? '提交转写任务失败'
    await logApiCall({
      provider: 'dashscope',
      endpoint: 'asr/transcription',
      refType: ref?.type,
      refId: ref?.id,
      ok: false,
      httpStatus: e?.response?.status ?? null,
      durationMs: Date.now() - started,
      error: msg,
    })
    throw new Error(`百炼转写提交失败：${msg}`)
  }
}

export async function queryTask(
  taskId: string,
): Promise<{ status: string; output?: any; error?: string; code?: string }> {
  if (!hasDashScope()) return { status: 'SUCCEEDED', output: { mock: true } }
  try {
    const res = await axios.get(`${config.dashscope.nativeUrl}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${config.dashscope.apiKey}` },
      timeout: 30_000,
    })
    return {
      status: res.data?.output?.task_status ?? 'UNKNOWN',
      output: res.data?.output,
      error: res.data?.output?.message ?? res.data?.message,
      code: res.data?.output?.code ?? res.data?.code,
    }
  } catch (e: any) {
    return { status: 'ERROR', error: e?.message ?? '查询任务失败' }
  }
}

async function downloadResult(resultUrl: string): Promise<any> {
  const res = await axios.get(resultUrl, { timeout: 30_000 })
  return res.data
}

/** 轮询直到完成；拿到 task_id 后重启也能续跑（FR-B6） */
export async function waitForResult(
  taskId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<AsrResult> {
  const interval = opts.intervalMs ?? config.extract.pollIntervalMs
  const timeout = opts.timeoutMs ?? config.extract.pollTimeoutMs
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeout) {
    const { status, output, error } = await queryTask(taskId)
    if (status === 'SUCCEEDED') {
      if (!hasDashScope()) return mockAsrResult(taskId)
      const result = output?.result
      let parsed: any = null
      if (result?.transcription_url) parsed = await downloadResult(result.transcription_url)
      return parseTranscription(parsed, taskId)
    }
    if (status === 'FAILED') {
      throw new Error(error || '百炼转写任务失败')
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('百炼转写任务超时')
}

function parseTranscription(transcription: any, taskId: string): AsrResult {
  const sentences: AsrSentence[] = []
  let fullText = ''
  for (const transcript of transcription?.transcripts ?? []) {
    for (const s of transcript?.sentences ?? []) {
      sentences.push({
        text: s.text ?? '',
        beginTime: s.begin_time ?? 0,
        endTime: s.end_time ?? 0,
      })
    }
    if (transcript?.text) fullText += transcript.text
  }
  fixTimeline(sentences)
  return { text: fullText, sentences, taskId }
}

/** 修复句级时间轴重叠（沿用 AI-Studio 逻辑） */
function fixTimeline(sentences: AsrSentence[]): void {
  for (let i = 0; i < sentences.length - 1; i++) {
    const cur = sentences[i]
    const next = sentences[i + 1]
    if (cur.endTime >= next.beginTime) {
      cur.endTime = Math.max(cur.beginTime + MIN_GAP_MS, next.beginTime - MIN_GAP_MS)
    }
  }
}

function mockAsrResult(taskId: string): AsrResult {
  const lines = [
    '大家好，今天聊一个很多人忽略的问题。',
    '第一，先看规则，再看收益，顺序不能反。',
    '第二，费用是长期影响最大的变量之一。',
    '第三，任何承诺收益的说法都要提高警惕。',
    '最后提醒：市场有风险，投资需谨慎。',
  ]
  const sentences: AsrSentence[] = lines.map((text, i) => ({
    text,
    beginTime: i * 5000,
    endTime: i * 5000 + 4200,
  }))
  return { text: lines.join(''), sentences, taskId, mock: true }
}
