/** 统一错误规范（§2.4 可观测：失败原因可读、可追溯） */
export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_state'
  | 'domain_not_allowed'
  | 'too_long'
  | 'upstream_error'
  | 'rate_limited'
  | 'internal'
  // ── 文案工坊（任务书 §5.2）──
  | 'COPY_LOCKED' // 审核中写操作
  | 'COPY_DRAFT_CONFLICT' // 稿级乐观锁冲突
  | 'COPY_NOT_APPROVED' // 无已通过版本
  | 'COPY_DRAFT_LIMIT' // 单 copy 稿数上限
  | 'COPY_PRECHECK_FAILED' // 提交时硬检查不过
  | 'ARTICLE_UNSUPPORTED_TYPE' // 不支持的文件类型 / 魔数不符
  | 'ARTICLE_TOO_LARGE' // 文件或正文超限
  | 'ARTICLE_NO_TEXT' // 无可提取文本（扫描件）
  | 'REVIEW_WITHDRAW_NOT_ALLOWED' // 已进入人工复核，不可撤回
  | 'REVIEW_STUB_DISABLED' // 审核桩已关闭（生产环境），桩专用接口不可用
  // ── 人物库（任务书 §5.2）──
  | 'PERSONA_NOT_FOUND'
  | 'PERSONA_NAME_DUPLICATE'
  | 'PERSONA_CONFLICT'
  | 'PERSONA_ARCHIVED'
  | 'PERSONA_IN_USE'
  | 'PERSONA_LINE_NOT_ALLOWED'
  | 'PERSONA_NOT_READY'
  | 'PERSONA_BINDING_RULE'
  | 'ASSET_UNSUPPORTED_TYPE'
  | 'ASSET_TOO_LARGE'
  | 'ASSET_QUALITY_FAILED'
  | 'ASSET_LIMIT'
  | 'ASSET_NOT_APPROVED'
  | 'AUTHORIZATION_REQUIRED'
  | 'AUTHORIZATION_EXPIRED'
  | 'CONSENT_MISMATCH'
  | 'CLONE_NOT_READY'
  | 'CLONE_UNCERTAIN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'HIFLY_NOT_CONFIGURED'
  | 'HIFLY_INSUFFICIENT_CREDIT'
  | 'HIFLY_QUOTA_EXCEEDED'
  | 'HIFLY_PLAN_UNSUPPORTED'
  | 'HIFLY_COMPLIANCE_REJECTED'
  | 'HIFLY_BAD_REQUEST'
  | 'HIFLY_UNAVAILABLE'
  // ── 视频创作（任务书 §6.3）──
  | 'VIDEO_MODE_NOT_ALLOWED' // 素人线口播（A5）
  | 'VIDEO_PRECHECK_FAILED' // data 带 checks（含人物库 readiness 项）
  | 'VIDEO_AVATAR_UNAVAILABLE' // 所选分身不属于该人物或非 ready
  | 'VIDEO_PERSONA_CHANGED' // 提交前复核不一致（V7）
  | 'VIDEO_TEXT_TOO_LONG' // >10000 字或预估 >180 秒
  | 'VIDEO_JOB_ACTIVE' // 同 copy 已有进行中任务
  | 'VIDEO_JOB_LIMIT' // 单 copy 版本上限
  | 'VIDEO_NOT_READY' // 基础视频未完成，取用被拒
  | 'VIDEO_ENGINE_UNAVAILABLE' // 飞影未配置且非 MOCK
  | 'VIDEO_VENDOR_REJECTED' // 飞影业务码拒绝，data 带 vendorCode
  | 'VIDEO_SUBMISSION_UNKNOWN' // 提交结果未知（V4）
  | 'VIDEO_POLL_TIMEOUT' // 轮询超窗（2 小时转人工）
  | 'VIDEO_SAVE_FAILED' // 已出片但下载/校验/入库失败
  | 'VIDEO_RESULT_URL_BLOCKED' // 结果地址未过防 SSRF 校验
  | 'VIDEO_STREAM_MISSING' // 缺视频/音频流
  | 'VIDEO_DIMENSIONS_INVALID' // 规格不符
  | 'VIDEO_DURATION_INVALID' // 时长校验不过
  | 'MEDIA_EMPTY' // 媒体为空
  | 'MATERIAL_PACK_EMPTY' // 素材包无可用素材
  // ── 发布管理（任务书 §6.3）──
  | 'PLATFORM_LINE_FORBIDDEN' // 线×平台矩阵越权（PB1）
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_IN_USE' // 有进行中发布 / 被人物绑定引用（FR-A4）
  | 'ACCOUNT_NOT_ACTIVE' // 账号非 active 不可发布
  | 'PUBLISH_RATE_LIMITED' // 每账号每日发布上限（PB8）
  | 'PUBLISH_CONTEXT_BUSY' // 上下文创建失败（仅浏览器启动异常场景）
  | 'PUBLISH_PLAN_NOT_FOUND'
  | 'PUBLISH_PLAN_NOT_CANCELLABLE'
  | 'PUBLISH_LOG_NOT_FOUND'
  | 'PUBLISH_LOG_NOT_RETRYABLE' // 当前状态不允许重发 / 标记
  | 'PUBLISH_NOT_CONFIRMED' // 引擎仍在确认窗口，不可重发
  | 'REVIEW_REQUIRED' // 实质修改未经审核确认（FR-R2）
  | 'LOGIN_SESSION_EXPIRED' // 登录会话已过期 / 失败
  | 'LOGIN_QR_FAILED' // 二维码获取失败
  // ── 视频剪辑（任务书 §6.3）──
  | 'CUT_RISK_LOCKED' // 风险提示段字幕不可编辑（FR-C3）
  | 'CUT_TEXT_TOO_LONG' // 单段字幕文本超长（FR-C3）
  | 'CUT_STYLE_INVALID' // 字幕样式超出白名单范围（FR-S2）
  | 'CUT_RENDER_BUSY' // 同 base 已有渲染中版本（FR-C4）
  | 'CUT_RENDER_TIMEOUT' // rendering 卡死 sweep 兜底（FR-J3）
  | 'CUT_NOT_DRAFT' // 草稿不存在 / 状态不允许该操作
  | 'CUT_NOT_COMPLETED' // 成片未渲染完成，不允许提交复审（FR-V1）
  | 'CUT_RISK_TEXT_EMPTY' // 开启风险尾页但文案为空（FR-K1）
  | 'CUT_ENGINE_UNAVAILABLE' // 环境缺 libass/drawtext 且未开 MOCK_FALLBACK（EC2）
  | 'BGM_NOT_FOUND' // BGM 不存在（FR-B1）
  | 'BGM_IN_USE' // BGM 被成片版本引用，不可删除（FR-B3）
  | 'FINAL_NOT_READY' // 成片不满足发布取用条件（FR-X1：未渲染/未过审/已实质修改）

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export const err = {
  badRequest: (msg: string, details?: unknown) => new ApiError('bad_request', msg, 400, details),
  notFound: (msg = '对象不存在') => new ApiError('not_found', msg, 404),
  unauthorized: (msg = '请先登录') => new ApiError('unauthorized', msg, 401),
  forbidden: (msg = '无权限') => new ApiError('forbidden', msg, 403),
  conflict: (msg: string, details?: unknown) => new ApiError('conflict', msg, 409, details),
  invalidState: (msg: string, details?: unknown) => new ApiError('invalid_state', msg, 409, details),
  domainNotAllowed: (msg = '链接域名不在白名单内', details?: unknown) =>
    new ApiError('domain_not_allowed', msg, 400, details),
  tooLong: (msg: string, details?: unknown) => new ApiError('too_long', msg, 413, details),
  upstream: (msg: string, details?: unknown) => new ApiError('upstream_error', msg, 502, details),
  rateLimited: (msg = '操作过于频繁，请稍后再试', details?: unknown) => new ApiError('rate_limited', msg, 429, details),
  internal: (msg = '服务内部错误') => new ApiError('internal', msg, 500),

  /* ── 文案工坊专属错误码（§5.2）───────────────────────────────── */
  /** 审核中锁定：写接口一律 409 */
  copyLocked: (msg = '该文案正在审核中，暂不可编辑；如需修改请先撤回提交', details?: unknown) =>
    new ApiError('COPY_LOCKED', msg, 409, details),
  /** 稿乐观锁：rev 不一致 */
  draftConflict: (msg = '该稿已在其他页面修改，请载入最新版本或另存为新稿', details?: unknown) =>
    new ApiError('COPY_DRAFT_CONFLICT', msg, 409, details),
  /** 无已通过版本，下游不可取稿 */
  notApproved: (msg = '该文案尚无审核通过的版本，不能用于视频创作', details?: unknown) =>
    new ApiError('COPY_NOT_APPROVED', msg, 409, details),
  /** 单 copy 稿数上限 */
  draftLimit: (msg: string, details?: unknown) => new ApiError('COPY_DRAFT_LIMIT', msg, 409, details),
  /** 提交前硬检查不通过，details 带 checks */
  precheckFailed: (msg: string, details?: unknown) => new ApiError('COPY_PRECHECK_FAILED', msg, 409, details),
  articleUnsupported: (msg: string, details?: unknown) =>
    new ApiError('ARTICLE_UNSUPPORTED_TYPE', msg, 400, details),
  articleTooLarge: (msg: string, details?: unknown) => new ApiError('ARTICLE_TOO_LARGE', msg, 413, details),
  articleNoText: (msg = '未识别到文字，请粘贴文本后重试', details?: unknown) =>
    new ApiError('ARTICLE_NO_TEXT', msg, 400, details),
  withdrawNotAllowed: (msg = '已进入人工复核，请等待审核结果', details?: unknown) =>
    new ApiError('REVIEW_WITHDRAW_NOT_ALLOWED', msg, 409, details),
  reviewStubDisabled: (msg = '审核桩已关闭（REVIEW_STUB_ENABLED=false），该接口仅供联调使用') =>
    new ApiError('REVIEW_STUB_DISABLED', msg, 403),

  /* ── 人物库专属错误码（任务书 §5.2）──────────────────────────────── */
  personaNotFound: (msg = '人物不存在') => new ApiError('PERSONA_NOT_FOUND', msg, 404),
  personaNameDuplicate: (msg: string, details?: unknown) =>
    new ApiError('PERSONA_NAME_DUPLICATE', msg, 409, details),
  personaConflict: (msg = '该人物已在其他页面修改，请载入最新数据后重试', details?: unknown) =>
    new ApiError('PERSONA_CONFLICT', msg, 409, details),
  personaArchived: (msg = '该人物已归档，不可操作') => new ApiError('PERSONA_ARCHIVED', msg, 409),
  personaInUse: (msg: string, details?: unknown) => new ApiError('PERSONA_IN_USE', msg, 409, details),
  lineNotAllowed: (msg = '该生产线不支持此操作', details?: unknown) =>
    new ApiError('PERSONA_LINE_NOT_ALLOWED', msg, 400, details),
  personaNotReady: (msg = '人物尚未准备就绪', details?: unknown) =>
    new ApiError('PERSONA_NOT_READY', msg, 409, details),
  bindingRule: (msg: string, details?: unknown) => new ApiError('PERSONA_BINDING_RULE', msg, 409, details),
  assetUnsupported: (msg: string, details?: unknown) =>
    new ApiError('ASSET_UNSUPPORTED_TYPE', msg, 400, details),
  assetTooLarge: (msg: string, details?: unknown) => new ApiError('ASSET_TOO_LARGE', msg, 413, details),
  assetQualityFailed: (msg: string, details?: unknown) =>
    new ApiError('ASSET_QUALITY_FAILED', msg, 400, details),
  assetLimit: (msg: string, details?: unknown) => new ApiError('ASSET_LIMIT', msg, 409, details),
  assetNotApproved: (msg = '素材尚未审核通过，不能使用', details?: unknown) =>
    new ApiError('ASSET_NOT_APPROVED', msg, 409, details),
  authorizationRequired: (msg = '需要有效的授权材料才能继续', details?: unknown) =>
    new ApiError('AUTHORIZATION_REQUIRED', msg, 409, details),
  authorizationExpired: (msg = '授权已过期', details?: unknown) =>
    new ApiError('AUTHORIZATION_EXPIRED', msg, 409, details),
  consentMismatch: (msg: string, details?: unknown) => new ApiError('CONSENT_MISMATCH', msg, 409, details),
  cloneNotReady: (msg = '当前状态不可执行该操作', details?: unknown) =>
    new ApiError('CLONE_NOT_READY', msg, 409, details),
  cloneUncertain: (msg = '状态待核对，请先核对状态，勿重复创建', details?: unknown) =>
    new ApiError('CLONE_UNCERTAIN', msg, 409, details),
  idempotencyConflict: (msg = '同一幂等键的请求参数不一致', details?: unknown) =>
    new ApiError('IDEMPOTENCY_CONFLICT', msg, 409, details),
  hiflyNotConfigured: (msg = '飞影未配置（HIFLY_API_KEY 缺失）', details?: unknown) =>
    new ApiError('HIFLY_NOT_CONFIGURED', msg, 503, details),
  hiflyInsufficientCredit: (msg = '飞影积分不足', details?: unknown) =>
    new ApiError('HIFLY_INSUFFICIENT_CREDIT', msg, 402, details),
  hiflyQuotaExceeded: (msg = '飞影套餐数量或并发上限', details?: unknown) =>
    new ApiError('HIFLY_QUOTA_EXCEEDED', msg, 409, details),
  hiflyPlanUnsupported: (msg = '当前飞影套餐不支持该能力', details?: unknown) =>
    new ApiError('HIFLY_PLAN_UNSUPPORTED', msg, 409, details),
  hiflyComplianceRejected: (msg = '素材未通过数字人服务合规校验', details?: unknown) =>
    new ApiError('HIFLY_COMPLIANCE_REJECTED', msg, 422, details),
  hiflyBadRequest: (msg: string, details?: unknown) => new ApiError('HIFLY_BAD_REQUEST', msg, 400, details),
  hiflyUnavailable: (msg = '飞影服务暂不可用', details?: unknown) =>
    new ApiError('HIFLY_UNAVAILABLE', msg, 502, details),

  /* ── 视频创作专属错误码（任务书 §6.3）────────────────────────────── */
  videoModeNotAllowed: (msg = '素人矩阵不使用数字人口播，请改用素材混剪', details?: unknown) =>
    new ApiError('VIDEO_MODE_NOT_ALLOWED', msg, 409, details),
  videoPrecheckFailed: (msg = '配置检查未通过，请先处理红叉项', details?: unknown) =>
    new ApiError('VIDEO_PRECHECK_FAILED', msg, 409, details),
  videoAvatarUnavailable: (msg = '所选分身不可用（不属于该人物或未就绪）', details?: unknown) =>
    new ApiError('VIDEO_AVATAR_UNAVAILABLE', msg, 409, details),
  videoPersonaChanged: (msg = '人物形象或声音在排队期间被修改，已停止提交；请重新生成', details?: unknown) =>
    new ApiError('VIDEO_PERSONA_CHANGED', msg, 409, details),
  videoTextTooLong: (msg = '口播文本超出上限', details?: unknown) =>
    new ApiError('VIDEO_TEXT_TOO_LONG', msg, 413, details),
  videoJobActive: (msg = '该文案已有进行中的视频任务', details?: unknown) =>
    new ApiError('VIDEO_JOB_ACTIVE', msg, 409, details),
  videoJobLimit: (msg = '该文案的基础视频版本数已达上限，请先归档旧版本', details?: unknown) =>
    new ApiError('VIDEO_JOB_LIMIT', msg, 409, details),
  videoNotReady: (msg = '基础视频尚未完成', details?: unknown) =>
    new ApiError('VIDEO_NOT_READY', msg, 409, details),
  videoEngineUnavailable: (msg = '数字人引擎不可用（飞影未配置且未开启 MOCK）', details?: unknown) =>
    new ApiError('VIDEO_ENGINE_UNAVAILABLE', msg, 503, details),
  videoVendorRejected: (msg: string, details?: unknown) =>
    new ApiError('VIDEO_VENDOR_REJECTED', msg, 422, details),
  videoSubmissionUnknown: (msg = '提交结果待确认，重新生成可能产生额外费用', details?: unknown) =>
    new ApiError('VIDEO_SUBMISSION_UNKNOWN', msg, 409, details),
  videoPollTimeout: (msg = '数字人服务任务超过自动轮询窗口，已转入人工核对', details?: unknown) =>
    new ApiError('VIDEO_POLL_TIMEOUT', msg, 409, details),
  videoSaveFailed: (msg = '视频已生成，但保存失败，请重试下载', details?: unknown) =>
    new ApiError('VIDEO_SAVE_FAILED', msg, 409, details),
  videoResultUrlBlocked: (msg = '结果视频地址未通过安全校验，已拒绝下载', details?: unknown) =>
    new ApiError('VIDEO_RESULT_URL_BLOCKED', msg, 502, details),
  videoStreamMissing: (msg = '成片缺少视频或音频流', details?: unknown) =>
    new ApiError('VIDEO_STREAM_MISSING', msg, 502, details),
  videoDimensionsInvalid: (msg = '成片规格不符（应为 1080×1920 竖屏）', details?: unknown) =>
    new ApiError('VIDEO_DIMENSIONS_INVALID', msg, 502, details),
  videoDurationInvalid: (msg = '成片时长校验未通过', details?: unknown) =>
    new ApiError('VIDEO_DURATION_INVALID', msg, 502, details),
  mediaEmpty: (msg = '媒体文件为空或不可读', details?: unknown) => new ApiError('MEDIA_EMPTY', msg, 400, details),
  materialPackEmpty: (msg = '素材包没有可用素材，请先导入', details?: unknown) =>
    new ApiError('MATERIAL_PACK_EMPTY', msg, 409, details),

  /* ── 发布管理专属错误码（任务书 §6.3）────────────────────────────── */
  platformLineForbidden: (msg = '该生产线不可发布到此平台', details?: unknown) =>
    new ApiError('PLATFORM_LINE_FORBIDDEN', msg, 409, details),
  accountNotFound: (msg = '平台账号不存在') => new ApiError('ACCOUNT_NOT_FOUND', msg, 404),
  accountInUse: (msg = '账号有进行中的发布或被人物绑定引用，无法删除', details?: unknown) =>
    new ApiError('ACCOUNT_IN_USE', msg, 409, details),
  accountNotActive: (msg = '账号未就绪（未登录 / 已过期 / 已停用），不能用于发布', details?: unknown) =>
    new ApiError('ACCOUNT_NOT_ACTIVE', msg, 409, details),
  publishRateLimited: (msg = '该账号今日发布数已达上限', details?: unknown) =>
    new ApiError('PUBLISH_RATE_LIMITED', msg, 409, details),
  publishContextBusy: (msg = '发布浏览器上下文创建失败，请稍后重试', details?: unknown) =>
    new ApiError('PUBLISH_CONTEXT_BUSY', msg, 503, details),
  publishPlanNotFound: (msg = '发布计划不存在') => new ApiError('PUBLISH_PLAN_NOT_FOUND', msg, 404),
  publishPlanNotCancellable: (msg = '当前状态的发布计划不可取消', details?: unknown) =>
    new ApiError('PUBLISH_PLAN_NOT_CANCELLABLE', msg, 409, details),
  publishLogNotFound: (msg = '发布记录不存在') => new ApiError('PUBLISH_LOG_NOT_FOUND', msg, 404),
  publishLogNotRetryable: (msg = '当前状态的发布记录不可执行此操作', details?: unknown) =>
    new ApiError('PUBLISH_LOG_NOT_RETRYABLE', msg, 409, details),
  publishNotConfirmed: (msg = '发布仍在确认中，请等待结果或使用重新检测', details?: unknown) =>
    new ApiError('PUBLISH_NOT_CONFIRMED', msg, 409, details),
  reviewRequired: (msg = '标题或封面有实质修改，需审核确认后才能发布', details?: unknown) =>
    new ApiError('REVIEW_REQUIRED', msg, 409, details),
  loginSessionExpired: (msg = '登录会话已过期，请重新发起扫码', details?: unknown) =>
    new ApiError('LOGIN_SESSION_EXPIRED', msg, 409, details),
  loginQrFailed: (msg = '获取登录二维码失败，请重试', details?: unknown) =>
    new ApiError('LOGIN_QR_FAILED', msg, 502, details),
  // ── 视频剪辑 ──
  cutRiskLocked: (msg = '风险提示段为合规话术，不可编辑', details?: unknown) =>
    new ApiError('CUT_RISK_LOCKED', msg, 400, details),
  cutTextTooLong: (msg = '单段字幕文本超长', details?: unknown) => new ApiError('CUT_TEXT_TOO_LONG', msg, 400, details),
  cutStyleInvalid: (msg = '字幕样式超出允许范围', details?: unknown) => new ApiError('CUT_STYLE_INVALID', msg, 400, details),
  cutRenderBusy: (msg = '该视频已有渲染中的成片版本，请等待完成后再试', details?: unknown) =>
    new ApiError('CUT_RENDER_BUSY', msg, 409, details),
  cutNotDraft: (msg = '配置草稿不存在或状态不允许该操作', details?: unknown) =>
    new ApiError('CUT_NOT_DRAFT', msg, 409, details),
  cutNotCompleted: (msg = '成片尚未渲染完成，不能提交复审', details?: unknown) =>
    new ApiError('CUT_NOT_COMPLETED', msg, 409, details),
  cutRiskTextEmpty: (msg = '该文案没有风险提示内容，无法生成风险尾页', details?: unknown) =>
    new ApiError('CUT_RISK_TEXT_EMPTY', msg, 400, details),
  cutEngineUnavailable: (msg = '渲染环境缺少字幕能力（ffmpeg 需带 libass/freetype），且未开启 MOCK_FALLBACK', details?: unknown) =>
    new ApiError('CUT_ENGINE_UNAVAILABLE', msg, 503, details),
  bgmNotFound: (msg = 'BGM 不存在或已下架', details?: unknown) => new ApiError('BGM_NOT_FOUND', msg, 404, details),
  bgmInUse: (msg = 'BGM 已被成片版本引用，不可删除', details?: unknown) => new ApiError('BGM_IN_USE', msg, 409, details),
  finalNotReady: (msg = '成片不满足发布条件', details?: unknown) => new ApiError('FINAL_NOT_READY', msg, 409, details),
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}
