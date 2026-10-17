<template>
  <div class="mw-card">
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
    <div class="px-5 pt-4 pb-3 border-b border-[#f0f3f8]">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <a-dropdown trigger="click" :disabled="!store.drafts.length">
            <button type="button" class="draft-picker">
              <icon-file class="text-[#8b98ad]" />
              <span class="truncate">{{ currentDraftLabel }}</span>
              <icon-down class="text-[#9aa6ba] shrink-0" />
            </button>
            <template #content>
              <a-doption
                v-for="d in store.drafts"
                :key="d.id"
                :value="d.id"
                @click="onSwitchDraft(d.id)"
              >
                <div class="flex items-center justify-between gap-6 w-full">
                  <span class="flex items-center gap-2">
                    <a-tag :color="d.origin === 'ai' ? 'arcoblue' : 'gray'" size="small">
                      {{ d.origin === 'ai' ? 'AI' : '手写' }}
                    </a-tag>
                    {{ d.name }}
                  </span>
                  <span class="mw-subtle tabular-nums">{{ d.wordCount }}字</span>
                </div>
              </a-doption>
            </template>
          </a-dropdown>

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
          <a-button size="small" :disabled="!store.isDirty || !store.canEdit" :loading="editor?.saving" @click="onSave">
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
      <!-- 标题 -->
      <div class="px-5 pt-4">
        <a-input
          v-model="editor.title"
          :max-length="store.options?.limits.maxTitle ?? 60"
          :disabled="readonly"
          placeholder="文案标题"
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
          :class="{ 'has-violation': violations.has(i) }"
        >
          <div class="flex items-center gap-2 mb-1.5">
            <a-input
              v-model="s.label"
              size="mini"
              :disabled="readonly"
              placeholder="段落名"
              class="!w-[150px] section-label"
              @input="store.markDirty()"
            />
            <span class="mw-subtle tabular-nums">{{ countText(s.text) }} 字</span>
            <span v-if="s.sourceRefs?.length" class="mw-subtle">原文 {{ s.sourceRefs.join('、') }} 段</span>
            <span class="flex-1" />
            <a-tooltip content="生成这一段的其他写法">
              <a-button size="mini" type="text" :disabled="readonly" @click="emit('variant', i)">
                <template #icon><icon-swap /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip content="删除本段">
              <a-button size="mini" type="text" :disabled="readonly" @click="onRemoveSection(i)">
                <template #icon><icon-delete /></template>
              </a-button>
            </a-tooltip>
          </div>

          <a-textarea
            v-model="s.text"
            :disabled="readonly"
            :auto-size="{ minRows: 2, maxRows: 10 }"
            placeholder="这一段的口播内容"
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

        <a-button v-if="!readonly" long type="dashed" size="small" @click="onAddSection">
          <template #icon><icon-plus /></template>
          添加段落
        </a-button>
      </div>

      <!-- 只读风险提示块（W4，不计字数） -->
      <div class="mx-5 mb-4 px-3.5 py-2.5 rounded-lg bg-[#f8fafd] border border-[#eef2f8]">
        <div class="flex items-center gap-1.5 mb-1">
          <icon-safe class="text-[#8b98ad]" :size="13" />
          <span class="text-[12px] font-medium text-[#6b7688]">风险提示（自动附加，不计入字数）</span>
        </div>
        <div class="text-[12px] leading-[1.8] text-[#7c8798]">{{ riskHint }}</div>
      </div>

      <!-- 底部统计 -->
      <div class="px-5 py-3 border-t border-[#f0f3f8] flex items-center gap-4 text-[12px] text-[#6b7688]">
        <span>正文 <b class="text-[#131f38] tabular-nums">{{ totalWords }}</b> 字</span>
        <span>预计 <b class="text-[#131f38] tabular-nums">{{ estSeconds }}</b> 秒</span>
        <span class="mw-subtle">口径：汉字计 1、连续英文数字计 1、标点与空白不计、风险块不计</span>
        <span class="flex-1" />
        <span v-if="wordOffsetHint" :class="wordOffsetHint.cls">{{ wordOffsetHint.text }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type ComplianceHit } from '@/api/copy'

const emit = defineEmits<{ (e: 'variant', sectionIndex: number): void }>()
const store = useCopyStore()

const editor = computed(() => store.editor)
const readonly = computed(() => !store.canEdit || store.locked)

const currentDraftLabel = computed(() => {
  const d = store.drafts.find((x) => x.id === editor.value?.draftId)
  if (!d) return '选择稿件'
  return `${d.name} · 第 ${d.draftNo} 份`
})

const riskHint = computed(() => {
  const tpl = store.options?.templates.find((t) => t.id === (store.copy?.settings as Record<string, unknown>)?.templateId)
  return (
    tpl?.riskHint ||
    '本内容仅作信息分享与投资者教育，不构成投资建议。市场有风险，投资须谨慎；历史表现不代表未来收益。'
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

/** 与后端 estimateSeconds 一致：保留 1 位小数（÷3.5），避免与预检口径不一致 */
const estSeconds = computed(() => {
  const cps = store.options?.limits.charsPerSec ?? 3.5
  return Math.round((totalWords.value / cps) * 10) / 10
})

/** 字数偏离提示（软性，不阻断） */
const wordOffsetHint = computed(() => {
  const tier = store.options?.durationTiers.find(
    (d) => d.key === ((store.copy?.settings as Record<string, unknown>)?.durationTier ?? 'medium'),
  )
  if (!tier) return null
  if (tier.custom) return null
  if (totalWords.value < tier.minWords)
    return { text: `低于建议下限 ${tier.minWords} 字`, cls: 'text-[#b95f1d]' }
  if (totalWords.value > tier.maxWords)
    return { text: `超出建议上限 ${tier.maxWords} 字`, cls: 'text-[#b95f1d]' }
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

function hitsOfSection(index: number): ComplianceHit[] {
  return hits.value.filter((h) => h.sectionIndex === index)
}

/** P1-22：标题的命中（sectionIndex = -1） */
const titleHits = computed(() => hits.value.filter((h) => h.sectionIndex === -1))

function onSectionInput(_index: number): void {
  store.markDirty()
}

function onAddSection(): void {
  store.addSection()
}

function onRemoveSection(index: number): void {
  Modal.confirm({
    title: '删除该段落？',
    content: '删除后可通过「历史版本」恢复。',
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

async function onSwitchDraft(draftId: string): Promise<void> {
  if (draftId === editor.value?.draftId) return
  if (store.isDirty) {
    Modal.confirm({
      title: '当前稿有未保存改动',
      content: '切换稿件会丢失这些改动，是否先保存？',
      okText: '保存并切换',
      cancelText: '放弃改动',
      onOk: async () => {
        const r = await store.save()
        if (r === 'ok') await store.switchDraft(draftId)
      },
      onCancel: async () => {
        // 放弃改动：丢掉本地暂存并让 store 认为无脏数据
        store.acceptServerState()
        await store.switchDraft(draftId)
      },
    })
    return
  }
  await store.switchDraft(draftId)
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
.draft-picker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 3px 10px;
  border-radius: 7px;
  border: 1px solid #e6ecf5;
  background: #fbfcfe;
  font-size: 13px;
  color: #3c4a63;
  cursor: pointer;
  transition: all 0.16s ease;
}
.draft-picker:hover {
  border-color: #ccd9ef;
  background: #fff;
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

.section-label :deep(.arco-input) {
  background: transparent;
  border-color: transparent;
  font-weight: 500;
  color: #4a5872;
  padding-left: 0;
}
.section-label :deep(.arco-input:hover) {
  border-color: #e6ecf5;
}
</style>
