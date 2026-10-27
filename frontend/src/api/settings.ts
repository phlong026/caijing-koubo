/** 系统设置（用户中心 → 系统设置）：环境变量的界面化管理 */
import { apiGet, apiPut } from './client'

export type SettingType = 'string' | 'number' | 'boolean' | 'password'

export interface SettingItem {
  key: string
  group: string
  label: string
  desc?: string
  type: SettingType
  /** password 为脱敏回显（••••） */
  value: string
  hasValue: boolean
  /** 界面保存过、覆盖 .env 的项 */
  isSet: boolean
  restart?: boolean
  readonly?: boolean
}

export interface SettingGroup {
  key: string
  title: string
  desc?: string
  danger?: boolean
}

export interface SettingsDoc {
  groups: SettingGroup[]
  items: SettingItem[]
}

export function getSettings(): Promise<SettingsDoc> {
  return apiGet<SettingsDoc>('/settings')
}

export function saveSettings(
  settings: Array<{ key: string; value: string }>,
): Promise<{ applied: string[]; skipped: string[] }> {
  return apiPut('/settings', { settings })
}
