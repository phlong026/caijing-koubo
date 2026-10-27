/**
 * 系统设置配置清单（用户中心 → 系统设置）。
 *
 * 定位：界面只保留「开通一个服务必填」的凭据（API Key / 地址）与模型选择，
 * 布局保持最简，不放说明性文案；默认值内置在 config 里，字段中直接回显、可改。
 * 超时 / 并发 / 单价 / 接口路径 / 调度周期等调优项与部署级配置不进界面，
 * 一律走 .env（见 .env.example）+ 代码默认值。
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
  { key: 'copyllm', title: '文案二创模型（Claude）' },
  { key: 'dashscope', title: '阿里云百炼（语音转写）' },
  { key: 'hifly', title: '飞影数字人平台' },
  { key: 'tikhub', title: 'TikHub 对标数据源' },
  { key: 'finstep', title: '财跃 FinStep 资讯' },
  { key: 'saturn', title: '曙光舆情' },
  { key: 'oss', title: '对象存储 OSS' },
]

export const SETTING_DEFS: SettingDef[] = [
  /* ── 文案二创模型 ── */
  { key: 'COPY_LLM_BASE_URL', label: 'Base URL', type: 'string', group: 'copyllm', path: ['copyLlm', 'baseUrl'] },
  { key: 'COPY_LLM_API_KEY', label: 'API Key', type: 'password', group: 'copyllm', path: ['copyLlm', 'apiKey'] },
  { key: 'COPY_LLM_MODEL', label: '模型', type: 'string', group: 'copyllm', path: ['copyLlm', 'model'] },

  /* ── 百炼（语音转写） ── */
  { key: 'DASHSCOPE_API_KEY', label: 'API Key', type: 'password', group: 'dashscope', path: ['dashscope', 'apiKey'] },
  { key: 'ASR_MODEL', label: 'ASR 模型', type: 'string', group: 'dashscope', path: ['dashscope', 'asrModel'] },

  /* ── 飞影 ── */
  { key: 'HIFLY_API_KEY', label: 'API Key', type: 'password', group: 'hifly', path: ['hifly', 'apiKey'] },

  /* ── TikHub ── */
  { key: 'TIKHUB_API_KEY', label: 'API Key', type: 'password', group: 'tikhub', path: ['tikhub', 'apiKey'] },

  /* ── FinStep ── */
  { key: 'FINSTEP_API_KEY', label: 'API Key', type: 'password', group: 'finstep', path: ['finstep', 'apiKey'] },

  /* ── 曙光舆情 ── */
  { key: 'SATURN_NEWS_MCP_KEY', label: 'API Key', type: 'password', group: 'saturn', path: ['saturnNews', 'apiKey'] },

  /* ── OSS ── */
  { key: 'OSS_REGION', label: 'Region', type: 'string', group: 'oss', path: ['oss', 'region'] },
  { key: 'OSS_BUCKET', label: 'Bucket', type: 'string', group: 'oss', path: ['oss', 'bucket'] },
  { key: 'OSS_ACCESS_KEY_ID', label: 'Access Key ID', type: 'password', group: 'oss', path: ['oss', 'accessKeyId'] },
  { key: 'OSS_ACCESS_KEY_SECRET', label: 'Access Key Secret', type: 'password', group: 'oss', path: ['oss', 'accessKeySecret'] },
]

export const SETTING_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]))
