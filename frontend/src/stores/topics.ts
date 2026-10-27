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
  type TopicTemplatePayload,
  type TopicQuery,
} from '@/api/topics'

/** 候选栏筛选：pending = 尚未送入（待分配 + 已分配） */
export type CandidateFilter = 'pending' | 'candidate' | 'assigned'
const FILTER_STATUS: Record<CandidateFilter, string> = {
  pending: 'candidate,assigned',
  candidate: 'candidate',
  assigned: 'assigned',
}

/** 进行中的生成批次存 sessionStorage，刷新页面后可继续轮询（P2-22） */
const BATCH_KEY = 'mw_topic_batch'
function rememberBatch(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(BATCH_KEY, id)
    else sessionStorage.removeItem(BATCH_KEY)
  } catch {
    /* 隐私模式等不可用时忽略，仅失去刷新后续查能力 */
  }
}
function recalledBatch(): string | null {
  try {
    return sessionStorage.getItem(BATCH_KEY)
  } catch {
    return null
  }
}

export const useTopicStore = defineStore('topics', () => {
  const items = ref<Topic[]>([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(20)
  /** 候选栏筛选（P2-21） */
  const filter = ref<CandidateFilter>('pending')
  /** 只看某一批次（生成完成后自动指向该批，可取消） */
  const batchFilter = ref<string | null>(null)
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

  const checkedItems = computed(
    () => checkedIds.value.map((id) => items.value.find((t) => t.id === id)).filter(Boolean) as Topic[],
  )
  const assignedChecked = computed(() =>
    checkedItems.value.filter((t) => (assignment.value[t.id] ?? t.personaIds).length > 0),
  )
  const expectedCount = computed(() => batch.value?.expected ?? 0)

  /**
   * 候选列表。默认显示「尚未送入」的全部候选（待分配 + 已分配）：
   * 之前只查 status=candidate，分配人物后一刷新候选就从列表消失，再也送不进文案工坊。
   */
  async function load(query: TopicQuery = {}): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await getTopics({
        status: FILTER_STATUS[filter.value],
        batchId: batchFilter.value ?? undefined,
        page: page.value,
        pageSize: pageSize.value,
        ...query,
      })
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

  async function saveTemplate(payload: { id?: string } & TopicTemplatePayload) {
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
      rememberBatch(id)
      const final = await pollBatch(id)
      await showBatch(id)
      return final
    } finally {
      generating.value = false
    }
  }

  /** 生成结束后：清空勾选，筛到该批次第 1 页 */
  async function showBatch(id: string): Promise<void> {
    rememberBatch(null)
    checkedIds.value = []
    batchFilter.value = id
    page.value = 1
    await load()
  }

  /** 页面刷新后续查上次未结束的批次（P2-22）；返回结束后的批次，无可续查时返回 null */
  async function resumeBatch(): Promise<TopicBatch | null> {
    const id = batchId.value ?? recalledBatch()
    if (!id || generating.value) return null
    generating.value = true
    try {
      batchId.value = id
      const b = await getTopicBatch(id)
      batch.value = b
      const final = b.status === 'running' ? await pollBatch(id) : b
      await showBatch(id)
      return final
    } catch {
      rememberBatch(null)
      return null
    } finally {
      generating.value = false
    }
  }

  /** 真实模型串行跑「资讯 × 人物」子任务可能要好几分钟，轮询窗口放宽到 10 分钟 */
  function pollBatch(id: string, maxTimes = 400, intervalMs = 1500): Promise<TopicBatch> {
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
    // 生成的候选自带「生成时的目标人物」，界面上「分配给」已预填，但状态仍是 candidate，
    // 后端会拒绝直接送入（FR-C1①）。用户看到的分配即确认的分配：送入前先按界面所示提交分配。
    for (const id of topicIds) {
      const t = items.value.find((x) => x.id === id)
      const pids = assignment.value[id] ?? []
      if (t?.status === 'candidate' && pids.length) await assign(id, pids)
    }
    const res = await sendTopics(topicIds)
    await load()
    clearChecked()
    return res
  }

  /** FR-N5：归档候选（不再出现在候选栏） */
  async function archive(id: string): Promise<void> {
    await patchTopic(id, { status: 'archived' })
    checkedIds.value = checkedIds.value.filter((x) => x !== id)
    // 当前页删空了就退一页
    if (items.value.length === 1 && page.value > 1) page.value -= 1
    await load()
  }

  function setFilter(f: CandidateFilter): void {
    filter.value = f
    page.value = 1
    void load()
  }

  function clearBatchFilter(): void {
    batchFilter.value = null
    page.value = 1
    void load()
  }

  function setPage(p: number): void {
    page.value = p
    void load()
  }

  return {
    items,
    total,
    page,
    pageSize,
    filter,
    batchFilter,
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
    setFilter,
    clearBatchFilter,
    setPage,
    resumeBatch,
  }
})
