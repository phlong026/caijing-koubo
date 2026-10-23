<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="审核工作台">
      <template #sub
        >文案人工复核：查看提交版本与关卡结果，通过或退回（退回须写原因）。提交人不能裁决自己的文案。</template
      >
      <template #actions>
        <span v-if="!stubEnabled" class="mw-alert-banner">自动审核关卡尚未接入：已提交的文案由人工复核直接裁决</span>
      </template>
    </PageHead>

    <div class="flex items-center gap-4 mb-4 flex-wrap">
      <a-tabs v-model:active-key="scope" type="line" class="mw-tabs flex-1">
        <a-tab-pane key="pending"
          ><template #title
            >待审核 <span class="mw-subtle">{{ scope === 'pending' ? items.length : '' }}</span></template
          ></a-tab-pane
        >
        <a-tab-pane key="decided" title="最近已裁决" />
      </a-tabs>
      <a-select
        v-model="line"
        :style="{ width: '140px' }"
        allow-clear
        placeholder="全部生产线"
        aria-label="按生产线筛选"
      >
        <a-option value="manager" label="经理 IP" />
        <a-option value="kos" label="员工 KOS" />
        <a-option value="persona" label="素人矩阵" />
      </a-select>
      <a-button :loading="loading" @click="load"
        ><template #icon><icon-refresh /></template>刷新</a-button
      >
    </div>

    <div class="review-layout">
      <section class="flex flex-col gap-3" aria-label="审核队列">
        <p v-if="error" class="mw-subtle" role="alert">{{ error }}</p>
        <button
          v-for="r in items"
          :key="r.submissionId"
          type="button"
          class="mw-card review-item"
          :class="{ active: current?.submissionId === r.submissionId }"
          :aria-pressed="current?.submissionId === r.submissionId"
          @click="select(r)"
        >
          <div class="flex items-center gap-2">
            <span class="text-[14px] font-medium truncate flex-1">{{ r.copyTitle || '（无标题）' }}</span>
            <LineTag v-if="r.line" :line="r.line" />
          </div>
          <div class="mw-subtle mt-1.5">
            {{ r.personaName || '—' }} · 提交人 {{ r.submittedBy || '—' }} · {{ fmt(r.submittedAt) }}
          </div>
          <div class="mt-2 flex items-center gap-1.5 flex-wrap">
            <span class="mw-tag" :class="statusTone(r.status)">{{ GATE_LABELS[r.status] ?? r.status }}</span>
            <span v-if="r.versionNo" class="mw-tag mw-tag-gray">v{{ r.versionNo }}</span>
            <span v-if="r.decidedBy" class="mw-subtle">裁决人 {{ r.decidedBy }}</span>
          </div>
        </button>
        <div v-if="!items.length && !loading" class="mw-card p-8 text-center mw-subtle">
          {{ scope === 'pending' ? '当前没有待审核的文案' : '暂无已裁决记录' }}
        </div>
      </section>

      <section class="mw-card p-5 review-detail" aria-label="审核详情">
        <div v-if="!current" class="mw-subtle text-center py-16">从左侧选择一条文案开始复核</div>
        <a-spin v-else :loading="detailLoading" class="w-full">
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="text-[18px] font-bold m-0">{{ version?.title || current.copyTitle || '（无标题）' }}</h2>
            <LineTag v-if="current.line" :line="current.line" />
            <span class="mw-tag" :class="statusTone(current.status)">{{
              GATE_LABELS[current.status] ?? current.status
            }}</span>
          </div>
          <div class="mw-subtle mt-1">
            人物 {{ current.personaName || '—' }} · 版本 v{{ current.versionNo ?? '—' }} ·
            {{ version?.wordCount ?? 0 }} 字 · 提交人 {{ current.submittedBy || '—' }} · {{ fmt(current.submittedAt) }}
          </div>

          <div v-if="gates.length" class="gates">
            <div v-for="(g, i) in gates" :key="i" class="gate">
              <span class="mw-tag" :class="g.result === 'pass' ? 'mw-tag-green' : 'mw-tag-red'"
                >{{ GATE_LABELS[g.gate] ?? g.gate }} · {{ g.result === 'pass' ? '通过' : '未通过' }}</span
              >
              <span v-if="g.reason" class="mw-subtle">{{ g.reason }}</span>
              <span v-if="g.riskPoints?.length" class="risk-points">风险点：{{ g.riskPoints.join('；') }}</span>
            </div>
          </div>

          <article class="copy-body">
            <section v-for="(sec, i) in version?.sections ?? []" :key="i">
              <h3>{{ sec.label }}</h3>
              <p>{{ sec.text }}</p>
            </section>
            <section v-if="appendedRisk" class="risk-tail">
              <h3>风险提示（追加话术）</h3>
              <p>{{ appendedRisk }}</p>
            </section>
          </article>

          <div v-if="version?.complianceHits?.length" class="hits">
            <strong>提交时合规扫描命中</strong>
            <ul>
              <li v-for="(h, i) in version.complianceHits" :key="i">
                {{ h.word }}<span class="mw-subtle">（{{ h.level === 'hard' ? '硬禁用' : '软提示' }}）</span>
              </li>
            </ul>
          </div>

          <div v-if="current.reason" class="decided-reason">退回原因：{{ current.reason }}</div>

          <div v-if="decidable" class="decision">
            <a-textarea
              v-model="reason"
              :max-length="500"
              show-word-limit
              :auto-size="{ minRows: 2, maxRows: 5 }"
              placeholder="退回原因（退回时必填），会展示给文案作者"
            />
            <a-input-tag v-model="riskPoints" placeholder="风险点（可选，输入后回车）" allow-clear />
            <div class="flex items-center gap-2">
              <span v-if="isOwn" class="mw-subtle">四眼原则：这是你自己提交的文案，需由其他审核员裁决</span>
              <div class="flex-1" />
              <a-button status="danger" :loading="deciding" :disabled="isOwn" @click="decide('rejected')"
                >退回</a-button
              >
              <a-button type="primary" :loading="deciding" :disabled="isOwn" @click="decide('approved')">通过</a-button>
            </div>
          </div>
          <p v-else-if="scope === 'pending'" class="mw-subtle mt-3">
            该文案正在自动关卡中（{{ GATE_LABELS[current.status] }}），进入「待人工复核」后可裁决。
          </p>
        </a-spin>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import LineTag from '@/components/LineTag.vue'
import {
  copyApi,
  type CopyLine,
  type CopyVersion,
  type GateResult,
  type ReviewQueueItem,
  type Section,
} from '@/api/copy'
import { useAuthStore } from '@/stores/auth'

const GATE_LABELS: Record<string, string> = {
  submitted: '已提交',
  gate1: '第 1 关 · 合规词与禁用表述',
  gate2: '第 2 关 · 事实与风险点',
  gate3: '第 3 关 · 风险提示追加',
  pending_manual: '待人工复核',
  manual: '人工复核',
  approved: '审核通过',
  rejected: '已退回',
}

const auth = useAuthStore()
const scope = ref<'pending' | 'decided'>('pending')
const line = ref<CopyLine | undefined>()
const items = ref<ReviewQueueItem[]>([])
const stubEnabled = ref(false)
const loading = ref(false)
const error = ref('')
const current = ref<ReviewQueueItem | null>(null)
const version = ref<(CopyVersion & { sections: Section[]; plainText: string }) | null>(null)
const gates = ref<GateResult[]>([])
const appendedRisk = ref<string | null>(null)
const detailLoading = ref(false)
const reason = ref('')
const riskPoints = ref<string[]>([])
const deciding = ref(false)

const decidable = computed(
  () => scope.value === 'pending' && !!current.value && ['submitted', 'pending_manual'].includes(current.value.status),
)
const isOwn = computed(() => !!current.value?.submittedBy && current.value.submittedBy === auth.user?.username)

function fmt(v: string | null): string {
  return v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function statusTone(status: string): string {
  if (status === 'approved') return 'mw-tag-green'
  if (status === 'rejected') return 'mw-tag-red'
  if (status === 'pending_manual' || status === 'submitted') return 'mw-tag-yellow'
  return 'mw-tag-blue'
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = await copyApi.reviewQueue(scope.value, line.value)
    items.value = r.items
    stubEnabled.value = r.stubEnabled
    const keep = current.value && r.items.find((i) => i.submissionId === current.value!.submissionId)
    if (keep) current.value = keep
    else if (r.items.length) void select(r.items[0]!)
    else current.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function select(item: ReviewQueueItem): Promise<void> {
  current.value = item
  reason.value = ''
  riskPoints.value = []
  detailLoading.value = true
  try {
    const [v, sub] = await Promise.all([copyApi.version(item.versionId), copyApi.submissionDetail(item.submissionId)])
    if (current.value?.submissionId !== item.submissionId) return
    version.value = v
    gates.value = sub.gateResults ?? []
    appendedRisk.value = sub.appendedRiskText
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    detailLoading.value = false
  }
}

async function decide(result: 'approved' | 'rejected'): Promise<void> {
  if (!current.value) return
  if (result === 'rejected' && !reason.value.trim()) {
    Message.warning('退回必须填写原因')
    return
  }
  deciding.value = true
  try {
    await copyApi.manualDecision(current.value.submissionId, {
      result,
      reason: reason.value.trim() || undefined,
      riskPoints: riskPoints.value.length ? riskPoints.value : undefined,
    })
    Message.success(result === 'approved' ? '已通过，文案可用于视频创作' : '已退回，作者可修改后重新提交')
    current.value = null
    await load()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    deciding.value = false
  }
}

watch([scope, line], () => {
  current.value = null
  void load()
})
onMounted(load)
</script>

<style scoped>
.review-layout {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.review-item {
  text-align: left;
  padding: 14px 16px;
  cursor: pointer;
  background: #fff;
  font: inherit;
  color: inherit;
}
.review-item.active {
  border-color: var(--mw-primary);
  box-shadow: 0 0 0 1px var(--mw-primary);
}
.review-detail {
  position: sticky;
  top: 16px;
}
.gates {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.gate {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.risk-points {
  color: #b45427;
}
.copy-body {
  margin-top: 16px;
  border-top: 1px solid var(--mw-border-light);
  padding-top: 12px;
}
.copy-body h3 {
  font-size: 13px;
  margin: 12px 0 4px;
  color: var(--mw-text2);
}
.copy-body p {
  font-size: 14px;
  line-height: 1.9;
  margin: 0;
  white-space: pre-wrap;
}
.risk-tail {
  margin-top: 12px;
  padding: 8px 10px;
  background: #fff7e8;
  border-radius: 6px;
}
.hits {
  margin-top: 12px;
  font-size: 12px;
}
.hits ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.decided-reason {
  margin-top: 12px;
  font-size: 13px;
  color: #b42318;
}
.decision {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--mw-border-light);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
@media (max-width: 1100px) {
  .review-layout {
    grid-template-columns: 1fr;
  }
  .review-detail {
    position: static;
  }
}
</style>
