/**
 * 飞影接入层统一出口。
 *  - client.ts：真实 V2 客户端（R1~R4）；
 *  - mock.ts：无密钥时的 mock 客户端（AC-H4）；
 *  - resolveHiflyClient()：按配置解析当前客户端（M3 与本模块共用）。
 */
export * from './client.js'
export * from './mock.js'
import { config } from '../../config.js'
import { err } from '../../errors.js'
import { createHttpHiflyClient, type HiflyClient } from './client.js'
import { getMockHiflyClient } from './mock.js'

export function resolveHiflyClient(): HiflyClient {
  if (config.hifly.apiKey) return createHttpHiflyClient()
  if (config.mockFallback) return getMockHiflyClient()
  throw err.hiflyNotConfigured('飞影未配置（HIFLY_API_KEY 缺失）且 MOCK_FALLBACK 未开启')
}
