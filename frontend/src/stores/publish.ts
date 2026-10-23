import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '@/api/publish'
import type { MatrixCell, Platform, PersonaLine, PublishOptions, PublishPlan, PublishLogView } from '@/api/publish'

/**
 * 发布管理 store（任务书 §7）：账号 / 矩阵 / 计划 / 记录四域。
 * 列表类数据不缓存过期值：load* 都直接覆盖（发布状态变化快，靠 sweep 周期与手动刷新）。
 */
export const usePublishStore = defineStore('publish', () => {
  const options = ref<PublishOptions | null>(null)
  const matrix = ref<Record<PersonaLine, Record<Platform, MatrixCell>> | null>(null)
  const accounts = ref<api.PlatformAccount[]>([])
  const accountsTotal = ref(0)
  const plans = ref<Array<PublishPlan & { logs: PublishLogView[] }>>([])
  const plansTotal = ref(0)
  const logs = ref<PublishLogView[]>([])
  const logsTotal = ref(0)
  const loading = ref(false)
  const error = ref('')

  async function loadOptions(): Promise<void> {
    options.value = await api.getPublishOptions()
  }

  async function loadMatrix(): Promise<void> {
    const r = await api.getPlatformMatrix()
    matrix.value = r.matrix
  }

  async function loadAccounts(query?: Record<string, unknown>): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const r = await api.listAccounts(query as Record<string, never>)
      accounts.value = r.items
      accountsTotal.value = r.total
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  async function loadPlans(query?: Record<string, unknown>): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const r = await api.listPlans(query as Record<string, never>)
      plans.value = r.items
      plansTotal.value = r.total
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  async function loadLogs(query?: Record<string, unknown>): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const r = await api.listLogs(query as Record<string, never>)
      logs.value = r.items
      logsTotal.value = r.total
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  return {
    options,
    matrix,
    accounts,
    accountsTotal,
    plans,
    plansTotal,
    logs,
    logsTotal,
    loading,
    error,
    loadOptions,
    loadMatrix,
    loadAccounts,
    loadPlans,
    loadLogs,
  }
})
