import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  collectMetrics,
  confirmFeatures as confirmFeaturesApi,
  confirmSuggestion as confirmSuggestionApi,
  dismissSuggestion as dismissSuggestionApi,
  downloadCsvTemplate,
  getAnalyticsMeta,
  getFeatures,
  getOverview,
  getSuggestions,
  importMetricsCsv,
  raiseBenchmarkPriority as raisePriorityApi,
  refreshSuggestions as refreshSuggestionsApi,
  type AnalyticsMeta,
  type FeatureStats,
  type ImportResult,
  type MetricWindow,
  type OverviewResult,
  type PreferenceProfile,
  type Suggestion,
} from '@/api/analytics'
import type { PersonaLine, Platform } from '@/api/publish'

/**
 * 数据看板数据层（任务书 DB4）。
 *
 * 三 Tab 各自维护 loading / error / empty 三态：
 *  - empty 由接口返回的 `empty` 决定（无任何快照 → 引导空态，AC-M13）；
 *  - error 保留原始 message，供页面「重试」按钮复用同一 load 函数；
 *  - 导入 / 确认等写操作单独维护 `acting`，避免与列表 loading 互相顶掉按钮状态。
 */

export type BoardTab = 'effect' | 'feature' | 'topic'

/** 选项常量（与 server publish/types.ts、personas/types.ts、analytics/types.ts 对应） */
export const DAY_OPTIONS = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
]

export const LINE_OPTIONS: Array<{ value: PersonaLine; label: string }> = [
  { value: 'manager', label: '经理 IP' },
  { value: 'kos', label: '员工 KOS' },
  { value: 'persona', label: '素人矩阵' },
]

export const PLATFORM_OPTIONS: Array<{ value: Platform; label: string }> = [
  { value: 'douyin', label: '抖音' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'kuaishou', label: '快手' },
  { value: 'shipinhao', label: '视频号' },
]

export const useAnalyticsStore = defineStore('analytics', () => {
  const tab = ref<BoardTab>('effect')
  const meta = ref<AnalyticsMeta | null>(null)

  /* ── 效果看板 ── */
  const days = ref(7)
  const line = ref<PersonaLine | ''>('')
  const platform = ref<Platform | ''>('')
  const overview = ref<OverviewResult | null>(null)
  const overviewLoading = ref(false)
  const overviewError = ref<string | null>(null)

  /* ── 特征沉淀 ── */
  const featureWindow = ref<MetricWindow>('t1')
  const featureDays = ref(30)
  const features = ref<FeatureStats | null>(null)
  const featureLoading = ref(false)
  const featureError = ref<string | null>(null)
  const profile = ref<PreferenceProfile | null>(null)

  /* ── 选题反馈 ── */
  const suggestions = ref<Suggestion[]>([])
  const suggestionTotal = ref(0)
  const suggestionLoading = ref(false)
  const suggestionError = ref<string | null>(null)

  /** 写操作统一开关（导入 / 确认 / 忽略 / 采集 / 降档） */
  const acting = ref(false)

  const pendingCount = computed(() => suggestions.value.filter((s) => s.status === 'pending').length)
  const isEmpty = computed(() => !!(overview.value?.empty ?? false))
  const providerHint = computed(() => overview.value?.provider.hint ?? meta.value?.provider.hint ?? '')

  /** 输入框的日期区间（北京时间展示，跟随后端 range） */
  const rangeText = computed(() => {
    const r = overview.value?.range
    if (!r) return ''
    const fmt = (iso: string) => {
      const d = new Date(`${iso.replace(' ', 'T')}Z`)
      if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
      const cst = new Date(d.getTime() + 8 * 3600_000)
      return `${cst.getUTCFullYear()}.${String(cst.getUTCMonth() + 1).padStart(2, '0')}.${String(cst.getUTCDate()).padStart(2, '0')}`
    }
    return `${fmt(r.from)} – ${fmt(r.to)} · 北京时间`
  })

  async function loadMeta(): Promise<void> {
    try {
      meta.value = await getAnalyticsMeta()
    } catch {
      /* 元信息失败不阻断主流程：页面回落到接口自带提示 */
    }
  }

  async function loadOverview(): Promise<void> {
    overviewLoading.value = true
    overviewError.value = null
    try {
      overview.value = await getOverview({
        days: days.value,
        line: line.value || undefined,
        platform: platform.value || undefined,
        page: 1,
        pageSize: 50,
      })
    } catch (e) {
      overviewError.value = (e as Error).message
      overview.value = null
    } finally {
      overviewLoading.value = false
    }
  }

  async function loadFeatures(): Promise<void> {
    featureLoading.value = true
    featureError.value = null
    try {
      features.value = await getFeatures({ window: featureWindow.value, days: featureDays.value })
      profile.value = features.value.profile
    } catch (e) {
      featureError.value = (e as Error).message
      features.value = null
    } finally {
      featureLoading.value = false
    }
  }

  async function loadSuggestions(): Promise<void> {
    suggestionLoading.value = true
    suggestionError.value = null
    try {
      const res = await getSuggestions({ page: 1, pageSize: 50 })
      suggestions.value = res.items
      suggestionTotal.value = res.total
    } catch (e) {
      suggestionError.value = (e as Error).message
      suggestions.value = []
      suggestionTotal.value = 0
    } finally {
      suggestionLoading.value = false
    }
  }

  /** 进入页面 / 切 Tab：只加载当前 Tab 需要的数据（元信息一次性） */
  async function load(force = false): Promise<void> {
    if (!meta.value || force) await loadMeta()
    if (tab.value === 'effect') {
      if (force || !overview.value) await loadOverview()
      // 效果看板右侧「待确认的选题建议」卡需要建议数据，量小，随看板一起取
      if (force || !suggestions.value.length) await loadSuggestions()
    }
    if (tab.value === 'feature' && (force || !features.value)) await loadFeatures()
    if (tab.value === 'topic' && (force || !suggestions.value.length)) await loadSuggestions()
  }

  async function setTab(next: BoardTab): Promise<void> {
    tab.value = next
    await load()
  }

  /* ── 写操作 ── */

  /** 导入 CSV：成功后三个 Tab 一并刷新（快照变了，特征与建议都会动） */
  async function importCsv(input: { platform: Platform; window: MetricWindow; file: File }): Promise<ImportResult> {
    acting.value = true
    try {
      const result = await importMetricsCsv(input)
      await Promise.all([loadOverview(), loadFeatures(), loadSuggestions()])
      return result
    } finally {
      acting.value = false
    }
  }

  async function collect(window?: MetricWindow) {
    acting.value = true
    try {
      const outcome = await collectMetrics(window ? { window } : {})
      await loadOverview()
      return outcome
    } finally {
      acting.value = false
    }
  }

  async function confirmFeatures(): Promise<PreferenceProfile> {
    acting.value = true
    try {
      const r = await confirmFeaturesApi({ window: featureWindow.value, days: featureDays.value })
      profile.value = r.profile
      await loadFeatures()
      return r.profile
    } finally {
      acting.value = false
    }
  }

  async function confirmSuggestion(id: string): Promise<string> {
    acting.value = true
    try {
      const r = await confirmSuggestionApi(id)
      await loadSuggestions()
      return r.topicId
    } finally {
      acting.value = false
    }
  }

  async function dismissSuggestion(id: string, reason?: string): Promise<void> {
    acting.value = true
    try {
      await dismissSuggestionApi(id, reason)
      await loadSuggestions()
    } finally {
      acting.value = false
    }
  }

  async function refreshSuggestions(): Promise<number> {
    acting.value = true
    try {
      const r = await refreshSuggestionsApi({ window: featureWindow.value, days: featureDays.value })
      await loadSuggestions()
      return r.created
    } finally {
      acting.value = false
    }
  }

  /** FR-M9 对标降档：成功后刷新看板（间隔变了，入口要显示新值） */
  async function raiseBenchmarkPriority(accountId: string) {
    acting.value = true
    try {
      const r = await raisePriorityApi(accountId)
      await loadOverview()
      return r
    } finally {
      acting.value = false
    }
  }

  /** CSV 模板下载（四平台） */
  async function downloadTemplate(target: Platform): Promise<void> {
    const blob = await downloadCsvTemplate(target)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `analytics-${target}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return {
    tab,
    meta,
    days,
    line,
    platform,
    overview,
    overviewLoading,
    overviewError,
    featureWindow,
    featureDays,
    features,
    featureLoading,
    featureError,
    profile,
    suggestions,
    suggestionTotal,
    suggestionLoading,
    suggestionError,
    acting,
    pendingCount,
    isEmpty,
    providerHint,
    rangeText,
    load,
    setTab,
    loadOverview,
    loadFeatures,
    loadSuggestions,
    importCsv,
    collect,
    confirmFeatures,
    confirmSuggestion,
    dismissSuggestion,
    refreshSuggestions,
    raiseBenchmarkPriority,
    downloadTemplate,
  }
})
