<template>
  <div class="mw-card copy-editor" :class="{ 'is-continuous': !showParagraphTools }">
    <!-- 生成完成后自动切稿的提示：内容被静默替换最容易让人以为丢了东西 -->
    <div v-if="store.switchedNotice" class="switch-notice">
      <icon-swap class="text-[#1d4ed8]" />
      <span class="flex-1">
        已自动切换到生成结果
        <b>{{ store.switchedNotice.draftName }}</b>
        （{{ store.switchedNotice.wordCount }} 字）
      </span>
      <a-link @click="store.switchedNotice = null">知道了</a-link>
    </div>

    <!-- 头部：稿切换 + 操作 -->
    <div class="copy-editor-toolbar px-5 pt-4 pb-3 border-b border-[#f0f3f8]">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <!-- 稿 tab（效果图「稿 1 / 稿 2 / 稿 3」），稿多时横向滚动 -->
          <div ref="draftTabs" class="draft-tabs">
            <button
              v-for="d in store.drafts"
              :key="d.id"
              type="button"
              class="draft-tab"
              :class="{ active: d.id === editor?.draftId }"
              :title="`${d.title || d.name} · ${d.wordCount} 字`"
              @click="onSwitchDraft(d.id)"
            >
              {{ d.isFinal ? '✓ ' : '' }}{{ d.name }}
            </button>
          </div>

          <a-tooltip content="新建空白稿">
            <a-button size="mini" shape="circle" :disabled="!store.canEdit" @click="onNewDraft">
              <icon-plus />
            </a-button>
          </a-tooltip>
          <a-tooltip content="另存为新稿（保留当前内容）">
            <a-button size="mini" shape="circle" :disabled="!store.canEdit || !editor" @click="onDuplicate">
              <icon-copy />
            </a-button>
          </a-tooltip>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <span v-if="saveHint" class="mw-subtle">{{ saveHint }}</span>
          <a-button
            v-if="store.saveState === 'error'"
            size="small"
            :disabled="!store.isDirty || !store.canEdit"
            :loading="editor?.saving"
            @click="onSave"
          >
            保存
          </a-button>
        </div>
      </div>

      <!-- 冲突提示 -->
      <div v-if="editor?.conflict" class="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-[#fdf4e3]">
        <icon-exclamation-circle-fill style="color: #a26a08" />
        <span class="text-[12px] text-[#a26a08] flex-1">该稿已在其他页面修改</span>
        <a-link @click="onReload">载入最新</a-link>
        <a-link @click="onSaveAsNew">另存为新稿</a-link>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="!editor" class="py-16">
      <a-empty description="暂无稿件，点击 + 新建一份，或用左侧「生成文案」">
        <a-button v-if="store.canEdit" type="primary" @click="onNewDraft">新建空白稿</a-button>
      </a-empty>
    </div>

    <template v-else>
      <!-- 精简工具栏（W4）：撤销 / 重做；段落的增删移动在各段右上角 -->
      <div class="px-5 pt-3 flex items-center gap-1">
        <a-button size="mini" type="text" :disabled="!editor.sections.some((s) => s.text.trim())" @click="onCopyBody"
          >复制正文</a-button
        >
        <a-button
          size="mini"
          type="text"
          :aria-pressed="showParagraphTools"
          @click="showParagraphTools = !showParagraphTools"
          >{{ showParagraphTools ? '收起段落工具' : '段落工具' }}</a-button
        >
        <a-tooltip content="撤销">
          <a-button aria-label="撤销" size="mini" type="text" :disabled="!store.canUndo" @click="store.undo()">
            <template #icon><icon-undo /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip content="重做">
          <a-button aria-label="重做" size="mini" type="text" :disabled="!store.canRedo" @click="store.redo()">
            <template #icon><icon-redo /></template>
          </a-button>
        </a-tooltip>
      </div>

      <!-- 标题 -->
      <div class="px-5 pt-2">
        <a-textarea
          v-model="editor.title"
          :max-length="store.options?.limits.maxTitle ?? 60"
          :disabled="readonly"
          placeholder="文案标题"
          :auto-size="{ minRows: 1 }"
          aria-label="文案标题"
          id="copy-draft-title"
          class="title-input"
          @input="store.markDirty()"
        />
      </div>

      <!-- 段落 -->
      <div class="px-5 py-3 space-y-3">
        <div
          v-for="(s, i) in editor.sections"
          :key="i"
          class="section-item"
          :id="`copy-section-${i}`"
          :class="{
            'has-violation': hardViolations.has(i),
            'has-soft-warning': violations.has(i) && !hardViolations.has(i),
          }"
        >
          <div v-if="showParagraphTools" class="section-actions flex items-center gap-2 mb-1.5">
            <span v-if="s.sourceRefs?.length" class="mw-subtle">原文 {{ s.sourceRefs.join('、') }} 段</span>
            <span class="flex-1" />
            <a-tooltip content="生成这一段的其他写法">
              <a-button
                aria-label="生成本段其他写法"
                size="mini"
                type="text"
                :disabled="readonly"
                @click="emit('variant', i)"
              >
                <template #icon><icon-swap /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip content="上移">
              <a-button
                aria-label="上移段落"
                size="mini"
                type="text"
                :disabled="readonly || i === 0"
                @click="store.moveSection(i, -1)"
              >
                <template #icon><icon-arrow-up /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip content="下移">
              <a-button
                aria-label="下移段落"
                size="mini"
                type="text"
                :disabled="readonly || i === editor.sections.length - 1"
                @click="store.moveSection(i, 1)"
              >
                <template #icon><icon-arrow-down /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip content="删除本段">
              <a-button aria-label="删除段落" size="mini" type="text" :disabled="readonly" @click="onRemoveSection(i)">
                <template #icon><icon-delete /></template>
              </a-button>
            </a-tooltip>
          </div>

          <a-textarea
            v-model="s.text"
            :disabled="readonly"
            :auto-size="{ minRows: 1 }"
            :aria-label="`第 ${i + 1} 段正文`"
            placeholder="输入文案正文"
            @input="onSectionInput(i)"
          />

          <!-- 合规命中 -->
          <div v-if="hitsOfSection(i).length" class="mt-1 flex flex-wrap gap-1.5">
            <a-tag
              v-for="(h, hi) in hitsOfSection(i)"
              :key="hi"
              :color="h.level === 'hard' ? 'red' : 'orange'"
              size="small"
            >
              {{ h.level === 'hard' ? '禁用' : '提示' }}：{{ h.word }}
            </a-tag>
          </div>
        </div>

        <a-button v-if="showParagraphTools && !readonly" long type="dashed" size="small" @click="onAddSection">
          <template #icon><icon-plus /></template>
          添加段落
        </a-button>
      </div>

      <!-- 只读风险提示块（W4，不计字数） -->
      <details class="risk-caption mx-5 mb-4 px-3.5 py-2.5 rounded-lg bg-[#f8fafd] border border-[#eef2f8]">
        <summary>风险提示字幕</summary>
        <div class="mt-2 text-[12px] leading-[1.8] text-[#7c8798]">{{ riskHint }}</div>
      </details>

      <!-- 底部统计 -->
      <div class="copy-editor-status">
        <span
          >正文 <b class="text-[#131f38] tabular-nums">{{ bodyWords }}</b> 字</span
        >
        <span
          >预计 <b class="text-[#131f38] tabular-nums">{{ estSeconds }}</b> 秒</span
        >
        <span class="flex-1" />
        <span v-if="wordOffsetHint" :class="wordOffsetHint.cls">{{ wordOffsetHint.text }}</span>
      </div>
    </template>
    <a-modal :visible="!!pendingDraft" title="当前稿有未保存改动" @cancel="cancelSwitch"
      ><p>可以先保存再切换，也可以留在当前稿继续编辑。</p>
      <template #footer
        ><a-button @click="cancelSwitch">继续编辑</a-button
        ><a-button status="danger" @click="confirmSwitch(true)">放弃并切换</a-button
        ><a-button type="primary" :loading="editor?.saving" @click="confirmSwitch(false)"
          >保存并切换</a-button
        ></template
      ></a-modal
    >
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type ComplianceHit } from '@/api/copy'

const emit = defineEmits<{ (e: 'variant', sectionIndex: number): void }>()
const store = useCopyStore()
const showParagraphTools = ref(false)
const draftTabs = ref<HTMLElement | null>(null)
let tabsObserver: ResizeObserver | undefined
function revealCurrentTab() {
  const strip = draftTabs.value,
    active = strip?.querySelector<HTMLElement>('.draft-tab.active')
  if (!strip || !active) return
  const box = strip.getBoundingClientRect(),
    tab = active.getBoundingClientRect()
  if (tab.right > box.right) strip.scrollLeft += tab.right - box.right + 4
  else if (tab.left < box.left) strip.scrollLeft += tab.left - box.left - 4
}
onMounted(() => {
  tabsObserver = new ResizeObserver(revealCurrentTab)
  if (draftTabs.value) tabsObserver.observe(draftTabs.value)
})
onBeforeUnmount(() => tabsObserver?.disconnect())
const pendingDraft = ref<string | null>(null)
let resolveSwitch: ((v: boolean) => void) | null = null
defineExpose({ selectDraft: onSwitchDraft })
function locateHit(e: Event) {
  const h = (e as CustomEvent).detail as ComplianceHit
  void nextTick(() => {
    const el = document.querySelector<HTMLTextAreaElement>(
      h.sectionIndex < 0
        ? '#copy-draft-title textarea, textarea#copy-draft-title'
        : `#copy-section-${h.sectionIndex} textarea`,
    )
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el?.focus()
    el?.setSelectionRange(h.start, h.end)
  })
}
onMounted(() => window.addEventListener('copy-focus-hit', locateHit))
onBeforeUnmount(() => {
  window.removeEventListener('copy-focus-hit', locateHit)
  resolveSwitch?.(false)
})

const editor = computed(() => store.editor)
const readonly = computed(() => !store.canEdit || store.locked)

watch(
  () => [editor.value?.draftId, store.drafts.length],
  () => {
    void nextTick(revealCurrentTab)
  },
  { immediate: true, flush: 'post' },
)

const riskHint = computed(() => {
  const tpl = store.options?.templates.find(
    (t) => t.id === (store.copy?.settings as Record<string, unknown>)?.templateId,
  )
  return (
    tpl?.riskHint || '本内容仅作信息分享与投资者教育，不构成投资建议。市场有风险，投资须谨慎；历史表现不代表未来收益。'
  )
})

/** P0-5：底栏保存状态（FR-E2：保存中 / 已自动保存 HH:mm / 保存失败可重试） */
const saveHint = computed(() => {
  if (!editor.value) return ''
  const state = store.saveState
  if (state === 'saving') return '保存中…'
  if (state === 'error') return `保存失败：${editor.value.saveError ?? '可重试'}`
  if (state === 'dirty') return '有未保存改动'
  if (editor.value.lastSavedAt) {
    const d = new Date(editor.value.lastSavedAt)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `已自动保存 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return ''
})

/** 与后端一致的字数口径：汉字 1、连续英文/数字串 1、标点与空白不计 */
function countText(text: string): number {
  const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
  const ALNUM = /[A-Za-z0-9]/
  let count = 0
  let inWord = false
  for (const ch of text ?? '') {
    if (CJK.test(ch)) {
      count += 1
      inWord = false
    } else if (ALNUM.test(ch)) {
      if (!inWord) {
        count += 1
        inWord = true
      }
    } else {
      inWord = false
    }
  }
  return count
}

const totalWords = computed(() => {
  if (!editor.value) return 0
  const title = editor.value.title?.trim()
  return (title ? countText(title) : 0) + editor.value.sections.reduce((sum, s) => sum + countText(s.text), 0)
})
const bodyWords = computed(() => editor.value?.sections.reduce((sum, s) => sum + countText(s.text), 0) ?? 0)

/** 与后端 estimateSeconds 一致：保留 1 位小数（÷3.5），避免与预检口径不一致 */
const estSeconds = computed(() => {
  const cps = store.options?.limits.charsPerSec ?? 3.5
  return Math.round((bodyWords.value / cps) * 10) / 10
})

/** 字数偏离提示（软性，不阻断） */
const wordOffsetHint = computed(() => {
  const tier = store.options?.durationTiers.find(
    (d) => d.key === ((store.copy?.settings as Record<string, unknown>)?.durationTier ?? 'medium'),
  )
  if (!tier) return null
  const max = tier.custom ? Number(store.creativeSettings.durationSeconds) : tier.maxSeconds
  const min = tier.custom ? max : tier.minSeconds
  if (estSeconds.value > max)
    return { text: `预计超时 ${(estSeconds.value - max).toFixed(1)} 秒`, cls: 'text-[#b95f1d]' }
  if (estSeconds.value < min)
    return { text: `预计少于目标 ${(min - estSeconds.value).toFixed(1)} 秒`, cls: 'text-[#b95f1d]' }
  if (tier.custom) return { text: '预计时长符合目标', cls: 'text-[#12805c]' }
  if (totalWords.value < tier.minWords) return { text: `低于建议下限 ${tier.minWords} 字`, cls: 'text-[#b95f1d]' }
  if (totalWords.value > tier.maxWords) return { text: `超出建议上限 ${tier.maxWords} 字`, cls: 'text-[#b95f1d]' }
  return { text: '字数在建议区间内', cls: 'text-[#12805c]' }
})

/**
 * P1-22 / FR-R1：编辑时防抖实时合规扫描（800ms），与「预检」的两份命中取并集。
 * 之前只读 store.precheck，必须先跑预检才有高亮，边写边改看不到风险词。
 */
const liveHits = ref<ComplianceHit[]>([])
const liveScanning = ref(false)
let liveTimer: ReturnType<typeof setTimeout> | null = null

const hits = computed<ComplianceHit[]>(() => {
  const pre = store.precheck?.complianceHits ?? []
  if (!liveHits.value.length) return pre
  // 同一位置同一词只保留一次（预检与实时扫描可能都命中）
  const seen = new Set<string>()
  const out: ComplianceHit[] = []
  for (const h of [...pre, ...liveHits.value]) {
    const k = `${h.sectionIndex}:${h.start}:${h.end}:${h.word}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(h)
  }
  return out
})

async function runLiveScan(): Promise<void> {
  const e = editor.value
  const c = store.copy
  if (!e || !c) {
    liveHits.value = []
    return
  }
  liveScanning.value = true
  try {
    const r = await copyApi.scanCompliance({
      copyId: c.id,
      title: e.title,
      sections: e.sections,
    })
    liveHits.value = r.hits
  } catch {
    // 实时扫描是辅助能力，失败不打扰用户（预检仍会在提交前把关）
  } finally {
    liveScanning.value = false
  }
}

function scheduleLiveScan(): void {
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = setTimeout(() => {
    liveTimer = null
    void runLiveScan()
  }, 800)
}

// 段落文本 / 标题 / 当前稿变化时重新扫描
watch(
  () => [
    editor.value?.draftId,
    editor.value?.title,
    editor.value?.editSeq,
    editor.value?.sections.map((s) => `${s.label}|${s.text}`).join('\u0001'),
  ],
  () => {
    if (!editor.value) {
      liveHits.value = []
      return
    }
    scheduleLiveScan()
  },
)

onBeforeUnmount(() => {
  if (liveTimer) clearTimeout(liveTimer)
})

const violations = computed(() => new Set(hits.value.map((h) => h.sectionIndex)))
const hardViolations = computed(() => new Set(hits.value.filter((h) => h.level === 'hard').map((h) => h.sectionIndex)))

function hitsOfSection(index: number): ComplianceHit[] {
  return hits.value.filter((h) => h.sectionIndex === index)
}

/** P1-22：标题的命中（sectionIndex = -1） */

function onSectionInput(_index: number): void {
  store.markDirty()
}

async function onCopyBody(): Promise<void> {
  const text = editor.value?.sections
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n\n')
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    Message.success('已复制正文')
  } catch {
    Message.error('复制失败，请手动选择正文复制')
  }
}

function onAddSection(): void {
  store.addSection()
}

function onRemoveSection(index: number): void {
  Modal.confirm({
    title: '删除该段落？',
    content: '删除后可用「撤销」或「历史版本」恢复。',
    okText: '删除',
    cancelText: '取消',
    onOk: () => store.removeSection(index),
  })
}

async function onSave(): Promise<void> {
  const r = await store.save()
  if (r === 'ok') Message.success('已保存')
  else if (r === 'need_confirm') {
    Modal.confirm({
      title: '该文案已审核通过',
      content: '修改后需重新提交审核，原通过版本会保留。是否继续？',
      okText: '继续修改',
      cancelText: '取消',
      onOk: async () => {
        const r2 = await store.save(true)
        if (r2 === 'ok') Message.success('已保存，文案进入修订中')
      },
    })
  } else if (r === 'error') {
    Message.error(store.error ?? '保存失败')
  }
}

async function onReload(): Promise<void> {
  await store.reloadDraft()
  Message.success('已载入最新内容')
}

async function onSaveAsNew(): Promise<void> {
  await store.saveAsNewDraft()
  Message.success('已另存为新稿')
}

async function onSwitchDraft(draftId: string): Promise<boolean> {
  if (draftId === editor.value?.draftId) return true
  if (store.isDirty) {
    if (pendingDraft.value) return false
    store.cancelAutosave()
    pendingDraft.value = draftId
    return new Promise((resolve) => {
      resolveSwitch = resolve
    })
  }
  return await store.switchDraft(draftId)
}
function cancelSwitch() {
  pendingDraft.value = null
  resolveSwitch?.(false)
  resolveSwitch = null
  if (store.isDirty) void store.autosave()
}
async function confirmSwitch(discard: boolean) {
  const id = pendingDraft.value
  if (!id) return
  if (discard) store.acceptServerState()
  else if ((await store.save()) !== 'ok') {
    Message.error(store.error || '保存未完成，请继续编辑')
    return
  }
  const ok = await store.switchDraft(id)
  pendingDraft.value = null
  resolveSwitch?.(ok)
  resolveSwitch = null
}

async function onNewDraft(): Promise<void> {
  if (store.isDirty) {
    Message.warning('请先保存当前稿再新建')
    return
  }
  const created = await copyApi.createDraft(store.copy!.id)
  await store.load(store.copy!.id)
  await store.switchDraft(created.id)
  Message.success('已新建空白稿')
}

async function onDuplicate(): Promise<void> {
  if (!editor.value) return
  const created = await copyApi.createDraft(store.copy!.id, editor.value.draftId)
  await store.load(store.copy!.id)
  Message.success(`已复制为「${created.name}」`)
}
</script>

<style scoped>
.is-continuous .section-item {
  background: transparent;
  padding: 0;
  border-radius: 0;
}
.is-continuous .section-item :deep(.arco-textarea-wrapper) {
  background: transparent;
  border-color: transparent;
}
.section-item :deep(.arco-textarea) {
  font-size: 16px;
  line-height: 2;
}
.is-continuous .section-item :deep(.arco-textarea) {
  padding: 0;
}
.is-continuous .section-item :deep(.arco-textarea-wrapper:focus-within) {
  border-color: #dbe6df;
}
.risk-caption summary {
  font-size: 12px;
  color: #6b7688;
  cursor: pointer;
}

.switch-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 12.5px;
  color: #1d4ed8;
  background: #f2f7ff;
  border-bottom: 1px solid #dbe8ff;
  border-radius: 8px 8px 0 0;
  animation: notice-in 0.3s ease;
}
.switch-notice b {
  font-weight: 600;
}
@keyframes notice-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.draft-tabs {
  display: flex;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}
.draft-tab {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 7px;
  border: 1px solid #e6ecf5;
  background: #fbfcfe;
  font-size: 13px;
  color: #3c4a63;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.16s ease;
}
.draft-tab:hover {
  border-color: #ccd9ef;
  background: #fff;
}
.draft-tab.active {
  border-color: var(--mw-primary-mid, #4f7cf7);
  background: var(--mw-primary-faint, #eef3ff);
  color: #1d4ed8;
  font-weight: 500;
}
.title-input :deep(.arco-input) {
  font-size: 16px;
  font-weight: 600;
  color: #131f38;
  border: none;
  border-bottom: 1px solid transparent;
  border-radius: 0;
  padding-left: 0;
  transition: border-color 0.18s ease;
}
.title-input :deep(.arco-input:hover),
.title-input :deep(.arco-input-focus) {
  border-bottom-color: #e6ecf5;
  box-shadow: none;
}

.section-item {
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid transparent;
  background: #fbfcfe;
  transition: all 0.18s ease;
}
.section-item:hover {
  background: #f8fafd;
}
.section-item.has-violation {
  border-color: #f5d4d1;
  background: #fefafa;
}
</style>
