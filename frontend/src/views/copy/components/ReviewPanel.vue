<template>
  <div v-if="review || copy?.status === 'approved' || copy?.status === 'rejected'" class="mw-card p-5">
    <div class="flex items-center justify-between mb-3">
      <div class="mw-card-title">
        审核进度 <a-tag v-if="review?.isStub" color="orange" size="small">模拟审核</a-tag>
      </div>
      <a-tag :color="statusColor" size="small">{{ statusText }}</a-tag>
    </div>

    <!-- 三关进度 -->
    <div v-if="review" class="space-y-1.5 mb-3">
      <div v-for="(g, gi) in review.gates" :key="gi" class="gate-row">
        <span class="gate-dot" :class="gateClass(g)" />
        <span class="text-[13px] text-[#3c4a63] w-[180px] shrink-0 truncate" :title="gateName(g.gate)">{{
          gateName(g.gate)
        }}</span>
        <span class="text-[12px] flex-1" :class="g.result === 'fail' ? 'text-[#c03e35]' : 'text-[#6b7688]'">
          {{ g.reason || (g.result === 'pass' ? '通过' : '未通过') }}
          <template v-if="g.riskPoints?.length">（风险点：{{ g.riskPoints.join('；') }}）</template>
        </span>
        <span v-if="g.at" class="mw-subtle tabular-nums shrink-0">{{ fmtTime(g.at) }}</span>
      </div>
    </div>

    <!-- 驳回原因 -->
    <div
      v-if="copy?.status === 'rejected'"
      class="mb-3 px-3 py-2 rounded-lg bg-[#fdeeee] text-[12.5px] text-[#c03e35] leading-[1.7]"
    >
      驳回原因：{{ review?.rejectReason || copy.rejectReason || '未填写' }}
      <template v-if="review?.rejectedGate"> <br />拦截环节：{{ gateName(review.rejectedGate) }} </template>
    </div>

    <!-- 操作 -->
    <div class="flex items-center gap-2 flex-wrap">
      <a-button v-if="copy?.status === 'approved'" size="small" type="primary" @click="onFetchApproved">
        <template #icon><icon-download /></template>
        查看通过稿
      </a-button>
    </div>

    <!-- 已通过稿预览 -->
    <a-modal v-model:visible="approvedVisible" title="已通过稿" :width="680" :footer="false" unmount-on-close>
      <a-spin :loading="approvedLoading">
        <div v-if="approved">
          <div class="flex items-center gap-2 mb-3">
            <a-tag color="green" size="small">第 {{ approved.versionNo }} 版</a-tag>
            <span class="text-[14px] font-semibold text-[#131f38]">{{ approved.title || '（无标题）' }}</span>
          </div>
          <div class="space-y-2.5 mb-4">
            <div v-for="(s, i) in approved.sections" :key="i" class="text-[13px] leading-[1.85] text-[#3c4a63]">
              {{ s.text }}
            </div>
          </div>
          <div class="px-3 py-2 rounded-lg bg-[#f8fafd] text-[12px] leading-[1.75] text-[#7c8798]">
            {{ approved.riskHint }}
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <a-button @click="onCopyText">复制全文</a-button>
          </div>
        </div>
      </a-spin>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type GateResult, type Section } from '@/api/copy'

const store = useCopyStore()

const copy = computed(() => store.copy)
const review = computed(() => store.detail?.review ?? null)


const statusText = computed(() => {
  if (review.value) return review.value.statusLabel
  if (copy.value?.status === 'approved') return '已通过'
  if (copy.value?.status === 'rejected') return '已驳回'
  return '未提交'
})

const statusColor = computed(() => {
  const s = copy.value?.status
  if (s === 'approved') return 'green'
  if (s === 'rejected') return 'red'
  if (s === 'in_review') return 'orange'
  return 'gray'
})

function gateClass(g: GateResult): string {
  return g.result === 'fail' ? 'fail' : 'ok'
}

function gateName(gate: string): string {
  return store.options?.labels.gates?.[gate] ?? gate
}

/* ── 取已通过稿 ── */
const approvedVisible = ref(false)
const approvedLoading = ref(false)
const approved = ref<{
  versionNo: number
  title: string | null
  sections: Section[]
  plainText: string
  riskHint: string | null
} | null>(null)

async function onFetchApproved(): Promise<void> {
  if (!copy.value) return
  approvedVisible.value = true
  approvedLoading.value = true
  approved.value = null
  try {
    approved.value = await copyApi.approved(copy.value.id)
  } catch (e) {
    Message.error((e as Error).message)
    approvedVisible.value = false
  } finally {
    approvedLoading.value = false
  }
}

async function onCopyText(): Promise<void> {
  if (!approved.value) return
  const text = [approved.value.title, ...approved.value.sections.map((s) => s.text), approved.value.riskHint]
    .filter(Boolean)
    .join('\n\n')
  try {
    await navigator.clipboard.writeText(text)
    Message.success('已复制到剪贴板')
  } catch {
    Message.error('复制失败，请手动选择文本')
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
</script>

<style scoped>
.gate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 7px;
  background: #fbfcfe;
}
.gate-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.gate-dot.ok {
  background: #12805c;
  box-shadow: 0 0 0 3px rgba(18, 128, 92, 0.12);
}
.gate-dot.fail {
  background: #c03e35;
  box-shadow: 0 0 0 3px rgba(192, 62, 53, 0.12);
}
.gate-dot.done {
  background: #2f6bff;
  box-shadow: 0 0 0 3px rgba(47, 107, 255, 0.12);
}
.gate-dot.idle {
  background: #d5dce7;
}
</style>
