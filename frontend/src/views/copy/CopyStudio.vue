<template>
  <div class="copy-page copy-flow-page mw-page">
    <PageHead title="文案工坊">
      <template #sub>
        <span v-if="copy">
          {{ store.editor?.title || copy.title || '（未命名文案）' }}
          <!-- persona 在详情接口顶层，不在 copy 上；这里统一走 personaName -->
          <template v-if="personaName"> · {{ personaName }}</template>
          <template v-if="copy.lineLabel"> · {{ copy.lineLabel }}</template>
        </span>
        <span v-else>选择素材，开始创作口播文案</span>
      </template>
      <template #actions>
        <a-button v-if="copy" :aria-pressed="workspace.focusWriting" @click="toggleWritingFocus"
          ><template #icon><icon-shrink v-if="workspace.focusWriting" /><icon-expand v-else /></template
          >{{ workspace.focusWriting ? '退出专注' : '专注写作' }}</a-button
        >
        <a-button @click="listVisible = true">
          <template #icon><icon-file /></template>
          文案任务
        </a-button>
      </template>
    </PageHead>

    <!-- 加载 -->
    <div v-if="store.loading" class="copy-layout">
      <div class="mw-card p-5">
        <a-skeleton :animation="true"><a-skeleton-line :rows="8" /></a-skeleton>
      </div>
      <div class="mw-card p-5">
        <a-skeleton :animation="true"><a-skeleton-line :rows="12" /></a-skeleton>
      </div>
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
    <div v-else-if="!copy" class="flow-card"><SourceIntake @created="onSourcesCreated" /></div>

    <!-- 主体 -->
    <div v-else class="creation-flow" aria-label="文案创作流程">
      <section id="copy-step-source" class="flow-step" aria-labelledby="copy-source-heading">
        <span class="flow-node" :class="{ complete: sourceConfirmed }">{{ sourceConfirmed ? '✓' : '1' }}</span>
        <div class="flow-step-body">
          <div class="flow-step-heading">
            <h2 id="copy-source-heading" tabindex="-1">准备素材</h2>
            <span class="flow-state" :class="{ complete: sourceConfirmed }">{{
              sourceConfirmed ? '已核对' : '待核对'
            }}</span
            ><a-button
              type="text"
              size="small"
              :aria-expanded="!collapsed.source"
              aria-controls="copy-source-content"
              @click="collapsed.source = !collapsed.source"
              >{{ collapsed.source ? '展开' : '收起' }}</a-button
            >
          </div>
          <div id="copy-source-content" v-show="!collapsed.source" class="flow-card">
            <SourcePanel @created="onSourcesCreated" @source-mode="(mode) => (sourceMode = mode)" />
            <div v-if="sourceMode === 'topics'" class="flow-next">
              <a-button @click="goToStep('settings')">下一步：设置创作要求 <icon-arrow-down /></a-button>
            </div>
          </div>
        </div>
      </section>
      <section id="copy-step-settings" class="flow-step" aria-labelledby="copy-settings-heading">
        <span class="flow-node">2</span>
        <div class="flow-step-body">
          <div class="flow-step-heading">
            <h2 id="copy-settings-heading" tabindex="-1">设置创作要求</h2>
            <span class="flow-state">{{
              store.settingsSaving
                ? '保存中'
                : store.settingsError
                  ? '保存失败'
                  : store.settingsDirty
                    ? '有改动'
                    : '已保存'
            }}</span
            ><a-button
              type="text"
              size="small"
              :aria-expanded="!collapsed.settings"
              aria-controls="copy-settings-content"
              @click="collapsed.settings = !collapsed.settings"
              >{{ collapsed.settings ? '展开' : '收起' }}</a-button
            >
          </div>
          <div id="copy-settings-content" v-show="!collapsed.settings" class="flow-card">
            <SettingsPanel @preview="onPreviewPrompt" />
            <div class="flow-next">
              <a-button type="text" @click="goToStep('write')">编辑已有文案 <icon-arrow-down /></a-button>
            </div>
          </div>
        </div>
      </section>
      <section id="copy-step-write" class="flow-step" aria-labelledby="copy-write-heading">
        <span class="flow-node" :class="{ complete: currentFinal }">{{ currentFinal ? '✓' : '3' }}</span>
        <div class="flow-step-body">
          <div class="flow-step-heading">
            <h2 id="copy-write-heading" tabindex="-1">改写与定稿</h2>
            <span class="flow-state" :class="{ complete: currentFinal }">{{ currentFinal ? '已定稿' : '可编辑' }}</span>
            <div class="flow-heading-actions">
              <a-button size="small" @click="versionVisible = true">本稿历史</a-button
              ><a-button
                size="small"
                :disabled="!store.editor || !store.canEdit || savingDraft || store.editor.saving"
                :loading="savingDraft || store.editor?.saving"
                @click="onSaveDraft"
                >保存版本</a-button
              >
            </div>
          </div>
          <div role="region" aria-label="文案编辑区">
            <CandidateShelf @open="(id) => draftEditorRef?.selectDraft(id)" /><DraftEditor
              ref="draftEditorRef"
              @variant="onVariant"
            />
          </div>
          <div class="flow-next">
            <a-button @click="goToStep('review')">下一步：检查与审核 <icon-arrow-down /></a-button>
          </div>
        </div>
      </section>
      <section id="copy-step-review" class="flow-step" aria-labelledby="copy-review-heading">
        <span class="flow-node" :class="{ complete: copy.status === 'approved' }">{{
          copy.status === 'approved' ? '✓' : '4'
        }}</span>
        <div class="flow-step-body">
          <div class="flow-step-heading">
            <h2 id="copy-review-heading" tabindex="-1">检查与审核</h2>
            <span class="flow-state" :class="{ complete: copy.status === 'approved' }">{{ reviewStatusLabel }}</span>
          </div>
          <ReviewPanel v-if="showReview" />
          <div class="flow-card flow-submit">
            <div>
              <strong>{{
                copy.status === 'approved'
                  ? '文案已通过审核'
                  : copy.status === 'in_review'
                    ? '文案正在审核中'
                    : '检查文案，提交审核'
              }}</strong>
              <p>
                {{
                  copy.status === 'approved'
                    ? '可查看通过稿，准备制作视频。'
                    : copy.status === 'in_review'
                      ? '审核完成后可在此查看结果。'
                      : '提交前将检查字数、时长、用词和定稿内容。'
                }}
              </p>
            </div>
            <a-button
              v-if="copy.status === 'draft' || copy.status === 'rejected'"
              type="primary"
              :disabled="!store.editor || store.generating"
              @click="submitVisible = true"
              >检查并提交审核</a-button
            >
            <a-button
              v-else-if="
                copy.status === 'in_review' &&
                ['submitted', 'gate1', 'gate2', 'gate3'].includes(store.detail?.review?.status ?? '')
              "
              @click="onWithdraw"
              >撤回提交</a-button
            >
            <a-button v-else-if="copy.status === 'approved'" type="primary" @click="onGoVideo">去视频创作</a-button>
          </div>
        </div>
      </section>
    </div>

    <!-- 弹层 -->
    <CopyListDrawer
      v-model:visible="listVisible"
      :initial-ids="pendingIds"
      @picked="(id) => router.replace({ query: { id } })"
    />
    <VersionDrawer v-model:visible="versionVisible" />
    <SubmitDialog v-model:visible="submitVisible" @submitted="onSubmitted" @navigate="onPrecheckNavigate" />
    <VariantPanel v-model:visible="variantVisible" :section-index="variantIndex" />
    <TemplateEditor v-model:visible="configVisible" />

    <!-- 提示词预览 -->
    <a-modal v-model:visible="promptVisible" title="本次创作任务预览" :width="720" :footer="false" unmount-on-close>
      <a-spin :loading="promptLoading">
        <div v-if="promptData">
          <div class="flex items-center gap-3 mb-3">
            <span class="mw-subtle">字数区间 {{ promptData.wordRange.min }}–{{ promptData.wordRange.max }} 字</span>
          </div>
          <div class="task-preview-summary">
            <strong
              >{{ store.options?.templates.find((t) => t.id === store.creativeSettings.templateId)?.name }} ·
              {{ store.availableStyles.find((s) => s.id === store.creativeSettings.styleId)?.name }}</strong
            >
            <p>
              目标：{{ store.options?.durationTiers.find((d) => d.key === store.creativeSettings.durationTier)?.name
              }}<template v-if="store.creativeSettings.durationTier === 'custom'">
                {{ store.creativeSettings.durationSeconds }} 秒</template
              >
              · {{ store.creativeSettings.count }} 篇
            </p>
            <p>{{ store.creativeSettings.instructions || '按所选人物、模板和风格创作' }}</p>
            <p class="mw-subtle">使用素材：{{ store.copy?.settings?.sourceReview ? '已保存的校对稿' : '原始素材' }}</p>
          </div>
        </div>
      </a-spin>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { Message, Modal } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type DurationTier, type CreativeSettings, type SourceReview } from '@/api/copy'
import SourcePanel from './components/SourceWorkbench.vue'
import SourceIntake from './components/SourceIntake.vue'
import CandidateShelf from './components/CandidateShelf.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import DraftEditor from './components/DraftEditor.vue'
import ReviewPanel from './components/ReviewPanel.vue'
import CopyListDrawer from './components/CopyListDrawer.vue'
import VersionDrawer from './components/VersionDrawer.vue'
import SubmitDialog from './components/SubmitDialog.vue'
import VariantPanel from './components/VariantPanel.vue'
import TemplateEditor from './components/TemplateEditor.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const route = useRoute()
const router = useRouter()
const store = useCopyStore()
const draftEditorRef = ref<InstanceType<typeof DraftEditor> | null>(null)
const workspace = useWorkspaceStore()
const collapsed = reactive({ source: false, settings: false })
const sourceMode = ref('topics')
type FlowStep = 'source' | 'settings' | 'write' | 'review'
function goToStep(step: FlowStep) {
  if (step === 'source' || step === 'settings') collapsed[step] = false
  void nextTick(() => {
    const heading = document.getElementById(`copy-${step}-heading`)
    heading?.scrollIntoView({ block: 'start', behavior: 'auto' })
    heading?.focus({ preventScroll: true })
  })
}
function toggleWritingFocus() {
  workspace.focusWriting = !workspace.focusWriting
  if (workspace.focusWriting) goToStep('write')
}
const createdTargetId = ref<string | null>(null)
function onSourcesCreated(ids: string[]) {
  if (ids.length) {
    createdTargetId.value = ids.length === 1 ? ids[0] : null
    void router.push({ path: '/copy', query: ids.length === 1 ? { id: ids[0] } : { ids: ids.join(',') } })
  }
}
function onPrecheckNavigate(step: 'source' | 'settings' | 'write') {
  submitVisible.value = false
  goToStep(step)
}
onBeforeUnmount(() => {
  workspace.focusWriting = false
})

const copy = computed(() => store.copy)
const sourceConfirmed = computed(
  () => (store.copy?.settings?.sourceReview as SourceReview | undefined)?.confirmed === true,
)
const currentFinal = computed(
  () => !!store.drafts.find((d) => d.id === store.editor?.draftId && d.isFinal) && !store.isDirty,
)
const reviewStatusLabel = computed(
  () =>
    ({ draft: '待提交', in_review: '审核中', approved: '已通过', rejected: '待修改', archived: '已归档' })[
      copy.value?.status ?? 'draft'
    ],
)
watch(
  () => store.activeGeneration?.status,
  (status, previous) => {
    if ((status === 'done' || status === 'partial') && (previous === 'pending' || previous === 'running'))
      goToStep('write')
  },
)
/** 人物名取自详情顶层 `persona`（copy 自身没有 persona 字段） */
const personaName = computed(() => store.detail?.persona?.name ?? '')
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
  // 载入后按人物刷新可选风格（Q4 按线过滤）。
  // 注意：`copy.persona` 只在**列表项**里有值，`GET /copy/:id` 返回的 copy 对象不带该字段
  // （人物在详情顶层 persona）。早先只读 copy.persona.id，导致详情页永远拿不到人物，
  // 风格选项无法按线过滤。这里以详情顶层优先，再回落到 copy.persona。
  const pid = store.detail?.persona?.id ?? store.copy?.persona?.id
  if (pid) {
    await store.loadOptions(pid)
  }
  if (store.copy?.id === target && createdTargetId.value === target) {
    createdTargetId.value = null
    collapsed.source = true
    goToStep('settings')
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
  if (!store.isDirty && !store.settingsDirty) return
  e.preventDefault()
  // 部分浏览器需要设置 returnValue 才会弹确认
  e.returnValue = ''
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))

onBeforeRouteLeave(async () => {
  if (!(await store.saveCreativeSettings())) {
    Message.error(store.settingsError || '创作设置尚未保存')
    return false
  }
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
  if (!(await store.saveCreativeSettings())) {
    Message.error(store.settingsError)
    return
  }
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
    Message.success(v.created ? `已保存第 ${v.versionNo} 版` : '当前内容已保存')
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
const promptData = ref<{
  system: string
  user: string
  promptHash: string
  wordRange: { min: number; max: number }
} | null>(null)

async function onPreviewPrompt(settings: CreativeSettings): Promise<void> {
  if (!copy.value) return
  const s = { ...settings } as unknown as Record<string, unknown>
  const templateId = (s.templateId as string) || store.options?.templates[0]?.id
  const styleId = (s.styleId as string) || store.availableStyles[0]?.id
  if (!templateId || !styleId) {
    Message.warning('请先选择内容模板与表达风格')
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
      count: Number(s.count) || 1,
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
.task-preview-summary {
  padding: 18px;
  background: #f1f7f3;
  border: 1px solid #dce9df;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.9;
}
.task-preview-summary p {
  margin: 8px 0 0;
}
:global(.copy-compare-modal .arco-modal),
:global(.source-review-modal .arco-modal) {
  max-width: calc(100vw - 32px);
}
:global(.copy-compare-modal .arco-modal-body),
:global(.source-review-modal .arco-modal-body) {
  max-height: calc(100dvh - 180px);
  overflow: auto;
}
:global(.settings-save-state) {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  color: #7c8880;
  margin-bottom: 6px;
}
:global(.copy-page.copy-flow-page) {
  height: auto;
  min-height: 100%;
  overflow: visible;
  display: block;
  padding: 26px 32px 60px;
  max-width: 1300px;
  margin: 0 auto;
}
:global(.copy-flow-page .mw-page-head) {
  margin-bottom: 30px;
  flex-wrap: wrap;
}
:global(.copy-flow-page .mw-page-actions) {
  flex-wrap: wrap;
}
.creation-flow {
  max-width: 1080px;
  margin: 0 auto;
}
.flow-step {
  position: relative;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  column-gap: 20px;
  padding-bottom: 32px;
  scroll-margin-top: 24px;
}
.flow-step:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 17px;
  top: 36px;
  bottom: 0;
  border-left: 1px solid var(--mw-border);
}
.flow-node {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid #becbd1;
  border-radius: 50%;
  color: var(--mw-primary);
  font-size: 14px;
  font-weight: 600;
  background: var(--mw-bg);
}
.flow-node.complete {
  background: #edf5ef;
  border-color: #c8ddcd;
  color: #33704a;
}
.flow-step-body {
  min-width: 0;
}
.flow-step-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.flow-step-heading h2 {
  font-size: 17px;
  font-weight: 600;
  color: var(--mw-text);
  line-height: 1.5;
  scroll-margin-top: 24px;
}
.flow-step-heading h2:focus {
  outline: none;
}
.flow-step-heading > .arco-btn,
.flow-heading-actions {
  margin-left: auto;
}
.flow-heading-actions {
  display: flex;
  gap: 8px;
}
.flow-state {
  font-size: 12px;
  color: var(--mw-text3);
}
.flow-state.complete {
  color: #33704a;
}
.flow-card {
  padding: 24px;
  border: 1px solid var(--mw-border);
  border-radius: 8px;
  background: #fff;
}
.flow-next {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
}
.flow-submit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}
.flow-submit strong {
  font-size: 15px;
  font-weight: 500;
}
.flow-submit p {
  font-size: 13px;
  color: var(--mw-text3);
  margin-top: 8px;
  line-height: 1.8;
}
:global(.copy-flow-page .copy-settings) {
  height: auto;
  display: block;
}
:global(.copy-flow-page .copy-settings-fields) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 22px 28px;
  overflow: visible;
  padding: 0;
}
:global(.copy-flow-page .copy-settings-fields > .creative-requirements),
:global(.copy-flow-page .copy-settings-fields > .gen-panel) {
  grid-column: 1 / -1;
}
:global(.copy-flow-page .copy-settings .mw-form-row) {
  display: block;
  margin: 0;
}
:global(.copy-flow-page .copy-settings .mw-form-label) {
  display: block;
  width: auto;
  font-size: 13px;
  padding: 0;
  margin-bottom: 9px;
}
:global(.copy-flow-page .copy-settings .duration-setting .arco-radio-group-button) {
  display: flex;
  width: fit-content;
  max-width: 100%;
  flex-wrap: wrap;
}
:global(.copy-flow-page .copy-settings .duration-setting .arco-radio-button) {
  width: auto;
  padding: 0 14px;
}
:global(.copy-flow-page .copy-settings .copy-generation-count) {
  display: block;
}
:global(.copy-flow-page .copy-settings .copy-generation-count > .mw-subtle) {
  margin-left: 10px;
}
:global(.copy-flow-page .copy-settings .copy-generate-actions) {
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--mw-border-light);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
:global(.copy-flow-page .copy-generate-actions > .settings-save-state) {
  display: none;
}
:global(.copy-flow-page .copy-generate-actions > .arco-btn) {
  width: auto;
  min-width: 180px;
  margin-left: auto;
}
:global(.copy-flow-page .copy-editor) {
  min-height: 0;
  border-radius: 8px;
}
:global(.copy-flow-page .copy-editor-toolbar) {
  position: static;
}
:global(.copy-flow-page .copy-editor.is-continuous .section-item) {
  padding: 0;
  border-bottom: 0;
}
:global(.copy-flow-page .copy-editor.is-continuous .section-item .arco-textarea) {
  padding: 3px 0;
  font-size: 16px;
  line-height: 2;
}
:global(.copy-flow-page .copy-editor.is-continuous .section-item.has-violation),
:global(.copy-flow-page .copy-editor.is-continuous .section-item.has-soft-warning) {
  padding-left: 10px;
}
@media (max-width: 900px) {
  :global(.copy-page.copy-flow-page) {
    padding: 20px 20px 40px;
  }
  .flow-step {
    column-gap: 14px;
  }
  .flow-card {
    padding: 20px;
  }
}
@media (max-width: 600px) {
  :global(.copy-page.copy-flow-page) {
    padding: 18px 12px 32px;
  }
  .flow-step {
    grid-template-columns: 28px minmax(0, 1fr);
    column-gap: 10px;
    padding-bottom: 26px;
  }
  .flow-node {
    width: 28px;
    height: 28px;
    font-size: 12px;
  }
  .flow-step:not(:last-child)::before {
    left: 13px;
    top: 30px;
  }
  .flow-step-heading {
    min-height: 28px;
    gap: 8px;
    margin-bottom: 12px;
  }
  .flow-step-heading h2 {
    font-size: 16px;
  }
  .flow-heading-actions {
    width: 100%;
    margin: 0;
  }
  .flow-card {
    padding: 16px;
  }
  .flow-submit > .arco-btn {
    width: 100%;
  }
  :global(.copy-flow-page .copy-settings-fields) {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }
  :global(.copy-flow-page .copy-generate-actions > .arco-btn) {
    width: 100%;
    margin: 0;
  }
  :global(.copy-flow-page .copy-editor-toolbar > div:first-child) {
    gap: 8px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .creation-flow {
    scroll-behavior: auto;
  }
}
</style>
