import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { cutApi, type CutConfig, type CutVersionView, type VideoCut } from '@/api/cut'

/**
 * 视频剪辑 store（任务书 §7 工程）。
 * 渲染中版本每 3 秒轮询，进度本地峰值防回退（沿 stores/video.ts 模式）。
 */
export const useCutStore = defineStore('cut', () => {
  const config = ref<CutConfig | null>(null)
  const loading = ref(false)
  const activeCut = ref<CutVersionView | null>(null)
  const progressPeak = ref<Record<string, number>>({})
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const draft = computed(() => config.value?.draft ?? null)
  const base = computed(() => config.value?.base ?? null)
  const versions = computed(() => config.value?.versions ?? [])
  const engine = computed(() => config.value?.engine ?? 'mock')
  const isMockEngine = computed(() => engine.value === 'mock')

  /** 终态版本的复审徽标语义（§7：过审后草稿变更 → 待复审横幅） */
  const approvedDrifted = computed(() => {
    const v = versions.value.find((x) => x.approvedContentHash)
    return !!v && v.reviewStatus === 'none' && !!v.approvedContentHash && v.contentHash !== v.approvedContentHash
  })

  async function loadConfig(videoJobId: string, force = false): Promise<void> {
    if (loading.value) return
    loading.value = true
    try {
      config.value = await cutApi.getConfig(videoJobId)
      const active = versions.value.find((v) => ['queued', 'rendering', 'cancelling'].includes(v.status))
      if (active) await trackCut(active.id, force)
      else if (!force) activeCut.value = null
    } finally {
      loading.value = false
    }
  }

  function applyPeak(cut: VideoCut): VideoCut {
    const peak = progressPeak.value[cut.id] ?? 0
    if (cut.progress < peak) cut.progress = peak
    else progressPeak.value[cut.id] = cut.progress
    return cut
  }

  async function trackCut(cutId: string, silent = false): Promise<void> {
    const view = await cutApi.getCut(cutId)
    view.cut = applyPeak(view.cut)
    activeCut.value = view
    if (!silent) syncVersionInView(view.cut)
    startPolling(cutId)
  }

  function startPolling(cutId: string): void {
    stopPolling()
    pollTimer = setInterval(async () => {
      try {
        const view = await cutApi.getCut(cutId)
        view.cut = applyPeak(view.cut)
        activeCut.value = view
        syncVersionInView(view.cut)
        if (['completed', 'failed', 'cancelled'].includes(view.cut.status)) {
          stopPolling()
          await refreshVersions()
        }
      } catch {
        // 轮询失败静默，下一周期重试
      }
    }, 3000)
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /** 轮询结果同步回版本列表（切版本下拉的状态徽标实时更新） */
  function syncVersionInView(cut: VideoCut): void {
    const cfg = config.value
    if (!cfg) return
    const idx = cfg.versions.findIndex((v) => v.id === cut.id)
    if (idx >= 0) cfg.versions[idx] = cut
  }

  async function refreshVersions(): Promise<void> {
    if (!config.value) return
    const r = await cutApi.listVersions(config.value.base.videoJobId)
    config.value.versions = r.versions
  }

  function reset(): void {
    stopPolling()
    config.value = null
    activeCut.value = null
    progressPeak.value = {}
  }

  return {
    config,
    loading,
    draft,
    base,
    versions,
    engine,
    isMockEngine,
    approvedDrifted,
    activeCut,
    loadConfig,
    trackCut,
    refreshVersions,
    stopPolling,
    reset,
  }
})
