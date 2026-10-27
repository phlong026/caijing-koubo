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
  // DATA_DIR 供测试隔离本地兜底存储（.data/oss）；缺省仍是 server/.data
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(serverRoot, './.data'),
  // 发布管理的持久化浏览器上下文根目录（PB3：每账号一目录，Cookie/登录态留在目录内不入库）
  browserData: process.env.PUBLISH_BROWSER_DATA_DIR
    ? path.resolve(process.env.PUBLISH_BROWSER_DATA_DIR)
    : path.resolve(serverRoot, './.data/browser-data'),
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
      userInfo: str('TIKHUB_PATH_USER_INFO', '/api/v1/douyin/app/v3/handler_user_profile'),
      userPosts: str('TIKHUB_PATH_USER_POSTS', '/api/v1/douyin/app/v3/fetch_user_post_videos'),
      videoDetail: str('TIKHUB_PATH_VIDEO_DETAIL', '/api/v1/douyin/app/v3/fetch_one_video'),
      shareParse: str('TIKHUB_PATH_SHARE_PARSE', '/api/v1/douyin/app/v3/fetch_one_video_by_share_url'),
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
    /**
     * P2-13a：ASR 按音频时长计费的单价（元 / 秒）。配置后提取成本 = 时长 × 单价，
     * 未配置（0）时沿用按次计价 ASR_UNIT_PRICE。具体单价以百炼账单为准。
     */
    asrPricePerSec: num('ASR_PRICE_PER_SEC', 0),
  },

  oss: {
    region: str('OSS_REGION', 'oss-cn-shanghai'),
    bucket: str('OSS_BUCKET', ''),
    accessKeyId: str('OSS_ACCESS_KEY_ID', ''),
    accessKeySecret: str('OSS_ACCESS_KEY_SECRET', ''),
    internal: bool('OSS_INTERNAL', false),
    /** 数据面自定义端点（私有域名 / VPC 专线 / 本地仿真）；留空用 region 推导的官方域名 */
    endpoint: str('OSS_ENDPOINT', ''),
    /** 端点是绑定到 Bucket 的自定义域名（CNAME）时置 true：此时 URL 不再拼 bucket 前缀 */
    cname: bool('OSS_CNAME', false),
    /** 签名 URL 专用公网端点：飞影等外部服务必须能访问，OSS_INTERNAL=true 时不得走内网域名；留空 = 官方公网域名 */
    signEndpoint: str('OSS_SIGN_ENDPOINT', ''),
    /** 超过该大小改走分片上传（MB），避免把大视频整个读进内存 */
    multipartThresholdMb: num('OSS_MULTIPART_THRESHOLD_MB', 50),
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

  /**
   * 曙光舆情 MCP（saturn-news，JSON-RPC over streamableHttp）。
   * 与 FinStep 相反：这是**纯数据接口**，单次 0.5~2s，可以当主采集源用。
   * 注意 Authorization 头直接放 key，不要加 Bearer 前缀。
   */
  saturnNews: {
    apiKey: str('SATURN_NEWS_MCP_KEY', ''),
    url: str('SATURN_NEWS_MCP_URL', 'https://mcpgw.fullgoalservice.com.cn/ext-mcp/saturn-news-mcp'),
    timeoutMs: num('SATURN_NEWS_TIMEOUT_MS', 30000),
    /** 采集用的关键词（逗号分隔），逐个检索后合并去重 */
    keywords: str('SATURN_NEWS_KEYWORDS', 'A股,基金,央行'),
    /** 回看天数，生成 date_range 用 */
    lookbackDays: num('SATURN_NEWS_LOOKBACK_DAYS', 1),
    /** 每个关键词取多少条 */
    limitPerKeyword: num('SATURN_NEWS_LIMIT', 30),
    /** 采集哪几个通道：weibo_blog/flash/wechat/web_v1 */
    channels: str('SATURN_NEWS_CHANNELS', 'flash,wechat,web_v1'),
    /** 摘要最大字符数（snippet 最多 2000 字，列表页不需要那么长） */
    summaryMaxChars: num('SATURN_NEWS_SUMMARY_MAX_CHARS', 300),
    /** 是否在启动时校验连通性（false 可省一次 12s 握手） */
    probeOnBoot: str('SATURN_NEWS_PROBE_ON_BOOT', 'false') === 'true',
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
    /**
     * 审核桩开关（W1）：开启时提交后自动模拟三关并开放人工裁决接口，仅供本地联调 / smoke。
     * 桩裁决接口虽已限定审核员角色，但会跳过真实三关。
     * 决策 D3（2026-10-17）：测试期间不开审核桩 → 所有环境缺省关闭，需显式 REVIEW_STUB_ENABLED=true；
     * 关闭后审核单停在「已提交」，等真实审核（校对台）回写结果。
     */
    reviewStubEnabled: bool('REVIEW_STUB_ENABLED', false),
    /** 审核桩：每关模拟耗时（毫秒），smoke 可调小 */
    reviewStubStepMs: num('REVIEW_STUB_STEP_MS', 300),
  },

  /**
   * 校对台（外部内容审核平台，机审 + 人工初审/终审）。配置 BASE_URL 即启用：
   * 文案提交后送校对台，后台轮询进度，通过后以校对台返回的文案作为审核通过版本；启用后审核桩不再推进新单。
   */
  jiaoduitai: {
    baseUrl: str('JIAODUITAI_BASE_URL', ''),
    timeoutMs: num('JIAODUITAI_TIMEOUT_MS', 15000),
    pollMs: num('JIAODUITAI_POLL_MS', 15000),
    /**
     * 决策 D4（2026-10-27）：风险提示话术以校对台返回的为准。校对台 v1.1 文档尚无独立的话术字段，
     * 这里预留字段名：填写后从审核结果里取该字段作为追加话术（视频创作取稿优先使用），
     * 未填写或结果里没有时仍用模板 riskHint 兜底。
     */
    riskField: str('JIAODUITAI_RISK_FIELD', ''),
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
    /**
     * P0-4 合规闸门：COPY_LLM_* 指向第三方中转（如 ccg-cli.online）时，文案与人物档案会发往该服务。
     * 决策 D1（2026-10-27）：文案二创采用第三方中转的 Claude 模型，百炼只负责语音转文案 →
     * 所有环境缺省开启；需要临时停用中转时显式设为 false，文案生成回退百炼。
     */
    complianceApproved: bool('COPY_LLM_COMPLIANCE_APPROVED', true),
  },

  /**
   * 飞影 HiFly 开放平台 V2（https://hfw-api.hifly.cc，文档 https://api.hifly.cc/hifly.html）。
   * 声音克隆 / 口播分身制作 / 数字人口播视频生成统一走飞影（人物库模块任务书 §0.2 A8）。
   * 无密钥且 MOCK_FALLBACK=true 时由 mock 客户端接管（确定性标识、可注入 uncertain/failed）。
   */
  hifly: {
    apiKey: str('HIFLY_API_KEY', ''),
    baseUrl: str('HIFLY_BASE_URL', 'https://hfw-api.hifly.cc'),
    /** JSON 接口超时（毫秒） */
    timeoutMs: num('HIFLY_TIMEOUT_MS', 60000),
    /** 二进制（上传 / 下载）超时（毫秒） */
    binaryTimeoutMs: num('HIFLY_BINARY_TIMEOUT_MS', 300000),
    /** 轮询超过该时长仍非终态 → uncertain（R9，2 小时） */
    pollMaxAgeMs: num('HIFLY_POLL_MAX_AGE_MS', 7200000),
    /** 提交飞影时的 AIGC 标识（Q11，默认 1） */
    aigcFlag: num('HIFLY_AIGC_FLAG', 1) ? 1 : 0,
    /** 轮询起始间隔与退避上限（毫秒） */
    pollInitialMs: num('HIFLY_POLL_INITIAL_MS', 15000),
    pollMaxMs: num('HIFLY_POLL_MAX_MS', 120000),
    /** 积分余额缓存（毫秒，L14） */
    creditCacheMs: num('HIFLY_CREDIT_CACHE_MS', 300000),
    /** 授权即将到期提醒提前天数（FR-U3） */
    authExpiryRemindDays: num('AUTH_EXPIRY_REMIND_DAYS', 30),
    /** KOS 共享人物账号绑定上限（Q5） */
    kosSharedAccountLimit: num('KOS_SHARED_ACCOUNT_LIMIT', 5),
  },

  /**
   * 飞影成片结果域名白名单（FR-P4 防 SSRF：`video_Url` 只允许这些主机）。
   * PoC 记录实际域名后配置；未配置时放行 `*.hifly.cc` 与 `*.hiflycdn.com` 一类已知后缀。
   */
  videoResultHosts: str('HIFLY_RESULT_HOSTS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * 视频创作模块（任务书 §3.3 生成参数基线）。
   * 计价与生成耗时系数按 PoC 实测修订（V3 交付物）。
   */
  video: {
    /** 口播时长上限（秒，Q11）与提交文本上限（飞影 create_by_tts 10000 字） */
    maxSeconds: num('VIDEO_MAX_SECONDS', 180),
    maxTextChars: 10000,
    /** 输出规格（Q7）：规范化目标 */
    outputWidth: num('VIDEO_OUTPUT_WIDTH', 1080),
    outputHeight: num('VIDEO_OUTPUT_HEIGHT', 1920),
    outputFps: num('VIDEO_OUTPUT_FPS', 30),
    /** 飞影侧全局生成并发（A6）与本地阶段 worker 并发（下载/校验/对齐/合成） */
    genConcurrency: num('VIDEO_GEN_CONCURRENCY', 3),
    workerConcurrency: num('VIDEO_WORKER_CONCURRENCY', 2),
    /** 轮询间隔（video-poll-sweep 扫描周期）与查询异常退避序列 */
    pollIntervalMs: num('VIDEO_POLL_INTERVAL_MS', 10000),
    pollBackoffMs: [5000, 10000, 20000, 30000],
    /** 1001/1015（并发/提交数上限）延后重排秒数与最大重排次数 */
    submitResecSec: num('VIDEO_SUBMIT_REQUEUE_SEC', 60),
    submitResecMax: num('VIDEO_SUBMIT_REQUEUE_MAX', 5),
    /** 单 copy 基础视频版本上限 */
    jobLimitPerCopy: num('VIDEO_JOB_LIMIT_PER_COPY', 10),
    /** 成片下载上限（MB）与时长校验容差（毫秒） */
    archiveMaxMb: num('VIDEO_ARCHIVE_MAX_MB', 512),
    durationToleranceMs: num('VIDEO_DURATION_TOLERANCE_MS', 1000),
    /** 时间轴对齐分数阈值（FR-P5） */
    alignMinScore: num('VIDEO_ALIGN_MIN_SCORE', 0.85),
    /** 超长句二次切分上限（字符，FR-P1） */
    sentenceMaxChars: num('VIDEO_SENTENCE_MAX', 120),
    /** Q3=B 音频驱动时的句间隔（毫秒） */
    sentenceGapMs: num('VIDEO_SENTENCE_GAP_MS', 120),
    /** 切句与配音缓存身份的规则版本（规则变更即失效旧缓存） */
    segmentationVersion: str('VIDEO_SEGMENTATION_VERSION', 'v1'),
    /**
     * 生成进度估算：样本 <3 时预计生成秒数 = max(genSecondsMin, 预计秒 × genSecondsFactor)
     * （FR-A7，PoC 实测前默认 max(180, 预计秒 × 4)）
     */
    genSecondsFactor: num('VIDEO_GEN_SECONDS_FACTOR', 4),
    genSecondsMin: num('VIDEO_GEN_SECONDS_MIN', 180),
    /** 进度样本保留条数（按飞影最近 N 次生成耗时中位数自适应） */
    progressSamples: num('VIDEO_PROGRESS_SAMPLES', 10),
    /**
     * 预估积分 = creditsPerSec × 成片秒数（PoC 计价规则，未定前仅供界面展示，
     * 精确对账不在一期，§1.2）
     */
    creditsPerSec: num('VIDEO_CREDITS_PER_SEC', 0.5),
  },

  /**
   * 发布管理模块（任务书 §4.2 / PU0）。
   * 引擎抽象见 modules/publish/engine.ts：真实引擎平移 AI-Studio Playwright 流程，
   * mock 引擎（MOCK_FALLBACK=true 且未配置 PUBLISH_HEADLESS 环境时自动兜底）支持故障注入。
   */
  publish: {
    /** 服务端浏览器形态（PB2）：headless 默认开；PU9 灰度首验不过则回退 headful+Xvfb */
    headless: bool('PUBLISH_HEADLESS', true),
    /** 全局并发浏览器上下文上限（PB9，按服务器内存复核） */
    maxContexts: num('PUBLISH_MAX_CONTEXTS', 3),
    /** 空闲上下文自动关闭（毫秒） */
    idleCloseMs: num('PUBLISH_IDLE_CLOSE_MS', 600000),
    /** 获取上下文排队超时（毫秒）：超时任务回 scheduled 下轮再试，不失败 */
    acquireTimeoutMs: num('PUBLISH_ACQUIRE_TIMEOUT_MS', 300000),
    /** 每账号每日发布上限（PB8）：单独重发占用额度，补录不占用 */
    dailyLimitPerAccount: num('PUBLISH_DAILY_LIMIT_PER_ACCOUNT', 5),
    /** 发布确认窗口（毫秒，FR-E1）：平移 AI-Studio waitForPublishConfirmation 的 15 分钟 */
    confirmTimeoutMs: num('PUBLISH_CONFIRM_TIMEOUT_MS', 900000),
    /** confirming 卡死 sweep 兜底（毫秒，FR-E3）：只兜 worker 崩溃异常，引擎 15 分钟自行落定 */
    confirmSweepMs: num('PUBLISH_CONFIRM_SWEEP_MS', 1200000),
    /** 验证码人工窗口（毫秒，PB10）：verification_required 保留上下文等待人工 */
    manualWindowMs: num('PUBLISH_MANUAL_WINDOW_MS', 1800000),
    /** 登录会话超时（毫秒，FR-L1）与轮询节奏（publish-login-sweep） */
    loginSessionTimeoutMs: num('PUBLISH_LOGIN_SESSION_TIMEOUT_MS', 7200000),
    loginPollIntervalMs: num('PUBLISH_LOGIN_POLL_INTERVAL_MS', 15000),
    /** 发布 sweep 扫描周期（毫秒）：到期计划 / 重试 / 窗口超时 / 守护（§3.5） */
    sweepIntervalMs: num('PUBLISH_SWEEP_INTERVAL_MS', 60000),
    /** 失败自动重试延迟（毫秒，PB6：1 次 / 5 分钟） */
    retryDelayMs: num('PUBLISH_RETRY_DELAY_MS', 300000),
    /** schedule 最早可定时间（毫秒，FR-C3：≥ now + 1min） */
    minScheduleAheadMs: num('PUBLISH_MIN_SCHEDULE_AHEAD_MS', 60000),
    /** executing 计划卡死守护阈值（毫秒） */
    planStuckMs: num('PUBLISH_PLAN_STUCK_MS', 7200000),
    /**
     * 真实发布引擎（PU2/PU3）：auto（默认）= MOCK_FALLBACK=true 时全 mock、false 时已平移平台走真实；
     * 显式 true / false 覆盖 auto（如开发机临时验证真实引擎）。未平移平台在非 mock 模式下明确报错。
     */
    realEngine: str('PUBLISH_REAL_ENGINE', 'auto'),
  },

  /**
   * 视频剪辑模块（任务书 §4.2 / CE0）。
   * 渲染引擎见 modules/cut/engine.ts：ffmpeg 完整链路需环境带 libass/freetype
   * （check-media-env 探测）；缺失且 MOCK_FALLBACK=true 时自动降级 mock（字幕直过、尾页纯色）。
   */
  cut: {
    /** 渲染 worker 并发（Q7：与视频创作 genConcurrency 分队列互不影响） */
    workerConcurrency: num('CUT_WORKER_CONCURRENCY', 2),
    /** 单步 ffmpeg 超时（毫秒，沿 compose.runFfmpeg 基线） */
    stepTimeoutMs: num('CUT_STEP_TIMEOUT_MS', 600000),
    /** 整任务卡死兜底（毫秒，FR-J3）：rendering 超此时长无进展 → failed(CUT_RENDER_TIMEOUT) */
    renderTimeoutMs: num('CUT_RENDER_TIMEOUT_MS', 1800000),
    /** cancelling 无进展兜底（毫秒，§3.1）：超时 sweep 直接收尾 cancelled */
    cancellingTimeoutMs: num('CUT_CANCELLING_TIMEOUT_MS', 600000),
    /** video-cut-sweep 扫描周期（毫秒） */
    sweepIntervalMs: num('CUT_SWEEP_INTERVAL_MS', 60000),
    /** 剪气口默认参数（Q3：默认关） */
    defaultNoiseDb: num('CUT_NOISE_DB', -30),
    minSilenceMs: num('CUT_MIN_SILENCE_MS', 500),
    keepGapMs: num('CUT_KEEP_GAP_MS', 120),
    /** BGM 默认音量 / 淡入淡出（毫秒） */
    bgmVolume: num('CUT_BGM_VOLUME', 0.2),
    bgmFadeMs: num('CUT_BGM_FADE_MS', 2000),
    /** 风险尾页默认时长（秒，Q4）与上限 */
    riskTailSeconds: num('CUT_RISK_TAIL_SECONDS', 5),
    riskTailMaxSeconds: num('CUT_RISK_TAIL_MAX_SECONDS', 15),
    /** 内置字体目录（fontsdir）与单段字幕文本上限 */
    fontsDir: str('CUT_FONTS_DIR', 'assets/fonts'),
    maxSegmentsTextLen: num('CUT_SEGMENT_TEXT_MAX', 200),
    /** BGM 上传大小上限（MB） */
    bgmMaxMb: num('CUT_BGM_MAX_MB', 20),
    /** 字体上传大小上限（MB，Q7：30 不够再调） */
    fontMaxMb: num('CUT_FONT_MAX_MB', 30),
  },

  /**
   * 登录与权限（P0-1）。
   * 操作人一律取自登录令牌，不再信任请求头 X-Operator。
   * 生产环境必须配置 AUTH_JWT_SECRET（≥32 字符），否则拒绝启动。
   */
  auth: {
    jwtSecret: str('AUTH_JWT_SECRET', ''),
    tokenTtlHours: num('AUTH_TOKEN_TTL_HOURS', 12),
    cookieName: 'mw_token',
    /** 库内没有任何账号时，用它创建首个管理员；开发环境缺省 admin / admin123 */
    bootstrapAdminUser: str('AUTH_BOOTSTRAP_ADMIN_USER', 'admin'),
    bootstrapAdminPassword: str('AUTH_BOOTSTRAP_ADMIN_PASSWORD', ''),
    /** 连续失败多少次后锁定、锁定多久（分钟） */
    maxLoginFailures: num('AUTH_MAX_LOGIN_FAILURES', 5),
    lockMinutes: num('AUTH_LOCK_MINUTES', 5),
  },
  /** P2-12：计费 / 高成本接口按操作人限流；RATE_LIMIT_SCALE 整体放大或缩小各接口的每分钟次数 */
  rateLimit: {
    enabled: bool('RATE_LIMIT_ENABLED', true),
    scale: num('RATE_LIMIT_SCALE', 1),
  },
  /** 允许跨域的前端来源（逗号分隔）；生产缺省为空 = 只允许同源 */
  corsOrigins: str(
    'CORS_ORIGINS',
    str('NODE_ENV', 'development') === 'production' ? '' : 'http://localhost:5173,http://127.0.0.1:5173',
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * 示例数据（P1-6）：示例人物「张经理（示例）」等及其占位授权。
   * 占位授权没有实体材料却标记为「已核验」，会进入合规审计口径，因此生产缺省关闭；
   * 关闭时启动会把已存在的示例人物归档、示例授权撤销（幂等）。
   */
  seedDemo: bool('SEED_DEMO', str('NODE_ENV', 'development') !== 'production'),

  defaultOperator: str('DEFAULT_OPERATOR', 'ops'),
  // P1-7：生产环境默认**关闭** mock 兜底；否则漏配 key 时会静默返回假账号/假视频/假转写。
  mockFallback: bool('MOCK_FALLBACK', str('NODE_ENV', 'development') !== 'production'),

  /**
   * 资讯「内置示意源」开关（与 mockFallback 解耦）。
   *
   * 为什么必须拆开：`mockFallback` 同时是 TikHub / 百炼 ASR / 百炼 LLM / OSS / 文案模型
   * 的兜底开关。为了让热点资讯只用真实数据就把 MOCK_FALLBACK 关掉，会让视频提取、
   * 文案生成一并报「未配置密钥」——用一个全局开关去控制单个数据源的展示口径，
   * 是明显的粒度错误。
   *
   * 默认：开发环境 true（免得没配 key 时资讯列表空白），生产 false。
   * 想让资讯只出现真实来源时，单独设 `NEWS_MOCK_SOURCE=false`。
   */
  newsMockSource: bool('NEWS_MOCK_SOURCE', str('NODE_ENV', 'development') !== 'production'),

  // §2.4 防 SSRF 白名单：与任务书 §2.4 的 3 个域名保持一致（P2-14）
  linkWhitelist: ['v.douyin.com', 'www.douyin.com', 'www.iesdouyin.com'],
  maxRedirects: 3,
}

export function hasTikHub(): boolean {
  return !!config.tikhub.apiKey
}
export function hasDashScope(): boolean {
  return !!config.dashscope.apiKey
}
/** 文案二创是否启用专用模型：BASE_URL 与 API_KEY 齐备，且（生产环境）已通过合规批准 */
export function hasCopyLlm(): boolean {
  return !!(config.copyLlm.baseUrl && config.copyLlm.apiKey && config.copyLlm.complianceApproved)
}
export function hasOss(): boolean {
  return !!(config.oss.bucket && config.oss.accessKeyId && config.oss.accessKeySecret)
}
/** OSS 配置自检：返回问题清单（半配置、内网域名无法被外部访问等），启动时打印 */
export function ossConfigIssues(): string[] {
  const o = config.oss
  const issues: string[] = []
  const set = [o.bucket, o.accessKeyId, o.accessKeySecret].filter(Boolean).length
  if (set > 0 && set < 3) {
    issues.push('OSS 配置不完整：OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET 需同时填写，当前按「未配置」处理（回落本地存储）')
  }
  if (set === 3) {
    if (!/^oss-[a-z0-9-]+$/.test(o.region) && !o.endpoint) {
      issues.push(`OSS_REGION「${o.region}」格式应为 oss-cn-shanghai 这类，或改填 OSS_ENDPOINT`)
    }
    if (o.internal && !o.signEndpoint) {
      issues.push('OSS_INTERNAL=true：数据面走内网，签名 URL 已强制改用公网域名；如需自定义公网域名请设置 OSS_SIGN_ENDPOINT')
    }
    if (o.signEndpoint && !/^https:\/\//i.test(o.signEndpoint)) {
      issues.push('OSS_SIGN_ENDPOINT 必须是 https:// 开头，否则飞影自取会被判不可用并回落自上传')
    }
  }
  return issues
}
/** FinStep 资讯接口是否可用（无 Key 时该源整体不启用，不影响其它资讯源） */
export function hasFinStep(): boolean {
  return !!config.finstep.apiKey
}
/** 校对台审核平台是否已接入（未配置时沿用审核桩 / 人工复核） */
export function hasJiaoduitai(): boolean {
  return !!config.jiaoduitai.baseUrl
}
/**
 * 文案审核当前由谁处理（新提交的单）：校对台 > 审核桩 > 人工复核。
 * 与 submitForReview 的分流一致：校对台已接入时审核桩不推进新单；都没有时由审核员在审核工作台直接裁决。
 */
export function reviewMode(): 'jiaoduitai' | 'stub' | 'manual' {
  if (hasJiaoduitai()) return 'jiaoduitai'
  return config.copy.reviewStubEnabled ? 'stub' : 'manual'
}
/** 飞影 HiFly 是否已配置（无 Key 时 mock 兜底，人物库克隆链路仍可联调） */
export function hasHifly(): boolean {
  return !!config.hifly.apiKey
}
/** 曙光舆情 MCP 是否可用 */
export function hasSaturnNews(): boolean {
  return !!(config.saturnNews.apiKey && config.saturnNews.url)
}
