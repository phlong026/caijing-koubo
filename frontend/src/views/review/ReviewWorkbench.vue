<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="审核工作台">
      <template #sub>串联审核链：第 1 关 抖音 AI 文案审核 → 第 2 关 自有审核智能体 → 第 3 关 风险提示 Skill → 人工复核</template>
      <template #actions>
        <span class="mw-alert-banner">方案模拟 · 审核智能体与平台侧审核能力待验证</span>
      </template>
    </PageHead>

    <div class="flex items-center gap-4 mb-4">
      <a-tabs v-model:active-key="tab" type="line" class="mw-tabs">
        <a-tab-pane key="pending"><template #title>待审核 <span class="mw-subtle">{{ queue.length }}</span></template></a-tab-pane>
        <a-tab-pane key="passed"><template #title>已通过 <span class="mw-subtle">{{ passed.length }}</span></template></a-tab-pane>
        <a-tab-pane key="rejected"><template #title>已退回 <span class="mw-subtle">{{ rejected.length }}</span></template></a-tab-pane>
      </a-tabs>
    </div>

    <div class="grid grid-cols-[330px_1fr] gap-5 items-start">
      <!-- ============ 审核队列 ============ -->
      <div class="flex flex-col gap-3">
        <div v-if="tab === 'pending'">
          <div
            v-for="r in queue"
            :key="r.id"
            class="mw-card p-4 cursor-pointer transition-all"
            :class="currentId === r.id ? 'border-[color:var(--mw-primary)] ring-1 ring-[color:var(--mw-primary)]' : 'hover:shadow-sm'"
            @click="currentId = r.id"
          >
            <div class="flex items-center gap-2">
              <span class="text-[14px] font-medium truncate flex-1">{{ r.title }}</span>
              <LineTag :line="r.line" />
            </div>
            <div class="mw-subtle mt-1.5">{{ r.submitter }} · {{ r.time }} · 来源：{{ r.source }}</div>
            <div class="mt-2 flex items-center gap-1.5">
              <span class="mw-tag mw-tag-green">第1关 通过</span>
              <span class="mw-tag mw-tag-green">第2关 通过</span>
              <span class="mw-tag mw-tag-blue">第3关 已追加</span>
            </div>
          </div>
          <div v-if="!queue.length" class="mw-card p-8 text-center mw-subtle">当前队列已清空</div>
        </div>
        <div v-else class="mw-card divide-y divide-[#f2f4f7]">
          <div v-for="r in tab === 'passed' ? passed : rejected" :key="r.id" class="p-4">
            <div class="flex items-center gap-2">
              <span class="text-[14px] font-medium flex-1 truncate">{{ r.title }}</span>
              <LineTag :line="r.line" />
            </div>
            <div class="mw-subtle mt-1">{{ r.submitter }} · {{ r.time }}</div>
            <div class="mt-1.5">
              <span class="mw-tag" :class="tab === 'passed' ? 'mw-tag-green' : 'mw-tag-red'">
                {{ tab === 'passed' ? '人工复核通过' : '已退回：' + (rejectReasons[r.id] || '命中规则') }}
              </span>
            </div>
          </div>
          <div v-if="!(tab === 'passed' ? passed : rejected).length" class="p-8 text-center mw-subtle">暂无记录</div>
        </div>
      </div>

      <!-- ============ 审核详情 ============ -->
      <div v-if="current && tab === 'pending'" class="flex flex-col gap-4">
        <!-- 串联关卡指示 -->
        <div class="mw-card p-4 flex items-center gap-3">
          <template v-for="(g, i) in gates" :key="g.name">
            <span v-if="i > 0"><icon-right :size="16" class="text-[var(--mw-text3)]" /></span>
            <div class="flex items-center gap-2.5">
              <div class="text-center">
                <div class="mw-subtle">第 {{ i + 1 }} 关</div>
                <div class="text-[13.5px] font-medium mt-0.5">{{ g.name }}</div>
              </div>
              <span class="mw-tag mw-tag-green">{{ g.status }}</span>
            </div>
          </template>
          <div class="flex-1"></div>
          <span class="mw-tag mw-tag-blue">人工复核中</span>
        </div>

        <!-- 平台侧结果 -->
        <div class="mw-card p-5">
          <div class="flex items-center gap-2 mb-2">
            <div class="text-[15px] font-semibold">抖音 AI 文案审核 — 平台侧结果</div>
            <span class="mw-tag mw-tag-green">通过</span>
          </div>
          <div class="text-[13.5px] text-[var(--mw-text2)]">{{ current.platform.text }}</div>
          <div class="mw-subtle mt-1.5">审核时间：09:11 · 平台返回置信度 {{ current.platform.conf }}%</div>
        </div>

        <!-- 初审报告 -->
        <div class="mw-card p-5">
          <div class="flex items-center gap-2 mb-2">
            <div class="text-[15px] font-semibold">自有审核智能体 — 初审报告</div>
            <span class="mw-tag mw-tag-green">通过</span>
          </div>
          <div class="flex flex-col gap-1.5 text-[13.5px] text-[var(--mw-text2)]">
            <div>{{ current.agent.compliance }}</div>
            <div>{{ current.agent.risk }}</div>
            <div>{{ current.agent.product }}</div>
            <div>{{ current.agent.sensitive }}</div>
          </div>
          <div class="mw-subtle mt-2">初审时间：09:12 · 置信度 {{ current.agent.conf }}%</div>
        </div>

        <!-- 文案预览 -->
        <div class="mw-card p-5">
          <div class="flex items-center gap-2 mb-2">
            <div class="text-[15px] font-semibold">文案预览</div>
            <LineTag :line="current.line" />
            <span class="mw-subtle">{{ current.title }}</span>
          </div>
          <div class="text-[14px] leading-7 text-[var(--mw-text)]">{{ current.copy }}</div>
          <div class="mt-3 p-3.5 rounded-[8px] bg-[#f7f8fa] border border-[var(--mw-border)]">
            <div class="text-[13px] font-semibold mb-1">风险提示 Skill 追加话术</div>
            <div class="text-[13px] text-[var(--mw-text2)] leading-6">{{ current.skillText }}</div>
          </div>
        </div>

        <!-- 操作区 -->
        <div class="mw-card p-5">
          <div class="flex items-center gap-3">
            <a-button type="primary" size="large" @click="approve"><template #icon><icon-check /></template>通过审核</a-button>
            <a-button size="large" status="danger" @click="rejecting = !rejecting"><template #icon><icon-undo /></template>退回修改</a-button>
          </div>
          <div v-if="rejecting" class="mt-3">
            <a-textarea v-model="reason" :auto-size="{ minRows: 2 }" placeholder="退回原因（退回时必填）..." />
            <a-button type="primary" status="danger" class="mt-2" @click="reject">确认退回</a-button>
          </div>
          <div class="mw-subtle mt-3 flex items-center gap-1"><icon-info-circle :size="13" />通过后文案可用于视频生成；退回将通知提交人并从第 1 关重新走审核链。</div>
        </div>
      </div>
      <div v-else class="mw-card p-10 text-center mw-subtle">在左侧选择记录查看三关审核结果与文案全文</div>
    </div>
    <div class="mw-corner-note">方案模拟 · 演示数据</div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import LineTag from '@/components/LineTag.vue'
import { reviewQueue } from '@/mocks/data'

const tab = ref('pending')
const currentId = ref('R-301')
const rejecting = ref(false)
const reason = ref('')
const rejectReasons = reactive<Record<string, string>>({})
const passed = ref<typeof reviewQueue>([])
const rejected = ref<typeof reviewQueue>([])
const queue = ref(reviewQueue.filter((r) => !passed.value.includes(r) && !rejected.value.includes(r)))

const current = computed(() => queue.value.find((r) => r.id === currentId.value))
const gates = [
  { name: '抖音 AI 文案审核', status: '通过' },
  { name: '自有审核智能体', status: '通过' },
  { name: '风险提示 Skill', status: '已追加' },
]

function approve() {
  const r = current.value
  if (!r) return
  passed.value.push(r)
  queue.value = queue.value.filter((x) => x.id !== r.id)
  Message.success(`「${r.title}」已通过人工复核，可用于视频生成（演示）`)
}
function reject() {
  const r = current.value
  if (!r) return
  if (!reason.value.trim()) return Message.warning('退回时必填退回原因')
  rejectReasons[r.id] = reason.value.trim()
  rejected.value.push(r)
  queue.value = queue.value.filter((x) => x.id !== r.id)
  rejecting.value = false
  reason.value = ''
  Message.success(`「${r.title}」已退回，通知提交人（演示）`)
}
</script>
