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
  forbidden: (msg = '无权限') => new ApiError('forbidden', msg, 403),
  conflict: (msg: string, details?: unknown) => new ApiError('conflict', msg, 409, details),
  invalidState: (msg: string, details?: unknown) => new ApiError('invalid_state', msg, 409, details),
  domainNotAllowed: (msg = '链接域名不在白名单内', details?: unknown) =>
    new ApiError('domain_not_allowed', msg, 400, details),
  tooLong: (msg: string, details?: unknown) => new ApiError('too_long', msg, 413, details),
  upstream: (msg: string, details?: unknown) => new ApiError('upstream_error', msg, 502, details),
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
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}
