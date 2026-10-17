<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="文案工坊">
      <template #sub>
        <span v-if="copy">
          {{ copy.title || '（未命名文案）' }}
          <template v-if="copy.persona"> · {{ copy.persona.name }}</template>
          <template v-if="copy.lineLabel"> · {{ copy.lineLabel }}</template>
        </span>
        <span v-else>从爆款选题或文章生成可审核、可追溯的口播文案</span>
      </template>
      <template #actions>
        <a-button @click="listVisible = true">
          <template #icon><icon-file /></template>
          草稿记录
        </a-button>
        <!-- P1-21：效果图页头为「草稿记录 / 保存草稿 / 提交审核」，补回「保存草稿」（FR-E3 manual_save） -->
        <a-button
          :disabled="!copy || !store.editor || !store.isDirty || !store.canEdit"
          :loading="store.editor?.saving"
          @click="onSaveDraft"
        >
          <template #icon><icon-save /></template>
          保存草稿
        </a-button>
        <a-button
          v-if="copy && copy.status === 'in_review'"
          type="text"
          @click="onWithdraw"
        >
          <template #icon><icon-undo /></template>
          撤回提交
        </a-button>
        <a-button
          v-if="copy && (copy.status === 'draft' || copy.status === 'rejected')"
          type="primary"
          :disabled="!store.editor"
          @click="submitVisible = true"
        >
          <template #icon><icon-send /></template>
          提交审核
        </a-button>
        <a-button v-else-if="copy && copy.status === 'approved'" type="primary" @click="onGoVideo">
          <template #icon><icon-video-camera /></template>
          去视频创作
        </a-button>
      </template>
    </PageHead>

    <!-- 步骤条 -->
    <div v-if="copy" class="flex items-center mb-6 px-1">
      <div class="mw-step" :class="stepClass(1)"><span class="mw-step-index">1</span>写文案</div>
      <div class="mw-step-line" :class="{ done: stepDone(1) }"></div>
      <div class="mw-step" :class="stepClass(2)"><span class="mw-step-index">2</span>自动预检</div>
      <div class="mw-step-line" :class="{ done: stepDone(2) }"></div>
      <div class="mw-step" :class="stepClass(3)"><span class="mw-step-index">3</span>人工复核</div>
      <div class="mw-step-line" :class="{ done: stepDone(3) }"></div>
      <div class="mw-step" :class="stepClass(4)"><span class="mw-step-index">4</span>视频创作</div>
    </div>

    <!-- 加载 -->
    <div v-if="store.loading" class="grid grid-cols-[46fr_54fr] gap-5">
      <div class="mw-card p-5"><a-skeleton :animation="true"><a-skeleton-line :rows="8" /></a-skeleton></div>
      <div class="mw-card p-5"><a-skeleton :animation="true"><a-skeleton-line :rows="12" /></a-skeleton></div>
    </div>

    <!-- 加载失败 / 不存在 -->
    <div v-else-if="store.notFound" class="mw-card py-20 text-center">
      <icon-exclamation-circle style="font-size: 44px; color: #d5dce7" />
      <div class="text-[15px] font-medium text-[#3c4a63] mt-3">文案不存在或已被删除</div>
      <div class="mw-subtle mt-1.5">可能链接已失效，或该文案已被归档</div>
      <a-button type="primary" class="mt-5" @click="listVisible = true">打开文案列表</a-button>
    </div>
    <div v-else-if="store.error && !copy" class="mw-card py-20 text-center">
      <icon-exclamation-circle style="font-size: 44px; color: #f0b3ac" />
      <div class="text-[15px] font-medium text-[#3c4a63] mt-3">加载失败</div>
      <div class="mw-subtle mt-1.5">{{ store.error }}</div>
      <a-button type="primary" class="mt-5" @click="reload">重试</a-button>
    </div>

    <!-- 空态：还没有选中文案 -->
    <div v-else-if="!copy" class="mw-card py-24 text-center">
      <icon-file style="font-size: 44px; color: #d5dce7" />
      <div class="text-[15px] font-medium text-[#3c4a63] mt-3">还没有打开任何文案</div>
      <div class="mw-subtle mt-1.5">可以从文案列表中选择，或新建一条</div>
      <a-button type="primary" class="mt-5" @click="listVisible = true">打开文案列表</a-button>
    </div>

    <!-- 主体 -->
    <div v-else class="grid grid-cols-[46fr_54fr] gap-5 items-start">
      <div class="flex flex-col gap-5">
        <SourcePanel />
        <SettingsPanel @preview="onPreviewPrompt" />
      </div>
      <div class="flex flex-col gap-5">
        <ReviewPanel v-if="showReview" />
        <DraftEditor @variant="onVariant" />
      </div>
    </div>

    <!-- 弹层 -->
    <CopyListDrawer
      v-model:visible="listVisible"
      :initial-ids="pendingIds"
      @picked="(id) => router.replace({ query: { id } })"
    />
    <VersionDrawer v-model:visible="versionVisible" />
    <SubmitDialog v-model:visible="submitVisible" @submitted="onSubmitted" />
    <VariantPanel v-model:visible="variantVisible" :section-index="variantIndex" />
    <TemplateEditor v-model:visible="configVisible" />

    <!-- 提示词预览 -->
    <a-modal v-model:visible="promptVisible" title="提示词预览" :width="720" :footer="false" unmount-on-close>
      <a-spin :loading="promptLoading">
        <div v-if="promptData">
          <div class="flex items-center gap-3 mb-3">
            <span class="mw-subtle">字数区间 {{ promptData.wordRange.min }}–{{ promptData.wordRange.max }} 字</span>
            <span class="mw-subtle">哈希 {{ promptData.promptHash.slice(0, 12) }}</span>
          </div>
          <pre class="prompt-box">{{ promptData.prompt }}</pre>
        </div>
      </a-spin>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { Message, Modal } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type DurationTier } from '@/api/copy'
import SourcePanel from './components/SourcePanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import DraftEditor from './components/DraftEditor.vue'
import ReviewPanel from './components/ReviewPanel.vue'
import CopyListDrawer from './components/CopyListDrawer.vue'
import VersionDrawer from './components/VersionDrawer.vue'
import SubmitDialog from './components/SubmitDialog.vue'
import VariantPanel from './components/VariantPanel.vue'
import TemplateEditor from './components/TemplateEditor.vue'

const route = useRoute()
const router = useRouter()
const store = useCopyStore()

const copy = computed(() => store.copy)
const showReview = computed(
  () => !!store.detail?.review || ['in_review', 'approved', 'rejected'].includes(copy.value?.status ?? ''),
)

const listVisible = ref(false)
const versionVisible = ref(false)
const submitVisible = ref(false)
const configVisible = ref(false)
const variantVisible = ref(false)
const variantIndex = ref(0)

/**
 * P1-20 / FR-S1：`?ids=a,b` 时不能只打开第一条（爆款选题一次送 2 个人物，用户会漏看）。
 * 多条时打开列表抽屉并按 ids 过滤；只有 1 条时直接打开。
 */
const pendingIds = ref<string[]>([])

/** 路由 query.id 是当前文案的唯一入口 */
function routeId(): string | null {
  const qid = route.query.id as string | undefined
  return qid || null
}

/** ?ids=a,b 解析为数组 */
function routeIds(): string[] {
  const raw = route.query.ids as string | undefined
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function resolveId(): string | null {
  const id = routeId()
  if (id) return id
  const ids = routeIds()
  return ids[0] ?? null
}

async function loadByRoute(): Promise<void> {
  const id = routeId()
  const ids = routeIds()

  // P1-20：多条 ids → 打开列表并按 ids 过滤；单条 → 直接打开
  if (!id && ids.length > 1) {
    pendingIds.value = ids
    store.reset()
    listVisible.value = true
    return
  }
  pendingIds.value = []

  const target = id ?? ids[0] ?? null
  if (!target) {
    store.reset()
    return
  }
  await store.load(target)
  // 载入后按人物刷新可选风格（Q4 按线过滤）
  if (store.copy?.persona?.id) {
    await store.loadOptions(store.copy.persona.id)
  }
}

watch(() => route.query, loadByRoute, { immediate: false })

onMounted(async () => {
  await store.loadOptions()
  await loadByRoute()
  if (!routeId() && routeIds().length === 0) listVisible.value = true
})

onBeforeUnmount(() => {
  store.stopPolling()
  window.removeEventListener('beforeunload', onBeforeUnload)
})

/* ── P0-5：离开拦截（未保存内容不能静默丢失）──────────────���─────── */

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!store.isDirty) return
  e.preventDefault()
  // 部分浏览器需要设置 returnValue 才会弹确认
  e.returnValue = ''
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))

onBeforeRouteLeave(async () => {
  if (!store.isDirty) return true
  // 先尝试自动保存一次，成功就放行
  const r = await store.save()
  if (r === 'ok') return true
  return await new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: '还有未保存的改动',
      content: '离开后这些改动只保留在本机暂存里，下次打开该稿时可以恢复。是否离开？',
      okText: '离开',
      cancelText: '留下继续编辑',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
})

/* ── P1-21：保存草稿（生成 manual_save 版本）────────────────────── */

const savingDraft = ref(false)

async function onSaveDraft(): Promise<void> {
  if (!copy.value || !store.editor) return
  savingDraft.value = true
  try {
    // 先落盘，再生成版本，保证版本内容就是屏幕上看到的内容
    const r = await store.save()
    if (r !== 'ok') {
      if (r === 'need_confirm') Message.warning('该稿已通过审核，重新编辑需确认；请先在编辑区确认后重试')
      else if (r !== 'conflict') Message.error(store.error ?? '保存失败')
      return
    }
    // P1-21：生成 manual_save 版本（后端按内容 hash 去重，内容没变时 created=false）
    const v = await copyApi.saveVersion(copy.value.id, store.editor.draftId)
    await store.load(copy.value.id)
    Message.success(v.created ? `已保存草稿 v${v.versionNo}` : `内容未变化，已是 v${v.versionNo}`)
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    savingDraft.value = false
  }
}

async function onWithdraw(): Promise<void> {
  if (!copy.value) return
  try {
    await copyApi.withdraw(copy.value.id)
    await store.load(copy.value.id)
    Message.success('已撤回提交，可继续编辑')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

function onGoVideo(): void {
  Message.info('视频创作模块尚未接入，请在内测环境验证')
}

function reload(): void {
  void loadByRoute()
}

/* ── 步骤条 ── */

function stepClass(n: number): Record<string, boolean> {
  const s = copy.value?.status
  if (s === 'approved') return { active: n === 4, done: n < 4 }
  if (s === 'in_review') return { active: n === 3, done: n < 3 }
  if (s === 'rejected') return { active: n === 2, done: n < 2 }
  return n === 1 ? { active: true } : {}
}

function stepDone(n: number): boolean {
  const s = copy.value?.status
  if (s === 'approved') return n < 4
  if (s === 'in_review') return n < 3
  if (s === 'rejected') return n < 2
  return false
}

/* ── 变体 ── */

function onVariant(sectionIndex: number): void {
  variantIndex.value = sectionIndex
  variantVisible.value = true
}

/* ── 提交 ── */

function onSubmitted(_submissionId: string): void {
  Message.info('审核进行中，可稍后刷新查看结果')
}

/* ── 提示词预览 ── */

const promptVisible = ref(false)
const promptLoading = ref(false)
const promptData = ref<{ prompt: string; promptHash: string; wordRange: { min: number; max: number } } | null>(null)

async function onPreviewPrompt(): Promise<void> {
  if (!copy.value) return
  const s = (copy.value.settings ?? {}) as Record<string, unknown>
  const templateId = (s.templateId as string) || store.options?.templates[0]?.id
  const styleId = (s.styleId as string) || store.availableStyles[0]?.id
  if (!templateId || !styleId) {
    Message.warning('请先在左侧选择模板与风格')
    return
  }
  promptVisible.value = true
  promptLoading.value = true
  promptData.value = null
  try {
    promptData.value = await copyApi.promptPreview(copy.value.id, {
      templateId,
      styleId,
      durationTier: (s.durationTier as DurationTier) || 'medium',
      durationSeconds: (s.durationSeconds as number) ?? null,
      instructions: (s.instructions as string) ?? undefined,
    })
  } catch (e) {
    Message.error((e as Error).message)
    promptVisible.value = false
  } finally {
    promptLoading.value = false
  }
}
</script>

<style scoped>
.prompt-box {
  max-height: 480px;
  overflow: auto;
  padding: 14px 16px;
  border-radius: 9px;
  background: #fbfcfe;
  border: 1px solid #eef2f8;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.75;
  color: #3c4a63;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
</style>
