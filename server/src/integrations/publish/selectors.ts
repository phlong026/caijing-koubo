/**
 * 发布引擎平台常量（PU2/PU3 · A13）：选择器与流程分离，平台改版只动本文件。
 *
 * 来源：AI-Studio electron/mapi/publish/main.ts 顶部常量 + 登录/checkLogin/publishTo* 内联选择器组，
 * lib/browser-path 的 STEALTH 常量。VERIFICATION 选择器仅覆盖**短信验证码类弹窗**，
 * 滑块 / 扫码类风控不在检测范围（落入 manual_pending 兜底，任务书 R1）。
 */

/** 平台标识（publish 模块 types.Platform 的子集：真实引擎支持的平台） */
export type PublishPlatform = 'douyin' | 'kuaishou' | 'shipinhao' | 'xiaohongshu'

/** stealth UA（平移 AI-Studio STEALTH_UA，按 OS 分流） */
export const STEALTH_UA =
  process.platform === 'darwin'
    ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 发布成功信号（文案选择器，平台分立） */
export const PUBLISH_SUCCESS_SELECTORS: Record<PublishPlatform, string[]> = {
  douyin: ['text="发布成功"', 'text="已发布"', 'text="作品发布成功"', 'text=/发布成功|已发布|发布完成/'],
  kuaishou: ['text="发布成功"', 'text="已发布"', 'text="作品发布成功"', 'text=/发布成功|已发布|发布完成/'],
  shipinhao: [
    'text="发表成功"',
    'text="发布成功"',
    'text="已发表"',
    'text="已发布"',
    'text=/发表成功|发布成功|已发表|已发布/',
  ],
  xiaohongshu: ['text="发布成功"', 'text="已发布"', 'text="笔记发布成功"', 'text=/发布成功|已发布|笔记发布成功/'],
}

/** 发布页 URL 标记（离开发布页 = 成功信号之一的 URL 判定） */
export const PUBLISH_PAGE_MARKERS: Record<PublishPlatform, string[]> = {
  douyin: ['/creator-micro/content/upload'],
  kuaishou: ['/article/publish/video'],
  shipinhao: ['/platform/post/create'],
  xiaohongshu: ['/publish/publish'],
}

/** 短信验证码弹窗：文案 / 输入框 / 动作按钮（三选二命中即判 verification） */
export const VERIFICATION_TEXT_SELECTORS = [
  'text=/短信验证码|接收短信验证码|请输入验证码|输入验证码|手机验证码|安全验证|验证手机号|获取验证码|发送验证码|验证码错误/',
]

export const VERIFICATION_INPUT_SELECTORS = [
  'input[placeholder*="验证码"]',
  'input[placeholder*="输入验证码"]',
  'input[maxlength="6"]',
  'input[maxlength="4"]',
]

export const VERIFICATION_ACTION_SELECTORS = [
  'button:has-text("获取验证码")',
  'button:has-text("发送验证码")',
  'button:has-text("验证")',
  'button:has-text("确认")',
]

/** 各平台入口 / 检测 / 上传 URL（平移 login 与 actuallyCheckLoginStatus 的 URL 分支） */
export const PLATFORM_URLS: Record<PublishPlatform, { home: string; checkUrl: string; uploadUrl: string }> = {
  douyin: {
    home: 'https://creator.douyin.com/',
    checkUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    uploadUrl: 'https://creator.douyin.com/creator-micro/content/upload',
  },
  kuaishou: {
    home: 'https://cp.kuaishou.com/',
    checkUrl: 'https://cp.kuaishou.com/article/publish',
    uploadUrl: 'https://cp.kuaishou.com/article/publish/video',
  },
  shipinhao: {
    home: 'https://channels.weixin.qq.com/',
    checkUrl: 'https://channels.weixin.qq.com/platform/post/create',
    uploadUrl: 'https://channels.weixin.qq.com/platform/post/create',
  },
  xiaohongshu: {
    home: 'https://creator.xiaohongshu.com/',
    checkUrl: 'https://creator.xiaohongshu.com/publish/publish?from=menu&target=video',
    uploadUrl: 'https://creator.xiaohongshu.com/publish/publish?from=menu&target=video',
  },
}

/** 登录态判定组：命中任一选择器且 URL 不含 urlExclude 关键词 = 已登录 */
export const LOGIN_DETECT: Record<PublishPlatform, { selectors: string[]; urlExclude: string[] }> = {
  douyin: {
    selectors: ['#header-avatar', '.creator-avatar', 'input[type="file"]'],
    urlExclude: ['login', 'passport'],
  },
  kuaishou: {
    selectors: ['[class*="avatar"]', '.user-avatar', '.user-name', '[class*="upload"]'],
    urlExclude: ['login', 'passport'],
  },
  shipinhao: {
    selectors: ['[class*="avatar"]', '.avatar', '.user-info'],
    urlExclude: ['login', 'auth', 'qr', 'mp.weixin.qq.com'],
  },
  xiaohongshu: {
    selectors: ['[class*="avatar"]', '.user-avatar', '.user-name', '[class*="upload"]'],
    urlExclude: ['login', 'passport', 'account'],
  },
}

/** 昵称提取选择器（登录成功后回填 displayName 用） */
export const NICKNAME_SELECTORS: Record<PublishPlatform, string[]> = {
  douyin: [
    '#header-avatar',
    '.creator-avatar',
    '.nickname',
    '.user-name',
    '.userName',
    '[class*="nickname"]',
    '[class*="userName"]',
  ],
  kuaishou: ['.user-name', '.userName', '.nickname', '[class*="nickname"]', '[class*="userName"]'],
  shipinhao: ['.nickname', '.user-name', '[class*="nickname"]', '[class*="userName"]'],
  xiaohongshu: ['.user-name', '.userName', '.nickname', '[class*="nickname"]', '[class*="userName"]'],
}

/** 二维码提取：img src（data/base64）优先，canvas 截图兜底（A14 平移） */
export const QR_SELECTORS: Record<PublishPlatform, { img: string[]; canvas: string[] }> = {
  douyin: { img: ['.qrcode-img'], canvas: ['canvas[class*="qrcode"]'] },
  kuaishou: { img: ['.qrcode-box img'], canvas: [] },
  shipinhao: { img: ['.qrcode img'], canvas: [] },
  xiaohongshu: { img: ['.qrcode-img', '.qrcode img'], canvas: ['canvas'] },
}

/** checkLogin 的 URL 判定关键词（平台分立，平移 actuallyCheckLoginStatus 的 URL 分支） */
export const LOGIN_URL_CHECK: Record<PublishPlatform, { notLoggedInKeywords: string[]; loggedInHost: string }> = {
  douyin: { notLoggedInKeywords: ['login', 'passport', 'sso', 'verify'], loggedInHost: 'creator.douyin.com' },
  kuaishou: { notLoggedInKeywords: ['login'], loggedInHost: 'cp.kuaishou.com' },
  shipinhao: { notLoggedInKeywords: ['login', 'auth'], loggedInHost: 'channels.weixin.qq.com' },
  xiaohongshu: { notLoggedInKeywords: ['login', 'passport'], loggedInHost: 'creator.xiaohongshu.com' },
}

/** 发布成功的视频 ID 提取（A11：extractVideoIdFromUrl） */
export function extractVideoIdFromUrl(url: string): string {
  try {
    const u = new URL(url)
    // 抖音：/video/<id>；快手：/short-video/<id>；视频号：encodedParams 里 object_id；小红书：/explore/<id>
    const douyin = url.match(/\/video\/(\d+)/)
    if (douyin) return douyin[1]
    const kuaishou = url.match(/\/short-video\/([\w-]+)/)
    if (kuaishou) return kuaishou[1]
    const xhs = url.match(/\/explore\/([\w]+)/)
    if (xhs) return xhs[1]
    // 视频号 object_id 形如 export/<id>，取尾段
    const objectId = (u.searchParams.get('object_id') ?? url.match(/object_id=([\w%]+)/)?.[1] ?? '')
      .split('/')
      .pop()
    if (objectId) return decodeURIComponent(objectId)
    return ''
  } catch {
    return ''
  }
}
