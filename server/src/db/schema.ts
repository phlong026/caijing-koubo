/**
 * 表结构定义（任务书 §3.1 业务表 / §3.2 支撑表）。
 * 用方言无关的 DSL 描述，由 driver 生成 MySQL / SQLite DDL，保证迁移脚本幂等可重复执行。
 */
export type ColType =
  | 'varchar'
  | 'text'
  | 'longtext'
  | 'int'
  | 'bigint'
  | 'tinyint'
  | 'decimal'
  | 'datetime'
  | 'json'

export interface Col {
  name: string
  type: ColType
  len?: number
  scale?: number
  nullable?: boolean
  def?: string | number | null
  comment?: string
}

export interface IndexDef {
  name: string
  cols: string[]
  unique?: boolean
}

export interface TableDef {
  name: string
  pk: string
  cols: Col[]
  uniques?: string[][]
  indexes?: IndexDef[]
  comment?: string
}

const vc = (name: string, len = 64, extra: Partial<Col> = {}): Col => ({ name, type: 'varchar', len, ...extra })
const int = (name: string, def: number | null = 0, extra: Partial<Col> = {}): Col => ({
  name,
  type: 'int',
  def,
  ...extra,
})
const big = (name: string, def = 0): Col => ({ name, type: 'bigint', def })
const tint = (name: string, def = 0): Col => ({ name, type: 'tinyint', def })
const dec = (name: string, def = 0): Col => ({ name, type: 'decimal', len: 12, scale: 6, def })
const dt = (name: string, nullable = true): Col => ({ name, type: 'datetime', nullable })

export const TABLES: TableDef[] = [
  // ── 资讯 ──────────────────────────────────────────────────────────
  {
    name: 'news_item',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('external_id', 128),
      vc('source', 64),
      vc('category', 16, { def: '其他' }),
      vc('title', 512),
      { name: 'summary', type: 'text', nullable: true },
      vc('content_url', 1024, { nullable: true }),
      vc('image_url', 1024, { nullable: true }),
      dt('published_at'),
      dt('fetched_at'),
      vc('url_hash', 64, { nullable: true }),
    ],
    uniques: [['source', 'external_id'], ['url_hash']],
    indexes: [
      { name: 'idx_news_published', cols: ['published_at'] },
      { name: 'idx_news_category', cols: ['category'] },
      { name: 'idx_news_source', cols: ['source'] },
    ],
    comment: 'FR-N1/N2 资讯',
  },
  {
    name: 'news_category_rule',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('category', 16),
      vc('keyword', 64),
      int('priority', 0),
      tint('enabled', 1),
      dt('created_at'),
    ],
    indexes: [{ name: 'idx_rule_enabled', cols: ['enabled', 'priority'] }],
    comment: 'FR-N2 分类关键词规则（配置表维护）',
  },

  // ── 选题 ──────────────────────────────────────────────────────────
  {
    name: 'topic',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('source', 16),
      vc('source_id', 64, { nullable: true }),
      vc('title', 512),
      vc('direction', 64, { nullable: true }),
      { name: 'hook', type: 'text', nullable: true },
      { name: 'rationale', type: 'text', nullable: true },
      { name: 'persona_ids', type: 'json', nullable: true },
      vc('status', 16, { def: 'candidate' }),
      vc('batch_id', 40, { nullable: true }),
      dt('sent_at'),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
    ],
    indexes: [
      { name: 'idx_topic_status', cols: ['status'] },
      { name: 'idx_topic_batch', cols: ['batch_id'] },
      { name: 'idx_topic_source', cols: ['source'] },
    ],
    comment: 'FR-C1 选题（状态机 candidate→assigned→sent→archived）',
  },
  {
    name: 'topic_generation_batch',
    pk: 'id',
    cols: [
      vc('id', 40),
      { name: 'news_ids', type: 'json', nullable: true },
      { name: 'persona_ids', type: 'json', nullable: true },
      int('count_per', 3),
      vc('template_id', 40, { nullable: true }),
      vc('status', 16, { def: 'running' }),
      dec('llm_cost'),
      int('expected', 0),
      int('produced', 0),
      { name: 'error', type: 'text', nullable: true },
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('finished_at'),
    ],
    indexes: [{ name: 'idx_batch_status', cols: ['status', 'created_at'] }],
    comment: 'FR-N4 生成批次',
  },
  {
    name: 'topic_prompt_template',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('name', 128),
      { name: 'content', type: 'text' },
      tint('is_default', 0),
      vc('builtin', 32, { nullable: true }),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
    ],
    indexes: [{ name: 'idx_tpl_default', cols: ['is_default'] }],
    comment: 'FR-C2 提示词模板',
  },

  // ── 对标账号 ──────────────────────────────────────────────────────
  {
    name: 'benchmark_account',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('platform', 16, { def: 'douyin' }),
      vc('platform_uid', 64),
      vc('sec_uid', 128, { nullable: true }),
      vc('nickname', 128, { nullable: true }),
      big('fans_count'),
      vc('source_url', 1024, { nullable: true }),
      vc('monitor_status', 16, { def: 'on' }),
      int('monitor_interval_hours', 24),
      dt('next_check_at'),
      dt('last_checked_at'),
      int('consecutive_failures'),
      { name: 'last_error', type: 'text', nullable: true },
      dt('abnormal_at'),
      dt('user_info_refreshed_at'),
      dt('removed_at'),
      vc('added_by', 64, { nullable: true }),
      dt('created_at'),
    ],
    uniques: [['platform', 'platform_uid']],
    indexes: [{ name: 'idx_acct_sweep', cols: ['monitor_status', 'next_check_at'] }],
    comment: 'FR-B1/B2 对标账号（纯账号监控 D2）',
  },
  {
    name: 'benchmark_video',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('account_id', 40, { nullable: true }), // v1.1 adhoc 视频可空
      vc('origin', 16, { def: 'monitor' }), // monitor | adhoc
      vc('platform', 16, { def: 'douyin' }),
      vc('video_id', 64),
      vc('title', 1024, { nullable: true }),
      vc('cover_url', 1024, { nullable: true }),
      int('duration', 0, { nullable: true }),
      vc('share_url', 1024, { nullable: true }),
      vc('author_nickname', 128, { nullable: true }),
      vc('author_sec_uid', 128, { nullable: true }),
      tint('is_top'),
      big('play_count'),
      big('digg_count'),
      big('comment_count'),
      big('share_count'),
      big('interact_total'),
      dt('stats_updated_at'),
      tint('is_hot'),
      { name: 'hot_baseline', type: 'json', nullable: true },
      dt('hot_alerted_at'),
      tint('is_backfill'),
      dt('published_at'),
      dt('fetched_at'),
    ],
    uniques: [['platform', 'video_id']],
    indexes: [
      { name: 'idx_video_account_pub', cols: ['account_id', 'published_at'] },
      { name: 'idx_video_hot', cols: ['is_hot'] },
      { name: 'idx_video_origin', cols: ['origin'] },
    ],
    comment: 'FR-B4 对标视频（不持久化播放地址，提取时重新获取 D11）',
  },
  {
    name: 'benchmark_alert',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('type', 16), // new_publish | hot
      vc('account_id', 40, { nullable: true }),
      vc('video_id', 40, { nullable: true }), // benchmark_video.id
      { name: 'payload', type: 'json', nullable: true },
      tint('is_read'),
      dt('created_at'),
    ],
    indexes: [
      { name: 'idx_alert_read', cols: ['is_read', 'created_at'] },
      { name: 'idx_alert_type', cols: ['type'] },
    ],
    comment: 'FR-B9 两类告警',
  },
  {
    name: 'script_extract_cache',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('platform', 16),
      vc('video_id', 64),
      { name: 'text', type: 'longtext', nullable: true },
      { name: 'sentences', type: 'json', nullable: true },
      int('duration', 0, { nullable: true }),
      vc('engine', 64, { nullable: true }),
      vc('extract_mode', 16, { nullable: true }),
      vc('task_id', 128, { nullable: true }),
      vc('status', 16, { def: 'pending' }), // pending|submitting|running|done|failed|uncertain
      vc('oss_key', 512, { nullable: true }),
      int('attempts'),
      dt('submitted_at'),
      { name: 'error', type: 'text', nullable: true },
      dec('cost'),
      dt('created_at'),
      dt('updated_at'),
    ],
    uniques: [['platform', 'video_id']],
    indexes: [{ name: 'idx_cache_status', cols: ['status'] }],
    comment: 'FR-B6 文案提取缓存（并发占位 + 幂等）',
  },

  // ── 成本 / 审计 / 支撑 ────────────────────────────────────────────
  {
    name: 'api_call_log',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('provider', 32),
      vc('endpoint', 255),
      vc('ref_type', 32, { nullable: true }),
      vc('ref_id', 64, { nullable: true }),
      dec('cost_estimate'),
      tint('ok', 1),
      int('http_status', 0, { nullable: true }),
      int('duration_ms', 0, { nullable: true }),
      { name: 'error', type: 'text', nullable: true },
      vc('request_id', 64, { nullable: true }),
      dt('created_at'),
    ],
    indexes: [
      { name: 'idx_call_created', cols: ['created_at'] },
      { name: 'idx_call_provider', cols: ['provider', 'created_at'] },
    ],
    comment: 'FR-C4 第三方调用记录（P2-5 已补状态码/耗时/错误/request id）',
  },
  {
    name: 'operation_log',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('operator', 64),
      vc('action', 64),
      vc('target_type', 32, { nullable: true }),
      vc('target_id', 64, { nullable: true }),
      { name: 'detail', type: 'json', nullable: true },
      dt('created_at'),
    ],
    indexes: [
      { name: 'idx_oplog_created', cols: ['created_at'] },
      { name: 'idx_oplog_target', cols: ['target_type', 'target_id'] },
    ],
    comment: 'D14 操作日志（留存 ≥2 年）',
  },
  {
    name: 'persona',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('name', 128),
      vc('line', 16), // manager | kos | persona
      tint('enabled', 1),
      { name: 'ip_profile', type: 'json', nullable: true },
      tint('is_stub', 1), // D13：M1 人物库未就绪前的只读桩标记
      dt('created_at'),
      dt('updated_at'),
    ],
    indexes: [{ name: 'idx_persona_line', cols: ['line', 'enabled'] }],
    comment: 'D13 persona 只读桩（M1 落地后切换数据源、接口不变）',
  },
  {
    name: 'copy',
    pk: 'id',
    cols: [
      // ── D12 冻结字段（语义与命名不得变更，文案工坊只做增量扩展）──
      vc('id', 40),
      vc('topic_id', 40, { nullable: true }),
      vc('persona_id', 40, { nullable: true }),
      vc('source', 16),
      vc('status', 16, { def: 'draft' }),
      vc('title', 512, { nullable: true }),
      { name: 'source_text', type: 'longtext', nullable: true },
      vc('source_ref_type', 32, { nullable: true }), // news_item | benchmark_video | article_source | manual
      vc('source_ref_id', 64, { nullable: true }),
      vc('extract_cache_id', 40, { nullable: true }),
      { name: 'body', type: 'longtext', nullable: true }, // 已通过版本纯文本冗余（回写时填充）
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      // ── 文案工坊扩展（任务书 §4.1，全部可空或有安全默认值 FR-X1）──
      vc('line', 16, { nullable: true }), // 冗余人物所属线：筛选与查重规则用
      vc('current_draft_id', 40, { nullable: true }),
      vc('submitted_version_id', 40, { nullable: true }),
      vc('approved_version_id', 40, { nullable: true }), // W11 修订期间保留
      vc('review_submission_id', 40, { nullable: true }),
      vc('review_gate', 16, { nullable: true }), // 审核当前关卡快照（列表展示用）
      { name: 'reject_reason', type: 'text', nullable: true },
      { name: 'settings', type: 'json', nullable: true }, // 创作设置记忆
      tint('ever_submitted', 0),
      dt('updated_at'),
      dt('archived_at'),
    ],
    indexes: [
      { name: 'idx_copy_topic', cols: ['topic_id'] },
      { name: 'idx_copy_source_ref', cols: ['source_ref_type', 'source_ref_id'] },
      { name: 'idx_copy_status_upd', cols: ['status', 'updated_at'] },
      { name: 'idx_copy_persona', cols: ['persona_id', 'status'] },
    ],
    comment: 'D12 copy 冻结契约（所有权归文案工坊，本模块只按此写入）',
  },

  // ── 文案工坊（任务书 §4.2）──────────────────────────────────────
  {
    name: 'copy_draft',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('copy_id', 40),
      int('draft_no'),
      vc('name', 64),
      vc('title', 512, { nullable: true }),
      { name: 'sections', type: 'json', nullable: true }, // [{label,text,sourceRefs?}]
      { name: 'plain_text', type: 'longtext', nullable: true },
      int('word_count', 0),
      int('rev', 0), // 乐观锁
      int('latest_version_no', 0),
      tint('has_submitted', 0),
      vc('origin', 16, { def: 'manual' }), // ai | manual | variant | copy
      vc('generation_id', 40, { nullable: true }),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
      dt('deleted_at'),
    ],
    uniques: [['copy_id', 'draft_no']],
    indexes: [{ name: 'idx_copy_draft_copy', cols: ['copy_id', 'deleted_at'] }],
    comment: '文案工坊 - 稿（W2：一个 copy 下多份稿）',
  },
  {
    name: 'copy_version',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('copy_id', 40),
      vc('draft_id', 40),
      int('version_no'), // 在 copy 内单调递增（W3）
      vc('title', 512, { nullable: true }),
      { name: 'sections', type: 'json', nullable: true },
      { name: 'plain_text', type: 'longtext', nullable: true },
      int('word_count', 0),
      vc('content_hash', 64, { nullable: true }),
      vc('origin', 16), // ai_generate | manual_save | variant | restore | submit
      tint('locked', 0),
      { name: 'compliance_hits', type: 'json', nullable: true },
      dec('similarity', 0),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
    ],
    uniques: [['copy_id', 'version_no']],
    indexes: [{ name: 'idx_copy_version_draft', cols: ['draft_id'] }],
    comment: '文案工坊 - 版本（不可变快照）',
  },
  {
    name: 'copy_generation',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('copy_id', 40),
      vc('draft_id', 40, { nullable: true }), // 变体时为目标稿
      vc('kind', 16, { def: 'generate' }), // generate | variant
      vc('mode', 16), // news | benchmark | article | manual
      vc('template_id', 40, { nullable: true }),
      int('template_rev', 0),
      vc('style_id', 40, { nullable: true }),
      int('style_rev', 0),
      vc('duration_tier', 16, { def: 'medium' }),
      int('duration_seconds', 0, { nullable: true }), // v1.1 custom 必填
      int('count', 1),
      { name: 'instructions', type: 'text', nullable: true },
      int('target_section', 0, { nullable: true }),
      vc('target_section_text', 64, { nullable: true }),
      { name: 'persona_snapshot', type: 'json', nullable: true },
      { name: 'prompt_text', type: 'longtext', nullable: true },
      vc('prompt_hash', 64, { nullable: true }),
      vc('model', 64, { nullable: true }),
      vc('status', 16, { def: 'pending' }), // pending | running | done | partial | failed
      int('succeeded', 0),
      int('failed', 0),
      { name: 'error', type: 'text', nullable: true },
      dec('cost', 0),
      vc('idempotency_key', 64, { nullable: true }),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('finished_at'),
    ],
    uniques: [['idempotency_key']],
    indexes: [
      { name: 'idx_copy_gen_copy', cols: ['copy_id', 'created_at'] },
      { name: 'idx_copy_gen_status', cols: ['status'] },
    ],
    comment: '文案工坊 - 生成记录（批次，含提示词与人物快照 FR-G6）',
  },
  {
    name: 'copy_variant',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('copy_id', 40),
      vc('draft_id', 40),
      vc('generation_id', 40, { nullable: true }),
      int('section_index', 0),
      { name: 'section_text_at_gen', type: 'text', nullable: true },
      vc('kind', 32, { def: '口语化' }),
      { name: 'text', type: 'text', nullable: true },
      dt('applied_at'),
      vc('applied_version_id', 40, { nullable: true }),
      dt('created_at'),
    ],
    indexes: [{ name: 'idx_copy_variant_gen', cols: ['generation_id'] }],
    comment: '文案工坊 - AI 变体候选（W5：显式应用才写入）',
  },
  {
    name: 'copy_template',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('name', 128),
      vc('description', 512, { nullable: true }),
      { name: 'prompt', type: 'text', nullable: true },
      { name: 'structure_hint', type: 'text', nullable: true },
      { name: 'risk_hint', type: 'text', nullable: true },
      tint('is_builtin', 0),
      tint('enabled', 1),
      int('sort', 0),
      int('revision', 1),
      vc('updated_by', 64, { nullable: true }),
      dt('updated_at'),
      dt('created_at'),
    ],
    indexes: [{ name: 'idx_copy_tpl_sort', cols: ['enabled', 'sort'] }],
    comment: '文案工坊 - 模板（FR-M2）',
  },
  {
    name: 'copy_style',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('name', 128),
      vc('line', 16), // manager | kos | persona
      { name: 'prompt', type: 'text', nullable: true },
      tint('is_builtin', 0),
      tint('enabled', 1),
      int('sort', 0),
      int('revision', 1),
      vc('updated_by', 64, { nullable: true }),
      dt('updated_at'),
      dt('created_at'),
    ],
    indexes: [{ name: 'idx_copy_style_line', cols: ['line', 'enabled', 'sort'] }],
    comment: '文案工坊 - 风格（FR-M3，按线过滤 Q4）',
  },
  {
    name: 'article_source',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('filename', 255, { nullable: true }),
      vc('mime', 128, { nullable: true }),
      int('size', 0),
      vc('storage_path', 512, { nullable: true }),
      { name: 'outline', type: 'json', nullable: true },
      { name: 'plain_text', type: 'longtext', nullable: true },
      int('word_count', 0),
      vc('status', 16, { def: 'parsed' }), // parsed | failed
      { name: 'error', type: 'text', nullable: true },
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
    ],
    indexes: [{ name: 'idx_article_created', cols: ['created_at'] }],
    comment: '文案工坊 - 文章来源（FR-S2）',
  },
  {
    name: 'compliance_word',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('word', 128),
      vc('level', 16, { def: 'soft' }), // hard | soft
      vc('category', 32, { nullable: true }),
      tint('enabled', 1),
      vc('updated_by', 64, { nullable: true }),
      dt('updated_at'),
      dt('created_at'),
    ],
    uniques: [['word']],
    indexes: [{ name: 'idx_compliance_level', cols: ['level', 'enabled'] }],
    comment: '文案工坊 - 合规词库（W9 两级）',
  },
  {
    name: 'review_submission',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('copy_id', 40),
      vc('copy_version_id', 40),
      vc('status', 18, { def: 'submitted' }), // submitted|gate1|gate2|gate3|pending_manual|approved|rejected|withdrawn

      { name: 'gate_results', type: 'json', nullable: true },
      { name: 'appended_risk_text', type: 'text', nullable: true },
      vc('rejected_gate', 16, { nullable: true }),
      { name: 'reason', type: 'text', nullable: true },
      vc('decided_by', 64, { nullable: true }),
      tint('is_stub', 1),
      dt('created_at'),
      dt('updated_at'),
    ],
    uniques: [['copy_version_id']],
    indexes: [{ name: 'idx_review_status', cols: ['status'] }],
    comment: '审核单（所有权：审核模块；未就绪时由文案工坊桩建表 §5.3）',
  },
  {
    name: 'schema_migrations',
    pk: 'version',
    cols: [vc('version', 64), dt('applied_at')],
    comment: '迁移版本记录',
  },
]

export function createTableSql(t: TableDef, kind: 'mysql' | 'sqlite'): string {
  const parts: string[] = []
  const q = (s: string) => (kind === 'mysql' ? `\`${s}\`` : `"${s}"`)

  for (const c of t.cols) {
    let type: string
    switch (c.type) {
      case 'varchar':
        type = kind === 'mysql' ? `VARCHAR(${c.len ?? 64})` : 'TEXT'
        break
      case 'text':
        type = kind === 'mysql' ? 'TEXT' : 'TEXT'
        break
      case 'longtext':
        type = kind === 'mysql' ? 'LONGTEXT' : 'TEXT'
        break
      case 'int':
        type = kind === 'mysql' ? 'INT' : 'INTEGER'
        break
      case 'bigint':
        type = kind === 'mysql' ? 'BIGINT' : 'INTEGER'
        break
      case 'tinyint':
        type = kind === 'mysql' ? 'TINYINT' : 'INTEGER'
        break
      case 'decimal':
        type = kind === 'mysql' ? `DECIMAL(${c.len ?? 12},${c.scale ?? 6})` : 'REAL'
        break
      case 'datetime':
        type = kind === 'mysql' ? 'DATETIME' : 'TEXT'
        break
      case 'json':
        type = kind === 'mysql' ? 'JSON' : 'TEXT'
        break
      default:
        type = 'TEXT'
    }
    const notNull = c.nullable === false || t.pk === c.name ? ' NOT NULL' : ''
    let def = ''
    if (c.def !== undefined && c.def !== null) {
      const d = typeof c.def === 'number' ? String(c.def) : `'${String(c.def).replace(/'/g, "''")}'`
      def = ` DEFAULT ${d}`
    } else if (c.nullable !== false && t.pk !== c.name) {
      def = ' DEFAULT NULL'
    }
    parts.push(`${q(c.name)} ${type}${notNull}${def}`)
  }

  if (kind === 'mysql') {
    parts.push(`PRIMARY KEY (${q(t.pk)})`)
    for (const u of t.uniques ?? []) {
      const name = `uk_${t.name}_${u.join('_')}`
      parts.push(`CONSTRAINT ${q(name)} UNIQUE (${u.map(q).join(', ')})`)
    }
    const comment = t.comment ? ` COMMENT='${t.comment.replace(/'/g, '')}'` : ''
    return `CREATE TABLE IF NOT EXISTS ${q(t.name)} (\n  ${parts.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci${comment}`
  }

  for (const u of t.uniques ?? []) {
    const name = `uk_${t.name}_${u.join('_')}`
    parts.push(`CONSTRAINT ${q(name)} UNIQUE (${u.map(q).join(', ')})`)
  }
  parts.push(`PRIMARY KEY (${q(t.pk)})`)
  return `CREATE TABLE IF NOT EXISTS ${q(t.name)} (\n  ${parts.join(',\n  ')}\n)`
}

export function createIndexSql(t: TableDef, i: IndexDef, kind: 'mysql' | 'sqlite'): string {
  const q = (s: string) => (kind === 'mysql' ? `\`${s}\`` : `"${s}"`)
  const cols = i.cols.map(q).join(', ')
  if (kind === 'sqlite') {
    return `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(i.name)} ON ${q(t.name)} (${cols})`
  }
  return `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${q(t.name)} (${cols})`
}
