<template>
  <div v-if="review || copy?.status === 'approved' || copy?.status === 'rejected'" class="mw-card p-5">
    <div class="flex items-center justify-between mb-3">
      <div class="mw-card-title">
        审核进度 <a-tag v-if="review?.isStub" color="orange" size="small">模拟审核</a-tag>
      </div>
      <a-tag :color="statusColor" size="small">{{ statusText }}</a-tag>
    </div>

    <!-- 审核去向（决策 D3 / D4）：校对台审核或审核员人工裁决 -->
    <p v-if="inReview && review?.channel === 'jiaoduitai'" class="mw-subtle mb-3">
      已送校对台审核<template v-if="review.externalReviewNo">（审核单 {{ review.externalReviewNo }}）</template
      >，结果自动同步；校对台不支持撤回。
      <template v-if="externalStatusText">
        <br />当前进展：<b class="text-[#2f6bff]">{{ externalStatusText }}</b
        ><icon-refresh v-if="polling" class="inline-block ml-1 animate-spin" :size="12" />
      </template>
    </p>
    <p v-else-if="inReview && review?.channel === 'manual'" class="mw-subtle mb-3">
      等待审核员在「审核工作台」裁决（自动审核关卡尚未接入）。
    </p>

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

    <!-- 驳回原因（校对台只出意见：机审 findings / 人工驳回意见都在这里，改稿后重新提交即重送审核） -->
    <div
      v-if="copy?.status === 'rejected'"
      class="mb-3 px-3 py-2 rounded-lg bg-[#fdeeee] text-[12.5px] text-[#c03e35] leading-[1.7] whitespace-pre-wrap"
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
      <a-button
        v-if="copy?.status === 'rejected'"
        size="small"
        type="primary"
        status="danger"
        @click="onFillReviewOpinion"
      >
        <template #icon><icon-edit /></template>
        按审核意见改稿重新生成
      </a-button>
      <span v-if="copy?.status === 'rejected'" class="mw-subtle">改好后重新提交将重送审核（单号不变）</span>
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
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type GateResult, type Section } from '@/api/copy'

const store = useCopyStore()

const copy = computed(() => store.copy)
const review = computed(() => store.detail?.review ?? null)
const inReview = computed(() => copy.value?.status === 'in_review')

/* ── 校对台进展：状态文案 + 轮询（机审几十秒、人工分钟级，自动刷新免手动翻页） ── */

const EXTERNAL_STATUS_LABELS: Record<string, string> = {
  sending: '送审中',
  resubmit_pending: '待重新送审',
  resubmit_refused: '重审被拒收',
  pending_machine: '待机审',
  machine_reviewing: '机审中',
  pending_revise: '机审拦截待修改',
  pending_first: '待初审',
  first_reviewing: '初审中',
  pending_final: '待终审',
  final_reviewing: '终审中',
  approved: '已通过',
  rejected: '已驳回',
}

const externalStatusText = computed(() => {
  const v = review.value?.externalStatus
  return v ? (EXTERNAL_STATUS_LABELS[v] ?? v) : ''
})

const polling = ref(false)
let pollTimer: number | null = null

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

async function refreshReview(): Promise<void> {
  const cur = store.detail?.review
  const copyId = copy.value?.id
  if (!cur || !copyId) return
  polling.value = true
  try {
    const { review: next } = await copyApi.reviewProgress(copyId)
    // 轮询期间换了文案 / 撤回重建了审核单：丢弃这次结果
    if (store.detail?.review?.id !== cur.id || !next || next.id !== cur.id) return
    store.detail.review = { ...cur, ...next }
    if (next.status === 'approved' || next.status === 'rejected') {
      stopPoll()
      // 终态联动 copy 状态 / 草稿解锁，重拉整份详情（低频，仅此一次）
      await store.load(copyId)
    }
  } catch {
    /* 网络抖动静默跳过，下轮再试 */
  } finally {
    polling.value = false
  }
}

const shouldPoll = computed(() => inReview.value && !!review.value && !review.value.isStub && !!review.value.id)

watch(
  shouldPoll,
  (v) => {
    stopPoll()
    if (v) {
      void refreshReview()
      pollTimer = window.setInterval(() => void refreshReview(), 15000)
    }
  },
  { immediate: true },
)

onBeforeUnmount(stopPoll)

/* ── 驳回态：把审核意见填入创作要求，AI 按意见改稿重新生成 ── */

function onFillReviewOpinion(): void {
  const opinion = review.value?.rejectReason || copy.value?.rejectReason || ''
  if (!opinion.trim()) {
    Message.warning('暂无审核意见，请手动修改后重新提交')
    return
  }
  const prefix = '上稿被审核退回，请务必逐条修正以下问题后重新创作：\n'
  const opinionText = `${prefix}${opinion}`
  const prev = (store.creativeSettings.instructions ?? '').trim()
  if (prev.includes(opinion.slice(0, 30))) {
    Message.info('审核意见已在创作要求中，可直接生成')
    return
  }
  store.creativeSettings.instructions = prev ? `${prev}\n${opinionText}` : opinionText
  Message.success('审核意见已填入「本次创作要求」，确认后点击生成，生成满意后重新提交即可重送审核')
}

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
