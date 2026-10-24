import { config } from '../../config.js'
import { hiflyStatus } from '../../integrations/hifly/client.js'
import { isOssEnabled } from '../../integrations/aliyun-oss/client.js'

/**
 * GET /video/options 选项字典（AC-0.4）。
 * 模式、生成方式、飞影配置状态与剩余积分（脱敏）、计价规则、输出规格与各上限。
 * 无密钥且 MOCK_FALLBACK 开启时 mock=true（V13：全链路可无密钥联调）。
 * 积分与人物库 /personas/options 同源（FR-A4），各自带 5 分钟缓存。
 */

export interface VideoOptions {
  modes: Array<{ key: 'avatar' | 'mixcut'; label: string; desc: string; personaLineBlocked?: string }>
  genModes: Array<{ key: 'tts' | 'audio'; label: string }>
  engine: {
    provider: 'hifly'
    configured: boolean
    mock: boolean
    credit: number | null
    creditError: string | null
  }
  pricing: { creditsPerSec: number; desc: string; note: string }
  output: { width: number; height: number; fps: number; codec: string }
  limits: {
    maxSeconds: number
    maxTextChars: number
    jobLimitPerCopy: number
    genConcurrency: number
    sentenceMaxChars: number
    archiveMaxMb: number
  }
  alignMinScore: number
  storage: { oss: boolean; mode: 'oss' | 'local' }
}

export async function buildVideoOptions(credit: { value: number | null; error: string | null }): Promise<VideoOptions> {
  const v = config.video
  return {
    modes: [
      {
        key: 'avatar',
        label: '数字人口播',
        desc: '飞影分身以人物克隆声音直接生成口播视频',
        personaLineBlocked: '素人矩阵不使用数字人口播',
      },
      {
        key: 'mixcut',
        label: '素材混剪',
        desc: '配音整轨 + 底板画面 + 按时间轴叠加素材',
      },
    ],
    // Q3 备选 B（create_by_audio）确认前只开放文本直出
    genModes: [{ key: 'tts', label: '文本直出' }],
    engine: {
      provider: 'hifly',
      configured: hiflyStatus().configured,
      mock: hiflyStatus().mock,
      credit: credit.value,
      creditError: credit.error,
    },
    pricing: {
      creditsPerSec: v.creditsPerSec,
      desc: '预估积分 = 单价 × 预计口播秒数',
      note: '计价规则按 PoC 实测修订；精确对账不在一期',
    },
    output: { width: v.outputWidth, height: v.outputHeight, fps: v.outputFps, codec: 'H.264 / AAC' },
    limits: {
      maxSeconds: v.maxSeconds,
      maxTextChars: v.maxTextChars,
      jobLimitPerCopy: v.jobLimitPerCopy,
      genConcurrency: v.genConcurrency,
      sentenceMaxChars: v.sentenceMaxChars,
      archiveMaxMb: v.archiveMaxMb,
    },
    alignMinScore: v.alignMinScore,
    storage: { oss: isOssEnabled(), mode: isOssEnabled() ? 'oss' : 'local' },
  }
}
