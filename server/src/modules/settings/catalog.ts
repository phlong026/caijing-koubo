/**
 * 系统设置配置清单（用户中心 → 系统设置）。
 *
 * 定位：界面只保留「开通一个服务必填」的参数——凭据（API Key）、开通开关性质的
 * Base URL、以及直接决定产出的模型选择。超时 / 并发 / 单价 / 接口路径 / 调度周期
 * 等调优项不进界面，一律走 .env（见 .env.example）+ 代码默认值；数据库 / Redis /
 * 端口 / JWT 等部署级配置同样只在 .env 维护（桌面版固定 SQLite + memory 队列，不依赖）。
 *
 * key 即环境变量名；path 指向 config 对象中的字段，保存后热写入（读 config 的代码立即拿到新值）。
 */
export interface SettingDef {
  key: string
  label: string
  desc?: string
  type: 'string' | 'number' | 'boolean' | 'password'
  group: string
  /** config 对象中的定位（读取 / 热写用） */
  path: (string | number)[]
  /** 行为在进程启动时固化、需重启才完全生效的项 */
  restart?: boolean
  /** 只展示、拒写（保留机制备用；当前清单无此类项） */
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
  { key: 'copyllm', title: '文案二创专用模型', desc: 'COPY_LLM_*：Claude 等第三方模型中转，地址与 Key 配齐即启用，否则回退百炼；生产环境需同时打开合规开关。保存后立即生效。' },
  { key: 'dashscope', title: '阿里云百炼（LLM / ASR）', desc: '文案生成的回退模型与视频转写。保存后立即生效。' },
  { key: 'hifly', title: '飞影数字人平台', desc: '声音克隆 / 口播分身 / 数字人视频生成。保存后立即生效。' },
  { key: 'tikhub', title: 'TikHub 对标数据源', desc: '对标账号与视频数据采集（D4）。' },
  { key: 'finstep', title: '财跃 FinStep 资讯', desc: 'ReAct 资讯接口（市场早参 / 热门主题），填 Key 即启用。' },
  { key: 'saturn', title: '曙光舆情 MCP', desc: '主采集源之一（纯数据接口），填 Key 即启用。' },
  { key: 'jiaoduitai', title: '校对台对接', desc: '填写服务地址即启用外部校对台审核链路。' },
  { key: 'oss', title: '对象存储 OSS', desc: '提取链路中转；四项配齐即启用，未配全时回落本地存储。' },
]

export const SETTING_DEFS: SettingDef[] = [
  /* ── 文案二创专用模型 ── */
  { key: 'COPY_LLM_BASE_URL', label: 'Base URL', type: 'string', group: 'copyllm', path: ['copyLlm', 'baseUrl'] },
  { key: 'COPY_LLM_API_KEY', label: 'API Key', type: 'password', group: 'copyllm', path: ['copyLlm', 'apiKey'] },
  { key: 'COPY_LLM_MODEL', label: '模型名', type: 'string', group: 'copyllm', path: ['copyLlm', 'model'], desc: '如 claude-opus-5.5' },
  { key: 'COPY_LLM_COMPLIANCE_APPROVED', label: '第三方合规已批准', type: 'boolean', group: 'copyllm', path: ['copyLlm', 'complianceApproved'], desc: '生产环境必须开启，否则配了 Key 也会回退百炼' },

  /* ── 百炼 ── */
  { key: 'DASHSCOPE_API_KEY', label: 'API Key', type: 'password', group: 'dashscope', path: ['dashscope', 'apiKey'] },
  { key: 'LLM_MODEL', label: 'LLM 模型', type: 'string', group: 'dashscope', path: ['dashscope', 'llmModel'], desc: '默认 qwen-plus' },
  { key: 'ASR_MODEL', label: 'ASR 模型', type: 'string', group: 'dashscope', path: ['dashscope', 'asrModel'], desc: '默认 qwen3-asr-flash-filetrans' },

  /* ── 飞影 ── */
  { key: 'HIFLY_API_KEY', label: 'API Key', type: 'password', group: 'hifly', path: ['hifly', 'apiKey'] },

  /* ── TikHub ── */
  { key: 'TIKHUB_API_KEY', label: 'API Key', type: 'password', group: 'tikhub', path: ['tikhub', 'apiKey'] },

  /* ── FinStep ── */
  { key: 'FINSTEP_API_KEY', label: 'API Key', type: 'password', group: 'finstep', path: ['finstep', 'apiKey'] },

  /* ── 曙光舆情 ── */
  { key: 'SATURN_NEWS_MCP_KEY', label: 'MCP Key', type: 'password', group: 'saturn', path: ['saturnNews', 'apiKey'] },

  /* ── 校对台 ── */
  { key: 'JIAODUITAI_BASE_URL', label: '服务地址', type: 'string', group: 'jiaoduitai', path: ['jiaoduitai', 'baseUrl'], desc: '配置即启用外部校对台审核' },

  /* ── OSS ── */
  { key: 'OSS_REGION', label: 'Region', type: 'string', group: 'oss', path: ['oss', 'region'] },
  { key: 'OSS_BUCKET', label: 'Bucket', type: 'string', group: 'oss', path: ['oss', 'bucket'] },
  { key: 'OSS_ACCESS_KEY_ID', label: 'Access Key ID', type: 'password', group: 'oss', path: ['oss', 'accessKeyId'] },
  { key: 'OSS_ACCESS_KEY_SECRET', label: 'Access Key Secret', type: 'password', group: 'oss', path: ['oss', 'accessKeySecret'] },
]

export const SETTING_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]))
