import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  getVideoJob,
  getVideoOptions,
  getVideoCopyContext,
  postVideoPrecheck,
  type CopyContext,
  type JobSummary,
  type VideoOptions,
  type PrecheckResult,
  type CreateJobInput,
  type VideoMode,
} from '@/api/video'

/**
 * 视频创作 store（任务书 §7 工程）。
 * 轮询：进行中任务每 3 秒拉一次详情，离开页面停止、回来续查；
 * 进度用本地峰值防回退（服务端 progress_floor 单调，前端再兜一层）。
 */
export const useVideoStore = defineStore('video', () => {
  const options = ref<VideoOptions | null>(null)
  const context = ref<CopyContext | null>(null)
  const contextLoading = ref(false)
  const precheck = ref<PrecheckResult | null>(null)

  /** 当前追踪的任务（进行中轮询对象） */
  const activeJob = ref<JobSummary | null>(null)
  const progressPeak = ref<Record<string, number>>({})
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const hardChecksPass = computed(() =>
    (precheck.value?.checks ?? []).filter((c) => c.level === 'hard').every((c) => c.pass),
  )

  async function loadOptions(force = false): Promise<void> {
    if (options.value && !force) return
    options.value = await getVideoOptions()
  }

  async function loadContext(copyId: string): Promise<void> {
    contextLoading.value = true
    try {
      context.value = await getVideoCopyContext(copyId)
      precheck.value = null
    } finally {
      contextLoading.value = false
    }
  }

  async function refreshPrecheck(input: {
    mode: VideoMode
    avatarId?: string | null
    mixcutPackIds?: string[]
  }): Promise<void> {
    if (!context.value) return
    precheck.value = await postVideoPrecheck({
      copyId: context.value.copy.id,
      mode: input.mode,
      avatarId: input.avatarId,
      mixcutPackIds: input.mixcutPackIds,
    })
  }

  /** 应用进度峰值（防回退，§7） */
  function applyJob(job: JobSummary): JobSummary {
    const peak = progressPeak.value[job.id] ?? 0
    if (job.progress < peak) job.progress = peak
    else progressPeak.value[job.id] = job.progress
    return job
  }

  async function trackJob(jobId: string): Promise<void> {
    const detail = await getVideoJob(jobId)
    const { snapshot: _s, textSnapshot: _t, events: _e, ...summary } = detail
    activeJob.value = applyJob(summary as JobSummary)
    startPolling(jobId)
  }

  function startPolling(jobId: string): void {
    stopPolling()
    pollTimer = setInterval(async () => {
      try {
        const detail = await getVideoJob(jobId)
        const { snapshot: _s, textSnapshot: _t, events: _e, ...summary } = detail
        activeJob.value = applyJob(summary as JobSummary)
        // 终态 / 半终态停止轮询（人工动作后由页面重新发起）
        if (
          ['completed', 'failed', 'cancelled', 'save_failed', 'submission_unknown', 'paused'].includes(summary.phase)
        ) {
          stopPolling()
          void refreshContext()
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

  async function refreshContext(): Promise<void> {
    if (context.value) await loadContext(context.value.copy.id)
  }

  return {
    options,
    context,
    contextLoading,
    precheck,
    activeJob,
    hardChecksPass,
    loadOptions,
    loadContext,
    refreshPrecheck,
    refreshContext,
    trackJob,
    startPolling,
    stopPolling,
    applyJob,
  }
})

export type { CreateJobInput }
