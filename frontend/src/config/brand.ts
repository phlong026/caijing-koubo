import { reactive } from 'vue'

/**
 * 品牌白标配置（Brand White-label Config）
 *
 * 换品牌只改这里（或后续从服务端 /api/config 下发覆盖 setBrand()）：
 * - appName    品牌名称（侧边栏、浏览器标题）
 * - appTagline 品牌说明（侧边栏副标）
 * - logoText   Logo 字标（取品牌名关键字；留空则回退为通用图形）
 * - logoGradient Logo 渐变色 [起, 止]（同时用于字标块、头像、导航指示等品牌位）
 * - themePrimary 主题色（预留：与 style.css 的 Arco 变量联动，暂不生效）
 */
export interface BrandConfig {
  appName: string
  appTagline: string
  logoText: string
  logoGradient: [string, string]
  themePrimary: string
}

/** 白标预设：切换品牌时整体替换 */
export const brandPresets: Record<string, BrandConfig> = {
  /** 默认：矩阵工场 */
  default: {
    appName: '矩阵工场',
    appTagline: '内容生产与运营',
    logoText: '矩',
    logoGradient: ['#2e63e7', '#16339e'],
    themePrimary: '#344f61',
  },
  /** 示例：基金客户白标（演示用） */
  fund: {
    appName: '财富内容中台',
    appTagline: '基金 KOS 内容生产与运营',
    logoText: '财',
    logoGradient: ['#c2551d', '#7c2d12'],
    themePrimary: '#c2551d',
  },
}

/** 当前生效的品牌（运行时可被 setBrand 覆盖，例如登录后从服务端拉取租户品牌） */
export const brand = reactive<BrandConfig>({ ...brandPresets.default })

/* ---------- 主题色工具 ---------- */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}
/** 颜色混合：t 为混入 b 的比例（0-1），返回 "r,g,b" 三元组 */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const f = (x: number, y: number) => Math.round(x + (y - x) * t)
  return `${f(r1, r2)},${f(g1, g2)},${f(b1, b2)}`
}

/**
 * 将品牌主题色注入整站：
 * - 设置 --mw-primary* 设计令牌（按钮渐变、链接、选中态、焦点环等）
 * - 重写 Arco 的 --arcoblue-1..10 色阶（页签、开关、单选等组件主色）
 */
export function applyBrandTheme() {
  const p = brand.themePrimary
  const W = '#ffffff'
  const B = '#000000'
  const s = document.body.style
  s.setProperty('--mw-primary', p)
  s.setProperty('--mw-primary-light', `rgb(${mix(p, W, 0.08)})`)
  s.setProperty('--mw-primary-deep', `rgb(${mix(p, B, 0.1)})`)
  s.setProperty('--mw-primary-bg', `rgb(${mix(p, W, 0.93)})`)
  s.setProperty('--mw-primary-mid', `rgb(${mix(p, W, 0.52)})`)
  s.setProperty('--mw-primary-soft', `rgb(${mix(p, W, 0.68)})`)
  s.setProperty('--mw-primary-faint', `rgb(${mix(p, W, 0.945)})`)
  s.setProperty('--mw-primary-ring', `rgba(${mix(p, W, 0)}, 0.14)`)
  s.setProperty('--mw-primary-shadow', `rgba(${mix(p, B, 0)}, 0.3)`)
  const scale: [number, string, number][] = [
    [1, W, 0.94], [2, W, 0.87], [3, W, 0.72], [4, W, 0.54], [5, W, 0.32],
    [6, p, 0], [7, B, 0.08], [8, B, 0.18], [9, B, 0.3], [10, B, 0.45],
  ]
  for (const [i, base, t] of scale) {
    s.setProperty(`--arcoblue-${i}`, i === 6 ? mix(p, B, 0) : mix(p, base, t))
  }
}

/** 应用品牌：主题色 + favicon 一起刷新 */
export function applyBrand() {
  applyBrandTheme()
  applyBrandFavicon()
}

export function setBrand(presetOrConfig: string | Partial<BrandConfig>) {
  const next =
    typeof presetOrConfig === 'string'
      ? brandPresets[presetOrConfig]
      : { ...brandPresets.default, ...presetOrConfig }
  if (!next) return
  Object.assign(brand, next)
  applyBrand()
}

/** 按品牌配置动态生成 favicon（渐变圆角块 + 字标） */
export function applyBrandFavicon() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, brand.logoGradient[0])
  grad.addColorStop(1, brand.logoGradient[1])
  const r = 14
  ctx.beginPath()
  ctx.roundRect(0, 0, size, size, r)
  ctx.fillStyle = grad
  ctx.fill()
  if (brand.logoText) {
    ctx.fillStyle = '#fff'
    ctx.font = `700 ${size * 0.52}px "PingFang SC", "Microsoft YaHei", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(brand.logoText, size / 2, size / 2 + size * 0.03)
  }
  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.href = canvas.toDataURL('image/png')
}
