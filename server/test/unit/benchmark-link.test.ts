import { describe, expect, it } from 'vitest'
import { extractSecUid, extractVideoId, isWhitelisted, normalizeShareInput } from '../../src/modules/benchmark/link.js'

/** 用户实际粘贴过的链接（2026-10-28）：裸域 + 无协议 + 携带来源查询参数 */
const USER_LINK =
  'douyin.com/user/MS4wLjABAAAAunpkE2IXyHAxm4A24G5d1Cf5141pnZy8HwNR5f2-6pI_GYBVR-Pv23uFyfMPB_9I?enter_from=general_search&from_tab_name=main'

describe('normalizeShareInput（分享输入归一化）', () => {
  it('裸域无协议主页链接补全为 https', () => {
    expect(normalizeShareInput(USER_LINK)).toMatch(/^https:\/\/douyin\.com\/user\/MS4wLjABAAAA/)
  })

  it('保留原查询参数', () => {
    expect(normalizeShareInput(USER_LINK)).toContain('enter_from=general_search')
  })

  it('www 开头的无协议链接补全协议', () => {
    expect(normalizeShareInput('www.douyin.com/user/MS4wLjABAAAAxyz')).toBe('https://www.douyin.com/user/MS4wLjABAAAAxyz')
  })

  it('手机分享文本：从整段话中提取短链', () => {
    const shareText =
      '7.92 p@f.XZ 12/23 【某某的抖音号】 复制打开抖音，看看【相关作品】 https://v.douyin.com/iRnAbCdEf/ 获取更多精彩内容，操作十分简单！马上看'
    expect(normalizeShareInput(shareText)).toBe('https://v.douyin.com/iRnAbCdEf/')
  })

  it('分享文本 URL 后紧跟中文标点时去除尾部标点', () => {
    const shareText = '复制此链接，打开抖音 https://v.douyin.com/abc123/，精彩内容不错过'
    expect(normalizeShareInput(shareText)).toBe('https://v.douyin.com/abc123/')
  })

  it('多个 URL 取第一个', () => {
    expect(normalizeShareInput('看 https://v.douyin.com/aaa/ 和 https://www.douyin.com/bbb')).toBe('https://v.douyin.com/aaa/')
  })

  it('已是合法 URL 时原样返回', () => {
    const u = 'https://www.douyin.com/user/MS4wLjABAAAAxyz?enter_from=x'
    expect(normalizeShareInput(u)).toBe(u)
  })

  it('首尾空白被去除', () => {
    expect(normalizeShareInput('  https://v.douyin.com/x/  ')).toBe('https://v.douyin.com/x/')
  })

  it('不含链接的文本原样返回（由后续流程报“链接格式不正确”）', () => {
    expect(normalizeShareInput('这不是链接')).toBe('这不是链接')
  })
})

describe('isWhitelisted（防 SSRF 白名单含官方裸域）', () => {
  it.each(['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'])('%s 允许', (h) => {
    expect(isWhitelisted(h)).toBe(true)
  })
  it.each(['evil.com', 'douyin.com.evil.com', 'evil-douyin.com', 'v.douyin.com.evil.io', ''])('%s 拒绝', (h) => {
    expect(isWhitelisted(h)).toBe(false)
  })
})

describe('extract 标识提取', () => {
  it('带来源查询参数的主页链接仍能提取 sec_uid', () => {
    expect(extractSecUid(USER_LINK)).toBe('MS4wLjABAAAAunpkE2IXyHAxm4A24G5d1Cf5141pnZy8HwNR5f2-6pI_GYBVR-Pv23uFyfMPB_9I')
  })
  it('iesdouyin 分享页格式', () => {
    expect(extractSecUid('https://www.iesdouyin.com/share/user/MS4wLjABAAAAxyz?mid=1')).toBe('MS4wLjABAAAAxyz')
  })
  it('modal_id 视频链接', () => {
    expect(extractVideoId('https://www.douyin.com/user/x?modal_id=7612345678901234567')).toBe('7612345678901234567')
  })
})
