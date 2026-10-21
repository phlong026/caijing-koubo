import type { PersonaLine } from './types.js'

/**
 * 人物库选项字典（FR-I2，GET /personas/options 下发）。
 * 一期不做字典管理界面：种子字典 + 允许自由输入。
 * 授权确认文本为**开发起草 v1**，须法务 / 合规确认后上线（Q12）；
 * 文本变更即升版本，旧 consent 不可用于新克隆。
 */

/** IP 定位下拉选项（按线给默认，允许自由输入） */
export const IP_OPTIONS: Record<
  'role' | 'serviceScope' | 'expressionStyle' | 'contentDirection',
  string[]
> = {
  role: [
    '基金经理 / 宏观研究负责人',
    '投资顾问 / 理财经理',
    '投资者教育专员',
    '行业研究员',
    '债券基金观察者',
    'ETF 与指数投资爱好者',
    '财经自媒体人',
    '素人投资者',
  ],
  serviceScope: [
    '宏观与市场解读',
    '资产配置框架',
    '基金基础知识',
    '定投与费用科普',
    '债基与固收+',
    '利率与信用风险解读',
    '行业与产业链研究',
    'ETF 与指数投资',
    '投资心理与行为误区',
  ],
  expressionStyle: [
    '沉稳克制、数据先行，少情绪词，结论留有余地',
    '口语化、比喻多、短句，先讲规则再讲方法',
    '接地气、讲案例，强调风险边界',
    '观点鲜明、节奏快，先给结论再给依据',
    '像朋友聊天，第一人称视角',
  ],
  contentDirection: [
    '知识科普',
    '市场解读',
    '风险提示',
    '热点评论',
    '实操方法',
    '心理建设',
    '政策解读',
    '产品品类讲解',
  ],
}

/** 按线预填的内容方向默认值（FR-I2「按线给默认」） */
export const LINE_DEFAULT_DIRECTIONS: Record<PersonaLine, string[]> = {
  manager: ['市场解读', '风险提示'],
  kos: ['知识科普', '实操方法'],
  persona: ['心理建设', '热点评论'],
}

/** 按线预填的合规基线（FR-I4：新建人物时预填禁用表达） */
export const LINE_DEFAULT_FORBIDDEN: Record<PersonaLine, string[]> = {
  manager: ['不承诺收益', '不使用绝对化表述（稳赚、必涨）', '不给出个股买卖建议'],
  kos: ['不承诺收益', '不推荐具体产品', '不使用夸大表述'],
  persona: ['不承诺保本', '不预测具体点位', '不做收益对比排名'],
}

/** 克隆授权确认文本（L6 / Q12）。版本变更即升 CONSENT_TEXT_VERSION */
export const CONSENT_TEXT_VERSION = 'v1'

export const CONSENT_TEXTS: Record<'AVATAR_CLONE' | 'VOICE_CLONE', { title: string; body: string }> = {
  AVATAR_CLONE: {
    title: '口播分身制作授权确认',
    body:
      '本人确认：已阅读并同意以上授权材料所列全部条款，授权范围包含「肖像」。' +
      '同意以上述授权材料为依据，使用本次上传的分身素材制作口播分身（数字人形象），' +
      '制作成果仅用于授权材料载明的用途范围。本人知悉：分身由第三方数字人服务商（飞影）训练生成，' +
      '素材将按服务商要求提交；如授权范围、素材或文本版本与确认时不符，制作将被拒绝。',
  },
  VOICE_CLONE: {
    title: '声音克隆授权确认',
    body:
      '本人确认：已阅读并同意以上授权材料所列全部条款，授权范围包含「声音」。' +
      '同意以上述授权材料为依据，使用本次上传的声音样本克隆音色，' +
      '克隆成果仅用于授权材料载明的用途范围。本人知悉：声音由第三方数字人服务商（飞影）训练生成，' +
      '样本将按服务商要求提交；如授权范围、样本或文本版本与确认时不符，克隆将被拒绝。',
  },
}

/** 内容配比默认标签（FR-I3，效果图：知识科普 / 市场解读 / 风险提示） */
export const CONTENT_MIX_PRESETS: string[] = ['知识科普', '市场解读', '风险提示', '实操方法', '热点评论', '心理建设']
