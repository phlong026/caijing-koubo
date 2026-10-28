import { config } from '../../config.js'
import { err } from '../../errors.js'
import type { MetricWindow, MetricValues } from './types.js'

/**
 * 回采 Provider 抽象（FR-M4 / DB1）。
 *
 * 一期只实现 CSV（人工导入，不走本接口的自动路径），创作者中心（Playwright）做占位：
 * 未启用时 `collect` 抛 PROVIDER_UNAVAILABLE，由调度层记为 pending 明细而不是失败——
 * 这样「到期未回采」是可观测的状态，运营补 CSV 后即消失，符合三级降级（A6）的第一级现状。
 */

export type ProviderName = 'csv' | 'creator'

export interface DueItem {
  publishLogId: string
  platform: string
  accountId: string
}

export interface CollectedMetric {
  publishLogId: string
  platform: string
  accountId: string
  values: MetricValues
}

export interface MetricProvider {
  name: ProviderName
  /** 能否用于自动采集（CSV 为人工导入，不参与调度） */
  available(): boolean
  collect(window: MetricWindow, items: DueItem[]): Promise<CollectedMetric[]>
}

const csvProvider: MetricProvider = {
  name: 'csv',
  available: () => false,
  async collect() {
    throw err.providerUnavailable(
      '当前回采方式为 CSV 手动导入，无法自动采集；请在看板「导入回采数据」上传各平台导出文件',
      { provider: 'csv' },
    )
  },
}

const creatorProvider: MetricProvider = {
  name: 'creator',
  available: () => false,
  async collect() {
    throw err.providerUnavailable(
      '创作者中心自动回采随发布 PU9 同环境启用（Playwright 登录态回采），一期未实现',
      { provider: 'creator' },
    )
  },
}

export function getProvider(): MetricProvider {
  return config.analytics.provider === 'creator' ? creatorProvider : csvProvider
}

export function providerStatus(): { name: string; available: boolean; hint: string } {
  const p = getProvider()
  return {
    name: p.name,
    available: p.available(),
    hint: '平台回采能力待验证 · 当前为 CSV 导入',
  }
}
