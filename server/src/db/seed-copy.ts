import type { Db } from './index.js'
import { upsert } from './index.js'
import { toDb, utcNow } from '../lib/time.js'
import { DURATION_TIERS } from '../modules/copy/constants.js'

/**
 * 文案工坊种子（任务书 FR-M2 / FR-M3 / FR-M4 / §3.3）。
 * 说明：
 *  - 模板、风格的 id 固定，便于内置数据在已有库上重复 upsert 而不产生重复行；
 *  - 内置项 `is_builtin=1`：可编辑不可删除（AC-M2/M3）；
 *  - 合规词库为**开发起草初稿**，须合规部门确认后上线（§11.2 F4），当前仅用于联调与 smoke；
 *  - 模板 riskHint 为风险提示块预览文本（W10），最终话术以审核链第 3 关为准。
 */

/** 内置 4 模板（FR-M2）：均内置基础合规约束与 riskHint，「产品推荐型」额外强约束风险等级与适当性 */
export const BUILTIN_TEMPLATES: Array<{
  id: string
  name: string
  description: string
  prompt: string
  structureHint: string
  riskHint: string
  sort: number
}> = [
  {
    id: 'ctpl_market',
    name: '市场解读型',
    description: '先给结论、再给依据，用数据解释当下行情，适合资讯类来源。',
    prompt:
      '你是一位专业的财经口播写手。请把下方素材写成一段可直接口播的解读稿。\n' +
      '要求：\n' +
      '1) 开头用一到两句给出结论或判断，紧接着说明“为什么这件事与你有关”；\n' +
      '2) 中间用 2–3 个要点交代依据，依据必须来自素材中的事实、数据或公开表态；\n' +
      '3) 收尾给出一句可执行的观察建议（例如看哪些指标、避免哪些动作），不下买卖结论；\n' +
      '4) 全文避免承诺收益、避免绝对化表述。',
    structureHint: '开场（结论 + 相关性） / 要点 1–3（依据） / 收尾（观察建议）',
    riskHint:
      '本内容仅作市场信息解读，不构成投资建议。市场有风险，投资须谨慎；历史表现不代表未来收益。',
    sort: 10,
  },
  {
    id: 'ctpl_education',
    name: '投教科普型',
    description: '从一个常见误解切入，讲清规则与方法边界，适合知识与政策类来源。',
    prompt:
      '你是一位投资者教育内容写手。请把下方素材写成一段通俗的科普口播稿。\n' +
      '要求：\n' +
      '1) 先用一个常见误解或提问开场，让听众代入自己的困惑；\n' +
      '2) 讲清规则本身（是什么、怎么算、边界在哪），必要时用生活化比喻；\n' +
      '3) 给出 2–3 条可操作的注意事项，说明适用条件，不做适用性承诺；\n' +
      '4) 语言口语化、句子短，专业术语首次出现要解释。',
    structureHint: '开场（误解提问） / 规则说明 / 注意事项 / 收尾',
    riskHint: '本内容为投资者教育科普，不构成投资建议，也不代表任何产品的推荐。投资前请阅读产品合同与风险揭示书。',
    sort: 20,
  },
  {
    id: 'ctpl_product',
    name: '产品推荐型',
    description: '讲品类与选择逻辑、风险等级与适当性，不做具体产品承诺。',
    prompt:
      '你是一位合规意识很强的财经内容写手。请把下方素材写成一段“品类讲解”口播稿。\n' +
      '硬性要求（必须逐条满足）：\n' +
      '1) 只讲产品**品类**的运作机制与选择维度，不点名具体产品、不做收益比较排名；\n' +
      '2) 必须先讲适用人群与风险等级，再讲选择维度，顺序不可颠倒；\n' +
      '3) 明确提示适当性要求：购买前需完成风险测评，风险承受能力与产品风险等级不匹配时不得购买；\n' +
      '4) 不得出现任何收益承诺、保本表述、绝对化用语；涉及业绩必须说明“过往业绩不代表未来表现”。',
    structureHint: '开场（品类是什么） / 适用人群与风险等级 / 选择维度 / 适当性提示 / 收尾',
    riskHint:
      '本产品风险等级以销售机构公示为准，购买前请完成风险承受能力测评并阅读基金合同、招募说明书与风险揭示书。过往业绩不代表未来表现，投资须谨慎。',
    sort: 30,
  },
  {
    id: 'ctpl_comment',
    name: '热点评论型',
    description: '观点鲜明但不越界，给出支撑理由与反面考虑，适合争议性热点。',
    prompt:
      '你是一位有观点的财经评论作者。请基于下方素材写一段口播评论。\n' +
      '要求：\n' +
      '1) 开场直接亮明观点，观点要具体，不要含糊的“值得关注”；\n' +
      '2) 给出 2–3 条支撑理由，理由必须有素材依据或常识性逻辑；\n' +
      '3) 主动补一段“反面考虑”，说明这个观点在什么情况下会失效，体现审慎；\n' +
      '4) 不对未来行情做确定性判断，不评价具体机构或个人。',
    structureHint: '开场（亮观点） / 理由 1–3 / 反面考虑 / 收尾',
    riskHint: '本内容为个人观点评论，仅供参考，不构成投资建议。市场有风险，决策请自行判断并承担相应风险。',
    sort: 40,
  },
]

/** 内置 6 风格（FR-M3 / Q4：严格按线过滤） */
export const BUILTIN_STYLES: Array<{
  id: string
  name: string
  line: 'manager' | 'kos' | 'persona'
  prompt: string
  sort: number
}> = [
  {
    id: 'csty_manager_pro',
    name: '经理 · 专业',
    line: 'manager',
    prompt:
      '语气沉稳克制，专业但不晦涩。多用“估值分位、股债性价比、流动性”这类可验证的框架性表述；' +
      '结论留有余地（“倾向于”“更可能是”），少用感叹句，不使用夸张的比喻。',
    sort: 10,
  },
  {
    id: 'csty_manager_plain',
    name: '经理 · 通俗',
    line: 'manager',
    prompt:
      '保持专业判断，但把术语翻译成日常话。每讲一个概念就给一个生活化类比（如把仓位比作配菜比例）；' +
      '句子控制在 20 字以内，节奏平缓，避免连续三个术语。',
    sort: 20,
  },
  {
    id: 'csty_kos_lively',
    name: 'KOS · 活泼',
    line: 'kos',
    prompt:
      '像营业部柜台的熟人说事，节奏轻快，可适度使用“家人们”“划重点”等口语；' +
      '善用设问和自问自答，每段结尾留一个小钩子；但涉及风险和费用时必须放慢并说清楚。',
    sort: 30,
  },
  {
    id: 'csty_kos_edu',
    name: 'KOS · 通俗科普',
    line: 'kos',
    prompt:
      '教学习惯：先给定义，再给例子，最后给易错点。用“第一、第二”明确分点；' +
      '术语首次出现必须用一句话解释；不堆砌数据，每个数字都说明它意味着什么。',
    sort: 40,
  },
  {
    id: 'csty_persona_casual',
    name: '素人 · 口语化',
    line: 'persona',
    prompt:
      '以普通投资者的第一人称视角讲自己的理解与观察，语气像跟朋友聊天；' +
      '可以表达困惑和取舍，但不虚构收入、持仓金额与具体买卖经历；句长短不一，避免书面词。',
    sort: 50,
  },
  {
    id: 'csty_persona_hook',
    name: '素人 · 悬念钩子',
    line: 'persona',
    prompt:
      '开场必须制造一个具体、可感知的悬念或反差（“我上周才发现一件事”），' +
      '前 3 秒留白感强；中段逐步揭晓，信息递进；收尾回到听众自身的处境，给出一个可验证的小动作。',
    sort: 60,
  },
]

/** 合规词库初稿（W9 两级）。硬禁用 = 阻止提交；软提示 = 仅提醒 */
export const COMPLIANCE_SEED: Array<{ word: string; level: 'hard' | 'soft'; category: string }> = [
  // ── 硬禁用：收益承诺 / 保本 / 确定性判断 ──
  { word: '保本', level: 'hard', category: '收益承诺' },
  { word: '保底', level: 'hard', category: '收益承诺' },
  { word: '稳赚', level: 'hard', category: '收益承诺' },
  { word: '稳赚不赔', level: 'hard', category: '收益承诺' },
  { word: '零风险', level: 'hard', category: '风险表述' },
  { word: '无风险', level: 'hard', category: '风险表述' },
  { word: '保收益', level: 'hard', category: '收益承诺' },
  { word: '保证收益', level: 'hard', category: '收益承诺' },
  { word: '承诺收益', level: 'hard', category: '收益承诺' },
  { word: '保本保收益', level: 'hard', category: '收益承诺' },
  { word: '必涨', level: 'hard', category: '确定性判断' },
  { word: '必跌', level: 'hard', category: '确定性判断' },
  { word: '包赚', level: 'hard', category: '收益承诺' },
  { word: '躺赚', level: 'hard', category: '收益承诺' },
  { word: '闭眼买', level: 'hard', category: '投资建议' },
  { word: '稳赚不亏', level: 'hard', category: '收益承诺' },
  { word: '刚性兑付', level: 'hard', category: '收益承诺' },
  { word: '内幕消息', level: 'hard', category: '违规表述' },
  // ── 软提示：绝对化 / 夸大 ──
  { word: '最好', level: 'soft', category: '绝对化用语' },
  { word: '最佳', level: 'soft', category: '绝对化用语' },
  { word: '最强', level: 'soft', category: '绝对化用语' },
  { word: '最高', level: 'soft', category: '绝对化用语' },
  { word: '最低', level: 'soft', category: '绝对化用语' },
  { word: '第一', level: 'soft', category: '绝对化用语' },
  { word: '首选', level: 'soft', category: '绝对化用语' },
  { word: '唯一', level: 'soft', category: '绝对化用语' },
  { word: '顶级', level: 'soft', category: '绝对化用语' },
  { word: '极致', level: 'soft', category: '绝对化用语' },
  { word: '翻倍', level: 'soft', category: '夸大收益' },
  { word: '暴涨', level: 'soft', category: '夸大收益' },
  { word: '稳赢', level: 'soft', category: '夸大收益' },
  { word: '一定涨', level: 'soft', category: '确定性判断' },
  { word: '肯定赚', level: 'soft', category: '夸大收益' },
  { word: '无脑', level: 'soft', category: '夸大收益' },
  { word: '随便买', level: 'soft', category: '投资建议' },
]

/**
 * persona 桩的 §4.3 扩展字段补齐（幂等，已有库安全）。
 * `ip_profile` 是 JSON 列，无法用 SQL 做「仅在缺失时补键」，故读出后合并再写回；
 * 只补三个可选键，不覆盖 M1 或人工已写入的任何既有值。
 */
export async function seedPersonaExtensions(db: Db): Promise<void> {
  const now = toDb(utcNow())
  const ext: Record<string, Record<string, string>> = {
    ps_manager_demo: {
      audience_needs: '想知道当前市场处于什么位置、自己的持仓要不要调整，怕追高也怕踏空',
      factual_background:
        '从业 12 年，长期跟踪宽基指数估值与宏观流动性；擅长用估值分位与股债性价比讲清配置逻辑。',
      sample_script:
        '今天先给结论：这一轮调整更像是估值修复后的正常回摆，不是趋势反转。判断依据有三点，第一……',
    },
    ps_kos_demo: {
      audience_needs: '刚接触基金，分不清申购赎回与费用，想知道定投到底适不适合自己',
      factual_background: '负责营业部投资者教育三年，日常解答新手高频问题，熟悉基金合同与费用结构。',
      sample_script: '很多人以为定投就是每月固定买一点，其实关键不在买多少，而在你买的是什么。',
    },
    ps_persona_demo: {
      audience_needs: '手里有一笔闲钱，想要比活期高一点又怕亏本金，想知道债基为什么会跌',
      factual_background: '自己做债基配置六年，记录过几轮利率波动中债基净值回撤的过程与修复节奏。',
      sample_script: '债基也会跌，这点必须先说清楚。去年那波调整，很多人是第一次看到债基净值连着绿。',
    },
  }
  for (const [id, patch] of Object.entries(ext)) {
    const row = await db.get<{ ip_profile: string | null }>('SELECT `ip_profile` FROM `persona` WHERE `id` = ?', [id])
    if (!row) continue
    let ip: Record<string, unknown> = {}
    try {
      ip = row.ip_profile ? (JSON.parse(row.ip_profile) as Record<string, unknown>) : {}
    } catch {
      ip = {}
    }
    let changed = false
    for (const [k, v] of Object.entries(patch)) {
      if (ip[k] === undefined || ip[k] === null || ip[k] === '') {
        ip[k] = v
        changed = true
      }
    }
    if (!changed) continue
    await db.run('UPDATE `persona` SET `ip_profile` = ?, `updated_at` = ? WHERE `id` = ?', [
      JSON.stringify(ip),
      now,
      id,
    ])
  }
}

/**
 * 幂等种子：模板 / 风格 / 合规词库。
 * 模板与风格只在缺失时插入，**不覆盖**运营已编辑的提示词（revision 语义）。
 */
export async function seedCopyWorkshop(db: Db): Promise<void> {
  const now = toDb(utcNow())

  for (const t of BUILTIN_TEMPLATES) {
    await upsert(db, {
      table: 'copy_template',
      row: {
        id: t.id,
        name: t.name,
        description: t.description,
        prompt: t.prompt,
        structure_hint: t.structureHint,
        risk_hint: t.riskHint,
        is_builtin: 1,
        enabled: 1,
        sort: t.sort,
        revision: 1,
        updated_by: 'system',
        created_at: now,
        updated_at: now,
      },
      uniqueCols: ['id'],
      // 仅补齐内置标记与排序；提示词交给运营维护，不覆盖
      updateCols: ['is_builtin', 'sort'],
    })
  }

  for (const s of BUILTIN_STYLES) {
    await upsert(db, {
      table: 'copy_style',
      row: {
        id: s.id,
        name: s.name,
        line: s.line,
        prompt: s.prompt,
        is_builtin: 1,
        enabled: 1,
        sort: s.sort,
        revision: 1,
        updated_by: 'system',
        created_at: now,
        updated_at: now,
      },
      uniqueCols: ['id'],
      updateCols: ['is_builtin', 'line', 'sort'],
    })
  }

  for (const w of COMPLIANCE_SEED) {
    await upsert(db, {
      table: 'compliance_word',
      row: {
        id: `cw_${w.word}`.slice(0, 40),
        word: w.word,
        level: w.level,
        category: w.category,
        enabled: 1,
        updated_by: 'system',
        created_at: now,
        updated_at: now,
      },
      uniqueCols: ['word'],
      updateCols: ['level', 'category'],
    })
  }

  // 时长档配置可由 GET /copy/options 读到的兜底校验（配置来自 config，seed 仅记录条数日志）
  void DURATION_TIERS
}
