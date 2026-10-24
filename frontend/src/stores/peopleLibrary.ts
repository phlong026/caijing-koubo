import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  getPersonaDetail,
  getPersonaOptions,
  getPersonaStats,
  getPersonas,
  getReminders,
  type PersonaDetail,
  type PersonaLine,
  type PersonaListItem,
  type PersonaOptions,
  type PersonaReminder,
  type PersonaStats,
} from '@/api/personas'
import { usePersonaStore } from '@/stores/personas'

export type StatusFilter = 'all' | 'usable' | 'incomplete' | 'disabled' | 'archived'

const POLL_MS = 4000

/** 详情里是否还有处理中 / 制作中的对象（决定是否需要自动轮询） */
export function hasInProgress(d: PersonaDetail | null): boolean {
  if (!d) return false
  const assetBusy = d.assets.some((a) => a.status === 'uploaded' || a.status === 'processing' || a.processing)
  const cloneBusy = [...d.avatars, ...d.voices].some((x) => ['pending', 'submitting', 'running'].includes(x.status))
  return assetBusy || cloneBusy
}

/**
 * 人物库页面 store（PL6）：列表 / 统计 / 选项 / 当前详情 / 提醒。
 * 与 stores/personas.ts（选题 / 文案的人物下拉）分开：后者只关心 usable 人物，这里需要全量并带筛选。
 */
export const usePeopleLibraryStore = defineStore('peopleLibrary', () => {
  const items = ref<PersonaListItem[]>([])
  const stats = ref<PersonaStats | null>(null)
  const options = ref<PersonaOptions | null>(null)
  const reminders = ref<PersonaReminder[]>([])
  const unread = ref(0)

  const line = ref<'all' | PersonaLine>('all')
  const status = ref<StatusFilter>('all')
  const keyword = ref('')

  const loading = ref(false)
  const error = ref<string | null>(null)

  const currentId = ref<string | null>(null)
  const detail = ref<PersonaDetail | null>(null)
  const detailLoading = ref(false)
  const detailError = ref<string | null>(null)

  let timer: ReturnType<typeof setTimeout> | null = null
  let listSeq = 0
  let detailSeq = 0

  const current = computed(() => items.value.find((p) => p.id === currentId.value) ?? null)
  const lineCounts = computed(() => ({
    all: stats.value?.total ?? 0,
    manager: stats.value?.lines.manager ?? 0,
    kos: stats.value?.lines.kos ?? 0,
    persona: stats.value?.lines.persona ?? 0,
  }))

  async function loadOptions(force = false): Promise<void> {
    if (options.value && !force) return
    try {
      options.value = await getPersonaOptions()
    } catch (e) {
      // 选项失败不阻断页面：积分与字典缺失时前端回落到内置默认
      console.warn('加载人物库选项失败', e)
    }
  }

  async function loadStats(): Promise<void> {
    try {
      stats.value = await getPersonaStats()
      unread.value = stats.value.unreadReminders
    } catch (e) {
      console.warn('加载人物统计失败', e)
    }
  }

  async function loadReminders(): Promise<void> {
    try {
      const r = await getReminders(false)
      reminders.value = r.items
      unread.value = r.unread
    } catch (e) {
      console.warn('加载提醒失败', e)
    }
  }

  async function loadList(): Promise<void> {
    const seq = ++listSeq
    loading.value = true
    error.value = null
    try {
      const r = await getPersonas({
        line: line.value === 'all' ? undefined : line.value,
        keyword: keyword.value.trim() || undefined,
        includeDisabled: true,
        includeArchived: status.value === 'archived',
        status: status.value === 'all' ? undefined : status.value,
      })
      if (seq !== listSeq) return // 较新的请求已发出
      items.value = r.items
      // 当前选中的人物不在结果里：自动选第一个，避免右侧停在已被筛掉的人物上
      if (!items.value.some((p) => p.id === currentId.value)) {
        await select(items.value[0]?.id ?? null)
      }
    } catch (e) {
      if (seq === listSeq) error.value = e instanceof Error ? e.message : '加载人物失败'
    } finally {
      if (seq === listSeq) loading.value = false
    }
  }

  function stopPolling(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function schedulePoll(): void {
    stopPolling()
    if (!currentId.value || !hasInProgress(detail.value)) return
    timer = setTimeout(() => void refreshDetail(true), POLL_MS)
  }

  /** silent=true：轮询刷新，不闪 loading 也不清空旧数据 */
  async function refreshDetail(silent = false): Promise<void> {
    const id = currentId.value
    if (!id) {
      detail.value = null
      return
    }
    const seq = ++detailSeq
    if (!silent) detailLoading.value = true
    detailError.value = null
    try {
      const d = await getPersonaDetail(id)
      if (seq !== detailSeq || id !== currentId.value) return
      detail.value = d
      // 同步列表里的该条（状态标签 / 计数 / 封面）
      const idx = items.value.findIndex((p) => p.id === id)
      if (idx >= 0) items.value[idx] = { ...items.value[idx], ...d }
    } catch (e) {
      if (seq === detailSeq) detailError.value = e instanceof Error ? e.message : '加载详情失败'
    } finally {
      if (seq === detailSeq) detailLoading.value = false
      schedulePoll()
    }
  }

  async function select(id: string | null): Promise<void> {
    currentId.value = id
    detail.value = null
    if (!id) {
      stopPolling()
      return
    }
    await refreshDetail(false)
  }

  /** 写操作后统一刷新：详情 + 列表项 + 统计，并让选题 / 文案的人物下拉缓存失效 */
  async function afterMutation(): Promise<void> {
    await Promise.all([refreshDetail(true), loadStats()])
    await loadList()
    void usePersonaStore().load(true)
  }

  function setLine(v: 'all' | PersonaLine): void {
    line.value = v
    void loadList()
  }
  function setStatus(v: StatusFilter): void {
    status.value = v
    void loadList()
  }
  function search(v: string): void {
    keyword.value = v
    void loadList()
  }

  async function init(): Promise<void> {
    await Promise.all([loadOptions(), loadStats(), loadReminders()])
    await loadList()
  }

  function dispose(): void {
    stopPolling()
    detailSeq++
    listSeq++
  }

  return {
    items,
    stats,
    options,
    reminders,
    unread,
    line,
    status,
    keyword,
    loading,
    error,
    currentId,
    current,
    detail,
    detailLoading,
    detailError,
    lineCounts,
    init,
    loadList,
    loadStats,
    loadOptions,
    loadReminders,
    select,
    refreshDetail,
    afterMutation,
    setLine,
    setStatus,
    search,
    dispose,
    stopPolling,
  }
})
