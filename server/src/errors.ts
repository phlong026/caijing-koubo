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
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}
