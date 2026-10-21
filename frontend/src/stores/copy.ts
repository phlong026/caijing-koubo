import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { ApiError } from '@/api/client'
import { copyApi, type CreativeSettings, type CopyDetail, type CopyOptions, type Draft, type Generation, type PrecheckResult, type Section } from '@/api/copy'

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

/* ── P0-5：本地暂存（AC-F4 断网时未保存内容不丢失）────────────────── */

const LOCAL_KEY_PREFIX = 'mw.copy.draft.'
/** 自动保存防抖：FR-E2 要求停止输入 2 秒后保存 */
const AUTOSAVE_DEBOUNCE_MS = 2000

interface LocalDraft {
  copyId: string
  draftId: string
  rev: number
  title: string
  sections: Section[]
  savedAt: number
}

function localKey(copyId: string, draftId: string): string {
  return `${LOCAL_KEY_PREFIX}${copyId}.${draftId}`
}

/** 读本地暂存：任何异常都吞掉（隐私模式 / 配额超限 / 数据损坏） */
function readLocalDraft(copyId: string, draftId: string): LocalDraft | null {
  try {
    const raw = localStorage.getItem(localKey(copyId, draftId))
    if (!raw) return null
    const o = JSON.parse(raw) as LocalDraft
    if (!o || typeof o !== 'object' || !Array.isArray(o.sections)) return null
    return o
  } catch {
    return null
  }
}

function writeLocalDraft(d: LocalDraft): void {
  try {
    localStorage.setItem(localKey(d.copyId, d.draftId), JSON.stringify(d))
  } catch {
    /* 配额不足或隐私模式：暂存失败不影响编辑 */
  }
}

function clearLocalDraft(copyId: string, draftId: string): void {
  try {
    localStorage.removeItem(localKey(copyId, draftId))
  } catch {
    /* 忽略 */
  }
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
  /**
   * P0-5：用「编辑序号」代替布尔 dirty。
   * 每次修改 `editSeq++`；保存时记录发出请求那一刻的 `savedSeq`；
   * 请求返回后只有 savedSeq === editSeq 才算干净 —— 否则保存期间用户继续输入的那部分
   * 改动会被误标为「已保存」，之后既不会自动保存、也不会在离开时提示。
   */
  const editor = ref<{
    draftId: string
    title: string
    sections: Section[]
    rev: number
    editSeq: number
    savedSeq: number
    saving: boolean
    lastSavedAt: string | null
    conflict: boolean
    /** 自动保存失败的最新原因（底栏展示「保存失败，可重试」） */
    saveError: string | null
    /** 本次载入时在 localStorage 里发现了比服务端更新的暂存，等待用户决定 */
    localNewer: boolean
  } | null>(null)

  /** 派生「脏」状态：有未保存到服务端的编辑 */
  const isDirty = computed(() => !!editor.value && editor.value.editSeq > editor.value.savedSeq)

  /** 底栏文案（FR-E2：保存中 / 已自动保存 HH:mm / 保存失败可重试） */
  const saveState = computed<'saved' | 'saving' | 'dirty' | 'error'>(() => {
    const e = editor.value
    if (!e) return 'saved'
    if (e.saving) return 'saving'
    if (e.saveError) return 'error'
    if (e.editSeq > e.savedSeq) return 'dirty'
    return 'saved'
  })

  /* ── 撤销 / 重做（W4 精简工具栏）── */
  /**
   * 以「标题 + 段落」整体快照为单位。连续输入 800ms 内合并为一步，最多保留 50 步。
   * committed 始终是最近一次编辑之后的内容：新一轮输入开始时把它压入撤销栈，
   * 即「这一轮输入之前」的状态。换稿或重新载入（editor 被整体替换）时清空历史。
   */
  type EditorSnap = { title: string; sections: Section[] }
  const UNDO_LIMIT = 50
  const UNDO_MERGE_MS = 800
  const undoStack = ref<EditorSnap[]>([])
  const redoStack = ref<EditorSnap[]>([])
  let committed: EditorSnap | null = null
  let lastEditAt = 0
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  function snapEditor(): EditorSnap | null {
    const e = editor.value
    return e ? { title: e.title, sections: e.sections.map((x) => ({ ...x })) } : null
  }

  function resetHistory(): void {
    undoStack.value = []
    redoStack.value = []
    committed = snapEditor()
    lastEditAt = 0
  }
  // 只在 editor 被整体替换（换稿 / 载入 / 放弃改动）时触发，段落内的修改不会触发
  watch(editor, resetHistory)

  function recordHistory(): void {
    const now = Date.now()
    if (committed && now - lastEditAt > UNDO_MERGE_MS) {
      undoStack.value.push(committed)
      if (undoStack.value.length > UNDO_LIMIT) undoStack.value.shift()
      redoStack.value = []
    }
    lastEditAt = now
    committed = snapEditor()
  }

  function applySnap(snap: EditorSnap): void {
    const e = editor.value
    if (!e) return
    e.title = snap.title
    e.sections = snap.sections.map((x) => ({ ...x }))
    committed = snapEditor()
    lastEditAt = 0
    precheck.value = null
    markDirty(false)
  }

  function undo(): void {
    const prev = undoStack.value.pop()
    const cur = snapEditor()
    if (!prev || !cur || !canEdit.value) return
    redoStack.value.push(cur)
    applySnap(prev)
  }

  function redo(): void {
    const next = redoStack.value.pop()
    const cur = snapEditor()
    if (!next || !cur || !canEdit.value) return
    undoStack.value.push(cur)
    applySnap(next)
  }

  let autosaveTimer: ReturnType<typeof setTimeout> | null = null
  /** 串行化：同一时刻只有一个保存请求在飞，期间的新改动等它回来后再合并发送 */
  let saveInFlight = false
  type SaveResult = 'ok' | 'conflict' | 'need_confirm' | 'error'
  let activeSave: Promise<SaveResult> | null = null
  let saveAgain = false

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

  const creativeSettings = reactive<CreativeSettings>({ templateId: '', styleId: '', durationTier: 'medium', durationSeconds: 60, count: 1, instructions: '' })
  const settingsSaving = ref(false)
  const settingsError = ref('')
  const savedSettings = ref('')
  const settingsCopyId = ref('')
  let settingsTimer: ReturnType<typeof setTimeout> | null = null
  let settingsPending: Promise<boolean> | null = null
  const settingsDirty = computed(() => !!settingsCopyId.value && JSON.stringify(creativeSettings) !== savedSettings.value)
  function hydrateSettings() {
    const s = detail.value?.copy.settings ?? {}
    settingsCopyId.value = ''
    Object.assign(creativeSettings, { templateId: s.templateId || options.value?.templates[0]?.id || '', styleId: s.styleId || availableStyles.value[0]?.id || '', durationTier: s.durationTier || 'medium', durationSeconds: s.durationSeconds ?? 60, count: s.count ?? 1, instructions: s.instructions ?? '' })
    savedSettings.value = JSON.stringify(creativeSettings)
    settingsCopyId.value = detail.value?.copy.id ?? ''
    settingsError.value = ''
  }
  async function saveCreativeSettings(): Promise<boolean> {
    if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = null }
    if (settingsPending) { await settingsPending; if (!settingsDirty.value) return !settingsError.value }
    if (!settingsDirty.value || !copy.value || !canEdit.value) return true
    const id = copy.value.id
    const body = JSON.parse(JSON.stringify(creativeSettings)) as CreativeSettings
    if (!body.templateId || !body.styleId) return false
    settingsSaving.value = true
    settingsError.value = ''
    settingsPending = (async () => {
      try {
        const r = await copyApi.saveSettings(id, body)
        if (detail.value?.copy.id === id) { detail.value.copy.settings = { ...detail.value.copy.settings, ...body }; savedSettings.value = JSON.stringify(body) }
        return true
      } catch (e) { settingsError.value = (e as Error).message; return false }
      finally { settingsSaving.value = false; settingsPending = null }
    })()
    return settingsPending
  }
  watch(creativeSettings, () => {
    if (settingsTimer) clearTimeout(settingsTimer)
    if (settingsDirty.value && canEdit.value) settingsTimer = setTimeout(() => { void saveCreativeSettings() }, 900)
  }, { deep: true })

  async function load(copyId: string): Promise<void> {
    if (settingsDirty.value && !(await saveCreativeSettings())) { error.value = settingsError.value; return }

    loading.value = true
    error.value = null
    notFound.value = false
    stopPolling()
    try {
      detail.value = await copyApi.detail(copyId)
      precheck.value = null
      hydrateSettings()
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
    // P0-5：服务端有内容，但本地暂存更新（例如上次断网没存上 / 直接关掉了标签页）
    const local = detail.value ? readLocalDraft(detail.value.copy.id, d.id) : null
    const base = {
      draftId: d.id,
      title: d.title ?? '',
      sections: toEditableSections(d.sections),
      rev: d.rev,
      saving: false,
      lastSavedAt: d.updatedAt,
      conflict: false,
      saveError: null,
    }
    const serverTime = d.updatedAt ? new Date(d.updatedAt).getTime() : 0
    if (local && local.savedAt > serverTime) {
      editor.value = {
        ...base,
        title: local.title,
        sections: toEditableSections(local.sections),
        // 本地暂存的 rev 可能已过期，保留服务端 rev 以便冲突时走 COPY_DRAFT_CONFLICT
        editSeq: 1,
        savedSeq: 0,
        localNewer: true,
      }
      return
    }
    if (local) clearLocalDraft(detail.value!.copy.id, d.id)
    editor.value = { ...base, editSeq: 0, savedSeq: 0, localNewer: false }
  }

  /** 用户确认丢弃本地暂存，回到服务端内容 */
  function discardLocalDraft(): void {
    if (!detail.value || !editor.value) return
    clearLocalDraft(detail.value.copy.id, editor.value.draftId)
    syncEditorFromCurrent()
  }

  /**
   * 用户选择「放弃改动」：清掉本地暂存并把编辑序号对齐，
   * 之后 isDirty 为 false，切换稿件不会再被拦。
   */
  function acceptServerState(): void {
    const e = editor.value
    if (!e) return
    cancelAutosave()
    if (detail.value) clearLocalDraft(detail.value.copy.id, e.draftId)
    e.savedSeq = e.editSeq
    e.saveError = null
    e.localNewer = false
  }

  /** 切换当前稿：若本地有未保存改动，先提示调用方确认 */
  async function switchDraft(draftId: string): Promise<boolean> {
    if (isDirty.value) return false
    await copyApi.switchDraft(copy.value!.id, draftId)
    await load(copy.value!.id)
    return true
  }

  /** P0-5：标记改动 —— editSeq++ + 写本地暂存 + 安排 2 秒防抖自动保存；用户编辑同时记入撤销历史 */
  function markDirty(history = true): void {
    const e = editor.value
    if (!e) return
    if (history) recordHistory()
    e.editSeq += 1
    e.saveError = null
    persistLocal()
    scheduleAutosave()
  }

  function persistLocal(): void {
    const e = editor.value
    const c = copy.value
    if (!e || !c) return
    writeLocalDraft({
      copyId: c.id,
      draftId: e.draftId,
      rev: e.rev,
      title: e.title,
      sections: e.sections,
      savedAt: Date.now(),
    })
  }

  function cancelAutosave(): void {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer)
      autosaveTimer = null
    }
  }

  function scheduleAutosave(): void {
    cancelAutosave()
    if (!canEdit.value) return
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null
      void autosave()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  /** 自动保存：串行化，冲突时不打扰用户（只标记，交给手动保存处理） */
  async function autosave(): Promise<void> {
    if (!isDirty.value || saveInFlight) {
      if (saveInFlight) saveAgain = true
      return
    }
    const r = await save()
    if (r === 'ok' && isDirty.value) void autosave()
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

  /** 段落上移 / 下移（W4 工具栏「段落增删移动」） */
  function moveSection(index: number, delta: -1 | 1): void {
    const list = editor.value?.sections
    const to = index + delta
    if (!list || to < 0 || to >= list.length) return
    const [item] = list.splice(index, 1)
    list.splice(to, 0, item!)
    markDirty()
    precheck.value = null
  }

  function updateTitle(title: string): void {
    if (!editor.value) return
    editor.value.title = title
    markDirty()
  }

  /**
   * 保存当前稿。
   * @returns 'ok' | 'conflict' | 'need_confirm' | 'error'
   */
  async function save(confirmReedit = false): Promise<SaveResult> {
    if (activeSave) {
      const result = await activeSave
      if (result !== 'ok' || !isDirty.value) return result
    }
    const task = performSave(confirmReedit)
    activeSave = task
    try { return await task } finally { if (activeSave === task) activeSave = null }
  }
  async function performSave(confirmReedit = false): Promise<SaveResult> {
    if (!editor.value || !copy.value) return 'error'
    cancelAutosave()
    const e = editor.value
    const savingSeq = e.editSeq
    e.saving = true
    e.saveError = null
    error.value = null
    saveInFlight = true
    try {
      const r = await copyApi.saveDraft(copy.value.id, e.draftId, {
        title: e.title || null,
        sections: e.sections,
        rev: e.rev,
        confirmReedit,
      })
      e.rev = r.draft.rev
      // P0-5：只有「发出请求时」与「当前」的编辑序号一致才算干净
      e.savedSeq = savingSeq
      e.conflict = false
      e.lastSavedAt = r.draft.updatedAt
      precheck.value = null
      if (e.editSeq === savingSeq) clearLocalDraft(copy.value.id, e.draftId)
      // P0-5：不再整体重拉 detail（每次保存都拉会触发懒建稿副作用、也拖慢输入）；
      // 只就地更新当前稿的 rev / updatedAt 与列表里的对应项。
      patchDetailAfterSave(e.draftId, r.draft.rev, r.draft.updatedAt, r.draft)
      return 'ok'
    } catch (err0) {
      const ex = err0
      if (ex instanceof ApiError) {
        if (ex.code === 'COPY_DRAFT_CONFLICT') {
          e.conflict = true
          error.value = '该稿已在其他页面修改，请载入最新内容或另存为新稿'
          return 'conflict'
        }
        if (ex.code === 'COPY_LOCKED') {
          error.value = '文案正在审核中，暂不可编辑'
          return 'error'
        }
        if (ex.status === 409 && (ex as unknown as { details?: { requiresConfirm?: boolean } }).details?.requiresConfirm) {
          return 'need_confirm'
        }
        e.saveError = ex.message
        error.value = ex.message
      } else {
        e.saveError = (ex as Error).message || '保存失败'
        error.value = e.saveError
      }
      // 失败时保留本地暂存，下次打开可恢复（AC-F4）
      persistLocal()
      return 'error'
    } finally {
      if (editor.value) editor.value.saving = false
      saveInFlight = false
      if (saveAgain) {
        saveAgain = false
        scheduleAutosave()
      }
    }
  }

  /** 保存成功后轻量打补丁，避免整份 detail 重拉 */
  function patchDetailAfterSave(draftId: string, rev: number, updatedAt: string, saved: Draft): void {
    const d = detail.value
    if (!d) return
    const target = d.drafts.find((x) => x.id === draftId)
    if (target) {
      const unchanged = target.title === saved.title && JSON.stringify(target.sections) === JSON.stringify(saved.sections)
      const isFinal = target.isFinal && unchanged
      Object.assign(target, saved, { isFinal })
      target.rev = rev
      target.updatedAt = updatedAt
    }
    if (d.currentDraft && d.currentDraft.id === draftId) {
      d.currentDraft.rev = rev
      d.currentDraft.updatedAt = updatedAt
      d.currentDraft.title = editor.value?.title ?? d.currentDraft.title
      d.currentDraft.sections = editor.value?.sections ?? d.currentDraft.sections
    }
    // 本地暂存也不应再提示「本地更新」
    if (editor.value) editor.value.localNewer = false
  }

  /** 载入最新（放弃本地改动） */
  async function reloadDraft(): Promise<void> {
    if (!copy.value || !editor.value) return
    cancelAutosave()
    const d = await copyApi.getDraft(copy.value.id, editor.value.draftId)
    clearLocalDraft(copy.value.id, d.id)
    editor.value = {
      draftId: d.id,
      title: d.title ?? '',
      sections: toEditableSections(d.sections),
      rev: d.rev,
      editSeq: 0,
      savedSeq: 0,
      saving: false,
      lastSavedAt: d.updatedAt,
      conflict: false,
      saveError: null,
      localNewer: false,
    }
  }

  /** 另存为新稿，保住本地内容 */
  async function saveAsNewDraft(): Promise<void> {
    if (!copy.value || !editor.value) return
    const created = await copyApi.createDraft(copy.value.id)
    editor.value.draftId = created.id
    editor.value.rev = 0
    // 换了稿，编辑序号重新对齐，避免上一稿的序号影响脏判断
    editor.value.savedSeq = 0
    editor.value.editSeq = Math.max(1, editor.value.editSeq)
    const r = await save()
    if (r === 'ok') await load(copy.value.id)
  }

  async function runPrecheck(): Promise<PrecheckResult | null> {
    if (!(await saveCreativeSettings())) { error.value = settingsError.value; return null }
    if (!copy.value || !editor.value) return null
    // 预检先落盘，避免校验的是旧内容
    if (isDirty.value) {
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
      if (isDirty.value) {
        const r = await save()
        if (r !== 'ok' && r !== 'need_confirm') {
          generating.value = false
          return false
        }
      }
      const accepted = await copyApi.generate(copy.value.id, body)
      activeGeneration.value = { id: accepted.generationId, status: accepted.status, count: body.count, succeeded: 0, failed: 0 } as Generation
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
            if (!isDirty.value) syncEditorFromCurrent()
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
    creativeSettings, settingsSaving, settingsError, settingsDirty, saveCreativeSettings,
    options,
    optionsLoading,
    detail,
    loading,
    error,
    notFound,
    editor,
    /** P0-5：派生脏状态（替代原来的 editor.dirty 布尔） */
    isDirty,
    saveState,
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
    updateTitle,
    addSection,
    removeSection,
    moveSection,
    undo,
    redo,
    canUndo,
    canRedo,
    save,
    autosave,
    cancelAutosave,
    discardLocalDraft,
    acceptServerState,
    reloadDraft,
    saveAsNewDraft,
    runPrecheck,
    generate,
    stopPolling,
    reset,
  }
})
