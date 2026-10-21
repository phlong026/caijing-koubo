import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getPersonas, type PersonaListItem } from '@/api/personas'

/**
 * 人物库 store（PL6）。
 * 契约变化（FR-X1）：GET /personas 返回 {items,total}，默认仅 usable；
 * `enabled` 历史命名保留，语义升级为「usable」（§3.2 派生 active），
 * 下拉消费方（选题 / 文案）因此自动只拿到可用人物（AC-X6）。
 */
export const usePersonaStore = defineStore('personas', () => {
  const items = ref<PersonaListItem[]>([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let loaded = false

  /** 可用人物（active）；下拉只展示这些 */
  const enabled = computed(() => items.value.filter((p) => p.usable))
  /** 不可用人物及原因（前端提示 / 管理页展示） */
  const unusable = computed(() => items.value.filter((p) => !p.usable))

  async function load(force = false): Promise<void> {
    if (loaded && !force) return
    loading.value = true
    error.value = null
    try {
      const r = await getPersonas({ includeDisabled: true })
      items.value = r.items
      total.value = r.total
      loaded = true
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  function byId(id: string): PersonaListItem | undefined {
    return items.value.find((p) => p.id === id)
  }

  function nameOf(id: string): string {
    return byId(id)?.name ?? id
  }

  /** 不可用原因文案（下拉 tooltip / 提交报错展示） */
  function reasonOf(id: string): string {
    const p = byId(id)
    if (!p) return '人物不存在'
    if (p.usable) return ''
    return p.statusReasons.map((r) => r.message).join('；') || p.statusLabel
  }

  return { items, total, enabled, unusable, loading, error, load, byId, nameOf, reasonOf }
})
