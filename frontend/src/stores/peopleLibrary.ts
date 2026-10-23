import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  getPersonaDetail,
  getPersonaOptions,
  getPersonaStats,
  getPersonas,
  getReminders,
  readAllReminders,
  type PersonaDetail,
  type PersonaLine,
  type PersonaListItem,
  type PersonaListQuery,
  type PersonaOptions,
  type PersonaReminder,
} from '@/api/personas'
import { usePersonaStore } from './personas'

/**
 * 人物库管理页 store（PL6 / PL7）。
 * 与 `personas` store 分开：后者服务选题 / 文案下拉，只关心可用人物；
 * 这里管全部人物、详情、上传后的处理进度与克隆轮询。
 * 任何写操作后调用 `afterMutation()`，同时刷新下拉用的 `personas` store。
 */

export type LineTab = 'all' | PersonaLine
export type StatusFilter = 'all' | 'usable' | 'incomplete' | 'disabled' | 'archived'

/** 处理中 / 克隆中的条目存在时，详情按此间隔自动刷新 */
const DETAIL_POLL_MS = 5000

export const usePeopleLibraryStore = defineStore('peopleLibrary', () => {
  const options = ref<PersonaOptions | null>(null)
  const items = ref<PersonaListItem[]>([])
  const lineCounts = ref<Record<PersonaLine, number>>({ manager: 0, kos: 0, persona: 0 })
  const totalCount = ref(0)
  const unreadReminders = ref(0)
  const reminders = ref<PersonaReminder[]>([])

  const lineTab = ref<LineTab>('all')
  const statusFilter = ref<StatusFilter>('all')
  const keyword = ref('')

  const loading = ref(false)
  const error = ref<string | null>(null)

  const selectedId = ref<string | null>(null)
  const detail = ref<PersonaDetail | null>(null)
  const detailLoading = ref(false)
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  /** 页面离开后置 true：在途请求回来也不再续排轮询（store 是单例，不停会一直轮询） */
  let disposed = false
  /** 列表请求序号：快速切 Tab / 搜索时只采用最后一次请求的结果 */
  let listSeq = 0

  const selected = computed(() => items.value.find((p) => p.id === selectedId.value) ?? null)

  /** 详情里是否有需要等待后端推进的条目（素材处理、克隆制作、试听生成） */
  const hasPendingWork = computed(() => {
    const d = detail.value
    if (!d) return false
    const assetBusy = d.assets.some((a) => a.processing || a.status === 'uploaded' || a.status === 'processing')
    const cloneBusy = (s: string) => s === 'pending' || s === 'submitting' || s === 'running'
    return assetBusy || d.avatars.some((a) => cloneBusy(a.status)) || d.voices.some((v) => cloneBusy(v.status))
  })

  function buildQuery(): PersonaListQuery {
    const q: PersonaListQuery = { includeDisabled: true }
    if (lineTab.value !== 'all') q.line = lineTab.value
    if (keyword.value.trim()) q.keyword = keyword.value.trim()
    if (statusFilter.value === 'archived') {
      q.includeArchived = true
      q.status = 'archived'
    } else if (statusFilter.value !== 'all') {
      q.status = statusFilter.value
    }
    return q
  }

  async function loadOptions(): Promise<void> {
    try {
      options.value = await getPersonaOptions()
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  async function loadStats(): Promise<void> {
    try {
      const s = await getPersonaStats()
      lineCounts.value = s.lines
      totalCount.value = s.total
      unreadReminders.value = s.unreadReminders
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  async function loadList(): Promise<void> {
    const seq = ++listSeq
    loading.value = true
    error.value = null
    try {
      const r = await getPersonas(buildQuery())
      if (seq !== listSeq) return
      items.value = r.items
      // 当前选中的人物被筛掉时，改选第一个，保证右侧详情总有内容
      if (!r.items.some((p) => p.id === selectedId.value)) {
        await select(r.items[0]?.id ?? null)
      }
    } catch (e) {
      if (seq === listSeq) error.value = (e as Error).message
    } finally {
      if (seq === listSeq) loading.value = false
    }
  }

  async function loadDetail(): Promise<void> {
    const id = selectedId.value
    if (!id) {
      detail.value = null
      return
    }
    detailLoading.value = !detail.value || detail.value.id !== id
    try {
      const d = await getPersonaDetail(id)
      // 请求返回前用户可能已切到别的人物，丢弃过期结果
      if (selectedId.value === id) detail.value = d
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      detailLoading.value = false
      schedulePoll()
    }
  }

  function schedulePoll(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    if (disposed || !hasPendingWork.value) return
    pollTimer = setTimeout(async () => {
      await loadDetail()
      // 后台推进完成后列表计数 / 状态标签也要跟上
      if (!hasPendingWork.value) await refreshList()
    }, DETAIL_POLL_MS)
  }

  async function select(id: string | null): Promise<void> {
    selectedId.value = id
    if (!id || detail.value?.id !== id) detail.value = null
    await loadDetail()
  }

  /** 静默刷新列表（不置 loading、不改选中项），用于后台状态变化后同步卡片 */
  async function refreshList(): Promise<void> {
    const seq = ++listSeq
    try {
      const fresh = await getPersonas(buildQuery())
      if (seq === listSeq) items.value = fresh.items
    } catch (e) {
      if (seq === listSeq) error.value = `列表刷新失败：${(e as Error).message}`
    }
  }

  /** 任意写操作之后：刷新详情、列表、计数与下拉用 store */
  async function afterMutation(): Promise<void> {
    await Promise.all([loadDetail(), loadStats()])
    await refreshList()
    void usePersonaStore().load(true)
  }

  async function loadReminders(): Promise<void> {
    try {
      const r = await getReminders()
      reminders.value = r.items
      unreadReminders.value = r.unread
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  async function markRemindersRead(): Promise<void> {
    await readAllReminders()
    await loadReminders()
  }

  async function init(): Promise<void> {
    disposed = false
    await Promise.all([loadOptions(), loadStats()])
    await loadList()
  }

  function dispose(): void {
    disposed = true
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  return {
    options,
    items,
    lineCounts,
    totalCount,
    unreadReminders,
    reminders,
    lineTab,
    statusFilter,
    keyword,
    loading,
    error,
    selectedId,
    selected,
    detail,
    detailLoading,
    hasPendingWork,
    init,
    dispose,
    loadList,
    loadDetail,
    loadStats,
    loadOptions,
    select,
    afterMutation,
    loadReminders,
    markRemindersRead,
  }
})
