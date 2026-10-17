import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getPersonas, type Persona } from '@/api/personas'

/** D13：persona 为只读桩，前端只读取、不做增删改 */
export const usePersonaStore = defineStore('personas', () => {
  const items = ref<Persona[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  let loaded = false

  const enabled = computed(() => items.value.filter((p) => p.enabled))

  async function load(force = false): Promise<void> {
    if (loaded && !force) return
    loading.value = true
    error.value = null
    try {
      items.value = await getPersonas()
      loaded = true
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  function byId(id: string): Persona | undefined {
    return items.value.find((p) => p.id === id)
  }

  function nameOf(id: string): string {
    return byId(id)?.name ?? id
  }

  return { items, enabled, loading, error, load, byId, nameOf }
})
