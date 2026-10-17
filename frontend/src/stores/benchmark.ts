import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  createAccount,
  deleteAccount,
  extractVideo,
  fetchAccountNow,
  getAccounts,
  getAlerts,
  getDailyQuota,
  getBenchmarkVideos,
  getUnreadAlertCount,
  getVideoScript,
  markAlertRead,
  markAllAlertsRead,
  parseBenchmarkLink,
  patchAccount,
  previewAccount,
  sendVideoToCopy,
  type Account,
  type AccountPreview,
  type Alert,
  type BenchVideo,
  type BenchmarkVideoQuery,
  type DailyQuota,
  type ExtractStatus,
  type VideoScript,
} from '@/api/benchmark'

/** 提取中状态：需要前端轮询 */
export const EXTRACTING: ExtractStatus[] = ['pending', 'submitting', 'running']

export const EXTRACT_LABEL: Record<ExtractStatus, string> = {
  none: '未提取',
  pending: '排队中',
  submitting: '提交中',
  running: '识别中',
  done: '已提取',
  failed: '提取失败',
  uncertain: '待确认',
}

export const EXTRACT_TAG: Record<ExtractStatus, string> = {
  none: 'mw-tag mw-tag-gray',
  pending: 'mw-tag mw-tag-blue',
  submitting: 'mw-tag mw-tag-blue',
  running: 'mw-tag mw-tag-blue',
  done: 'mw-tag mw-tag-green',
  failed: 'mw-tag mw-tag-red',
  uncertain: 'mw-tag mw-tag-yellow',
}

export const useBenchmarkStore = defineStore('benchmark', () => {
  /* ── 账号 ─────────────────────────────── */
  const accounts = ref<Account[]>([])
  const accountsLoading = ref(false)
  const quota = ref<DailyQuota | null>(null)

  /* ── 视频 ─────────────────────────────── */
  const videos = ref<BenchVideo[]>([])
  const videoTotal = ref(0)
  const videoPage = ref(1)
  const videoPageSize = ref(24)
  const videosLoading = ref(false)
  const showPlayCount = ref(false)
  const videoFilter = ref<BenchmarkVideoQuery>({})

  /* ── 告警 ─────────────────────────────── */
  const alerts = ref<Alert[]>([])
  const alertTotal = ref(0)
  const unread = ref(0)
  const alertsLoading = ref(false)

  const abnormalAccounts = computed(() =>
    accounts.value.filter((a) => a.monitorStatus === 'on' && (a.consecutiveFailures > 0 || !!a.lastError)),
  )
  const hasExtracting = computed(() => videos.value.some((v) => EXTRACTING.includes(v.extractStatus)))

  async function loadAccounts(): Promise<void> {
    accountsLoading.value = true
    try {
      accounts.value = await getAccounts()
    } finally {
      accountsLoading.value = false
    }
  }

  async function loadQuota(): Promise<void> {
    try {
      quota.value = await getDailyQuota()
    } catch {
      quota.value = null
    }
  }

  function preview(url: string): Promise<AccountPreview> {
    return previewAccount(url)
  }

  async function add(url: string, intervalHours: number): Promise<Account> {
    const res = await createAccount({ url, intervalHours })
    await Promise.all([loadAccounts(), loadQuota()])
    return res
  }

  async function update(id: string, payload: { intervalHours?: number; monitorStatus?: 'on' | 'paused' }) {
    const res = await patchAccount(id, payload)
    await Promise.all([loadAccounts(), loadQuota()])
    return res
  }

  async function remove(id: string): Promise<void> {
    await deleteAccount(id)
    await Promise.all([loadAccounts(), loadQuota(), loadVideos()])
  }

  async function fetchNow(id: string): Promise<void> {
    await fetchAccountNow(id)
  }

  /* ── 视频 ─────────────────────────────── */
  async function loadVideos(partial?: BenchmarkVideoQuery): Promise<void> {
    if (partial) videoFilter.value = { ...videoFilter.value, ...partial }
    videosLoading.value = true
    try {
      const res = await getBenchmarkVideos({ ...videoFilter.value, page: videoPage.value, pageSize: videoPageSize.value })
      videos.value = res.items
      videoTotal.value = res.total
      videoPage.value = res.page
      showPlayCount.value = res.meta?.showPlayCount ?? false
    } finally {
      videosLoading.value = false
    }
  }

  function setVideoPage(p: number): Promise<void> {
    videoPage.value = p
    return loadVideos()
  }

  /** FR-B6：触发提取；并发重复点击服务端做幂等去重。P1-3①：uncertain 重试必须带 confirm */
  async function extract(videoId: string, confirm = false): Promise<void> {
    const res = await extractVideo(videoId, confirm)
    const v = videos.value.find((x) => x.id === videoId)
    if (v) v.extractStatus = res.status as ExtractStatus
  }

  function getScript(videoId: string): Promise<VideoScript> {
    return getVideoScript(videoId)
  }

  async function sendToCopy(videoId: string, personaIds: string[]): Promise<{ topicId: string; copyIds: string[] }> {
    const res = await sendVideoToCopy(videoId, personaIds)
    await loadVideos()
    return res
  }

  /** FR-B8：粘贴分享链接直接提取 */
  async function parseLink(shareUrl: string): Promise<BenchVideo> {
    const res = await parseBenchmarkLink(shareUrl)
    await loadVideos()
    return res.video
  }

  /* ── 告警 ─────────────────────────────── */
  async function loadAlerts(): Promise<void> {
    alertsLoading.value = true
    try {
      const res = await getAlerts({ pageSize: 20 })
      alerts.value = res.items
      alertTotal.value = res.total
    } finally {
      alertsLoading.value = false
    }
  }

  async function loadUnread(): Promise<void> {
    try {
      const res = await getUnreadAlertCount()
      unread.value = res.count
    } catch {
      unread.value = 0
    }
  }

  async function markRead(id: string): Promise<void> {
    await markAlertRead(id)
    await Promise.all([loadAlerts(), loadUnread()])
  }

  async function readAll(): Promise<void> {
    await markAllAlertsRead()
    await Promise.all([loadAlerts(), loadUnread()])
  }

  return {
    accounts,
    accountsLoading,
    quota,
    abnormalAccounts,
    videos,
    videoTotal,
    videoPage,
    videoPageSize,
    videosLoading,
    showPlayCount,
    videoFilter,
    hasExtracting,
    alerts,
    alertTotal,
    unread,
    alertsLoading,
    loadAccounts,
    loadQuota,
    preview,
    add,
    update,
    remove,
    fetchNow,
    loadVideos,
    setVideoPage,
    extract,
    getScript,
    sendToCopy,
    parseLink,
    loadAlerts,
    loadUnread,
    markRead,
    readAll,
  }
})
