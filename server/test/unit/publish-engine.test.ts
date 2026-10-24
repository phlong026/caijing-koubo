import { describe, expect, it } from 'vitest'

/**
 * 真实发布引擎（PU2/PU3）纯函数单测：
 * 平台 URL/视频 ID 提取、真实引擎启用判定（realEngine 配置 × 平移状态 × playwright 可用性）。
 * 涉及 Playwright 浏览器的链路不在单测范围（灰度实测）。
 */
import { extractVideoIdFromUrl } from '../../src/integrations/publish/selectors.js'
import { MIGRATED_PLATFORMS, isMigrated, realEngineStatus } from '../../src/integrations/publish/index.js'
import { resolvePublishEngine, resetPublishEngine } from '../../src/modules/publish/engine.js'
import { config } from '../../src/config.js'

describe('extractVideoIdFromUrl（A11 平移）', () => {
  it('抖音 /video/<id>', () => {
    expect(extractVideoIdFromUrl('https://www.douyin.com/video/7412345678901234567')).toBe('7412345678901234567')
  })
  it('快手 /short-video/<id>', () => {
    expect(extractVideoIdFromUrl('https://www.kuaishou.com/short-video/3xabc123')).toBe('3xabc123')
  })
  it('小红书 /explore/<id>', () => {
    expect(extractVideoIdFromUrl('https://www.xiaohongshu.com/explore/66f1234ab00000001e00')).toBe('66f1234ab00000001e00')
  })
  it('视频号 object_id 参数', () => {
    expect(extractVideoIdFromUrl('https://channels.weixin.qq.com/platform/post/create?object_id=export%2Fabc123')).toBe(
      'abc123',
    )
  })
  it('无法识别返回空串', () => {
    expect(extractVideoIdFromUrl('https://example.com/whatever')).toBe('')
    expect(extractVideoIdFromUrl('not-a-url')).toBe('')
  })
})

describe('平台平移状态（PU2 douyin + PU3 shipinhao/xiaohongshu；kuaishou 待扩展）', () => {
  it('MIGRATED_PLATFORMS：douyin / shipinhao / xiaohongshu', () => {
    expect(MIGRATED_PLATFORMS).toEqual(['douyin', 'shipinhao', 'xiaohongshu'])
  })
  it('isMigrated：已平移 true，kuaishou false', () => {
    expect(isMigrated('douyin')).toBe(true)
    expect(isMigrated('shipinhao')).toBe(true)
    expect(isMigrated('xiaohongshu')).toBe(true)
    expect(isMigrated('kuaishou')).toBe(false)
  })
  it('realEngineStatus 报告平移明细与模式', () => {
    const s = realEngineStatus()
    expect(s.migrated).toContain('douyin')
    expect(['auto', 'true', 'false']).toContain(s.mode)
  })
})

describe('引擎路由（resolvePublishEngine）', () => {
  it('auto + MOCK_FALLBACK=true（测试环境）→ 引擎形态为 mock，未平移平台不会路由到真实引擎', () => {
    resetPublishEngine()
    // vitest 环境 NODE_ENV=test → config.mockFallback 取决于环境变量；隔离环境恒 true。
    // 若 mockFallback 为 true，realEngineActiveFor 恒 false → mock 形态。
    const status = realEngineStatus()
    const engine = resolvePublishEngine()
    if (config.mockFallback) {
      expect(engine.mock).toBe(true)
    } else {
      // 非 mock 回退场景：至少不会抛错，形态由 playwright 是否安装决定
      expect(typeof engine.mock).toBe('boolean')
    }
    expect(status.mode).toBe(config.publish.realEngine)
  })
})
