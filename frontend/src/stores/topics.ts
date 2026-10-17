import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  createTopicTemplate,
  deleteTopicTemplate,
  generateTopics,
  getTopicBatch,
  getTopics,
  getTopicTemplates,
  patchTopic,
  sendTopics,
  updateTopicTemplate,
  type Topic,
  type TopicBatch,
  type TopicTemplate,
  type TopicQuery,
} from '@/api/topics'

export const useTopicStore = defineStore('topics', () => {
  const items = ref<Topic[]>([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(50)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** 生成批次 */
  const batchId = ref<string | null>(null)
  const batch = ref<TopicBatch | null>(null)
  const generating = ref(false)

  /** 勾选与分配（topicId -> personaIds） */
  const checkedIds = ref<string[]>([])
  const assignment = ref<Record<string, string[]>>({})

  const templates = ref<TopicTemplate[]>([])
  const templatesLoading = ref(false)

  const checkedItems = computed(() =>
    checkedIds.value.map((id) => items.value.find((t) => t.id === id)).filter(Boolean) as Topic[],
  )
  const assignedChecked = computed(() => checkedItems.value.filter((t) => (assignment.value[t.id] ?? t.personaIds).length > 0))
  const expectedCount = computed(() => batch.value?.expected ?? 0)

  async function load(query: TopicQuery = {}): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await getTopics({ status: 'candidate', page: page.value, pageSize: pageSize.value, ...query })
      items.value = res.items
      total.value = res.total
      page.value = res.page
      // 保留已有分配草稿，补齐接口返回的已分配人物
      for (const t of items.value) {
        if (!assignment.value[t.id]) assignment.value[t.id] = [...t.personaIds]
      }
    } catch (e) {
      error.value = (e as Error).message
      items.value = []
      total.value = 0
    } finally {
      loading.value = false
    }
  }

  async function loadTemplates(): Promise<void> {
    templatesLoading.value = true
    try {
      templates.value = await getTopicTemplates()
    } finally {
      templatesLoading.value = false
    }
  }

  async function saveTemplate(payload: { id?: string; name: string; content: string; isDefault?: boolean }) {
    if (payload.id) {
      const { id, ...rest } = payload
      await updateTopicTemplate(id, rest)
    } else {
      await createTopicTemplate(payload)
    }
    await loadTemplates()
  }

  async function removeTemplate(id: string) {
    await deleteTopicTemplate(id)
    await loadTemplates()
  }

  /** FR-N4：异步批次受理 → 轮询 → 刷新候选列表 */
  async function generate(payload: {
    newsIds: string[]
    personaIds: string[]
    countPer: number
    templateId?: string
  }): Promise<TopicBatch> {
    generating.value = true
    error.value = null
    try {
      const { batchId: id } = await generateTopics(payload)
      batchId.value = id
      const final = await pollBatch(id)
      checkedIds.value = []
      await load({ batchId: id })
      return final
    } finally {
      generating.value = false
    }
  }

  function pollBatch(id: string, maxTimes = 80, intervalMs = 1500): Promise<TopicBatch> {
    return new Promise((resolve, reject) => {
      let n = 0
      const tick = async () => {
        try {
          const b = await getTopicBatch(id)
          batch.value = b
          if (b.status !== 'running') return resolve(b)
        } catch (e) {
          return reject(e)
        }
        if (++n >= maxTimes) return reject(new Error('生成超时，请稍后在候选列表中查看结果'))
        setTimeout(tick, intervalMs)
      }
      void tick()
    })
  }

  /** FR-N5：分配人物（candidate → assigned） */
  async function assign(topicId: string, personaIds: string[]): Promise<void> {
    const t = await patchTopic(topicId, { personaIds })
    const i = items.value.findIndex((x) => x.id === topicId)
    if (i >= 0) items.value[i] = t
    assignment.value[topicId] = [...t.personaIds]
  }

  function setAssignment(topicId: string, personaIds: string[]): void {
    assignment.value[topicId] = personaIds
  }

  function toggleCheck(id: string): void {
    const i = checkedIds.value.indexOf(id)
    if (i >= 0) checkedIds.value.splice(i, 1)
    else checkedIds.value.push(id)
  }

  function clearChecked(): void {
    checkedIds.value = []
  }

  /** FR-C3：送入文案工坊。返回创建数与 copyIds，供页面直接跳到对应文案 */
  async function send(topicIds: string[]): Promise<{ created: number; copyIds: string[] }> {
    const res = await sendTopics(topicIds)
    await load()
    clearChecked()
    return res
  }

  async function archive(id: string): Promise<void> {
    await patchTopic(id, { status: 'archived' })
    await load()
  }

  return {
    items,
    total,
    page,
    pageSize,
    loading,
    error,
    batchId,
    batch,
    generating,
    checkedIds,
    assignment,
    templates,
    templatesLoading,
    checkedItems,
    assignedChecked,
    expectedCount,
    load,
    loadTemplates,
    saveTemplate,
    removeTemplate,
    generate,
    assign,
    setAssignment,
    toggleCheck,
    clearChecked,
    send,
    archive,
  }
})
