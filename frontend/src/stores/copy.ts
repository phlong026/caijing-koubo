import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { ApiError } from '@/api/client'
import { copyApi, type CopyDetail, type CopyOptions, type Draft, type Generation, type PrecheckResult, type Section } from '@/api/copy'

/**
 * 文案工坊主状态（W6）。
 *
 * 设计要点：
 * - `detail` 是唯一真源，编辑器里的草稿内容另存 `editor`（本地脏态），
 *   保证「AI 不覆盖人工」（W5）与乐观锁失效时能无损回退。
 * - 所有写操作都走 `guard()`，统一把 ApiError 转成可展示的中文提示。
 */
/** 把后端 sections 归一成可编辑数组：空稿补一个开场段，避免编辑区一片空白 */
function toEditableSections(raw: Section[] | undefined): Section[] {
  const list = (raw ?? []).map((s) => ({ label: s.label, text: s.text, sourceRefs: s.sourceRefs }))
  return list.length ? list : [{ label: '开场', text: '' }]
}

export const useCopyStore = defineStore('copy', () => {
  /* ── 选项 ── */
  const options = ref<CopyOptions | null>(null)
  const optionsLoading = ref(false)

  /* ── 当前文案 ── */
  const detail = ref<CopyDetail | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const notFound = ref(false)

  /* ── 编辑器本地态 ── */
  const editor = ref<{
    draftId: string
    title: string
    sections: Section[]
    rev: number
    dirty: boolean
    saving: boolean
    lastSavedAt: string | null
    conflict: boolean
  } | null>(null)

  /* ── 生成 ── */
  const generating = ref(false)
  const activeGeneration = ref<Generation | null>(null)
  /** 本批次已就绪的稿（来自 generation 接口的 drafts），用于「第 N 份已到」的即时反馈 */
  const generatedDrafts = ref<Array<{ id: string; draftNo: number; name: string; title: string | null; wordCount: number }>>([])
  /** 本轮生成开始的时间戳与预计总时长，用于进度条与剩余时间估算 */
  const genStartedAt = ref<number | null>(null)
  const genEstimateMs = ref<number>(0)
  /** 超时提示（轮询已停止但任务仍在跑） */
  const genTimedOut = ref(false)
  /**
   * 生成完成后自动切稿的一次性提示。
   * 内容被静默替换是最容易被误认为「丢了东西」的场景，必须给用户一个明确交代。
   */
  const switchedNotice = ref<{ draftName: string; wordCount: number } | null>(null)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  /* ── 预检 ── */
  const precheck = ref<PrecheckResult | null>(null)
  const prechecking = ref(false)

  const copy = computed(() => detail.value?.copy ?? null)
  const drafts = computed(() => detail.value?.drafts ?? [])
  const currentDraft = computed(() => detail.value?.currentDraft ?? null)
  const locked = computed(() => copy.value?.status === 'in_review')
  const canEdit = computed(() => !!copy.value && copy.value.status !== 'archived' && !locked.value)

  /** 风格按线过滤（Q4）：只展示与文案所属线一致的风格 */
  const availableStyles = computed(() => {
    const all = options.value?.styles ?? []
    const line = copy.value?.line
    if (!line) return all
    return all.filter((s) => !s.line || s.line === line)
  })

  async function loadOptions(personaId?: string): Promise<void> {
    optionsLoading.value = true
    try {
      options.value = await copyApi.options(personaId)
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      optionsLoading.value = false
    }
  }

  async function load(copyId: string): Promise<void> {
    loading.value = true
    error.value = null
    notFound.value = false
    stopPolling()
    try {
      detail.value = await copyApi.detail(copyId)
      syncEditorFromCurrent()
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.code === 'not_found')) notFound.value = true
      else error.value = (e as Error).message
      detail.value = null
      editor.value = null
    } finally {
      loading.value = false
    }
  }

  function syncEditorFromCurrent(): void {
    const d = detail.value?.currentDraft
    if (!d) {
      editor.value = null
      return
    }
    editor.value = {
      draftId: d.id,
      title: d.title ?? '',
      sections: toEditableSections(d.sections),
      rev: d.rev,
      dirty: false,
      saving: false,
      lastSavedAt: d.updatedAt,
      conflict: false,
    }
  }

  /** 切换当前稿：若本地有未保存改动，先提示调用方确认 */
  async function switchDraft(draftId: string): Promise<boolean> {
    if (editor.value?.dirty) return false
    await copyApi.switchDraft(copy.value!.id, draftId)
    await load(copy.value!.id)
    return true
  }

  function markDirty(): void {
    if (editor.value) editor.value.dirty = true
  }

  function updateSection(index: number, text: string): void {
    if (!editor.value) return
    const s = editor.value.sections[index]
    if (!s) return
    s.text = text
    markDirty()
    precheck.value = null
  }

  function addSection(): void {
    if (!editor.value) return
    editor.value.sections.push({ label: `段落 ${editor.value.sections.length + 1}`, text: '' })
    markDirty()
  }

  function removeSection(index: number): void {
    if (!editor.value) return
    editor.value.sections.splice(index, 1)
    markDirty()
    precheck.value = null
  }

  /**
   * 保存当前稿。
   * @returns 'ok' | 'conflict' | 'need_confirm' | 'error'
   */
  async function save(confirmReedit = false): Promise<'ok' | 'conflict' | 'need_confirm' | 'error'> {
    if (!editor.value || !copy.value) return 'error'
    editor.value.saving = true
    error.value = null
    try {
      const r = await copyApi.saveDraft(copy.value.id, editor.value.draftId, {
        title: editor.value.title || null,
        sections: editor.value.sections,
        rev: editor.value.rev,
        confirmReedit,
      })
      editor.value.rev = r.draft.rev
      editor.value.dirty = false
      editor.value.conflict = false
      editor.value.lastSavedAt = r.draft.updatedAt
      precheck.value = null
      // 轻量刷新稿列表与状态，不覆盖编辑器内容
      detail.value = await copyApi.detail(copy.value.id)
      return 'ok'
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'COPY_DRAFT_CONFLICT') {
          if (editor.value) editor.value.conflict = true
          error.value = '该稿已在其他页面修改，请载入最新内容或另存为新稿'
          return 'conflict'
        }
        if (e.code === 'COPY_LOCKED') {
          error.value = '文案正在审核中，暂不可编辑'
          return 'error'
        }
        if (e.status === 409 && (e as unknown as { details?: { requiresConfirm?: boolean } }).details?.requiresConfirm) {
          return 'need_confirm'
        }
        error.value = e.message
      } else {
        error.value = (e as Error).message
      }
      return 'error'
    } finally {
      if (editor.value) editor.value.saving = false
    }
  }

  /** 载入最新（放弃本地改动） */
  async function reloadDraft(): Promise<void> {
    if (!copy.value || !editor.value) return
    const d = await copyApi.getDraft(copy.value.id, editor.value.draftId)
    editor.value = {
      draftId: d.id,
      title: d.title ?? '',
      sections: toEditableSections(d.sections),
      rev: d.rev,
      dirty: false,
      saving: false,
      lastSavedAt: d.updatedAt,
      conflict: false,
    }
  }

  /** 另存为新稿，保住本地内容 */
  async function saveAsNewDraft(): Promise<void> {
    if (!copy.value || !editor.value) return
    const created = await copyApi.createDraft(copy.value.id)
    editor.value.draftId = created.id
    editor.value.rev = 0
    const r = await save()
    if (r === 'ok') await load(copy.value.id)
  }

  async function runPrecheck(): Promise<PrecheckResult | null> {
    if (!copy.value || !editor.value) return null
    // 预检先落盘，避免校验的是旧内容
    if (editor.value.dirty) {
      const r = await save()
      if (r !== 'ok') return null
    }
    prechecking.value = true
    try {
      precheck.value = await copyApi.precheck(copy.value.id, editor.value.draftId)
      return precheck.value
    } catch (e) {
      error.value = (e as Error).message
      return null
    } finally {
      prechecking.value = false
    }
  }

  /* ── 生成：异步任务 + 轮询 ── */

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /**
   * 估算总耗时（毫秒）。
   * 依据：真实模型（claude-opus-5.5）单份约 45–60 秒；同批并发 3 份。
   * 只作为**进度条的分母**使用，不参与任何业务判断，估偏了也只是条走得快/慢。
   * realtimeRatio 由历史完成记录动态修正（见下方 calibrate）。
   */
  const PER_ITEM_MS = 55_000
  const BATCH_CONCURRENCY = 3
  let calibration = 1 // 1 = 未校准；后端实测数据会修正它

  function estimateDuration(count: number): number {
    const rounds = Math.max(1, Math.ceil(count / BATCH_CONCURRENCY))
    // 首轮有冷启动开销（连接/排队），按 1.15 倍算
    return Math.round(rounds * PER_ITEM_MS * calibration * 1.15)
  }

  async function generate(body: {
    templateId: string
    styleId: string
    durationTier: 'short' | 'medium' | 'long' | 'custom'
    durationSeconds?: number | null
    count: number
    instructions?: string
  }): Promise<boolean> {
    if (!copy.value) return false
    error.value = null
    generating.value = true
    genTimedOut.value = false
    generatedDrafts.value = []
    try {
      if (editor.value?.dirty) {
        const r = await save()
        if (r !== 'ok' && r !== 'need_confirm') {
          generating.value = false
          return false
        }
      }
      const accepted = await copyApi.generate(copy.value.id, body)
      activeGeneration.value = { id: accepted.generationId, status: accepted.status } as Generation
      genStartedAt.value = Date.now()
      genEstimateMs.value = estimateDuration(Math.max(1, Number(body.count) || 1))
      startTick()
      startPolling(accepted.generationId)
      return true
    } catch (e) {
      error.value = (e as Error).message
      generating.value = false
      return false
    }
  }

  function startPolling(generationId: string): void {
    stopPolling()
    // 超时保护放宽到 10 分钟：真实模型批量生成（5 份×2 轮）可能超过 3 分钟，
    // 早期 2 分钟会误判为「卡住」。这里只停止轮询，任务本身在后端继续跑。
    const HARD_TIMEOUT_MS = 10 * 60_000
    pollTimer = setInterval(async () => {
      try {
        const g = await copyApi.generation(generationId)
        activeGeneration.value = g
        if (Array.isArray(g.drafts)) generatedDrafts.value = g.drafts

        const settled = g.status === 'done' || g.status === 'partial' || g.status === 'failed'
        if (settled) {
          stopPolling()
          stopTick()
          generating.value = false
          genTimedOut.value = false
          // 用真实耗时校准下一次的预估，让进度条越用越准
          if (genStartedAt.value && g.count > 0) {
            const real = Date.now() - genStartedAt.value
            const ideal = estimateDuration(g.count) / calibration
            const ratio = real / ideal
            if (ratio > 0.3 && ratio < 3) {
              // 平滑移动，避免单次抖动把预估带偏
              calibration = calibration * 0.65 + (ratio * 1.15) * 0.35
            }
          }
          if (copy.value) {
            const before = editor.value?.draftId
            detail.value = await copyApi.detail(copy.value.id)
            if (!editor.value?.dirty) syncEditorFromCurrent()
            // 稿被自动切换 → 提示用户，避免误以为内容丢失
            const now = editor.value
            if (now && before && now.draftId !== before && g.status !== 'failed') {
              const d = (detail.value?.drafts ?? []).find((x) => x.id === now.draftId)
              switchedNotice.value = { draftName: d?.name ?? '新稿', wordCount: d?.wordCount ?? 0 }
              window.setTimeout(() => { switchedNotice.value = null }, 8000)
            }
          }
          return
        }
        if (genStartedAt.value && Date.now() - genStartedAt.value > HARD_TIMEOUT_MS) {
          stopPolling()
          stopTick()
          generating.value = false
          genTimedOut.value = true
        }
      } catch {
        stopPolling()
        stopTick()
        generating.value = false
      }
    }, 1200)
  }

  /** 手动重试：轮询停止但任务其实还在跑时，用同一 generationId 重新接上 */
  function resumePolling(): void {
    const id = activeGeneration.value?.id
    if (!id) return
    genTimedOut.value = false
    generating.value = true
    if (!genStartedAt.value) genStartedAt.value = Date.now()
    startPolling(id)
  }

  /** 每 500ms 推进一次的时钟，专门驱动进度条与剩余时间这类「基于时间」的计算属性 */
  const tick = ref(0)
  let tickTimer: ReturnType<typeof setInterval> | null = null
  function startTick(): void {
    if (tickTimer) return
    tickTimer = setInterval(() => {
      tick.value = Date.now()
      // 没有在跑的任务就停掉，避免页面挂着一个空转定时器
      if (!generating.value) stopTick()
    }, 500)
  }
  function stopTick(): void {
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }

  /** 进度快照：给进度条与文案用（0–100） */
  const genProgress = computed(() => {
    void tick.value // 依赖时钟，保证每 500ms 重算
    const g = activeGeneration.value
    if (!g) return 0
    if (g.status === 'done' || g.status === 'failed' || g.status === 'partial') return 100
    if (g.status === 'pending') return 3
    if (!genStartedAt.value || !genEstimateMs.value) return 8
    const ratio = (Date.now() - genStartedAt.value) / genEstimateMs.value
    // 用「已完成份数」托底，保证进度条一定 >= 实际产出进度
    const byDrafts = g.count ? (generatedDrafts.value.length / g.count) * 92 : 0
    // 时间维度封顶 96%：没结束就不到 100，避免「100% 却还在转」的观感
    return Math.min(96, Math.max(8, Math.max(byDrafts, ratio * 88)))
  })

  /** 剩余时间预估 */
  const genRemainMs = computed(() => {
    void tick.value
    if (!generating.value || !genStartedAt.value || !genEstimateMs.value) return null
    const left = genEstimateMs.value - (Date.now() - genStartedAt.value)
    return Math.max(0, left)
  })

  /** 已耗时 */
  const genElapsedMs = computed(() => {
    void tick.value
    if (!genStartedAt.value) return 0
    return Math.max(0, Date.now() - genStartedAt.value)
  })

  function reset(): void {
    stopPolling()
    stopTick()
    detail.value = null
    editor.value = null
    precheck.value = null
    activeGeneration.value = null
    generatedDrafts.value = []
    genStartedAt.value = null
    genEstimateMs.value = 0
    genTimedOut.value = false
    switchedNotice.value = null
    error.value = null
    notFound.value = false
    generating.value = false
  }

  return {
    options,
    optionsLoading,
    detail,
    loading,
    error,
    notFound,
    editor,
    generating,
    activeGeneration,
    generatedDrafts,
    genStartedAt,
    genEstimateMs,
    genTimedOut,
    switchedNotice,
    genProgress,
    genRemainMs,
    genElapsedMs,
    resumePolling,
    precheck,
    prechecking,
    copy,
    drafts,
    currentDraft,
    locked,
    canEdit,
    availableStyles,
    loadOptions,
    load,
    syncEditorFromCurrent,
    switchDraft,
    markDirty,
    updateSection,
    addSection,
    removeSection,
    save,
    reloadDraft,
    saveAsNewDraft,
    runPrecheck,
    generate,
    stopPolling,
    reset,
  }
})
