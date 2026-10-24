import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  getNews,
  getNewsCategories,
  refreshNews,
  type NewsCategories,
  type NewsItem,
  type NewsRefreshResult,
} from '@/api/news'

const CATEGORY_LABELS: Record<string, string> = {
  all: '全部',
  市场: '市场',
  政策: '政策',
  行业: '行业',
  基金: '基金',
  其他: '其他',
}

/** 分类标签配色（与 mw-cat 体系一致） */
export const CAT_CLASS: Record<string, string> = {
  市场: 'mw-tag mw-tag-blue',
  政策: 'mw-tag mw-tag-purple',
  行业: 'mw-tag mw-tag-green',
  基金: 'mw-tag mw-tag-orange',
  其他: 'mw-tag mw-tag-gray',
}

export const useNewsStore = defineStore('news', () => {
  const items = ref<NewsItem[]>([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(20)
  const category = ref('all')
  const keyword = ref('')
  const source = ref('')
  const loading = ref(false)
  const refreshing = ref(false)
  const error = ref<string | null>(null)

  const categories = ref<NewsCategories>({ all: 0, items: [{ key: 'all', count: 0 }], sources: [] })
  const lastRefresh = ref<NewsRefreshResult | null>(null)

  /** 已勾选的资讯 id（1~10 条，对应后端校验） */
  const selectedIds = ref<string[]>([])

  const chips = computed(() =>
    categories.value.items.map((c) => ({
      key: c.key,
      label: CATEGORY_LABELS[c.key] ?? c.key,
      count: c.count,
    })),
  )
  const selectedItems = computed(
    () => selectedIds.value.map((id) => items.value.find((n) => n.id === id)).filter(Boolean) as NewsItem[],
  )

  async function loadCategories(): Promise<void> {
    try {
      categories.value = await getNewsCategories()
    } catch {
      /* 分类失败不阻塞列表 */
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await getNews({
        category: category.value,
        keyword: keyword.value,
        source: source.value || undefined,
        page: page.value,
        pageSize: pageSize.value,
      })
      items.value = res.items
      total.value = res.total
      page.value = res.page
    } catch (e) {
      error.value = (e as Error).message
      items.value = []
      total.value = 0
    } finally {
      loading.value = false
    }
  }

  async function refresh(): Promise<NewsRefreshResult> {
    refreshing.value = true
    try {
      const res = await refreshNews()
      lastRefresh.value = res
      await Promise.all([load(), loadCategories()])
      return res
    } finally {
      refreshing.value = false
    }
  }

  function setCategory(key: string): void {
    category.value = key
    page.value = 1
    void load()
  }

  function setKeyword(kw: string): void {
    keyword.value = kw
    page.value = 1
    void load()
  }

  function setSource(s: string): void {
    source.value = s
    page.value = 1
    void load()
  }

  function setPage(p: number): void {
    page.value = p
    void load()
  }

  function isSelected(id: string): boolean {
    return selectedIds.value.includes(id)
  }

  /** 返回 false 表示已达 10 条上限 */
  function toggleSelect(id: string): boolean {
    const i = selectedIds.value.indexOf(id)
    if (i >= 0) {
      selectedIds.value.splice(i, 1)
      return true
    }
    if (selectedIds.value.length >= 10) return false
    selectedIds.value.push(id)
    return true
  }

  function clearSelect(): void {
    selectedIds.value = []
  }

  return {
    items,
    total,
    page,
    pageSize,
    category,
    keyword,
    source,
    loading,
    refreshing,
    error,
    categories,
    lastRefresh,
    selectedIds,
    chips,
    selectedItems,
    load,
    loadCategories,
    refresh,
    setCategory,
    setKeyword,
    setSource,
    setPage,
    isSelected,
    toggleSelect,
    clearSelect,
  }
})
