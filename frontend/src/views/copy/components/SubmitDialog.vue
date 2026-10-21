<template>
  <a-modal
    :visible="visible"
    :title="'提交前检查'"
    class="copy-submit-modal"
    :width="620"
    unmount-on-close
    @cancel="emit('update:visible', false)"
  >
    <template #footer>
      <a-button @click="emit('update:visible', false)">取消</a-button>
      <a-button
        type="primary"
        :disabled="loading || !result?.canSubmit || (hasWarnings && !acknowledged)"
        :loading="submitting"
        @click="onSubmit"
        >确认提交审核</a-button
      >
    </template>
    <div v-if="loading" class="py-14 text-center">
      <a-spin />
      <div class="mw-subtle mt-3">正在检查字数、合规与查重…</div>
    </div>

    <template v-else-if="result">
      <p class="mw-subtle mb-3">
        {{ store.drafts.find((d) => d.id === result?.draftId)?.name }} · {{ store.editor?.title }}
      </p>
      <!-- 结论条 -->
      <div
        class="rounded-lg px-4 py-3 mb-4 flex items-center gap-2"
        :class="result.canSubmit ? (hasWarnings ? 'bg-[#fff5e5]' : 'bg-[#e9f7ef]') : 'bg-[#fdeeee]'"
      >
        <icon-check-circle-fill v-if="result.canSubmit && !hasWarnings" style="color: #12805c" />
        <icon-exclamation-circle-fill v-else :style="{ color: result.canSubmit ? '#a56b13' : '#c03e35' }" />
        <span
          class="text-[13px]"
          :class="result.canSubmit ? (hasWarnings ? 'text-[#a56b13]' : 'text-[#12805c]') : 'text-[#c03e35]'"
        >
          {{
            result.canSubmit
              ? hasWarnings
                ? '请确认以下提醒后提交'
                : '检查通过，可提交审核'
              : '请修改以下问题后再提交'
          }}
        </span>
      </div>

      <!-- 字数概览 -->
      <div class="grid grid-cols-3 gap-3 mb-4">
        <div class="stat-box">
          <div class="stat-num">{{ result.wordCount }}</div>
          <div class="mw-subtle">稿件字数（含标题）</div>
        </div>
        <div class="stat-box">
          <div class="stat-num">{{ result.estSeconds }}<span class="text-[13px] font-normal ml-0.5">秒</span></div>
          <div class="mw-subtle">预计口播时长</div>
        </div>
        <div class="stat-box">
          <div class="stat-num" :class="result.tierOk ? '' : 'text-[#b95f1d]'">
            {{ result.wordRange.min }}–{{ result.wordRange.max }}
          </div>
          <div class="mw-subtle">建议字数区间</div>
        </div>
      </div>

      <p class="mw-subtle mb-4">实际时长以配音为准，风险提示将单独显示为字幕。</p>
      <!-- 检查项 -->
      <div class="flex items-center justify-between mb-2">
        <span class="mw-subtle"
          >{{ result.checks.filter((c) => !c.pass && c.level === 'hard').length }} 项需修正 ·
          {{ result.checks.filter((c) => !c.pass && c.level === 'soft').length }} 项提醒 ·
          {{ result.checks.filter((c) => c.pass).length }} 项通过</span
        ><a-button type="text" size="mini" @click="showAll = !showAll">{{
          showAll ? '只看待处理' : '显示全部检查'
        }}</a-button>
      </div>
      <div class="space-y-2 mb-4">
        <div v-for="c in visibleChecks" :key="c.key" class="check-row">
          <icon-check-circle-fill v-if="c.pass" style="color: #12805c" :size="15" />
          <icon-exclamation-circle-fill v-else-if="c.level === 'hard'" style="color: #c03e35" :size="15" />
          <icon-exclamation-circle-fill v-else style="color: #b95f1d" :size="15" />
          <span class="text-[13px] flex-1" :class="c.pass ? 'text-[#3c4a63]' : 'text-[#131f38] font-medium'">
            {{ c.label }}
          </span>
          <a-tag :color="c.pass ? 'gray' : c.level === 'hard' ? 'red' : 'orange'" size="small">
            {{ c.pass ? '通过' : c.level === 'hard' ? '需修正' : '需留意' }}
          </a-tag>
          <a-button
            v-if="!c.pass && checkStep(c.key)"
            type="text"
            size="mini"
            :aria-label="`处理${c.label}`"
            @click="navigateTo(c.key)"
            >去处理</a-button
          >
          <span
            v-if="c.message || c.hint"
            class="text-[12px] w-full pl-[23px]"
            :class="c.pass ? 'text-[#9aa6ba]' : 'text-[#b95f1d]'"
          >
            {{ c.message || c.hint }}
          </span>
        </div>
      </div>

      <!-- 合规命中明细 -->
      <div v-if="result.complianceHits.length" class="mb-4">
        <div class="text-[13px] font-medium text-[#3c4a63] mb-2">
          需留意的用词（{{ result.complianceHits.length }}）
        </div>
        <div class="space-y-1.5 max-h-[160px] overflow-auto">
          <div
            v-for="(h, i) in result.complianceHits"
            :key="i"
            class="flex items-center gap-2 text-[12px] px-2.5 py-1.5 rounded-md bg-[#fbfcfe]"
          >
            <a-tag :color="h.level === 'hard' ? 'red' : 'orange'" size="small">
              {{ h.level === 'hard' ? '禁用' : '提示' }}
            </a-tag>
            <span class="font-medium text-[#131f38]">{{ h.word }}</span>
            <a-button size="mini" type="text" @click="locate(h)">{{
              h.sectionIndex < 0 ? '定位标题' : `定位第 ${h.sectionIndex + 1} 段`
            }}</a-button>
            <span v-if="h.fromPersona" class="mw-subtle">（来自人物设定）</span>
          </div>
        </div>
      </div>

      <!-- 查重（仅素人线） -->
      <div v-if="result.similarity" class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[13px] font-medium text-[#3c4a63]">与原文查重</span>
          <span class="text-[12px]" :class="result.similarity.blocked ? 'text-[#c03e35]' : 'text-[#6b7688]'">
            相似度 {{ (result.similarity.similarity * 100).toFixed(1) }}% （上限
            {{ (result.similarity.threshold * 100).toFixed(0) }}%）
          </span>
        </div>
        <a-progress
          :percent="Math.min(100, result.similarity.similarity * 100)"
          :status="result.similarity.blocked ? 'danger' : 'normal'"
          :show-text="false"
          size="small"
        />
        <div v-if="result.similarity.blocked" class="mt-2 text-[12px] text-[#c03e35] leading-[1.7]">
          以下内容与原文过于接近，请继续改写：
          <div v-for="(f, i) in result.similarity.fragments" :key="i" class="mt-1 px-2 py-1 rounded bg-[#fdeeee]">
            {{ typeof f === 'string' ? f : f.text }}
          </div>
        </div>
      </div>

      <div class="precheck-boundary">
        提交后还需人工审核。<a-checkbox v-if="hasWarnings" v-model="acknowledged"
          >我已了解以上提醒，继续提交</a-checkbox
        >
      </div>
    </template>

    <div v-else class="py-12 text-center">
      <a-empty :description="store.error || '检查失败，请重试'" /><a-button class="mt-3" @click="checkAgain"
        >重新检查</a-button
      >
    </div>
  </a-modal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type PrecheckResult } from '@/api/copy'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'submitted', submissionId: string): void
  (e: 'navigate', step: 'source' | 'settings' | 'write'): void
}>()

const store = useCopyStore()
function checkStep(key: string): 'source' | 'settings' | 'write' | undefined {
  const steps: Partial<Record<string, 'source' | 'settings' | 'write'>> = {
    sourceReview: 'source',
    finalSelection: 'write',
    duration: 'write',
    wordRange: 'write',
    content: 'write',
    title: 'write',
  }
  return steps[key]
}
function navigateTo(key: string) {
  const step = checkStep(key)
  if (step) emit('navigate', step)
}
const acknowledged = ref(false),
  showAll = ref(false)
const visibleChecks = computed(() =>
  showAll.value ? (result.value?.checks ?? []) : (result.value?.checks ?? []).filter((c) => !c.pass),
)
const hasWarnings = computed(() => !!result.value?.checks.some((c) => !c.pass && c.level === 'soft'))
const loading = ref(false)
const submitting = ref(false)
const result = ref<PrecheckResult | null>(null)

let checkSeq = 0
async function checkAgain() {
  const seq = ++checkSeq
  loading.value = true
  acknowledged.value = false
  const r = await store.runPrecheck()
  if (seq === checkSeq && props.visible) {
    result.value = r
    loading.value = false
  }
}
async function locate(h: { sectionIndex: number; start: number; end: number }) {
  emit('update:visible', false)
  await nextTick()
  window.dispatchEvent(new CustomEvent('copy-focus-hit', { detail: h }))
}
watch(
  () => props.visible,
  async (v) => {
    if (!v) {
      ++checkSeq
      loading.value = false
      return
    }
    result.value = null
    await checkAgain()
  },
)

async function onSubmit(): Promise<void> {
  if (!store.copy || !store.editor || !result.value?.canSubmit) return
  submitting.value = true
  try {
    const r = await copyApi.submit(store.copy.id, {
      draftId: store.editor.draftId,
      rev: store.editor.rev,
    })
    Message.success(`已提交审核（第 ${r.versionNo} 版），正在自动预检…`)
    emit('update:visible', false)
    emit('submitted', r.submissionId)
    await store.load(store.copy.id)
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.precheck-boundary {
  padding: 12px;
  background: #f5f7f5;
  border-radius: 8px;
  font-size: 12px;
  color: #6f7e74;
  line-height: 1.8;
}
.precheck-boundary :deep(.arco-checkbox) {
  display: flex;
  margin-top: 10px;
}

.stat-box {
  padding: 10px 12px;
  border-radius: 8px;
  background: #fbfcfe;
  border: 1px solid #eef2f8;
}
.stat-num {
  font-size: 20px;
  font-weight: 600;
  color: #131f38;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
}
.check-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #fbfcfe;
}
</style>
