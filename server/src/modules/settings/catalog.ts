/**
 * 系统设置配置清单（用户中心 → 系统设置）。
 *
 * 定位：让运营在界面里管理 .env 的等价配置，不再 SSH 改文件——这也是桌面版的前置工程。
 * key 即环境变量名；path 指向 config 对象中的字段，保存后热写入（读 config 的代码立即拿到新值）。
 *
 * 两类特殊标记：
 *  - restart：行为在进程启动时固化（如调度周期已注册的定时任务），改完需重启才完全生效；
 *    config 对象仍会热更新，新读取的代码用新值。
 *  - readonly：连接级配置（数据库 / Redis / 端口 / 路径 / JWT 密钥）。这些在进程启动时建立，
 *    界面改了无法生效（重启也一样，因为设置表在连接建立之后才可读），因此只展示、拒写，
 *    引导到 .env 修改。桌面版数据库固定 SQLite、队列固定 memory，不依赖这组配置。
 */
export interface SettingDef {
  key: string
  label: string
  desc?: string
  type: 'string' | 'number' | 'boolean' | 'password'
  group: string
  /** config 对象中的定位（读取用）；readonly 项保存时拒绝 */
  path: (string | number)[]
  restart?: boolean
  readonly?: boolean
}

export interface SettingGroup {
  key: string
  title: string
  desc?: string
  /** 开关类危险组（顶部红条警示） */
  danger?: boolean
}

export const SETTING_GROUPS: SettingGroup[] = [
  { key: 'copyllm', title: '文案二创专用模型', desc: 'COPY_LLM_*：Claude 等第三方模型中转，配置齐备即启用，否则回退百炼。保存后立即生效。' },
  { key: 'dashscope', title: '阿里云百炼（LLM / ASR）', desc: '文案生成的回退模型与视频转写。保存后立即生效。' },
  { key: 'hifly', title: '飞影数字人平台', desc: '声音克隆 / 口播分身 / 数字人视频生成。保存后立即生效。' },
  { key: 'tikhub', title: 'TikHub 对标数据源', desc: '对标账号与视频数据采集（D4）。' },
  { key: 'finstep', title: '财跃 FinStep 资讯', desc: 'ReAct 资讯接口（市场早参 / 热门主题），留空不启用。' },
  { key: 'saturn', title: '曙光舆情 MCP', desc: '主采集源之一（纯数据接口）。注意：Authorization 直接放 key，不加 Bearer 前缀。' },
  { key: 'jiaoduitai', title: '校对台对接', desc: '配置 BASE_URL 即启用外部校对台审核链路。' },
  { key: 'oss', title: '对象存储 OSS', desc: '提取链路中转；未配全时回落本地存储。' },
  { key: 'schedule', title: '采集与并发调度', desc: '调度周期与队列并发。已注册的定时任务按启动时的周期运行，调整后需重启服务完全生效。', },
  { key: 'hotrule', title: '爆款判定口径', desc: 'HOT_*：对标数据的爆款判定参数（D10）。' },
  { key: 'pipeline', title: '链路与展示口径', desc: '提取模式、时长上限与展示开关。' },
  { key: 'auth', title: '登录与限流', desc: '令牌有效期、登录锁定与接口限流。' },
  { key: 'dev', title: '开发与兜底开关', desc: '仅联调使用。生产环境误开会静默返回模拟数据或跳过真实审核。', danger: true },
  { key: 'deploy', title: '部署与环境（只读）', desc: '数据库 / Redis / 端口等在进程启动时建立，界面不可改；请修改 .env 后重启。' },
]

export const SETTING_DEFS: SettingDef[] = [
  /* ── 文案二创专用模型 ── */
  { key: 'COPY_LLM_BASE_URL', label: 'Base URL', type: 'string', group: 'copyllm', path: ['copyLlm', 'baseUrl'] },
  { key: 'COPY_LLM_API_KEY', label: 'API Key', type: 'password', group: 'copyllm', path: ['copyLlm', 'apiKey'] },
  { key: 'COPY_LLM_MODEL', label: '模型名', type: 'string', group: 'copyllm', path: ['copyLlm', 'model'], desc: '如 claude-opus-5.5' },
  { key: 'COPY_LLM_PROTOCOL', label: '协议', type: 'string', group: 'copyllm', path: ['copyLlm', 'protocol'], desc: 'auto | openai | anthropic' },
  { key: 'COPY_LLM_ANTHROPIC_VERSION', label: 'Anthropic 版本头', type: 'string', group: 'copyllm', path: ['copyLlm', 'anthropicVersion'] },
  { key: 'COPY_LLM_AUTO_FALLBACK_PROTOCOL', label: '协议猜错自动换重试', type: 'boolean', group: 'copyllm', path: ['copyLlm', 'autoFallbackProtocol'] },
  { key: 'COPY_LLM_TIMEOUT_MS', label: '超时（毫秒）', type: 'number', group: 'copyllm', path: ['copyLlm', 'timeoutMs'] },
  { key: 'COPY_LLM_UNIT_PRICE', label: '单价（元/千token）', type: 'number', group: 'copyllm', path: ['copyLlm', 'unitPrice'], desc: '分隔单价未配时按此计' },
  { key: 'COPY_LLM_INPUT_PRICE_PER_1K', label: '输入单价（元/千token）', type: 'number', group: 'copyllm', path: ['copyLlm', 'inputPricePer1k'] },
  { key: 'COPY_LLM_OUTPUT_PRICE_PER_1K', label: '输出单价（元/千token）', type: 'number', group: 'copyllm', path: ['copyLlm', 'outputPricePer1k'] },
  { key: 'COPY_LLM_COMPLIANCE_APPROVED', label: '合规已批准（P0-4）', type: 'boolean', group: 'copyllm', path: ['copyLlm', 'complianceApproved'], desc: '缺省开启（决策 D1）；设为 false 时文案生成回退百炼' },

  /* ── 百炼 ── */
  { key: 'DASHSCOPE_API_KEY', label: 'API Key', type: 'password', group: 'dashscope', path: ['dashscope', 'apiKey'] },
  { key: 'DASHSCOPE_BASE_URL', label: 'Base URL（兼容模式）', type: 'string', group: 'dashscope', path: ['dashscope', 'baseUrl'] },
  { key: 'DASHSCOPE_NATIVE_URL', label: 'Native URL', type: 'string', group: 'dashscope', path: ['dashscope', 'nativeUrl'] },
  { key: 'LLM_MODEL', label: 'LLM 模型', type: 'string', group: 'dashscope', path: ['dashscope', 'llmModel'] },
  { key: 'ASR_MODEL', label: 'ASR 模型', type: 'string', group: 'dashscope', path: ['dashscope', 'asrModel'] },
  { key: 'LLM_UNIT_PRICE', label: 'LLM 单价（元/千token）', type: 'number', group: 'dashscope', path: ['dashscope', 'llmUnitPrice'] },
  { key: 'ASR_UNIT_PRICE', label: 'ASR 单价（元/次）', type: 'number', group: 'dashscope', path: ['dashscope', 'asrUnitPrice'] },

  /* ── 飞影 ── */
  { key: 'HIFLY_API_KEY', label: 'API Key', type: 'password', group: 'hifly', path: ['hifly', 'apiKey'] },
  { key: 'HIFLY_BASE_URL', label: 'Base URL', type: 'string', group: 'hifly', path: ['hifly', 'baseUrl'] },
  { key: 'HIFLY_TIMEOUT_MS', label: 'JSON 超时（毫秒）', type: 'number', group: 'hifly', path: ['hifly', 'timeoutMs'] },
  { key: 'HIFLY_BINARY_TIMEOUT_MS', label: '二进制超时（毫秒）', type: 'number', group: 'hifly', path: ['hifly', 'binaryTimeoutMs'] },

  /* ── TikHub ── */
  { key: 'TIKHUB_API_KEY', label: 'API Key', type: 'password', group: 'tikhub', path: ['tikhub', 'apiKey'] },
  { key: 'TIKHUB_BASE_URL', label: 'Base URL', type: 'string', group: 'tikhub', path: ['tikhub', 'baseUrl'] },
  { key: 'TIKHUB_PATH_USER_INFO', label: '用户信息接口路径', type: 'string', group: 'tikhub', path: ['tikhub', 'paths', 'userInfo'] },
  { key: 'TIKHUB_PATH_USER_POSTS', label: '用户作品接口路径', type: 'string', group: 'tikhub', path: ['tikhub', 'paths', 'userPosts'] },
  { key: 'TIKHUB_PATH_VIDEO_DETAIL', label: '视频详情接口路径', type: 'string', group: 'tikhub', path: ['tikhub', 'paths', 'videoDetail'] },
  { key: 'TIKHUB_PATH_SHARE_PARSE', label: '分享解析接口路径', type: 'string', group: 'tikhub', path: ['tikhub', 'paths', 'shareParse'] },
  { key: 'TIKHUB_TIMEOUT_MS', label: '超时（毫秒）', type: 'number', group: 'tikhub', path: ['tikhub', 'timeoutMs'] },
  { key: 'TIKHUB_UNIT_PRICE', label: '单价（元/次）', type: 'number', group: 'tikhub', path: ['tikhub', 'unitPrice'] },

  /* ── FinStep ── */
  { key: 'FINSTEP_API_KEY', label: 'API Key', type: 'password', group: 'finstep', path: ['finstep', 'apiKey'] },
  { key: 'FINSTEP_BASE_URL', label: 'Base URL', type: 'string', group: 'finstep', path: ['finstep', 'baseUrl'] },
  { key: 'FINSTEP_COMPLETION_PATH', label: 'Completion 路径', type: 'string', group: 'finstep', path: ['finstep', 'completionPath'] },
  { key: 'FINSTEP_USER_ID', label: 'User ID', type: 'string', group: 'finstep', path: ['finstep', 'userId'] },
  { key: 'FINSTEP_TIMEOUT_MS', label: '超时（毫秒）', type: 'number', group: 'finstep', path: ['finstep', 'timeoutMs'] },
  { key: 'FINSTEP_SOURCES', label: '启用源（逗号分隔）', type: 'string', group: 'finstep', path: ['finstep', 'enabledSources'] },
  { key: 'FINSTEP_SUMMARY_MAX_CHARS', label: '摘要上限（字符）', type: 'number', group: 'finstep', path: ['finstep', 'summaryMaxChars'] },

  /* ── 曙光舆情 ── */
  { key: 'SATURN_NEWS_MCP_KEY', label: 'MCP Key', type: 'password', group: 'saturn', path: ['saturnNews', 'apiKey'] },
  { key: 'SATURN_NEWS_MCP_URL', label: 'MCP URL', type: 'string', group: 'saturn', path: ['saturnNews', 'url'] },
  { key: 'SATURN_NEWS_TIMEOUT_MS', label: '超时（毫秒）', type: 'number', group: 'saturn', path: ['saturnNews', 'timeoutMs'] },
  { key: 'SATURN_NEWS_KEYWORDS', label: '采集关键词（逗号分隔）', type: 'string', group: 'saturn', path: ['saturnNews', 'keywords'] },
  { key: 'SATURN_NEWS_LOOKBACK_DAYS', label: '回看天数', type: 'number', group: 'saturn', path: ['saturnNews', 'lookbackDays'] },
  { key: 'SATURN_NEWS_LIMIT', label: '每词条数', type: 'number', group: 'saturn', path: ['saturnNews', 'limitPerKeyword'] },
  { key: 'SATURN_NEWS_CHANNELS', label: '通道（逗号分隔）', type: 'string', group: 'saturn', path: ['saturnNews', 'channels'] },
  { key: 'SATURN_NEWS_SUMMARY_MAX_CHARS', label: '摘要上限（字符）', type: 'number', group: 'saturn', path: ['saturnNews', 'summaryMaxChars'] },
  { key: 'SATURN_NEWS_PROBE_ON_BOOT', label: '启动时连通性校验', type: 'boolean', group: 'saturn', path: ['saturnNews', 'probeOnBoot'], restart: true },

  /* ── 校对台 ── */
  { key: 'JIAODUITAI_BASE_URL', label: 'Base URL', type: 'string', group: 'jiaoduitai', path: ['jiaoduitai', 'baseUrl'], desc: '配置即启用外部校对台审核' },
  { key: 'JIAODUITAI_TIMEOUT_MS', label: '超时（毫秒）', type: 'number', group: 'jiaoduitai', path: ['jiaoduitai', 'timeoutMs'] },
  { key: 'JIAODUITAI_POLL_MS', label: '轮询间隔（毫秒）', type: 'number', group: 'jiaoduitai', path: ['jiaoduitai', 'pollMs'] },
  { key: 'JIAODUITAI_RISK_FIELD', label: '风险话术字段名', type: 'string', group: 'jiaoduitai', path: ['jiaoduitai', 'riskField'], desc: '审核结果里风险提示话术的字段名；留空则用模板话术（决策 D4）' },

  /* ── OSS ── */
  { key: 'OSS_REGION', label: 'Region', type: 'string', group: 'oss', path: ['oss', 'region'] },
  { key: 'OSS_BUCKET', label: 'Bucket', type: 'string', group: 'oss', path: ['oss', 'bucket'] },
  { key: 'OSS_ACCESS_KEY_ID', label: 'Access Key ID', type: 'password', group: 'oss', path: ['oss', 'accessKeyId'] },
  { key: 'OSS_ACCESS_KEY_SECRET', label: 'Access Key Secret', type: 'password', group: 'oss', path: ['oss', 'accessKeySecret'] },
  { key: 'OSS_INTERNAL', label: '走内网域名', type: 'boolean', group: 'oss', path: ['oss', 'internal'] },
  { key: 'OSS_PREFIX', label: '对象前缀', type: 'string', group: 'oss', path: ['oss', 'prefix'] },
  { key: 'OSS_SIGNED_URL_TTL', label: '签名 URL 有效期（秒）', type: 'number', group: 'oss', path: ['oss', 'signedUrlTtl'] },

  /* ── 采集与调度 ── */
  { key: 'NEWS_FETCH_INTERVAL_MIN', label: '资讯采集周期（分钟）', type: 'number', group: 'schedule', path: ['news', 'fetchIntervalMin'], restart: true },
  { key: 'SWEEP_INTERVAL_MIN', label: '对标扫描周期（分钟）', type: 'number', group: 'schedule', path: ['sweep', 'intervalMin'], restart: true },
  { key: 'FETCH_CONCURRENCY', label: '抓取并发', type: 'number', group: 'schedule', path: ['fetchQueue', 'concurrency'] },
  { key: 'FETCH_RATE_PER_SEC', label: '抓取限速（次/秒）', type: 'number', group: 'schedule', path: ['fetchQueue', 'ratePerSec'] },
  { key: 'COPY_GENERATE_ITEM_CONCURRENCY', label: '文案批内并发', type: 'number', group: 'schedule', path: ['copy', 'generateItemConcurrency'] },
  { key: 'CUT_WORKER_CONCURRENCY', label: '剪辑渲染并发', type: 'number', group: 'schedule', path: ['cut', 'workerConcurrency'], restart: true },
  { key: 'VIDEO_GEN_CONCURRENCY', label: '视频生成并发', type: 'number', group: 'schedule', path: ['video', 'genConcurrency'] },
  { key: 'VIDEO_WORKER_CONCURRENCY', label: '视频本地 worker 并发', type: 'number', group: 'schedule', path: ['video', 'workerConcurrency'], restart: true },
  { key: 'PUBLISH_MAX_CONTEXTS', label: '发布浏览器上下文上限', type: 'number', group: 'schedule', path: ['publish', 'maxContexts'] },

  /* ── 爆款判定 ── */
  { key: 'HOT_MULTIPLIER', label: '互动均值倍数', type: 'number', group: 'hotrule', path: ['hot', 'multiplier'] },
  { key: 'HOT_BASELINE_SAMPLE', label: '基线样本数', type: 'number', group: 'hotrule', path: ['hot', 'baselineSample'] },
  { key: 'HOT_MIN_SAMPLE', label: '最小样本数', type: 'number', group: 'hotrule', path: ['hot', 'minSample'] },
  { key: 'HOT_REFRESH_DAYS', label: '基线刷新天数', type: 'number', group: 'hotrule', path: ['hot', 'refreshDays'] },

  /* ── 链路与口径 ── */
  { key: 'EXTRACT_MODE', label: '提取模式', type: 'string', group: 'pipeline', path: ['extract', 'mode'], desc: 'oss | direct' },
  { key: 'EXTRACT_MAX_DURATION_MIN', label: '提取时长上限（分钟）', type: 'number', group: 'pipeline', path: ['extract', 'maxDurationMin'] },
  { key: 'PLAY_COUNT_VISIBLE', label: '作品列表显示播放数', type: 'boolean', group: 'pipeline', path: ['playCountVisible'] },
  { key: 'DEFAULT_OPERATOR', label: '操作人缺省值', type: 'string', group: 'pipeline', path: ['defaultOperator'] },

  /* ── 登录与限流 ── */
  { key: 'AUTH_TOKEN_TTL_HOURS', label: '令牌有效期（小时）', type: 'number', group: 'auth', path: ['auth', 'tokenTtlHours'] },
  { key: 'AUTH_MAX_LOGIN_FAILURES', label: '连续失败锁定阈值', type: 'number', group: 'auth', path: ['auth', 'maxLoginFailures'] },
  { key: 'AUTH_LOCK_MINUTES', label: '锁定时长（分钟）', type: 'number', group: 'auth', path: ['auth', 'lockMinutes'] },
  { key: 'RATE_LIMIT_ENABLED', label: '接口限流开关', type: 'boolean', group: 'auth', path: ['rateLimit', 'enabled'] },
  { key: 'RATE_LIMIT_SCALE', label: '限流倍率', type: 'number', group: 'auth', path: ['rateLimit', 'scale'] },

  /* ── 开发与兜底（危险组） ── */
  { key: 'MOCK_FALLBACK', label: 'Mock 兜底', type: 'boolean', group: 'dev', path: ['mockFallback'], desc: '无 key 时返回模拟数据，生产必须关' },
  { key: 'NEWS_MOCK_SOURCE', label: '资讯内置示意源', type: 'boolean', group: 'dev', path: ['newsMockSource'], desc: '生产应关：资讯只展示真实来源' },
  { key: 'REVIEW_STUB_ENABLED', label: '审核桩', type: 'boolean', group: 'dev', path: ['copy', 'reviewStubEnabled'], desc: '提交后自动模拟三关，生产必须关' },
  { key: 'SEED_DEMO', label: '示例人物种子', type: 'boolean', group: 'dev', path: ['seedDemo'], desc: '生产应关：示例人物会进合规审计口径', restart: true },

  /* ── 部署与环境（只读） ── */
  { key: 'PORT', label: '服务端口', type: 'number', group: 'deploy', path: ['port'], readonly: true },
  { key: 'LOG_LEVEL', label: '日志级别', type: 'string', group: 'deploy', path: ['logLevel'], readonly: true },
  { key: 'DB_DRIVER', label: '数据库驱动', type: 'string', group: 'deploy', path: ['db', 'driver'], readonly: true },
  { key: 'DB_HOST', label: 'MySQL 主机', type: 'string', group: 'deploy', path: ['db', 'host'], readonly: true },
  { key: 'DB_PORT', label: 'MySQL 端口', type: 'number', group: 'deploy', path: ['db', 'port'], readonly: true },
  { key: 'DB_USER', label: 'MySQL 用户', type: 'string', group: 'deploy', path: ['db', 'user'], readonly: true },
  { key: 'DB_PASSWORD', label: 'MySQL 密码', type: 'password', group: 'deploy', path: ['db', 'password'], readonly: true },
  { key: 'DB_NAME', label: 'MySQL 库名', type: 'string', group: 'deploy', path: ['db', 'database'], readonly: true },
  { key: 'DB_SQLITE_PATH', label: 'SQLite 路径', type: 'string', group: 'deploy', path: ['db', 'sqlitePath'], readonly: true },
  { key: 'REDIS_HOST', label: 'Redis 主机', type: 'string', group: 'deploy', path: ['redis', 'host'], readonly: true },
  { key: 'REDIS_PORT', label: 'Redis 端口', type: 'number', group: 'deploy', path: ['redis', 'port'], readonly: true },
  { key: 'REDIS_PASSWORD', label: 'Redis 密码', type: 'password', group: 'deploy', path: ['redis', 'password'], readonly: true },
  { key: 'REDIS_DB', label: 'Redis DB', type: 'number', group: 'deploy', path: ['redis', 'db'], readonly: true },
  { key: 'QUEUE_PREFIX', label: '队列前缀', type: 'string', group: 'deploy', path: ['queuePrefix'], readonly: true },
  { key: 'AUTH_JWT_SECRET', label: 'JWT 密钥', type: 'password', group: 'deploy', path: ['auth', 'jwtSecret'], readonly: true },
]

export const SETTING_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]))
