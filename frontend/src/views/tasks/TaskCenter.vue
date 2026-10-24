<template>
  <div class="p-7 pb-10 max-w-[1500px] mx-auto">
    <PageHead title="任务中心">
      <template #sub>
        <div>
          <div>跟进内容进度，找到下一步</div>
          <div>{{ todayLabel }}</div>
        </div>
      </template>
      <template #actions>
        <a-button :loading="listLoading" @click="refreshAll">
          <template #icon><icon-refresh /></template>刷新
        </a-button>
      </template>
    </PageHead>

    <div class="flex items-center gap-4 mb-4">
      <a-tabs v-model:active-key="tab" type="line" class="mw-tabs flex-1" @change="fetchTasks">
        <a-tab-pane key="all"
          ><template #title
            >全部任务 <span class="mw-subtle">{{ counts.all }}</span></template
          ></a-tab-pane
        >
        <a-tab-pane key="mine"
          ><template #title
            >我负责的 <span class="mw-subtle">{{ counts.mine }}</span></template
          ></a-tab-pane
        >
        <a-tab-pane key="todo"
          ><template #title
            >需处理 <span class="mw-subtle">{{ counts.todo }}</span></template
          ></a-tab-pane
        >
      </a-tabs>
    </div>
    <div class="flex items-center gap-2.5 mb-4 -mt-2">
      <a-select
        v-model="filterPhase"
        :style="{ width: '130px' }"
        placeholder="全部阶段"
        allow-clear
        @change="fetchTasks"
      >
        <a-option v-for="o in STAGE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</a-option>
      </a-select>
      <a-select
        v-model="filterStatus"
        :style="{ width: '130px' }"
        placeholder="全部状态"
        allow-clear
        @change="fetchTasks"
      >
        <a-option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</a-option>
      </a-select>
      <a-select v-model="filterLine" :style="{ width: '150px' }" placeholder="全部线" allow-clear @change="fetchTasks">
        <a-option v-for="(label, key) in LINE_LABELS" :key="key" :value="key">{{ label }}</a-option>
      </a-select>
      <a-input-search
        v-model="keyword"
        :style="{ width: '260px' }"
        placeholder="搜索任务标题、任务号、负责人..."
        allow-clear
        @search="fetchTasks"
        @clear="fetchTasks"
      />
    </div>

    <div class="grid grid-cols-[1fr_380px] gap-5 items-start">
      <!-- ============ 任务列表 ============ -->
      <div class="mw-card overflow-hidden">
        <div
          class="grid grid-cols-[30fr_16fr_10fr_22fr_12fr] text-[12px] mw-thead px-5 py-2.5 border-b border-[var(--mw-border)]"
        >
          <span>内容</span><span>运营主体</span><span>负责人</span><span>阶段与状态</span><span>下一步</span>
        </div>
        <div v-if="!listLoading && !tasks.length" class="py-16 text-center">
          <div class="text-[14px] text-[var(--mw-text2)]">还没有任务</div>
          <div class="mw-subtle mt-1">去文案工坊开始第一条内容，任务会自动出现在这里</div>
          <a-button type="outline" size="small" class="mt-3" @click="$router.push('/copy')">去文案工坊</a-button>
        </div>
        <a-spin v-else :loading="listLoading && !tasks.length">
          <div
            v-for="t in tasks"
            :key="t.copyId"
            class="grid grid-cols-[30fr_16fr_10fr_22fr_12fr] items-center px-5 py-3 border-b border-[#f2f4f7] cursor-pointer transition-colors"
            :class="currentId === t.copyId ? 'bg-[color:var(--mw-primary-faint)]' : 'hover:bg-[#fafbfc]'"
            @click="selectTask(t.copyId)"
          >
            <div class="flex items-center gap-3 min-w-0">
              <ThumbBox :seed="t.copyId" :width="52" :height="40" />
              <div class="min-w-0">
                <div class="text-[14px] font-medium truncate">{{ t.title }}</div>
                <div class="mw-subtle">任务 {{ t.taskNo }} · {{ t.personaName || '未分配人物' }}</div>
              </div>
            </div>
            <div>
              <div class="text-[13px]">{{ t.subject || '—' }}</div>
              <LineTag v-if="t.line" :line="t.line" class="mt-0.5" />
            </div>
            <div class="text-[13px]">{{ t.createdBy || '—' }}</div>
            <div>
              <div class="flex items-center gap-2 text-[13px] font-medium">
                <span class="mw-dot" :style="{ background: toneColor(t.stage.tone) }"></span>{{ t.stage.title }}
              </div>
              <div class="text-[12px] mt-0.5" :style="{ color: toneColor(t.stage.tone) }">
                {{ t.stage.statusLabel }}
              </div>
              <a-progress
                v-if="t.stage.progress != null && t.stage.progress > 0 && t.stage.tone === 'doing'"
                :percent="t.stage.progress / 100"
                size="mini"
                :show-text="false"
                class="mt-1 !w-32"
              />
            </div>
            <span v-if="stageAction(t)" class="mw-link flex items-center" @click.stop="goAction(t, stageAction(t)!)"
              >{{ stageAction(t)!.actionLabel }} <icon-right :size="12" class="ml-0.5"
            /></span>
            <span v-else class="mw-subtle">—</span>
          </div>
        </a-spin>
        <div v-if="total > pageSize" class="flex justify-end px-5 py-3">
          <a-pagination
            :current="page"
            :page-size="pageSize"
            :total="total"
            size="mini"
            show-total
            @change="
              (p: number) => {
                page = p
                fetchTasks()
              }
            "
          />
        </div>
      </div>

      <!-- ============ 任务详情 ============ -->
      <div class="mw-card p-5 min-h-[400px]" v-if="current">
        <a-spin :loading="detailLoading" class="block">
          <div class="flex items-start justify-between">
            <div class="text-[16px] font-semibold">{{ current.task.title }}</div>
            <span class="mw-subtle">任务 {{ current.task.taskNo }}</span>
          </div>
          <div class="mw-subtle mt-1">
            {{ current.task.personaName || '未分配人物' }} ·
            {{ current.task.line ? LINE_LABELS[current.task.line] || current.task.line : '—' }}
            <template v-if="current.task.subject"> · {{ current.task.subject }}</template>
          </div>

          <div class="mt-4 text-[14px] font-semibold mb-3">进度流程</div>
          <div class="mw-timeline-item" v-for="(n, i) in visibleNodes" :key="n.key">
            <div class="mw-timeline-dot" :style="{ background: toneColor(n.tone, i === 0) }">
              <icon-check :size="10" style="color: #fff" v-if="n.tone === 'done'" />
              <icon-edit :size="9" style="color: #fff" v-else />
            </div>
            <div class="text-[13.5px] font-medium" :style="n.tone === 'doing' ? 'color:#7c5cd6' : ''">
              {{ n.title }}
            </div>
            <div class="text-[12px] mt-0.5" :style="{ color: toneColor(n.tone) }">{{ n.statusLabel }}</div>
            <div class="text-[11.5px] text-[var(--mw-text3)] mt-0.5" v-if="n.happenedAt">
              {{ fmtTime(n.happenedAt) }}
            </div>
          </div>

          <div class="mt-2 text-[14px] font-semibold mb-2">关联内容</div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <template v-for="(c, i) in current.chips" :key="c.key">
              <span v-if="i > 0"><icon-right :size="12" class="text-[var(--mw-text3)]" /></span>
              <span
                class="p-2 rounded-[8px] border text-center"
                :class="c.current ? 'border-[#7c5cd6] bg-[#f6f2fd]' : 'border-[var(--mw-border)]'"
              >
                <div class="text-[12px] font-medium" :style="c.current ? 'color:#7c5cd6' : ''">{{ c.title }}</div>
                <div class="text-[10.5px] text-[var(--mw-text3)]">{{ c.sub }}</div>
              </span>
            </template>
          </div>

          <div class="mt-3 text-[14px] font-semibold mb-2">最近动态</div>
          <div v-if="!current.timeline.length" class="mw-subtle">暂无动态</div>
          <div v-for="(e, i) in current.timeline.slice(0, 8)" :key="i" class="flex items-start gap-2 py-1">
            <span class="mw-dot mt-1.5 shrink-0" :style="{ background: toneColor(e.tone) }"></span>
            <div class="min-w-0">
              <div class="text-[12.5px] truncate">
                {{ e.title }}<template v-if="e.desc"> · {{ e.desc }}</template>
              </div>
              <div class="text-[11px] text-[var(--mw-text3)]">{{ fmtTime(e.time) }}</div>
            </div>
          </div>

          <a-button
            v-if="detailAction"
            type="primary"
            long
            class="mt-4"
            @click="goAction(current.task, detailAction)"
            >{{ detailAction.actionLabel }}</a-button
          >
          <a-button v-else type="outline" long disabled class="mt-4">暂无待办</a-button>
        </a-spin>
      </div>
      <div class="mw-card p-5 text-center mw-subtle" v-else>选择左侧任务查看进度</div>
    </div>

    <div class="mt-4 flex items-center gap-6">
      <span class="mw-subtle flex items-center gap-1"
        ><icon-info-circle :size="13" />保存失败仅重试下载，避免重复生成计费。</span
      >
      <span class="mw-subtle flex items-center gap-1"
        ><icon-info-circle :size="13" />状态不明先查询原任务，不直接重新提交。</span
      >
      <span class="mw-subtle flex items-center gap-1"
        ><icon-info-circle :size="13" />素材混剪已一期启用，与口播共用任务流程。</span
      >
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import LineTag from '@/components/LineTag.vue'
import ThumbBox from '@/components/ThumbBox.vue'
import {
  getTaskDetail,
  listTasks,
  LINE_LABELS,
  STATUS_OPTIONS,
  STAGE_OPTIONS,
  type NodeTone,
  type TaskDetail,
  type TaskNode,
  type TaskSummary,
} from '@/api/taskCenter'

const router = useRouter()
const todayLabel = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: 'Asia/Shanghai' }).format(new Date())

const tab = ref('all')
const filterPhase = ref(undefined as string | undefined)
const filterStatus = ref(undefined as string | undefined)
const filterLine = ref(undefined as string | undefined)
const keyword = ref('')
const page = ref(1)
const pageSize = 20
const tasks = ref<TaskSummary[]>([])
const counts = ref({ all: 0, mine: 0, todo: 0 })
const total = ref(0)
const listLoading = ref(false)
const currentId = ref<string | null>(null)
const current = ref<TaskDetail | null>(null)
const detailLoading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

const visibleNodes = computed(() => (current.value ? current.value.task.nodes.filter((n) => n.key !== 'edit') : []))

function toneColor(tone: NodeTone, active = false): string {
  if (tone === 'done') return '#1d4ed8'
  if (tone === 'error') return '#d4380d'
  if (tone === 'wait') return '#98a2b3'
  if (tone === 'doing' || active) return '#7c5cd6'
  return '#d0d5dd'
}

function stageAction(t: TaskSummary): TaskNode | null {
  const node = t.nodes.find((n) => n.key === t.stage.key)
  return node?.action ? node : null
}

const detailAction = computed(() => (current.value ? stageAction(current.value.task) : null))

async function fetchTasks() {
  listLoading.value = true
  try {
    const res = await listTasks({
      tab: tab.value,
      phase: filterPhase.value,
      status: filterStatus.value,
      line: filterLine.value,
      keyword: keyword.value || undefined,
      page: page.value,
      pageSize,
    })
    tasks.value = res.items
    total.value = res.total
    counts.value = res.counts
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '任务列表加载失败')
  } finally {
    listLoading.value = false
  }
}

async function selectTask(copyId: string) {
  currentId.value = copyId
  detailLoading.value = true
  try {
    current.value = await getTaskDetail(copyId)
  } catch (e) {
    current.value = null
    Message.error(e instanceof Error ? e.message : '任务详情加载失败')
  } finally {
    detailLoading.value = false
  }
}

function refreshAll() {
  fetchTasks()
  if (currentId.value) selectTask(currentId.value)
}

/** §3.4 动作 → 路由映射（任务树只含最新版本视频，统一 copyId 定位） */
function routeOfAction(action: string, copyId: string): string {
  switch (action) {
    case 'write_copy':
    case 'continue_write':
    case 'revise_resubmit':
      return `/copy?id=${copyId}`
    case 'view_review':
      return '/review'
    case 'continue_edit':
      return '/video/edit'
    case 'create_plan':
    case 'wait_review':
    case 'view_logs':
    case 'retry':
    case 'manual_confirm':
      return `/publish?copyId=${copyId}`
    default:
      // create_video / view_progress / retry_download / query_original / bind_remote / realign / regenerate
      return `/video/create?copyId=${copyId}`
  }
}

function goAction(t: TaskSummary, node: TaskNode) {
  if (!node.action) return
  router.push(routeOfAction(node.action, t.copyId))
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(d)
}

onMounted(() => {
  fetchTasks()
  // 30 秒轮询（页签隐藏时跳过，TC2）
  pollTimer = setInterval(() => {
    if (document.hidden) return
    fetchTasks()
    if (currentId.value && !detailLoading.value) {
      getTaskDetail(currentId.value)
        .then((d) => (current.value = d))
        .catch(() => undefined)
    }
  }, 30_000)
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>
