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
const big = (name: string, def = 0, extra: Partial<Col> = {}): Col => ({ name, type: 'bigint', def, ...extra })
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
    indexes: [
      { name: 'idx_rule_enabled', cols: ['enabled', 'priority'] },
      // P2-13b：同一分类同一关键词只保留一条（建索引前 dedupeBeforeUniqueIndexes 会清理存量重复）
      { name: 'uq_rule_category_keyword', cols: ['category', 'keyword'], unique: true },
    ],
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
      int('video_width', 0),
      int('video_height', 0),
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
      tint('is_stub', 1), // D13：M1 人物库未就绪前的只读桩标记；M1 后语义为「示例人物」
      dt('created_at'),
      dt('updated_at'),
      // ── 人物库模块扩展（任务书 §4.1，L1 原地升级）──
      vc('owner_subject', 64, { nullable: true }), // 归属主体
      vc('description', 255, { nullable: true }), // 简介
      vc('binding_mode', 16, { def: 'exclusive' }), // exclusive | shared
      vc('cover_asset_id', 40, { nullable: true }), // → persona_asset(kind=photo)
      vc('default_avatar_id', 40, { nullable: true }), // → persona_avatar
      vc('default_voice_id', 40, { nullable: true }), // → persona_voice
      int('profile_revision', 0), // IP 定位保存递增（hash 不变不升）
      int('rev', 0), // 基本信息乐观锁
      vc('current_version_id', 40, { nullable: true }), // 最新人物版本
      vc('active_name_key', 64, { nullable: true }), // 规范化名称（未归档唯一，归档置 NULL）
      dt('archived_at'),
      vc('created_by', 64, { nullable: true }),
      vc('updated_by', 64, { nullable: true }),
    ],
    // 注意：active_name_key 唯一键走 indexes（unique）而非 uniques——
    // persona 是存量表，CREATE TABLE IF NOT EXISTS 不会给它补约束，
    // 必须经 migrate 的 indexExists 守卫单独建索引（MySQL 无 IF NOT EXISTS）。
    indexes: [
      { name: 'idx_persona_line', cols: ['line', 'enabled'] },
      { name: 'idx_persona_archived', cols: ['archived_at'] },
      { name: 'uk_persona_active_name', cols: ['active_name_key'], unique: true },
    ],
    comment: '人物（D13 桩升级：人物库模块 L1 原地扩展，存量 id 保留）',
  },

  // ── 人物库模块（任务书 §4.2）─────────────────────────────────────
  {
    name: 'persona_asset',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('persona_id', 40),
      vc('kind', 24), // photo | avatar_source | background_image | background_video | broll_video
      vc('name', 60),
      vc('background_label', 20, { nullable: true }), // 仅 avatar_source：分身背景名（L15）
      vc('status', 16, { def: 'uploaded' }), // uploaded|processing|pending_review|approved|rejected|failed
      vc('storage_key', 255),
      vc('compat_key', 255, { nullable: true }), // 分身兼容版本（H.264 mp4）
      vc('thumb_key', 255, { nullable: true }),
      vc('mime', 64),
      big('size_bytes'),
      vc('sha256', 64),
      vc('compat_sha256', 64, { nullable: true }),
      vc('sha256_key', 64, { nullable: true }), // 去重键（软删置 NULL 释放）
      int('width', 0, { nullable: true }),
      int('height', 0, { nullable: true }),
      big('duration_ms', 0, { nullable: true }),
      { name: 'fps', type: 'decimal', len: 6, scale: 2, def: 0, nullable: true },
      { name: 'quality', type: 'json', nullable: true }, // {schemaVersion, hard[], soft[], metrics}
      { name: 'tags', type: 'json', nullable: true },
      vc('review_decision', 16, { nullable: true }),
      { name: 'review_reason', type: 'text', nullable: true },
      { name: 'review_issue_codes', type: 'json', nullable: true },
      vc('reviewed_by', 64, { nullable: true }),
      dt('reviewed_at'),
      { name: 'error', type: 'text', nullable: true },
      int('sort', 0),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
      dt('deleted_at'),
      vc('deleted_by', 64, { nullable: true }),
    ],
    uniques: [['persona_id', 'kind', 'sha256_key']],
    indexes: [
      { name: 'idx_passet_persona', cols: ['persona_id', 'kind', 'status'] },
      { name: 'idx_passet_status', cols: ['status'] },
    ],
    comment: '人物素材（照片/分身素材/背景图/背景视频/空镜，软删）',
  },
  {
    name: 'persona_avatar',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('persona_id', 40),
      vc('name', 60),
      vc('source_asset_id', 40),
      vc('source_kind', 16), // video | image
      vc('background_label', 20, { nullable: true }),
      vc('provider', 16, { def: 'hifly' }),
      vc('vendor_title', 40),
      vc('short_ref', 6), // 短引用（核对用，库内唯一）
      vc('vendor_task_id', 128, { nullable: true }),
      vc('vendor_avatar_id', 128, { nullable: true }),
      vc('status', 16, { def: 'pending' }), // pending|submitting|running|ready|failed|uncertain
      { name: 'error', type: 'text', nullable: true },
      vc('consent_id', 40),
      vc('authorization_id', 40),
      vc('idempotency_key', 64),
      vc('request_hash', 64),
      int('attempts', 0),
      dt('submitted_at'),
      dt('last_polled_at'),
      dt('next_poll_at'),
      dt('ready_at'),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
      dt('deleted_at'),
      vc('deleted_by', 64, { nullable: true }),
    ],
    uniques: [
      ['idempotency_key'],
      ['short_ref'],
    ],
    indexes: [
      { name: 'idx_pavatar_persona', cols: ['persona_id', 'status'] },
      { name: 'idx_pavatar_poll', cols: ['status', 'next_poll_at'] },
    ],
    comment: '飞影口播分身（平移 oral_avatars，软删）',
  },
  {
    name: 'persona_voice',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('persona_id', 40),
      vc('name', 60),
      tint('is_sample', 0), // 1=声音样本（未发起克隆）；0=克隆声音（FR-V1/V3）
      vc('provider', 16, { def: 'hifly' }),
      int('voice_type', 8),
      vc('language', 24, { def: 'zh' }),
      vc('sample_key', 255),
      vc('sample_sha256', 64),
      big('sample_duration_ms', 0),
      vc('vendor_title', 40),
      vc('short_ref', 6),
      vc('vendor_task_id', 128, { nullable: true }),
      vc('vendor_voice_id', 128, { nullable: true }),
      vc('demo_key', 255, { nullable: true }), // 归档后的试听文件
      vc('consent_id', 40),
      vc('authorization_id', 40),
      vc('status', 16, { def: 'pending' }),
      { name: 'error', type: 'text', nullable: true },
      tint('confirmed', 0), // 人工试听确认
      vc('confirmed_by', 64, { nullable: true }),
      dt('confirmed_at'),
      { name: 'speech_rate', type: 'decimal', len: 3, scale: 1, def: 1.0 },
      { name: 'volume', type: 'decimal', len: 3, scale: 1, def: 1.0 },
      { name: 'pitch', type: 'decimal', len: 3, scale: 1, def: 1.0 },
      vc('idempotency_key', 64),
      vc('request_hash', 64),
      int('attempts', 0),
      dt('submitted_at'),
      dt('last_polled_at'),
      dt('next_poll_at'),
      dt('ready_at'),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
      dt('deleted_at'),
      vc('deleted_by', 64, { nullable: true }),
    ],
    uniques: [
      ['idempotency_key'],
      ['short_ref'],
    ],
    indexes: [
      { name: 'idx_pvoice_persona', cols: ['persona_id', 'status'] },
      { name: 'idx_pvoice_poll', cols: ['status', 'next_poll_at'] },
    ],
    comment: '飞影声音档案（平移 oral_voices，软删；is_sample=1 为未发起克隆的声音样本）',
  },
  {
    name: 'persona_voice_preview',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('voice_id', 40),
      vc('params_hash', 64),
      vc('text_hash', 64),
      { name: 'text', type: 'longtext', nullable: true }, // 试听原文（轮询重试需要）
      vc('vendor_task_id', 128, { nullable: true }),
      vc('status', 16, { def: 'running' }), // running|ready|failed
      vc('audio_key', 255, { nullable: true }),
      { name: 'error', type: 'text', nullable: true },
      int('attempts', 0),
      dt('next_poll_at'), // P0-2：轮询排期，由 poll_sweep 到期入队
      dt('created_at'),
      dt('expires_at'),
    ],
    uniques: [['voice_id', 'params_hash', 'text_hash']],
    indexes: [{ name: 'idx_pvprev_status', cols: ['status'] }],
    comment: '任意文本试听缓存（FR-V7，7 天）',
  },
  {
    name: 'persona_authorization',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('persona_id', 40),
      vc('grantor_name', 60),
      { name: 'scopes', type: 'json', nullable: true }, // portrait|voice|share
      vc('file_key', 255),
      vc('file_mime', 64),
      big('file_size', 0),
      vc('file_sha256', 64),
      vc('effective_from', 10), // YYYY-MM-DD
      dt('expires_at'), // Q4：必须填到期日期
      vc('status', 16, { def: 'pending' }), // pending|verified|rejected|revoked（expired 读时派生）
      { name: 'decision_reason', type: 'text', nullable: true },
      vc('verified_by', 64, { nullable: true }),
      dt('verified_at'),
      vc('revoked_by', 64, { nullable: true }),
      dt('revoked_at'),
      dt('remind_sent_at'), // 到期前 30 天提醒已发
      dt('expired_notified_at'), // P2-6：到期通知只发一次
      vc('note', 255, { nullable: true }),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
    ],
    indexes: [
      { name: 'idx_pauth_persona', cols: ['persona_id', 'status'] },
      { name: 'idx_pauth_expires', cols: ['status', 'expires_at'] },
    ],
    comment: '授权材料（读时派生 expired，FR-U3）',
  },
  {
    name: 'persona_consent',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('persona_id', 40),
      vc('authorization_id', 40),
      vc('purpose', 16), // AVATAR_CLONE | VOICE_CLONE
      vc('source_kind', 16), // avatar_source | voice_sample
      vc('source_id', 40),
      vc('source_sha256', 64),
      vc('consent_text_version', 32),
      vc('consented_by', 64),
      dt('consented_at'),
    ],
    indexes: [{ name: 'idx_pconsent_persona', cols: ['persona_id', 'purpose'] }],
    comment: '克隆授权确认（L6，五元组一致才放行）',
  },
  {
    name: 'persona_account_binding',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('persona_id', 40),
      vc('platform', 16), // douyin|xiaohongshu|kuaishou|shipinhao
      vc('account_key', 128),
      vc('display_name', 60),
      vc('platform_account_id', 40, { nullable: true }), // 发布管理（M4）迁移：指向 platform_account.id；读取判定顺序 = 外键优先、account_key 兜底
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('released_at'),
      vc('active_key', 160, { nullable: true }), // platform:account_key（解绑置 NULL）
    ],
    uniques: [['active_key']],
    indexes: [
      { name: 'idx_pbind_persona', cols: ['persona_id'] },
      { name: 'idx_pbind_account', cols: ['platform_account_id'] },
    ],
    comment: '账号绑定（L11，M4 已迁 platform_account 外键，account_key 兜底）',
  },
  {
    name: 'persona_version',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('persona_id', 40),
      int('version_no', 1),
      { name: 'snapshot', type: 'longtext', nullable: true },
      vc('snapshot_hash', 64),
      vc('trigger', 16), // profile | default_asset | voice_settings | migrate
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
    ],
    uniques: [['persona_id', 'version_no']],
    indexes: [{ name: 'idx_pversion_persona', cols: ['persona_id', 'created_at'] }],
    comment: '人物版本快照（L7，不可变）',
  },
  {
    name: 'persona_reminder',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('persona_id', 40),
      vc('kind', 24), // auth_expiring | auth_expired | clone_uncertain | clone_failed
      vc('ref_id', 40, { nullable: true }),
      vc('message', 255),
      dt('read_at'),
      dt('created_at'),
    ],
    indexes: [
      { name: 'idx_preminder_unread', cols: ['read_at', 'created_at'] },
      { name: 'idx_preminder_kind', cols: ['kind', 'ref_id'] },
    ],
    comment: '站内提醒（授权到期 / 克隆不确定态 / 失败）',
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
      vc('persona_version_id', 40, { nullable: true }), // FR-X3：生成时的人物版本
      { name: 'prompt_text', type: 'longtext', nullable: true },
      // 受理时的 system 段（prompt_text = system + 空行 + user）；执行时据此拆回 system / user，
      // 直接用落库快照调用模型，不再按运行时最新的人物 / 模板重拼（FR-G6 追溯一致）
      { name: 'prompt_system', type: 'longtext', nullable: true },
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
    name: 'app_user',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('username', 64),
      vc('display_name', 64),
      vc('password_hash', 255),
      vc('role', 16, { def: 'ops' }), // ops | reviewer | admin
      tint('enabled', 1),
      int('token_version', 0), // 改密 / 停用时 +1，使已签发令牌失效
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
      dt('last_login_at'),
    ],
    uniques: [['username']],
    comment: '登录账号与角色（运营 / 审核 / 管理员）',
  },
  // ── 视频创作（任务书 §4.1）──────────────────────────────────────
  {
    name: 'video_job',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('copy_id', 40),
      vc('copy_version_id', 40),
      int('copy_version_no'),
      int('version_no'), // 在 copy 内单调递增（V1：重新生成永远新建版本）
      vc('persona_id', 40),
      vc('persona_version_id', 40, { nullable: true }), // FR-S2 可追溯
      vc('line', 16, { nullable: true }), // 冗余人物所属线：素人线口播拦截
      vc('mode', 16, { def: 'avatar' }), // avatar | mixcut
      vc('gen_mode', 8, { nullable: true }), // tts | audio（仅 avatar；Q3 备选 B）
      vc('provider', 16, { def: 'hifly' }),
      vc('phase', 24, { def: 'waiting' }), // §3.1 阶段机
      int('progress_floor', 0), // 进度下限（单调不回退）
      vc('status_message', 200, { nullable: true }),
      vc('error_code', 64, { nullable: true }),
      { name: 'error_detail', type: 'text', nullable: true },
      { name: 'config_snapshot', type: 'json' }, // FR-A6 不可变快照
      { name: 'text_snapshot', type: 'json' }, // FR-P1 segments + submit_text
      vc('text_hash', 64, { nullable: true }),
      vc('avatar_id', 40, { nullable: true }), // 人物库 persona_avatar.id（删除守卫）
      vc('voice_id', 40, { nullable: true }), // 人物库 persona_voice.id（删除守卫）
      vc('vendor_title', 40, { nullable: true }), // 飞影后台检索标题（V14）
      vc('short_ref', 8, { nullable: true }),
      vc('remote_task_id', 128, { nullable: true }),
      { name: 'remote_result_url', type: 'text', nullable: true }, // 临时地址，仅排障引用
      int('remote_duration_sec', 0, { nullable: true }),
      int('submit_attempts', 0),
      dt('submitted_at'),
      dt('next_poll_at'),
      int('poll_failures', 0),
      int('expected_gen_seconds', 0, { nullable: true }),
      vc('tts_audio_id', 40, { nullable: true }), // 复用的配音缓存
      { name: 'timeline', type: 'json', nullable: true },
      vc('timeline_source', 16, { nullable: true }), // aligned | estimated | measured
      { name: 'align_score', type: 'decimal', len: 4, scale: 3, nullable: true },
      { name: 'replacements', type: 'json', nullable: true }, // FR-M4 替换点
      vc('result_key', 512, { nullable: true }),
      vc('cover_key', 512, { nullable: true }),
      int('duration_ms', 0),
      int('width', 0),
      int('height', 0),
      big('size_bytes', 0),
      tint('is_mock', 0),
      { name: 'credits_estimated', type: 'decimal', len: 12, scale: 2, def: 0 },
      vc('idempotency_key', 64, { nullable: true }),
      vc('request_hash', 64, { nullable: true }),
      dt('queued_at'),
      dt('started_at'),
      dt('finished_at'),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
      dt('archived_at'),
    ],
    uniques: [['copy_id', 'version_no'], ['short_ref'], ['idempotency_key']],
    indexes: [
      { name: 'idx_vjob_phase_poll', cols: ['phase', 'next_poll_at'] },
      { name: 'idx_vjob_copy', cols: ['copy_id', 'created_at'] },
      { name: 'idx_vjob_persona', cols: ['persona_id', 'phase'] },
      { name: 'idx_vjob_avatar', cols: ['avatar_id', 'phase'] },
      { name: 'idx_vjob_voice', cols: ['voice_id', 'phase'] },
    ],
    comment: '视频任务（一次基础视频生成 = 一个版本，V1）',
  },
  {
    name: 'video_job_event',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('video_job_id', 40),
      vc('from_phase', 24, { nullable: true }),
      vc('to_phase', 24),
      vc('error_code', 64, { nullable: true }),
      { name: 'detail', type: 'json', nullable: true }, // FR-P8：ASR 原始结果等排障信息
      vc('operator', 64, { nullable: true }),
      dt('created_at'),
    ],
    indexes: [{ name: 'idx_vjevt_job', cols: ['video_job_id', 'created_at'] }],
    comment: '视频任务阶段流水（排障与任务中心时间线）',
  },
  {
    name: 'video_tts_audio',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('identity', 64), // SHA-256(text_hash, vendor_voice_id, voice_params, 切句规则版本)
      vc('provider', 16, { def: 'hifly' }),
      vc('vendor_voice_id', 128),
      { name: 'voice_params', type: 'json' },
      vc('text_hash', 64),
      { name: 'remote_task_ids', type: 'json', nullable: true },
      vc('status', 16, { def: 'running' }), // running | ready | failed
      vc('storage_key', 512, { nullable: true }),
      int('duration_ms', 0, { nullable: true }),
      { name: 'timeline', type: 'json', nullable: true },
      vc('timeline_source', 16, { nullable: true }),
      int('segment_count', 0),
      dt('created_at'),
      dt('last_used_at'),
    ],
    uniques: [['identity']],
    comment: '混剪配音整轨缓存（FR-P2 / AC-T5，复用记 0 积分）',
  },
  {
    name: 'video_config',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('copy_id', 40),
      vc('mode', 16, { def: 'avatar' }),
      vc('avatar_id', 40, { nullable: true }),
      vc('background_asset_id', 40, { nullable: true }), // 混剪底板：人物库 persona_asset.id
      vc('voice_source', 16, { nullable: true }), // persona | public（素人线 Q12）
      vc('public_voice_id', 128, { nullable: true }),
      { name: 'mixcut', type: 'json', nullable: true }, // 素材包/关键词组/显示方式
      vc('updated_by', 64, { nullable: true }),
      dt('updated_at'),
    ],
    uniques: [['copy_id']],
    comment: '按 copy 记忆的创作配置（FR-C4）',
  },
  {
    name: 'material_pack',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('name', 128),
      vc('line', 16, { nullable: true }),
      vc('source_path', 512, { nullable: true }), // 目录或 zip 来源
      int('item_count', 0),
      tint('enabled', 1),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
    ],
    comment: '素材包桩（所有权：素材库，§2.5 FR-S4）',
  },
  {
    name: 'material_item',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('pack_id', 40),
      vc('storage_key', 512),
      tint('is_image', 0),
      int('duration_ms', 0, { nullable: true }),
      int('width', 0, { nullable: true }),
      int('height', 0, { nullable: true }),
      vc('thumb_key', 512, { nullable: true }),
      { name: 'tags', type: 'json', nullable: true },
      tint('enabled', 1),
    ],
    indexes: [{ name: 'idx_mitem_pack', cols: ['pack_id', 'enabled'] }],
    comment: '素材包条目（混剪素材，含时长与缩略图）',
  },
  {
    name: 'material_keyword_group',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('name', 128),
      { name: 'keywords', type: 'json' }, // string[]
      { name: 'pack_ids', type: 'json' }, // string[]：组 → 素材包映射
      int('duration_min_ms', 800),
      int('duration_max_ms', 3000),
      vc('selection_mode', 16, { def: 'random' }), // random | sequential
      tint('enabled', 1),
      int('sort', 0),
      vc('updated_by', 64, { nullable: true }),
      dt('updated_at'),
    ],
    comment: '混剪关键词组（R6 结构平移）',
  },
  // ── 发布管理模块（任务书 §4.1，PU0）──────────────────────────────
  {
    name: 'platform_account',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('platform', 16), // douyin|xiaohongshu|kuaishou|shipinhao
      vc('line', 16), // manager|kos|persona（决定可用平台矩阵 PB1）
      vc('display_name', 60),
      vc('uid', 128, { nullable: true }), // 平台侧账号标识，登录确认后回填（唯一约束在 MySQL/SQLite 对 NULL 不生效）
      vc('avatar_url', 255, { nullable: true }),
      vc('login_status', 16, { def: 'pending_login' }), // pending_login|active|expired|failed|disabled
      dt('last_checked_at'),
      dt('login_expires_at'),
      vc('owner_id', 64, { nullable: true }), // 归属运营（PB13：一期共享池，仅审计）
      vc('data_dir', 255, { nullable: true }), // 持久化浏览器上下文目录（PB3：凭证留存处，不入库 Cookie）
      tint('enabled', 1),
      vc('remark', 255, { nullable: true }),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
      dt('deleted_at'),
    ],
    uniques: [['platform', 'uid']],
    indexes: [
      { name: 'idx_pacct_list', cols: ['platform', 'login_status', 'enabled'] },
      { name: 'idx_pacct_line', cols: ['line'] },
    ],
    comment: '平台账号矩阵（A8：账号独立于人物；绑定表以 platform_account_id 外键指向本表）',
  },
  {
    name: 'publish_login_session',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('account_id', 40),
      vc('status', 16, { def: 'waiting_scan' }), // waiting_scan|scanned|confirmed|failed|expired
      vc('qr_object_key', 255, { nullable: true }), // 二维码截图 OSS 对象键（签名 URL 下发）
      dt('next_poll_at'),
      int('poll_attempts', 0),
      dt('expires_at'),
      vc('error', 255, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
    ],
    indexes: [
      { name: 'idx_plogin_account', cols: ['account_id', 'status'] },
      { name: 'idx_plogin_poll', cols: ['status', 'next_poll_at'] },
    ],
    comment: '扫码登录会话（FR-L1：next_poll_at + publish-login-sweep 轮询，重启续跑）',
  },
  {
    name: 'publish_plan',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('copy_id', 40),
      vc('copy_version_id', 40, { nullable: true }),
      vc('video_job_id', 64, { nullable: true }),
      int('base_video_version_no', 0),
      vc('title', 255),
      { name: 'description', type: 'text', nullable: true },
      { name: 'tags', type: 'json', nullable: true }, // string[]
      vc('cover_object_key', 255, { nullable: true }),
      vc('cover_source', 16, { def: 'first_frame' }), // first_frame | custom
      vc('title_hash', 64, { nullable: true }),
      vc('review_state', 16, { def: 'none' }), // none|needs_review|confirmed（FR-R1）
      vc('review_by', 64, { nullable: true }),
      dt('review_at'),
      vc('status', 16, { def: 'draft' }), // draft|scheduled|executing|cancelling|completed|partial|failed|cancelled
      dt('scheduled_at'),
      dt('completed_at'),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
      dt('deleted_at'),
    ],
    indexes: [
      { name: 'idx_pplan_status', cols: ['status', 'scheduled_at'] },
      { name: 'idx_pplan_copy', cols: ['copy_id'] },
    ],
    comment: '发布计划（PB12：绑定已过审文案；review_state 拦截实质修改未确认的单）',
  },
  {
    name: 'publish_log',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('plan_id', 40, { nullable: true }), // 补录记录可空（PB14）
      vc('platform', 16),
      vc('account_id', 40),
      vc('source', 8, { def: 'auto' }), // auto | manual
      vc('status', 24, { def: 'scheduled' }), // scheduled|uploading|confirming|published|failed|failed_final|verification_required|manual_pending|cancelled（无 queued/retrying）
      int('attempt', 0), // worker 开始执行时 +1；补录 = 0
      vc('title', 255, { nullable: true }),
      { name: 'description', type: 'text', nullable: true },
      { name: 'tags', type: 'json', nullable: true },
      vc('cover_object_key', 255, { nullable: true }),
      dt('scheduled_at'),
      dt('retry_at'), // failed(attempt=1) 的自动重试到期时间（FR-S1，sweep 到期 CAS 回 scheduled）
      dt('started_at'),
      dt('finished_at'),
      dt('window_expires_at'), // verification_required 人工窗口截止（FR-S3）
      vc('video_url', 500, { nullable: true }),
      vc('external_video_id', 64, { nullable: true }),
      vc('error_code', 64, { nullable: true }),
      vc('error_message', 500, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
    ],
    indexes: [
      { name: 'idx_plog_plan', cols: ['plan_id'] },
      { name: 'idx_plog_sweep', cols: ['status', 'scheduled_at'] },
      { name: 'idx_plog_account', cols: ['account_id', 'status'] },
    ],
    comment: '分平台发布记录（A5 三态；单平台失败自动重试一次）',
  },
  {
    name: 'video_cut',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('video_job_id', 40),
      int('version_no'), // 0 = 配置草稿（每 base 至多一个，由唯一约束保证）；正式版本从 1 单调递增
      vc('status', 16, { def: 'draft' }), // draft|queued|rendering|cancelling|completed|failed|cancelled（§3.1）
      vc('render_stage', 16, { def: 'idle' }), // idle|download|breathe|subtitle|bgm|tail|normalize|uploading
      int('progress', 0),
      int('base_version_no', 0), // 渲染时的 base 版本快照
      tint('subtitle_enabled', 1),
      { name: 'subtitle_style', type: 'json' },
      { name: 'segments', type: 'json' }, // [{index,text,startMs,endMs,kind,edited}]
      tint('risk_tail_enabled', 1),
      { name: 'risk_tail_text', type: 'text', nullable: true },
      int('risk_tail_seconds', 5),
      tint('bgm_enabled', 0),
      vc('bgm_id', 40, { nullable: true }),
      { name: 'bgm_volume', type: 'decimal', len: 3, scale: 2, def: 0.2 },
      int('bgm_fade_in', 2000),
      int('bgm_fade_out', 2000),
      tint('breathe_enabled', 0),
      { name: 'breathe_params', type: 'json', nullable: true }, // {noiseDb,minSilenceMs,keepGapMs}
      tint('pip_enabled', 0), // A9 画中画一期不做，字段预留
      vc('result_key', 512, { nullable: true }),
      vc('cover_key', 512, { nullable: true }),
      int('duration_ms', 0),
      int('width', 0),
      int('height', 0),
      big('size_bytes', 0),
      { name: 'timeline', type: 'json', nullable: true }, // 渲染后（剪气口重映射）句级时间轴
      vc('cut_text_hash', 64, { nullable: true }), // 字幕文本 hash（diff 展示与变化检测）
      vc('content_hash', 64, { nullable: true }), // §3.3 实质修改判定
      vc('review_status', 16, { def: 'none' }), // none|in_review|approved|rejected
      vc('approved_content_hash', 64, { nullable: true }), // 过审时冻结的 hash
      tint('is_mock', 0),
      vc('error_code', 64, { nullable: true }),
      vc('error_message', 500, { nullable: true }),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
    ],
    uniques: [['video_job_id', 'version_no']],
    indexes: [
      { name: 'idx_vcut_status', cols: ['status'] },
      { name: 'idx_vcut_review', cols: ['review_status'] },
    ],
    comment: '成片版本（剪辑模块：一行一个版本；draft 固定 version_no=0）',
  },
  {
    name: 'video_cut_event',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('cut_id', 40),
      vc('from_status', 16, { nullable: true }),
      vc('to_status', 16),
      vc('render_stage', 16, { nullable: true }),
      vc('error_code', 64, { nullable: true }),
      { name: 'detail', type: 'json', nullable: true },
      vc('operator', 64, { nullable: true }),
      dt('created_at'),
    ],
    indexes: [{ name: 'idx_vcevt_cut', cols: ['cut_id', 'created_at'] }],
    comment: '成片渲染阶段流水',
  },
  {
    name: 'cut_review_submission',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('cut_id', 40),
      int('cut_version_no', 0),
      vc('content_hash', 64, { nullable: true }),
      vc('status', 16, { def: 'submitted' }), // submitted|gate1|gate2|gate3|pending_manual|approved|rejected（同步桩，无 is_stub）
      { name: 'gates', type: 'json', nullable: true },
      { name: 'risk_points', type: 'json', nullable: true },
      vc('decision_by', 64, { nullable: true }),
      dt('decision_at'),
      vc('decision_reason', 500, { nullable: true }),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('updated_at'),
    ],
    indexes: [
      { name: 'idx_crev_status', cols: ['status'] },
      { name: 'idx_crev_cut', cols: ['cut_id'] },
    ],
    comment: '成片复审单（EC9：对照文案审核链，同步三关桩）',
  },
  {
    name: 'bgm_item',
    pk: 'id',
    cols: [
      vc('id', 40),
      vc('name', 120),
      vc('storage_key', 512),
      int('duration_ms', 0),
      big('size_bytes', 0),
      tint('enabled', 1),
      vc('created_by', 64, { nullable: true }),
      dt('created_at'),
      dt('deleted_at'),
    ],
    indexes: [{ name: 'idx_bgm_enabled', cols: ['enabled'] }],
    comment: '轻量 BGM 库（EC6 过渡实现，素材库立项后迁移）',
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
