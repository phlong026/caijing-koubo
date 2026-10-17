import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(here, '..')

// .env 不入库，缺失时全部走缺省值（第三方 key 为空即走 mock 兜底）
dotenv.config({ path: path.join(serverRoot, '.env') })

function str(key: string, def = ''): string {
  const v = process.env[key]
  return v === undefined || v === '' ? def : v
}
function num(key: string, def: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}
function bool(key: string, def: boolean): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return def
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes'
}

export const paths = {
  serverRoot,
  tempDir: path.resolve(serverRoot, str('TEMP_DIR', './.data/tmp')),
  dataDir: path.resolve(serverRoot, './.data'),
}

export const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 8787),
  host: str('HOST', '127.0.0.1'),
  logLevel: str('LOG_LEVEL', 'info'),

  db: {
    // auto：优先 MySQL，连不上则退回内置 sqlite（仅用于本地开发验证）
    driver: str('DB_DRIVER', 'auto') as 'auto' | 'mysql' | 'sqlite',
    host: str('DB_HOST', '127.0.0.1'),
    port: num('DB_PORT', 3306),
    user: str('DB_USER', 'root'),
    password: str('DB_PASSWORD', ''),
    database: str('DB_NAME', 'viral_topics'),
    sqlitePath: path.resolve(serverRoot, str('DB_SQLITE_PATH', './.data/dev.db')),
    poolSize: num('DB_POOL_SIZE', 10),
  },

  redis: {
    host: str('REDIS_HOST', '127.0.0.1'),
    port: num('REDIS_PORT', 26379),
    password: str('REDIS_PASSWORD', ''),
    db: num('REDIS_DB', 0),
  },
  queuePrefix: str('QUEUE_PREFIX', 'viral'),

  tikhub: {
    apiKey: str('TIKHUB_API_KEY', ''),
    baseUrl: str('TIKHUB_BASE_URL', 'https://api.tikhub.io'),
    paths: {
      userInfo: str('TIKHUB_PATH_USER_INFO', '/api/v1/douyin/web/fetch_user_info'),
      userPosts: str('TIKHUB_PATH_USER_POSTS', '/api/v1/douyin/web/fetch_user_post_videos'),
      videoDetail: str('TIKHUB_PATH_VIDEO_DETAIL', '/api/v1/douyin/web/fetch_video_detail'),
      shareParse: str('TIKHUB_PATH_SHARE_PARSE', '/api/v1/douyin/web/fetch_video_share_info'),
    },
    timeoutMs: num('TIKHUB_TIMEOUT_MS', 15000),
    retry: num('TIKHUB_RETRY', 1), // FR-N/B3：超时与一次自动重试
    unitPrice: num('TIKHUB_UNIT_PRICE', 0.003),
  },

  dashscope: {
    apiKey: str('DASHSCOPE_API_KEY', ''),
    baseUrl: str('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    nativeUrl: str('DASHSCOPE_NATIVE_URL', 'https://dashscope.aliyuncs.com/api/v1'),
    llmModel: str('LLM_MODEL', 'qwen-plus'),
    asrModel: str('ASR_MODEL', 'qwen3-asr-flash-filetrans'),
    timeoutMs: num('DASHSCOPE_TIMEOUT_MS', 120000),
    llmUnitPrice: num('LLM_UNIT_PRICE', 0.004),
    asrUnitPrice: num('ASR_UNIT_PRICE', 0.0005),
  },

  oss: {
    region: str('OSS_REGION', 'oss-cn-shanghai'),
    bucket: str('OSS_BUCKET', ''),
    accessKeyId: str('OSS_ACCESS_KEY_ID', ''),
    accessKeySecret: str('OSS_ACCESS_KEY_SECRET', ''),
    internal: bool('OSS_INTERNAL', false),
    prefix: str('OSS_PREFIX', 'benchmark-audio/'),
    signedUrlTtl: num('OSS_SIGNED_URL_TTL', 7200),
  },

  extract: {
    // D11：oss = 下载→ffmpeg 抽音轨→OSS 签名 URL（一期基线）；direct = 直接以播放地址提交（PoC 通过后开启）
    mode: str('EXTRACT_MODE', 'oss') as 'oss' | 'direct',
    maxDurationMin: num('EXTRACT_MAX_DURATION_MIN', 30),
    pollIntervalMs: num('ASR_POLL_INTERVAL_MS', 3000),
    pollTimeoutMs: num('ASR_POLL_TIMEOUT_MS', 900000),
    sampleRate: 16000,
  },

  /**
   * 财跃 FinStep ReAct 资讯接口。
   * 注意：它是 LLM 问答接口（SSE 流式），不是纯数据 API；
   * 一次调用会跑完整 ReAct 循环，因此按「低频兜底源」使用，不当主采集源。
   */
  finstep: {
    apiKey: str('FINSTEP_API_KEY', ''),
    baseUrl: str('FINSTEP_BASE_URL', 'https://product-backend.finstep.cn'),
    completionPath: str('FINSTEP_COMPLETION_PATH', '/chat/react/chat/v2/completion'),
    /** 接口必填，snake_case；用固定值让同一环境调用可复用 */
    userId: str('FINSTEP_USER_ID', 'viral-topics-server'),
    /** 单次 ReAct 可能跑几十秒，给足超时 */
    timeoutMs: num('FINSTEP_TIMEOUT_MS', 180000),
    /** 启用哪些 FinStep 工具源（逗号分隔），默认只开两个已验证的低风险源 */
    enabledSources: str('FINSTEP_SOURCES', 'alpha_morning,hot_topics'),
    /** 早参取多长的正文进入摘要（避免 8000 字长文塞满列表页） */
    summaryMaxChars: num('FINSTEP_SUMMARY_MAX_CHARS', 300),
  },

  news: { fetchIntervalMin: num('NEWS_FETCH_INTERVAL_MIN', 15) },  sweep: { intervalMin: num('SWEEP_INTERVAL_MIN', 10), jitterRatio: 0.1 },

  hot: {
    multiplier: num('HOT_MULTIPLIER', 3), // D10 互动均值 ×3
    baselineSample: num('HOT_BASELINE_SAMPLE', 30),
    minSample: num('HOT_MIN_SAMPLE', 5),
    refreshDays: num('HOT_REFRESH_DAYS', 7),
  },

  fetchQueue: {
    concurrency: num('FETCH_CONCURRENCY', 3),
    ratePerSec: num('FETCH_RATE_PER_SEC', 5),
    maxPages: num('FETCH_MAX_PAGES', 2),
  },

  // T3 实测：作品列表对非本人视频的 play_count 可能恒为 0，为 0 时前端隐藏
  playCountVisible: bool('PLAY_COUNT_VISIBLE', false),

  /** 文案工坊（任务书 §2/§3/§7） */
  copy: {
    /** 计字口径：预计口播秒数 = 字数 ÷ 该值（FR-E5） */
    charsPerSec: num('COPY_CHARS_PER_SEC', 3.5),
    /** 查重：字符 n-gram 长度与素人线拦截阈值（§3.5 / AC-R2） */
    similarityN: num('COPY_SIMILARITY_N', 5),
    similarityThreshold: num('COPY_SIMILARITY_THRESHOLD', 0.3),
    /** 单 copy 稿数上限与单批生成数量上限（Q11） */
    maxDrafts: num('COPY_MAX_DRAFTS', 10),
    maxBatchCount: num('COPY_MAX_BATCH_COUNT', 5),
    /** 自定义时长上下限（秒，F5） */
    customDurationMin: num('COPY_DURATION_MIN_SEC', 10),
    customDurationMax: num('COPY_DURATION_MAX_SEC', 180),
    /** 输入限长 */
    maxInstructions: num('COPY_MAX_INSTRUCTIONS', 500),
    maxTitle: num('COPY_MAX_TITLE', 60),
    maxManualSource: num('COPY_MAX_MANUAL_SOURCE', 5000),
    /** 文章解析：文件与正文上限（FR-S2） */
    articleMaxBytes: num('ARTICLE_MAX_BYTES', 10 * 1024 * 1024),
    articleMaxChars: num('ARTICLE_MAX_CHARS', 20000),
    /** 生成并发与单次 LLM 重试（FR-G4） */
    generateConcurrency: num('COPY_GENERATE_CONCURRENCY', 2),
    /** 单次生成内多份稿的批内并发：真实模型单份 40–60 秒，串行会超过前端轮询窗口 */
    generateItemConcurrency: num('COPY_GENERATE_ITEM_CONCURRENCY', 3),
    llmRetry: num('COPY_LLM_RETRY', 1),
    /** 审核桩：每关模拟耗时（毫秒），smoke 可调小 */
    reviewStubStepMs: num('REVIEW_STUB_STEP_MS', 300),
  },

  /**
   * 文案二创专用模型（与百炼并行、互不覆盖）。
   * 三个必填项（BASE_URL / API_KEY / MODEL）齐备时启用，否则自动回退百炼 DASHSCOPE_*。
   * 适用于 Claude 原生协议或任何 OpenAI 兼容中转。
   */
  copyLlm: {
    baseUrl: str('COPY_LLM_BASE_URL', ''),
    apiKey: str('COPY_LLM_API_KEY', ''),
    model: str('COPY_LLM_MODEL', ''),
    /** auto | anthropic | openai：auto 时按 baseurl + 模型名猜，猜错会自动换协议重试一次 */
    protocol: str('COPY_LLM_PROTOCOL', 'auto') as 'auto' | 'anthropic' | 'openai',
    anthropicVersion: str('COPY_LLM_ANTHROPIC_VERSION', '2023-06-01'),
    autoFallbackProtocol: bool('COPY_LLM_AUTO_FALLBACK_PROTOCOL', true),
    timeoutMs: num('COPY_LLM_TIMEOUT_MS', 180000),
    /** 计价：优先用分隔单价，都为 0 时退化为「总 token × COPY_LLM_UNIT_PRICE」 */
    unitPrice: num('COPY_LLM_UNIT_PRICE', 0),
    inputPricePer1k: num('COPY_LLM_INPUT_PRICE_PER_1K', 0),
    outputPricePer1k: num('COPY_LLM_OUTPUT_PRICE_PER_1K', 0),
  },

  defaultOperator: str('DEFAULT_OPERATOR', 'ops'),
  mockFallback: bool('MOCK_FALLBACK', true),

  // §2.4 防 SSRF 白名单
  linkWhitelist: ['v.douyin.com', 'www.douyin.com', 'www.iesdouyin.com', 'douyin.com', 'iesdouyin.com'],
  maxRedirects: 3,
}

export function hasTikHub(): boolean {
  return !!config.tikhub.apiKey
}
export function hasDashScope(): boolean {
  return !!config.dashscope.apiKey
}
/** 文案二创是否已配置专用模型（三项齐备才算） */
export function hasCopyLlm(): boolean {
  return !!(config.copyLlm.baseUrl && config.copyLlm.apiKey)
}
export function hasOss(): boolean {
  return !!(config.oss.bucket && config.oss.accessKeyId && config.oss.accessKeySecret)
}
/** FinStep 资讯接口是否可用（无 Key 时该源整体不启用，不影响其它资讯源） */
export function hasFinStep(): boolean {
  return !!config.finstep.apiKey
}
