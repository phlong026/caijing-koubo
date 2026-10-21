/** 人物库模块类型定义（R24 平移众墅之家 character_contracts 枚举） */

export type PersonaLine = 'manager' | 'kos' | 'persona'
export type BindingMode = 'exclusive' | 'shared'

export const LINE_LABELS: Record<PersonaLine, string> = {
  manager: '经理 IP',
  kos: '员工 KOS',
  persona: '素人矩阵',
}

/** §3.3 线规则 */
export const LINE_RULES: Record<
  PersonaLine,
  {
    label: string
    avatarAllowed: boolean
    voiceAllowed: boolean
    authRequired: boolean
    bindingModes: BindingMode[]
    defaultBindingMode: BindingMode
    accountLimit: number
  }
> = {
  manager: {
    label: '经理 IP',
    avatarAllowed: true,
    voiceAllowed: true,
    authRequired: true,
    bindingModes: ['exclusive'],
    defaultBindingMode: 'exclusive',
    accountLimit: 1,
  },
  kos: {
    label: '员工 KOS',
    avatarAllowed: true,
    voiceAllowed: true,
    authRequired: true,
    bindingModes: ['exclusive', 'shared'],
    defaultBindingMode: 'shared',
    accountLimit: 5,
  },
  persona: {
    label: '素人矩阵',
    avatarAllowed: false,
    voiceAllowed: false,
    authRequired: false,
    bindingModes: ['exclusive'],
    defaultBindingMode: 'exclusive',
    accountLimit: 1,
  },
}

export type AssetKind = 'photo' | 'avatar_source' | 'background_image' | 'background_video' | 'broll_video'
export type AssetStatus = 'uploaded' | 'processing' | 'pending_review' | 'approved' | 'rejected' | 'failed'

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  photo: '形象照片',
  avatar_source: '分身素材',
  background_image: '背景图',
  background_video: '背景视频',
  broll_video: '空镜视频',
}

/** 各类素材数量上限（FR-A1/A2/A3） */
export const ASSET_LIMITS: Record<AssetKind, number> = {
  photo: 50,
  avatar_source: 10,
  background_image: 30,
  background_video: 30,
  broll_video: 30,
}

/** 上传限制（options 下发，FR-A1~A3） */
export const UPLOAD_LIMITS = {
  photo: { exts: ['.jpg', '.jpeg', '.png', '.webp'], maxBytes: 10 * 1024 * 1024, minShortEdge: 720 },
  avatar_source: { exts: ['.mp4', '.mov'], maxBytes: 200 * 1024 * 1024, minDurationMs: 10_000, maxDurationMs: 600_000, minShortEdge: 720 },
  background_image: { exts: ['.jpg', '.jpeg', '.png', '.webp'], maxBytes: 10 * 1024 * 1024 },
  background_video: { exts: ['.mp4', '.mov'], maxBytes: 200 * 1024 * 1024, maxDurationMs: 60_000 },
  broll_video: { exts: ['.mp4', '.mov'], maxBytes: 200 * 1024 * 1024, maxDurationMs: 60_000 },
  authorization: { exts: ['.pdf', '.jpg', '.jpeg', '.png'], maxBytes: 20 * 1024 * 1024 },
  voice_sample: { exts: ['.wav', '.mp3', '.m4a'], maxBytes: 20 * 1024 * 1024, minDurationMs: 5_000, maxDurationMs: 180_000 },
} as const

export type AvatarStatus = 'pending' | 'submitting' | 'running' | 'ready' | 'failed' | 'uncertain'
export type VoiceStatus = 'pending' | 'submitting' | 'running' | 'ready' | 'failed' | 'uncertain'

export const AVATAR_STATUS_LABELS: Record<AvatarStatus, string> = {
  pending: '排队中',
  submitting: '提交中',
  running: '制作中',
  ready: '可用',
  failed: '失败',
  uncertain: '待核对',
}

export const VOICE_STATUS_LABELS: Record<VoiceStatus, string> = {
  pending: '排队中',
  submitting: '提交中',
  running: '克隆中',
  ready: '可用',
  failed: '失败',
  uncertain: '待核对',
}

/** 授权状态：revoked/rejected 终态；expired 读时派生（FR-U3） */
export type AuthorizationStatus = 'pending' | 'verified' | 'rejected' | 'revoked' | 'expired'
export type AuthorizationScope = 'portrait' | 'voice' | 'share'

export const AUTH_SCOPE_LABELS: Record<AuthorizationScope, string> = {
  portrait: '肖像',
  voice: '声音',
  share: '允许共享',
}

export type ConsentPurpose = 'AVATAR_CLONE' | 'VOICE_CLONE'
export type ConsentSourceKind = 'avatar_source' | 'voice_sample'

export const CONSENT_PURPOSE_LABELS: Record<ConsentPurpose, string> = {
  AVATAR_CLONE: '口播分身克隆',
  VOICE_CLONE: '声音克隆',
}

/** 平台账号（L11，M4 迁 platform_account） */
export type Platform = 'douyin' | 'xiaohongshu' | 'kuaishou' | 'shipinhao'
export const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  kuaishou: '快手',
  shipinhao: '视频号',
}

/** §3.2 人物有效状态（读时派生，不入库） */
export type EffectiveStatus = 'archived' | 'disabled' | 'auth_revoked' | 'auth_expired' | 'auth_pending' | 'active'

export const EFFECTIVE_STATUS_LABELS: Record<EffectiveStatus, string> = {
  archived: '已归档',
  disabled: '已停用',
  auth_revoked: '授权已撤销',
  auth_expired: '授权已过期',
  auth_pending: '授权待核验',
  active: '可用',
}

/** 附加标签（不影响 usable，影响 readiness 与卡片展示） */
export type PersonaExtraTag = 'voice_unconfirmed' | 'avatar_in_progress' | 'uncertain' | 'auth_expiring' | 'incomplete' | 'configured'

export const EXTRA_TAG_LABELS: Record<PersonaExtraTag, string> = {
  voice_unconfirmed: '声音待确认',
  avatar_in_progress: '分身制作中',
  uncertain: '状态待核对',
  auth_expiring: '授权将到期',
  incomplete: '待完善',
  configured: '已配置',
}

/** R14：飞影声音克隆语种白名单（普通话默认，不进 hash；键与飞影字典一致） */
export const VOICE_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'zh', label: '普通话' },
  { code: 'zh_cantonese', label: '粤语' },
  { code: 'zh_sichuanese', label: '四川话' },
  { code: 'zh_shanghainese', label: '上海话' },
  { code: 'zh_tianjinese', label: '天津话' },
  { code: 'zh_zhengzhounese', label: '郑州话' },
  { code: 'zh_wuhanese', label: '武汉话' },
]

export type ReminderKind = 'auth_expiring' | 'auth_expired' | 'clone_uncertain' | 'clone_failed'
export const REMINDER_KIND_LABELS: Record<ReminderKind, string> = {
  auth_expiring: '授权即将到期',
  auth_expired: '授权已到期',
  clone_uncertain: '克隆状态待核对',
  clone_failed: '克隆失败',
}

export type ClonePurpose = 'copy' | 'avatar_video' | 'mixcut'
