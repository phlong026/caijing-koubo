<template>
  <a-modal
    :visible="visible"
    :title="'提交前检查'"
    :width="620"
    :footer="false"
    unmount-on-close
    @cancel="emit('update:visible', false)"
  >
    <div v-if="loading" class="py-14 text-center">
      <a-spin />
      <div class="mw-subtle mt-3">正在检查字数、合规与查重…</div>
    </div>

    <template v-else-if="result">
      <!-- 结论条 -->
      <div
        class="rounded-lg px-4 py-3 mb-4 flex items-center gap-2"
        :class="result.canSubmit ? 'bg-[#e9f7ef]' : 'bg-[#fdeeee]'"
      >
        <icon-check-circle-fill v-if="result.canSubmit" style="color: #12805c" />
        <icon-exclamation-circle-fill v-else style="color: #c03e35" />
        <span class="text-[13px]" :class="result.canSubmit ? 'text-[#12805c]' : 'text-[#c03e35]'">
          {{ result.canSubmit ? '检查通过，可以提交审核' : '存在硬性不通过项，请修正后再提交' }}
        </span>
      </div>

      <!-- 字数概览 -->
      <div class="grid grid-cols-3 gap-3 mb-4">
        <div class="stat-box">
          <div class="stat-num">{{ result.wordCount }}</div>
          <div class="mw-subtle">正文总字数</div>
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

      <!-- 检查项 -->
      <div class="space-y-2 mb-4">
        <div v-for="c in result.checks" :key="c.key" class="check-row">
          <icon-check-circle-fill v-if="c.pass" style="color: #12805c" :size="15" />
          <icon-exclamation-circle-fill v-else-if="c.level === 'hard'" style="color: #c03e35" :size="15" />
          <icon-exclamation-circle-fill v-else style="color: #b95f1d" :size="15" />
          <span class="text-[13px] flex-1" :class="c.pass ? 'text-[#3c4a63]' : 'text-[#131f38] font-medium'">
            {{ c.label }}
          </span>
          <a-tag :color="c.level === 'hard' ? 'red' : 'orange'" size="small">
            {{ c.level === 'hard' ? '硬性' : '软性' }}
          </a-tag>
          <span v-if="c.hint" class="text-[12px] w-full pl-[23px]" :class="c.pass ? 'text-[#9aa6ba]' : 'text-[#b95f1d]'">
            {{ c.hint }}
          </span>
        </div>
      </div>

      <!-- 合规命中明细 -->
      <div v-if="result.complianceHits.length" class="mb-4">
        <div class="text-[13px] font-medium text-[#3c4a63] mb-2">合规命中（{{ result.complianceHits.length }}）</div>
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
            <span class="mw-subtle">第 {{ h.sectionIndex + 1 }} 段</span>
            <span v-if="h.fromPersona" class="mw-subtle">（来自人物设定）</span>
          </div>
        </div>
      </div>

      <!-- 查重（仅素人线） -->
      <div v-if="result.similarity" class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[13px] font-medium text-[#3c4a63]">与原文查重</span>
          <span class="text-[12px]" :class="result.similarity.blocked ? 'text-[#c03e35]' : 'text-[#6b7688]'">
            相似度 {{ (result.similarity.similarity * 100).toFixed(1) }}%
            （阈值 {{ (result.similarity.threshold * 100).toFixed(0) }}%）
          </span>
        </div>
        <a-progress
          :percent="Math.min(100, result.similarity.similarity * 100)"
          :status="result.similarity.blocked ? 'danger' : 'normal'"
          :show-text="false"
          size="small"
        />
        <div v-if="result.similarity.blocked" class="mt-2 text-[12px] text-[#c03e35] leading-[1.7]">
          素人线要求改写幅度更大，请在下方片段基础上继续调整：
          <div v-for="(f, i) in result.similarity.fragments" :key="i" class="mt-1 px-2 py-1 rounded bg-[#fdeeee]">
            {{ f }}
          </div>
        </div>
      </div>

      <!-- 操作 -->
      <div class="flex items-center justify-end gap-2 pt-1">
        <a-button @click="emit('update:visible', false)">取消</a-button>
        <a-button type="primary" :disabled="!result.canSubmit" :loading="submitting" @click="onSubmit">
          确认提交审核
        </a-button>
      </div>
    </template>

    <div v-else class="py-12 text-center">
      <a-empty description="检查失败，请重试" />
    </div>
  </a-modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type PrecheckResult } from '@/api/copy'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'submitted', submissionId: string): void
}>()

const store = useCopyStore()
const loading = ref(false)
const submitting = ref(false)
const result = ref<PrecheckResult | null>(null)

watch(
  () => props.visible,
  async (v) => {
    if (!v) {
      result.value = null
      return
    }
    loading.value = true
    result.value = await store.runPrecheck()
    loading.value = false
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
