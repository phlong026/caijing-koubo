import { describe, expect, it } from 'vitest'
import { isJsonModeUnsupported } from '../../src/integrations/copy-llm/index.js'

const err = (status: number | undefined, message: string) => Object.assign(new Error(message), { status })

describe('isJsonModeUnsupported（json_object 降级判定）', () => {
  it('400 类 json_object / response_format 报错触发降级', () => {
    expect(isJsonModeUnsupported(err(400, 'response_format is not supported on this route'))).toBe(true)
    expect(isJsonModeUnsupported(err(400, 'json_object mode is not available'))).toBe(true)
  })

  it('503 + no usable channel（new-api 中转参数路由失败）触发降级', () => {
    // CCG AI 实测：请求带 response_format=json_object 时中转不报 400 而报
    // 503 "no usable channel ... code=get_channel_failed"，参数去掉后即恢复。
    expect(isJsonModeUnsupported(err(503, 'no usable channel is available for this request'))).toBe(true)
  })

  it('普通 503 上游过载不触发降级', () => {
    expect(isJsonModeUnsupported(err(503, 'upstream overloaded, retry later'))).toBe(false)
  })

  it('与参数无关的错误不触发降级', () => {
    expect(isJsonModeUnsupported(err(401, 'invalid api key'))).toBe(false)
    expect(isJsonModeUnsupported(err(429, 'rate limited'))).toBe(false)
    expect(isJsonModeUnsupported(new Error(''))).toBe(false)
  })
})
