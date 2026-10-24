import crypto from 'node:crypto'
import { config } from '../../config.js'
import type { PlatformAccount } from './types.js'
import { createRealEngine, realEngineActiveFor, realEngineStatus } from '../../integrations/publish/index.js'

/**
 * PublishEngine（PB6）：发布引擎适配层，接口与视频创作 AvatarVideoEngine 同构。
 *  - mock = MOCK_FALLBACK 兜底（无浏览器环境 / 冒烟测试全链路）；
 *  - 真实引擎（PU2/PU3 平移 AI-Studio Playwright 流程）按平台拆分到 integrations/publish/。
 *
 * 故障注入（照搬 integrations/hifly/mock.ts 模式）：injectPublish(op, {behavior, times})，
 * op ∈ publish.login | publish.check | publish.execute，behavior 一次性消费，供 smoke 断言三态。
 */

/* ── 注入设施 ── */

export type MockPublishBehavior =
  | 'success' // 正常发布成功
  | 'verification' // 发布后出现验证码 → verification_required
  | 'manual_pending' // 点了发布但无成功信号 → manual_pending
  | 'failed' // 明确失败（上传被拒等）
  | 'error' // 引擎异常（上下文创建失败等）
  | 'login_failed' // 登录失败
  | 'login_expired' // checkLogin 检测到登录态失效

export interface MockPublishInjection {
  behavior: MockPublishBehavior
  /** 生效次数（默认 1，一次性；Infinity 为常驻） */
  times?: number
  /** failed 时的错误码（默认 PUBLISH_VENDOR_REJECTED 语义的通用码） */
  errorCode?: string
}

const injections = new Map<string, Array<MockPublishInjection & { remaining: number }>>()

export function injectPublish(op: string, injection: MockPublishInjection): void {
  const list = injections.get(op) ?? []
  list.push({ ...injection, times: injection.times ?? 1, remaining: injection.times ?? 1 })
  injections.set(op, list)
}

export function clearPublishInjections(): void {
  injections.clear()
}

function takeInjection(op: string): MockPublishInjection | null {
  const list = injections.get(op)
  if (!list?.length) return null
  const inj = list[0]
  inj.remaining -= 1
  if (inj.remaining <= 0) list.shift()
  if (!list.length) injections.delete(op)
  return inj
}

/* ── 引擎接口 ── */

export interface EngineLoginStart {
  /** 二维码图像（PNG buffer）；mock 为 1×1 占位图，真实引擎为页面截图，由调用方上传 OSS */
  qrPng: Buffer | null
  error?: string
}

export interface EngineLoginPoll {
  status: 'waiting' | 'scanned' | 'confirmed' | 'failed'
  nickname?: string
  uid?: string
  error?: string
}

export interface EngineCheckResult {
  loggedIn: boolean
  nickname?: string
  uid?: string
}

export interface EnginePublishInput {
  /** 本地视频文件绝对路径（执行 worker 已就绪） */
  videoPath: string
  coverPath: string | null
  title: string
  description: string
  tags: string[]
  /** AI 内容自标识（PB7：新增开发，平台支持才勾选） */
  aigcFlag: boolean
  /** 确认窗口（毫秒，FR-E1：平移 AI-Studio 15 分钟语义） */
  confirmTimeoutMs: number
  /** 调用归属（可观测） */
  refId?: string
  /**
   * 阶段回调：uploading=开始上传；confirming=已点发布进入确认轮询。
   * worker 在回调里 CAS 落库（uploading→confirming），mock 引擎同步回调。
   */
  onPhase?: (phase: 'uploading' | 'confirming') => void
}

export type EnginePublishStatus = 'published' | 'verification_required' | 'manual_pending' | 'failed'

export interface EnginePublishResult {
  status: EnginePublishStatus
  videoUrl?: string
  externalVideoId?: string
  /** 中文可读原因（failed / manual_pending 必有） */
  message?: string
  errorCode?: string
}

export interface PublishEngine {
  readonly mock: boolean
  /** 发起扫码登录（FR-L1）：打开登录页并截取二维码 */
  startLogin(account: PlatformAccount): Promise<EngineLoginStart>
  /** 轮询登录态（sweep 驱动）：waiting=未扫码、scanned=已扫码待确认、confirmed=登录成功 */
  pollLogin(account: PlatformAccount): Promise<EngineLoginPoll>
  /** 主动检测登录态（FR-L3：导航到发布页判断） */
  checkLogin(account: PlatformAccount): Promise<EngineCheckResult>
  /** 执行发布（FR-E1）：上传 → 填表 → 点发布 → 确认轮询，一次调用返回终态或三态 */
  publish(account: PlatformAccount, input: EnginePublishInput): Promise<EnginePublishResult>
}

/* ── mock 引擎 ── */

/** 确定性 uid：同账号恒定，便于幂等与回填断言 */
function detUid(account: PlatformAccount): string {
  const hash = crypto.createHash('sha256').update(`${account.platform}|${account.id}`).digest('hex')
  return `mock_${account.platform}_${hash.slice(0, 12)}`
}

/** 1×1 透明 PNG 占位二维码（mock） */
const PLACEHOLDER_QR = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** 默认第 N 次轮询确认登录（冒烟可等待但不至于太慢） */
const MOCK_LOGIN_POLLS_TO_CONFIRM = Number(process.env.PUBLISH_MOCK_LOGIN_POLLS_TO_CONFIRM ?? 2)
const pollCounts = new Map<string, number>()

export function createMockPublishEngine(): PublishEngine {
  return {
    mock: true,
    async startLogin(_account) {
      const inj = takeInjection('publish.login')
      if (inj?.behavior === 'login_failed') return { qrPng: null, error: 'mock 注入：获取二维码失败' }
      return { qrPng: PLACEHOLDER_QR }
    },
    async pollLogin(account) {
      const inj = takeInjection('publish.login')
      if (inj?.behavior === 'login_failed') return { status: 'failed', error: 'mock 注入：登录失败' }
      const key = `${account.platform}:${account.id}`
      const n = (pollCounts.get(key) ?? 0) + 1
      pollCounts.set(key, n)
      if (n < MOCK_LOGIN_POLLS_TO_CONFIRM) return { status: 'waiting' }
      pollCounts.delete(key)
      return {
        status: 'confirmed',
        nickname: account.displayName || `模拟账号_${account.id.slice(-4)}`,
        uid: detUid(account),
      }
    },
    async checkLogin(account) {
      const inj = takeInjection('publish.check')
      if (inj?.behavior === 'login_expired') return { loggedIn: false }
      return { loggedIn: true, nickname: account.displayName || `模拟账号_${account.id.slice(-4)}`, uid: account.uid ?? detUid(account) }
    },
    async publish(account, input) {
      void account
      input.onPhase?.('uploading')
      const inj = takeInjection('publish.execute') ?? { behavior: 'success' as const }
      switch (inj.behavior) {
        case 'success':
          input.onPhase?.('confirming')
          return {
            status: 'published',
            videoUrl: `https://www.mock-publish.example/video/${crypto.randomBytes(8).toString('hex')}`,
            externalVideoId: `mock_${crypto.randomBytes(6).toString('hex')}`,
          }
        case 'verification':
          input.onPhase?.('confirming')
          return { status: 'verification_required', message: 'mock 注入：发布后出现短信验证码，等待人工完成验证' }
        case 'manual_pending':
          input.onPhase?.('confirming')
          return { status: 'manual_pending', message: 'mock 注入：已点击发布但未检测到成功信号，请人工确认' }
        case 'failed':
          input.onPhase?.('confirming')
          return { status: 'failed', message: 'mock 注入：发布失败', errorCode: inj.errorCode ?? 'PUBLISH_MOCK_FAILED' }
        case 'error':
          throw new Error(inj.errorCode ?? 'mock 注入：引擎异常')
        default:
          return { status: 'published', videoUrl: `mock://publish/${input.refId ?? 'na'}` }
      }
    },
  }
}

/* ── 引擎解析 ── */

let cached: PublishEngine | null = null

/**
 * 解析发布引擎（PU2/PU3 接线）：路由引擎按 account.platform 分流——
 * 已平移平台（douyin）且真实引擎生效（realEngineActiveFor）→ Playwright 真实链路；
 * 未平移平台 / mock 模式 → mock 引擎（dev 联调与冒烟不受影响）。
 * MOCK_FALLBACK=false 时未平移平台在真实模式下由 integrations 层明确抛
 * PUBLISH_PLATFORM_NOT_MIGRATED，不会静默假成功。
 *
 * integrations/publish 顶层对 playwright 是懒加载（browser.ts 动态 import），
 * 此处静态 import 不引入浏览器依赖。
 */
export function resolvePublishEngine(): PublishEngine {
  if (cached) return cached
  cached = createRoutingPublishEngine()
  return cached
}

function createRoutingPublishEngine(): PublishEngine {
  const mock = createMockPublishEngine()
  const real = createRealEngine()
  const pick = (platform: string): PublishEngine => (realEngineActiveFor(platform) ? real : mock)
  return {
    // mock 标记实时判定：任一已平移平台真实生效即为「非 mock」（health / 发布页提示条用）
    get mock() {
      return !realEngineActiveFor('douyin')
    },
    startLogin: (account) => pick(account.platform).startLogin(account),
    pollLogin: (account) => pick(account.platform).pollLogin(account),
    checkLogin: (account) => pick(account.platform).checkLogin(account),
    publish: (account, input) => pick(account.platform).publish(account, input),
  }
}

/** 测试钩子：重置引擎缓存（注入引擎替换后生效） */
export function resetPublishEngine(): void {
  cached = null
}

export function publishEngineStatus(): {
  mock: boolean
  headless: boolean
  maxContexts: number
  realEngine: { migrated: string[]; playwright: boolean; mode: string }
} {
  const e = resolvePublishEngine()
  return {
    mock: e.mock,
    headless: config.publish.headless,
    maxContexts: config.publish.maxContexts,
    realEngine: realEngineStatus(),
  }
}
