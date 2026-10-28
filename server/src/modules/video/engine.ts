import { config } from '../../config.js'
import { err } from '../../errors.js'
import { resolveHiflyClient, type HiflyTaskResult } from '../../integrations/hifly/index.js'
import type { GenMode } from './types.js'

/**
 * AvatarVideoEngine（V2 决策）：服务端唯一的数字人视频引擎适配层。
 * hifly = 真实客户端（resolveHiflyClient 按配置解析）；mock = 无密钥兜底（V13）。
 * 生成方式 gen_mode=tts（默认）：create_by_tts 一次直接成片；
 * audio（Q3 备选 B）走 create_by_audio，上传整轨经人物库 transfer 语义（一期不启用）。
 *
 * 提交参数（V14）：aigc_flag=1、st_show=0（经客户端白名单校验）、
 * title = buildVendorTitle 产物（文案标题截断 + 短引用，供 submission_unknown 人工核对）。
 */

export interface EngineSubmitInput {
  vendorAvatarId: string
  vendorVoiceId: string
  submitText: string
  vendorTitle: string
  genMode: GenMode
  /** 调用归属（FR-P8）：video_job id，写进 api_call_log.ref_id */
  jobId?: string
}

export interface EngineSubmitResult {
  remoteTaskId: string
}

export interface EnginePollResult {
  state: 'WAITING' | 'PROCESSING' | 'DONE' | 'FAILED'
  videoUrl: string | null
  durationSec: number | null
  failReason: string | null
  vendorCode: number | null
}

export interface AvatarVideoEngine {
  readonly provider: 'hifly'
  readonly mock: boolean
  submit(input: EngineSubmitInput): Promise<EngineSubmitResult>
  poll(remoteTaskId: string, jobId?: string): Promise<EnginePollResult>
  /** 下载成片：mock 走客户端 mock:// 协议，真实走防 SSRF 校验下载 */
  download(videoUrl: string, destPath: string, maxBytes: number): Promise<void>
}

function toPollResult(r: HiflyTaskResult): EnginePollResult {
  return {
    state: r.state,
    videoUrl: r.videoUrl ?? null,
    durationSec: r.durationSec ?? null,
    failReason: r.failReason ?? null,
    vendorCode: r.vendorCode ?? null,
  }
}

export function createVideoEngine(): AvatarVideoEngine {
  const client = resolveHiflyClient()
  return {
    provider: 'hifly',
    mock: client.mock,
    async submit(input: EngineSubmitInput): Promise<EngineSubmitResult> {
      if (input.genMode === 'audio') {
        // Q3 备选 B：整轨音频驱动。一期默认 tts，audio 在 V0 评审拍板前不可达（§11 Q3）
        throw err.badRequest('gen_mode=audio 未启用（待 §11 Q3 拍板），当前仅支持文本直出')
      }
      const acc = await client.createVideoByTts({
        title: input.vendorTitle,
        avatarId: input.vendorAvatarId,
        voiceId: input.vendorVoiceId,
        text: input.submitText,
        aigcFlag: config.hifly.aigcFlag,
        stShow: 0,
        callRef: { refType: 'video_job', refId: input.jobId },
      })
      if (!acc.taskId) throw err.upstream('飞影受理成功但未返回任务号')
      return { remoteTaskId: acc.taskId }
    },
    async poll(remoteTaskId: string, jobId?: string): Promise<EnginePollResult> {
      return toPollResult(await client.videoTask(remoteTaskId, { refType: 'video_job', refId: jobId }))
    },
    async download(videoUrl: string, destPath: string, maxBytes: number): Promise<void> {
      if (client.mock) {
        await client.download(videoUrl, destPath)
        return
      }
      const { downloadValidatedFile, SafeDownloadError } = await import('../../media/safe-download.js')
      try {
        await downloadValidatedFile(videoUrl, destPath, { maxBytes })
      } catch (e) {
        if (e instanceof SafeDownloadError) throw err.videoResultUrlBlocked(e.message, { reason: e.reason })
        throw e
      }
    },
  }
}
