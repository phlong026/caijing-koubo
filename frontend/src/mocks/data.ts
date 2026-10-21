/** 全站演示数据（与参考效果图一致） */

export type Line = 'manager' | 'kos' | 'persona'

export const lineNames: Record<Line, string> = {
  manager: '经理 IP',
  kos: '员工 KOS',
  persona: '素人矩阵',
}

/** 资讯分类色 */
export const catClass: Record<string, string> = {
  市场: 'mw-cat mw-tag-orange',
  政策: 'mw-cat mw-tag-red',
  行业: 'mw-cat mw-tag-purple',
  基金: 'mw-cat mw-tag-yellow',
}

export interface NewsItem {
  id: string
  cat: string
  source: string
  time: string
  title: string
  excerpt: string
}

export const newsList: NewsItem[] = [
  {
    id: 'n1',
    cat: '基金',
    source: '内部投资资料（示例）',
    time: '09:20',
    title: '定投科普：先理解规则，再谈长期坚持',
    excerpt: '定期投入并不意味着没有风险。理解定投方式、费用与适用边界。',
  },
  {
    id: 'n2',
    cat: '市场',
    source: '编辑整理（示例）',
    time: '09:05',
    title: '市场波动时，如何认识自己的风险承受能力',
    excerpt: '市场存在波动是常态，了解自身风险承受能力，有助于选择更适合的投资方式和产品类型。',
  },
  {
    id: 'n3',
    cat: '行业',
    source: '投教资料（示例）',
    time: '08:40',
    title: '基金净值与份额：两个容易混淆的概念',
    excerpt: '基金净值反映单位份额的价值，份额数量与持有金额相关。理解二者区别，有助于更准确地看待账户变化。',
  },
]

/** 候选选题 */
export interface TopicItem {
  id: string
  title: string
  dir: string
  dirClass: string
  assigned?: string
  checked?: boolean
}

export const topicCandidates: TopicItem[] = [
  { id: 't1', title: '三分钟读懂基金定投', dir: '基础科普', dirClass: 'mw-tag-blue', assigned: '小林科普', checked: true },
  { id: 't2', title: '定投前，先想清楚这三个问题', dir: '风险认知', dirClass: 'mw-tag-yellow', assigned: '张经理', checked: true },
  { id: 't3', title: '定投的常见误区', dir: '概念澄清', dirClass: 'mw-tag-purple' },
]

/** 对标账号（爆款选题 · 对标账号视频标签页用） */
export const benchmarkVideos = [
  {
    id: 'b1',
    account: '稳健投教笔记',
    platform: '抖音',
    fans: '3.6w',
    title: '工资到手先存后花：三步搭建定投纪律',
    stats: '12.4w 播放 · 互动 5.2k · 爆款',
    time: '2 天前',
    extracted: '已提取',
  },
  {
    id: 'b2',
    account: '老周聊债基',
    platform: '小红书',
    fans: '1.9w',
    title: '债基回调别慌，先看这三张图',
    stats: '8.1w 播放 · 互动 3.4k · 爆款',
    time: '3 天前',
    extracted: '已提取',
  },
  {
    id: 'b3',
    account: '基养计划',
    platform: '抖音',
    fans: '2.2w',
    title: '为什么你一买就跌？聊聊择时幻觉',
    stats: '5.6w 播放 · 互动 1.9k',
    time: '5 天前',
    extracted: '提取中',
  },
]

/** 任务中心 */
export interface TaskRow {
  id: string
  no: string
  title: string
  subject: string
  line: Line
  owner: string
  stage: string
  status: string
  statusCls: string
  dot: string
  progress?: number
  next: string
  target: string
}

export const tasks: TaskRow[] = [
  { id: 'T-1024', no: 'T-1024', title: '基金定投入门', subject: '小林科普', line: 'kos', owner: '陈悦', stage: '剪辑合成', status: '草稿 v2', statusCls: '', dot: '#7c5cd6', next: '继续剪辑', target: '目标60秒' },
  { id: 'T-1025', no: 'T-1025', title: '市场波动与长期配置', subject: '张经理', line: 'manager', owner: '王敏', stage: '文案生成', status: '待人工审核', statusCls: 'color:#b26a00', dot: '#e69b3c', next: '查看审核', target: '目标60秒' },
  { id: 'T-1026', no: 'T-1026', title: '城市里的理财常识', subject: '小林科普', line: 'kos', owner: '周宁', stage: '选题生成', status: '候选待选择', statusCls: '', dot: '#3b82f6', next: '选择选题', target: '目标60秒' },
  { id: 'T-1027', no: 'T-1027', title: '认识基金净值', subject: '小林科普', line: 'kos', owner: '陈悦', stage: '基础视频', status: '生成中 38%', statusCls: '', dot: '#2563eb', next: '查看进度', target: '目标60秒', progress: 38 },
  { id: 'T-1028', no: 'T-1028', title: '风险与收益的关系', subject: '张经理', line: 'manager', owner: '周宁', stage: '基础视频', status: '保存失败', statusCls: 'color:#c0392b', dot: '#e05252', next: '重试下载', target: '目标60秒' },
  { id: 'T-1029', no: 'T-1029', title: '如何定期回顾目标', subject: '张经理', line: 'manager', owner: '王敏', stage: '基础视频', status: '状态待确认', statusCls: '', dot: '#9ca3af', next: '查询原任务', target: '目标60秒' },
]

/** 审核工作台 */
export interface ReviewItem {
  id: string
  title: string
  line: Line
  submitter: string
  time: string
  source: string
  platform: { text: string; conf: number }
  agent: { compliance: string; risk: string; product: string; sensitive: string; conf: number }
  copy: string
  skillText: string
}

export const reviewQueue: ReviewItem[] = [
  {
    id: 'R-301',
    title: '央行降准口播文案',
    line: 'manager',
    submitter: '运营-王五',
    time: '09:10',
    source: '热点资讯',
    platform: { text: '平台规则校验：通过（未命中违禁、诱导、绝对化等平台侧规则）', conf: 94 },
    agent: {
      compliance: '合规检查：通过（未检测到收益承诺、绝对化表述）',
      risk: '风险提示：已包含（由风险提示 Skill 自动追加）',
      product: '产品信息：准确（富国信用债A）',
      sensitive: '敏感词：未命中',
      conf: 96,
    },
    copy:
      '大家好，今天聊聊一个大事儿——央行降准了！降了0.5个百分点，释放了1万亿的长期资金。这对咱们手里的债基是个好消息，因为市场钱多了，债券收益率下行，债基净值就会涨。以富国信用债A为例，它在历次降准后的表现都比较稳健。不过要提醒大家，基金投资有风险，过往业绩不代表未来收益。',
    skillText:
      '基金有风险，投资需谨慎。本材料不构成投资建议，基金过往业绩不代表未来表现，投资者应根据自身风险承受能力谨慎决策。',
  },
  {
    id: 'R-302',
    title: '定投科普：先理解规则，再谈长期坚持',
    line: 'kos',
    submitter: '运营-陈悦',
    time: '09:32',
    source: '文章改写',
    platform: { text: '平台规则校验：通过（未命中违禁、诱导、绝对化等平台侧规则）', conf: 92 },
    agent: {
      compliance: '合规检查：通过（未检测到收益承诺、绝对化表述）',
      risk: '风险提示：已包含（由风险提示 Skill 自动追加）',
      product: '产品信息：未涉及具体产品',
      sensitive: '敏感词：未命中',
      conf: 95,
    },
    copy:
      '很多朋友问，定投到底是不是稳赚？先把规则讲清楚。定投是定期投入的一种方式，它让投入更有计划，但并不意味着可以避开市场波动。开始之前，先想清楚三件事：这笔钱多久会用、自己能承受多大波动、产品的费率和风险等级。坚持，也要定期回顾目标和资金安排。',
    skillText:
      '基金有风险，投资需谨慎。本内容仅为知识科普，不构成投资建议。投资者应根据自身风险承受能力谨慎决策。',
  },
]

/** 发布管理 */
export const publishContents = [
  {
    id: 'V-501',
    title: '基金定投入门',
    subject: '小林科普',
    line: 'kos' as Line,
    form: '数字人口播 · 1080P · 9:16 · 01:00',
    versions: ['文案 v3', '成片 v2'],
    status: { text: '成片复审通过（演示）', cls: 'mw-tag-green' },
    note: '发布绑定文案 v3、成片 v2',
  },
  {
    id: 'V-502',
    title: '认识基金净值',
    subject: '小林科普',
    line: 'kos' as Line,
    form: '数字人口播 · 1080P · 9:16 · 01:12',
    versions: ['文案 v2', '成片 v1'],
    status: { text: '待安排', cls: 'mw-tag-yellow' },
    note: '',
  },
  {
    id: 'V-503',
    title: '市场波动与长期配置',
    subject: '张经理',
    line: 'manager' as Line,
    form: '数字人口播 · 1080P · 9:16 · 01:08',
    versions: ['文案 v1', '成片 v1'],
    status: { text: '仅抖音', cls: 'mw-tag-blue' },
    note: '',
  },
]

export const platformRecords = [
  { platform: '抖音', icon: '▶', color: '#111827', status: '验证待完成', cls: 'mw-tag-yellow', desc: '需完成账号授权与权限验证', action: '查看验证' },
  { platform: '小红书', icon: '书', color: '#FF2442', status: '人工待处理', cls: 'mw-tag-yellow', desc: '账号信息需人工核对', action: '查看原因' },
  { platform: '抖音', icon: '▶', color: '#111827', status: '失败', cls: 'mw-tag-red', desc: '平台返回错误，详情见日志', action: '查看日志' },
]

/** 数据看板 */
export const trendData = {
  days: ['10.06', '10.07', '10.08', '10.09', '10.10', '10.11', '10.12'],
  series: [
    { name: '经理 IP', color: '#1d4ed8', values: [28, 36, 44, 50, 68, 56, 52] },
    { name: '员工 KOS', color: '#4f83f1', values: [18, 26, 34, 40, 48, 44, 40] },
    { name: '素人矩阵', color: '#a9c4f7', values: [8, 14, 22, 28, 34, 30, 27] },
  ],
}

export const contentPerf = [
  { id: 'a1', title: '基金定投入门', subject: '小林科普 · 员工 KOS', platform: '抖音', node: 'T+1', play: '8,600', interact: '286', finish: '—', hot: false },
  { id: 'a2', title: '市场波动与长期配置', subject: '张经理 · 经理 IP', platform: '抖音', node: 'T+7', play: '12,400', interact: '408', finish: '—', hot: true },
  { id: 'a3', title: '认识基金净值', subject: '小林科普 · 员工 KOS', platform: '小红书', node: 'T+1', play: '5,200', interact: '193', finish: '—', hot: false },
]

/** 视频剪辑：字幕段落 */
export const subtitleSegments = [
  { start: '00:00', end: '00:08', text: '大家好，我是小林。今天聊聊基金定投。', risk: false },
  { start: '00:08', end: '00:16', text: '定投是一种定期投入的方式。', risk: false },
  { start: '00:16', end: '00:26', text: '它让投入更有计划，但并不意味着可以避开市场波动。', risk: false },
  { start: '00:26', end: '00:39', text: '先了解产品的投资范围、费率和风险等级。', risk: false },
  { start: '00:39', end: '00:50', text: '定期回顾目标和资金安排，也别忽视风险。', risk: false },
  { start: '00:50', end: '01:00', text: '基金有风险，投资需谨慎。本内容不构成投资建议。', risk: true },
]

/** 素材库 */
export const materials = {
  fonts: [
    { name: '富国思源黑体', meta: 'TTF · 4.2MB · 2026-09-15', auth: '商用授权：已确认', enabled: true },
    { name: '富国品牌仿宋', meta: 'OTF · 3.8MB · 2026-09-15', auth: '商用授权：已确认', enabled: true },
    { name: '富国品牌楷体', meta: 'TTF · 3.5MB · 2026-09-20', auth: '商用授权：待确认', enabled: false },
  ],
  voices: [
    { name: '张三 — 自录制声音', meta: 'WAV · 48kHz · 经理 IP 线', enabled: true },
    { name: '李四 — 自录制声音', meta: 'WAV · 48kHz · 经理 IP 线', enabled: true },
    { name: '小林 — 自录制声音', meta: 'WAV · 48kHz · 员工 KOS 线', enabled: true },
    { name: 'KOS 通用女声', meta: 'WAV · 48kHz · 员工 KOS 线', enabled: true },
    { name: '通用讲解男声', meta: 'MP3 · 44.1kHz · 通用', enabled: false },
  ],
  packs: [
    { name: '品牌标准 · 蓝色背景', meta: '素材包 · 24 项 · 2026-09-15', enabled: true },
    { name: '品牌标准 · 白色简洁', meta: '素材包 · 18 项 · 2026-09-15', enabled: true },
    { name: 'Q4 季度主题', meta: '素材包 · 32 项 · 2026-10-01', enabled: true },
    { name: '投教图示图标包', meta: '素材包 · 56 项 · 2026-09-22', enabled: false },
  ],
  avatars: [
    { name: '张经理 · 商务形象', meta: '绑定声音：张三 · 经理 IP 线', enabled: true },
    { name: '李四 · 知性形象', meta: '绑定声音：李四 · 经理 IP 线', enabled: true },
    { name: '员工亲和形象', meta: '绑定声音：KOS 通用女声 · 可多账号共用', enabled: true },
  ],
}
