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
      <a-tabs v-model:active-key="tab" type="line" class="mw-tabs flex-1" @change="reload">
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
      <a-select v-model="filterPhase" :style="{ width: '130px' }" placeholder="全部阶段" allow-clear @change="reload">
        <a-option v-for="o in STAGE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</a-option>
      </a-select>
      <a-select v-model="filterStatus" :style="{ width: '130px' }" placeholder="全部状态" allow-clear @change="reload">
        <a-option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</a-option>
      </a-select>
      <a-select v-model="filterLine" :style="{ width: '150px' }" placeholder="全部线" allow-clear @change="reload">
        <a-option v-for="(label, key) in LINE_LABELS" :key="key" :value="key">{{ label }}</a-option>
      </a-select>
      <a-input-search
        v-model="keyword"
        :style="{ width: '260px' }"
        placeholder="搜索任务标题、任务号、负责人..."
        allow-clear
        @search="reload"
        @clear="reload"
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

          <div class="mt-3 flex items-center justify-between mb-2">
            <span class="text-[14px] font-semibold">最近动态</span>
            <span v-if="current.timelineTruncated" class="mw-subtle">仅显示最近 100 条</span>
          </div>
          <div v-if="!current.timeline.length" class="mw-subtle">暂无动态</div>
          <template v-else>
            <div class="max-h-[340px] overflow-y-auto">
              <div v-for="(e, i) in shownTimeline" :key="`${e.time}-${i}`" class="flex items-start gap-2 py-1">
                <span class="mw-dot mt-1.5 shrink-0" :style="{ background: toneColor(e.tone) }"></span>
                <div class="min-w-0">
                  <div class="text-[12.5px] truncate">
                    {{ e.title }}<template v-if="e.desc"> · {{ e.desc }}</template>
                  </div>
                  <div class="text-[11px] text-[var(--mw-text3)]">{{ fmtTime(e.time) }}</div>
                </div>
              </div>
            </div>
            <span
              v-if="current.timeline.length > TIMELINE_COLLAPSED"
              class="mw-link inline-block mt-1"
              @click="timelineExpanded = !timelineExpanded"
              >{{ timelineExpanded ? '收起' : `展开全部 ${current.timeline.length} 条` }}</span
            >
          </template>

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
import { useRoute, useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import LineTag from '@/components/LineTag.vue'
import ThumbBox from '@/components/ThumbBox.vue'
import { features } from '@/config/features'
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
const route = useRoute()
const todayLabel = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: 'Asia/Shanghai' }).format(new Date())

/** 筛选与页码写入 router query：跳去目标页再回来时状态不丢（§7） */
const qs = (k: string): string | undefined =>
  typeof route.query[k] === 'string' ? (route.query[k] as string) : undefined

const tab = ref(qs('tab') ?? 'all')
const filterPhase = ref(qs('phase'))
const filterStatus = ref(qs('status'))
const filterLine = ref(qs('line'))
const keyword = ref(qs('keyword') ?? '')
const page = ref(Math.max(1, Number(qs('page') ?? 1) || 1))
const pageSize = 20
const tasks = ref<TaskSummary[]>([])
const counts = ref({ all: 0, mine: 0, todo: 0 })
const total = ref(0)
const listLoading = ref(false)
const currentId = ref<string | null>(null)
const current = ref<TaskDetail | null>(null)
const detailLoading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

/** 时间线折叠阈值（后端按 §3.6 倒序返回，最多 100 条；此处正序展示） */
const TIMELINE_COLLAPSED = 6
const timelineExpanded = ref(false)

/** 五节点全展示：剪辑为真实节点（TC9 真实化，按 video_cut 最新版本行归一） */
const visibleNodes = computed(() => current.value?.task.nodes ?? [])
const timelineAsc = computed(() => (current.value ? [...current.value.timeline].reverse() : []))
const shownTimeline = computed(() =>
  timelineExpanded.value ? timelineAsc.value : timelineAsc.value.slice(-TIMELINE_COLLAPSED),
)

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

const QUERY_KEYS = ['tab', 'phase', 'status', 'line', 'keyword', 'page'] as const

function syncQuery() {
  const next: Record<string, string> = { tab: tab.value }
  if (filterPhase.value) next.phase = filterPhase.value
  if (filterStatus.value) next.status = filterStatus.value
  if (filterLine.value) next.line = filterLine.value
  if (keyword.value) next.keyword = keyword.value
  if (page.value > 1) next.page = String(page.value)
  const cur: Record<string, string> = {}
  for (const k of QUERY_KEYS) if (qs(k)) cur[k] = qs(k)!
  const keys = new Set([...Object.keys(cur), ...Object.keys(next)])
  for (const k of keys) if (cur[k] !== next[k]) return void router.replace({ query: { ...route.query, ...next } })
}

/** 筛选变化一律回到第 1 页，避免落在空页 */
function reload() {
  page.value = 1
  fetchTasks()
}

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
    syncQuery()
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '任务列表加载失败')
  } finally {
    listLoading.value = false
  }
}

async function selectTask(copyId: string) {
  currentId.value = copyId
  detailLoading.value = true
  timelineExpanded.value = false
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

/** §3.4 动作 → 路由映射（任务树只含最新版本视频，统一 copyId 定位；剪辑动作按节点 refId=videoJobId 定位剪辑页） */
function routeOfAction(action: string, copyId: string, refId?: string | null): string {
  switch (action) {
    case 'write_copy':
    case 'continue_write':
    case 'revise_resubmit':
      return `/copy?id=${copyId}`
    case 'view_review':
      // 审核工作台下线期间改跳文案工坊（「检查与审核」步骤可见审核状态），开关打开后恢复原跳转
      return features.reviewWorkbench ? '/review' : `/copy?id=${copyId}`
    case 'view_cut_review':
      // 成片复审下线期间改跳剪辑页（复审横幅可见状态）
      return features.reviewWorkbench
        ? '/review'
        : refId
          ? `/video/edit?videoJobId=${refId}`
          : `/video/create?copyId=${copyId}`
    case 'continue_edit':
    case 'create_cut':
    case 'view_cut_progress':
    case 'retry_cut':
      return refId ? `/video/edit?videoJobId=${refId}` : `/video/create?copyId=${copyId}`
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
  router.push(routeOfAction(node.action, t.copyId, node.refId))
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
