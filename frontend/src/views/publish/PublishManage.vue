<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import LineTag from '@/components/LineTag.vue'
import { usePublishStore } from '@/stores/publish'
import { useAuthStore } from '@/stores/auth'
import { listVideoJobs } from '@/api/video'
import {
  cancelPlan,
  confirmPlanReview,
  createAccount,
  createPlan,
  executePlanNow,
  LOG_STATUS_LABELS,
  markManualResult,
  patchAccount,
  recheckLog,
  retryLog,
  schedulePlan,
  PLATFORM_LABELS,
  LINE_LABELS,
  PLAN_STATUS_LABELS,
  type Platform,
  type PlatformAccount,
  type PersonaLine,
  type PublishLogView,
  type PublishPlan,
} from '@/api/publish'
import AccountDrawer from './AccountDrawer.vue'
import LoginQrDialog from './LoginQrDialog.vue'
import ManualRecordDialog from './ManualRecordDialog.vue'

/**
 * 发布管理（任务书 §7）：待安排 / 发布计划 / 发布记录 三 Tab + 平台账号抽屉。
 * 矩阵越权置灰（PB1）、needs_review 拦截（FR-R2）、验证中三出口（FR-S3/S4）。
 */
const store = usePublishStore()
const auth = useAuthStore()
const route = useRoute()

/** 任务中心 / 内容页「去发布」跳转定位（TC8）：按 copyId 过滤发布计划并高亮 */
const highlightCopyId = ref<string | null>(null)

const tab = ref<'todo' | 'plan' | 'log'>('todo')
const logPlatform = ref<Platform | undefined>()
const showAccountDrawer = ref(false)
const showManualDialog = ref(false)
const showAddAccount = ref(false)
const loginAccount = ref<PlatformAccount | null>(null)
const showLoginDialog = ref(false)
let pollTimer: number | null = null

const canWrite = computed(() => auth.hasRole('ops', 'admin'))
const canReview = computed(() => auth.hasRole('reviewer', 'admin'))

/* ── 待发布内容（已完成的基础视频）── */
interface PublishableJob {
  id: string
  copyId: string
  title: string
  line: string | null
  versionNo: number
  durationMs: number
}
const jobs = ref<PublishableJob[]>([])
const selectedJob = ref<PublishableJob | null>(null)

async function loadJobs(): Promise<void> {
  try {
    const r = await listVideoJobs({ phase: 'completed', pageSize: 50 })
    jobs.value = r.items.map((j) => ({
      id: j.id,
      copyId: j.copyId,
      title: j.vendorTitle || `基础视频 v${j.versionNo}（${j.copyId.slice(-6)}）`,
      line: j.line,
      versionNo: j.versionNo,
      durationMs: j.durationMs,
    }))
    if (selectedJob.value && !jobs.value.some((j) => j.id === selectedJob.value?.id)) selectedJob.value = null
  } catch (e) {
    Message.error((e as Error).message)
  }
}

/* ── 创建面板 ── */
const creating = ref(false)
const form = reactive({
  title: '',
  description: '',
  tags: '',
  scheduledAt: '',
  items: [] as Array<{ platform: Platform; accountId: string }>,
})

const activeAccounts = computed(() => store.accounts.filter((a) => a.enabled && a.loginStatus === 'active'))

/** PB1 矩阵置灰原因 */
function cellBlocked(line: string | null, platform: Platform): string | null {
  const l = (line ?? 'persona') as PersonaLine
  const cell = store.matrix?.[l]?.[platform]
  if (!cell) return null
  if (!cell.allowed) return `${LINE_LABELS[l]}不可发布到${PLATFORM_LABELS[platform]}`
  if (!cell.activeAccounts) return '该平台暂无在线账号'
  return null
}

function togglePick(platform: Platform, accountId: string): void {
  const idx = form.items.findIndex((i) => i.platform === platform && i.accountId === accountId)
  if (idx >= 0) form.items.splice(idx, 1)
  else form.items.push({ platform, accountId })
}

const isPicked = (platform: Platform, accountId: string): boolean =>
  form.items.some((i) => i.platform === platform && i.accountId === accountId)

function selectJob(j: PublishableJob): void {
  selectedJob.value = j
  form.title = j.title
  form.items = []
  form.scheduledAt = ''
}

async function submitPlan(immediately: boolean): Promise<void> {
  if (!selectedJob.value) return void Message.warning('请先选择待发布内容')
  if (!form.items.length) return void Message.warning('请至少勾选一个平台账号')
  creating.value = true
  try {
    const r = await createPlan({
      copyId: selectedJob.value.copyId,
      videoJobId: selectedJob.value.id,
      items: form.items.map((i) => ({
        platform: i.platform,
        accountId: i.accountId,
        title: form.title || undefined,
        description: form.description || undefined,
        tags: form.tags.split(/[,，\s]+/).filter(Boolean),
      })),
      scheduledAt: immediately ? null : form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
    })
    if (r.plan.reviewState === 'needs_review') {
      Message.warning('标题有实质修改，计划已创建并等待审核确认')
    } else {
      Message.success(immediately ? '已开始发布' : '发布计划已创建')
    }
    if (immediately) await executePlanNow(r.plan.id)
    tab.value = 'plan'
    await loadPlans()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

/* ── 计划 ── */
const loadPlans = () => store.loadPlans(highlightCopyId.value ? { copyId: highlightCopyId.value } : undefined)

function clearCopyHighlight(): void {
  highlightCopyId.value = null
  void loadPlans()
}

async function onSchedule(plan: PublishPlan): Promise<void> {
  try {
    await schedulePlan(plan.id, plan.scheduledAt ?? new Date(Date.now() + 120_000).toISOString())
    Message.success('已排期')
    await loadPlans()
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function onExecuteNow(plan: PublishPlan): Promise<void> {
  try {
    await executePlanNow(plan.id)
    Message.success('已开始执行')
    await loadPlans()
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function onConfirmReview(plan: PublishPlan): Promise<void> {
  try {
    await confirmPlanReview(plan.id)
    Message.success('已确认可发布')
    await loadPlans()
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function onCancel(plan: PublishPlan): Promise<void> {
  try {
    await cancelPlan(plan.id)
    Message.success('已取消')
    await loadPlans()
  } catch (e) {
    Message.error((e as Error).message)
  }
}

/* ── 记录 ── */
const loadLogs = () => store.loadLogs({ platform: logPlatform.value })

function logTone(s: PublishLogView['status']): string {
  if (s === 'published') return 'mw-tag-green'
  if (s === 'verification_required' || s === 'manual_pending') return 'mw-tag-orange'
  if (s === 'failed' || s === 'failed_final') return 'mw-tag-red'
  return 'mw-tag-gray'
}

async function withReload(fn: () => Promise<unknown>, okMsg?: string): Promise<void> {
  try {
    await fn()
    if (okMsg) Message.success(okMsg)
    await Promise.all([loadLogs(), loadPlans(), loadAccounts()])
  } catch (e) {
    Message.error((e as Error).message)
  }
}

function promptText(title: string, def = ''): string | null {
  const v = window.prompt(title, def)
  return v === null ? null : v.trim()
}

const markPublished = (l: PublishLogView) =>
  withReload(() => {
    const url = promptText('发布链接（选填，直接确认可留空）', l.videoUrl ?? '')
    if (url === null) throw new Error('已取消')
    return markManualResult(l.id, { published: true, videoUrl: url || undefined })
  }, '已标记发布成功')

const markFailed = (l: PublishLogView) =>
  withReload(() => {
    const reason = promptText('标记失败原因（必填）')
    if (!reason) throw new Error('标记失败必须填写原因')
    return markManualResult(l.id, { published: false, reason })
  }, '已标记失败')

/* ── 账号 ── */
const loadAccounts = () => Promise.all([store.loadAccounts(), store.loadMatrix()])

const addForm = reactive({ platform: 'douyin' as Platform, line: 'kos' as PersonaLine, displayName: '' })
async function submitAddAccount(): Promise<boolean> {
  if (!addForm.displayName.trim()) {
    Message.warning('请填写账号显示名')
    return false
  }
  try {
    const r = await createAccount({
      platform: addForm.platform,
      line: addForm.line,
      displayName: addForm.displayName.trim(),
    })
    Message.success('账号已创建，请扫码登录')
    showAddAccount.value = false
    addForm.displayName = ''
    loginAccount.value = r.account
    showLoginDialog.value = true
    await loadAccounts()
    return true
  } catch (e) {
    Message.error((e as Error).message)
    return false
  }
}

const onToggleAccount = (a: PlatformAccount, enabled: boolean) =>
  withReload(() => patchAccount(a.id, { enabled }), enabled ? '已启用' : '已停用，进行中发布不受影响')

const onCheckAccount = (a: PlatformAccount) =>
  withReload(async () => {
    const { checkAccountLogin } = await import('@/api/publish')
    const r = await checkAccountLogin(a.id)
    if (!r.loggedIn) Message.warning(`「${a.displayName}」登录态已失效，请重新扫码`)
  }, `「${a.displayName}」登录态正常`)

const onDeleteAccount = (a: PlatformAccount) =>
  withReload(() => import('@/api/publish').then((m) => m.deleteAccount(a.id)), '已删除')

/* ── 生命周期 ── */
async function refreshAll(): Promise<void> {
  await Promise.all([loadJobs(), loadAccounts(), loadPlans(), loadLogs(), store.loadOptions().catch(() => undefined)])
}

onMounted(async () => {
  // 任务中心 / 内容页「去发布」带 copyId 进入时，切到发布计划并按该文案过滤（TC8）
  const qCopyId = route.query.copyId
  if (typeof qCopyId === 'string' && qCopyId) {
    highlightCopyId.value = qCopyId
    tab.value = 'plan'
  }
  await refreshAll()
  // 记录状态变化快：20 秒轻轮询当前 Tab（服务端 sweep 60 秒兜底）
  pollTimer = window.setInterval(() => {
    if (tab.value === 'plan') void loadPlans()
    else if (tab.value === 'log') void loadLogs()
  }, 20_000)
})
onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer)
})

const fmtTime = (s: string | null | undefined): string =>
  s
    ? new Date(s).toLocaleString('zh-CN', {
        hour12: false,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
const platformKeys = Object.keys(PLATFORM_LABELS) as Platform[]
</script>

<template>
  <div class="p-7 pb-10 max-w-[1500px] mx-auto">
    <PageHead title="发布管理">
      <template #sub
        >平台账号扫码登录 → 选择已过审文案与基础视频 →
        按平台×账号矩阵发布；失败自动重试一次，验证码进入人工窗口。</template
      >
      <template #actions>
        <a-button v-if="canWrite" data-testid="manual-record" @click="showManualDialog = true">手动补录</a-button>
        <a-button type="outline" data-testid="account-drawer" @click="showAccountDrawer = true">
          <template #icon><icon-user-group /></template>平台账号（{{ store.accounts.length }}）
        </a-button>
      </template>
    </PageHead>

    <a-alert v-if="store.options?.engine.mock" type="warning" class="mb-4">
      发布引擎当前为 mock 模式（未配置浏览器环境）：全链路可联调，发布结果为模拟数据。
    </a-alert>

    <a-tabs v-model:active-key="tab" type="line" class="mw-tabs mb-4">
      <a-tab-pane key="todo"
        ><template #title
          >待安排 <span class="mw-subtle">{{ jobs.length }}</span></template
        ></a-tab-pane
      >
      <a-tab-pane key="plan"
        ><template #title
          >发布计划 <span class="mw-subtle">{{ tab === 'plan' ? store.plansTotal : '' }}</span></template
        ></a-tab-pane
      >
      <a-tab-pane key="log"
        ><template #title
          >发布记录 <span class="mw-subtle">{{ tab === 'log' ? store.logsTotal : '' }}</span></template
        ></a-tab-pane
      >
    </a-tabs>

    <!-- ══ 待安排 ══ -->
    <div v-if="tab === 'todo'" class="grid grid-cols-[1fr_430px] gap-5 items-start">
      <div class="mw-card p-5">
        <div class="text-[15px] font-semibold mb-3">选择待发布内容（{{ jobs.length }}）</div>
        <div class="flex flex-col gap-3">
          <button
            v-for="j in jobs"
            :key="j.id"
            type="button"
            class="p-3.5 rounded-[10px] border-2 cursor-pointer transition-colors text-left"
            :class="
              selectedJob?.id === j.id
                ? 'border-[color:var(--mw-primary)] bg-[color:var(--mw-primary-faint)]'
                : 'border-[var(--mw-border)] hover:border-[color:var(--mw-primary-soft)]'
            "
            data-testid="publishable-job"
            @click="selectJob(j)"
          >
            <div class="flex items-center gap-2">
              <span class="text-[15px] font-semibold truncate">{{ j.title }}</span>
              <LineTag v-if="j.line" :line="j.line" />
            </div>
            <div class="mw-subtle mt-1">基础视频 v{{ j.versionNo }} · {{ Math.round(j.durationMs / 1000) }} 秒</div>
          </button>
          <div v-if="!jobs.length" class="text-center py-10 mw-subtle">
            暂无已完成的基础视频。先到「视频创作」生成基础视频，完成后可在此发布。
          </div>
        </div>
      </div>

      <div class="mw-card p-5 sticky top-4">
        <div v-if="!selectedJob" class="mw-subtle text-center py-16">从左侧选择内容开始创建发布计划</div>
        <template v-else>
          <div class="text-[15px] font-semibold mb-1">创建发布计划</div>
          <div class="mw-subtle mb-4">{{ selectedJob.title }} · 基础视频 v{{ selectedJob.versionNo }}</div>

          <div class="mb-3">
            <div class="text-[13px] font-medium mb-1.5">发布标题（与文案标题不一致将触发审核确认）</div>
            <a-input v-model="form.title" :max-length="255" placeholder="发布标题" />
          </div>
          <div class="mb-3">
            <div class="text-[13px] font-medium mb-1.5">简介</div>
            <a-textarea
              v-model="form.description"
              :max-length="1000"
              :auto-size="{ minRows: 2, maxRows: 4 }"
              placeholder="发布简介（选填）"
            />
          </div>
          <div class="mb-3">
            <div class="text-[13px] font-medium mb-1.5">话题标签（逗号分隔）</div>
            <a-input v-model="form.tags" placeholder="基金, 定投" />
          </div>

          <div class="mb-3">
            <div class="text-[13px] font-medium mb-1.5">平台 × 账号（越权平台已置灰）</div>
            <div class="flex flex-col gap-2">
              <div
                v-for="pk in platformKeys"
                :key="pk"
                class="p-2.5 rounded-lg border border-[var(--mw-border)]"
                :class="{ 'opacity-50': cellBlocked(selectedJob.line, pk) }"
                :data-testid="`matrix-${pk}`"
              >
                <div class="flex items-center gap-2 mb-1.5">
                  <span class="text-[13px] font-medium">{{ PLATFORM_LABELS[pk] }}</span>
                  <span v-if="cellBlocked(selectedJob.line, pk)" class="mw-subtle text-[12px]">{{
                    cellBlocked(selectedJob.line, pk)
                  }}</span>
                </div>
                <div v-if="activeAccounts.filter((a) => a.platform === pk).length" class="flex flex-wrap gap-1.5">
                  <a-tag
                    v-for="a in activeAccounts.filter((a) => a.platform === pk)"
                    :key="a.id"
                    :checkable="!cellBlocked(selectedJob.line, pk)"
                    :checked="isPicked(pk, a.id)"
                    color="arcoblue"
                    class="cursor-pointer"
                    @check="togglePick(pk, a.id)"
                    >{{ a.displayName }}</a-tag
                  >
                </div>
                <div v-else class="mw-subtle text-[12px]">无在线账号</div>
              </div>
            </div>
          </div>

          <div class="mb-4">
            <div class="text-[13px] font-medium mb-1.5">定时发布（留空 = 待安排）</div>
            <a-date-picker
              v-model="form.scheduledAt"
              show-time
              format="YYYY-MM-DD HH:mm"
              placeholder="选择发布时间"
              class="w-full"
            />
          </div>

          <div class="flex gap-2">
            <a-button type="primary" long :loading="creating" data-testid="create-plan" @click="submitPlan(false)"
              >创建计划</a-button
            >
            <a-button long :loading="creating" data-testid="create-and-execute" @click="submitPlan(true)"
              >创建并立即发布</a-button
            >
          </div>
        </template>
      </div>
    </div>

    <!-- ══ 发布计划 ══ -->
    <div v-else-if="tab === 'plan'" class="flex flex-col gap-3">
      <p v-if="store.error" class="mw-subtle" role="alert">{{ store.error }}</p>
      <div
        v-if="highlightCopyId"
        class="flex items-center gap-2 px-3 py-2 rounded-[8px] border border-[color:var(--mw-primary-soft)] bg-[color:var(--mw-primary-faint)] text-[13px]"
      >
        <span>正在查看该文案的发布计划</span>
        <span class="mw-subtle flex-1 min-w-0 truncate">{{ highlightCopyId }}</span>
        <a-link @click="clearCopyHighlight">查看全部</a-link>
      </div>
      <a-spin :loading="store.loading" class="w-full">
        <div
          v-for="p in store.plans"
          :key="p.id"
          class="mw-card p-4"
          :class="highlightCopyId && p.copyId === highlightCopyId ? 'ring-1 ring-[#7c5cd6]' : ''"
          data-testid="plan-card"
        >
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[15px] font-semibold flex-1 min-w-0 truncate">{{ p.title }}</span>
            <span
              class="mw-tag"
              :class="
                p.status === 'completed'
                  ? 'mw-tag-green'
                  : p.status === 'failed'
                    ? 'mw-tag-red'
                    : p.status === 'draft'
                      ? 'mw-tag-gray'
                      : 'mw-tag-blue'
              "
              >{{ PLAN_STATUS_LABELS[p.status] }}</span
            >
            <span v-if="p.reviewState === 'needs_review'" class="mw-tag mw-tag-orange" data-testid="needs-review"
              >需审核确认</span
            >
            <span v-if="p.scheduledAt" class="mw-subtle">计划 {{ fmtTime(p.scheduledAt) }}</span>
          </div>
          <a-alert v-if="p.reviewState === 'needs_review'" type="warning" class="mt-2">
            标题或封面有实质修改，需审核确认后才能执行。
          </a-alert>
          <div class="mt-2 flex items-center gap-1.5 flex-wrap">
            <span v-for="l in p.logs" :key="l.id" class="mw-tag" :class="logTone(l.status)">
              {{ PLATFORM_LABELS[l.platform] }} · {{ LOG_STATUS_LABELS[l.status]
              }}<template v-if="l.attempt > 1"> · 第{{ l.attempt }}次</template>
            </span>
          </div>
          <div class="mt-3 flex items-center gap-2 flex-wrap">
            <a-button
              v-if="canReview && p.reviewState === 'needs_review'"
              size="mini"
              type="primary"
              data-testid="review-confirm"
              @click="onConfirmReview(p)"
              >审核确认可发布</a-button
            >
            <a-button
              v-if="canWrite && p.status === 'draft' && p.reviewState !== 'needs_review'"
              size="mini"
              type="primary"
              @click="onExecuteNow(p)"
              >立即发布</a-button
            >
            <a-button
              v-if="canWrite && p.status === 'draft' && p.reviewState !== 'needs_review'"
              size="mini"
              @click="onSchedule(p)"
              >定时</a-button
            >
            <a-button
              v-if="canWrite && ['draft', 'scheduled', 'executing'].includes(p.status)"
              size="mini"
              status="danger"
              @click="onCancel(p)"
              >取消</a-button
            >
            <span class="mw-subtle text-[12px] ml-auto"
              >创建人 {{ p.createdBy || '—' }} · {{ fmtTime(p.createdAt) }}</span
            >
          </div>
        </div>
        <div v-if="!store.plans.length && !store.loading" class="mw-card p-8 text-center mw-subtle">暂无发布计划</div>
      </a-spin>
    </div>

    <!-- ══ 发布记录 ══ -->
    <div v-else class="flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <a-select
          v-model="logPlatform"
          :style="{ width: '140px' }"
          allow-clear
          placeholder="全部平台"
          @change="loadLogs"
        >
          <a-option v-for="(label, key) in PLATFORM_LABELS" :key="key" :value="key" :label="label" />
        </a-select>
        <a-button :loading="store.loading" @click="loadLogs"
          ><template #icon><icon-refresh /></template>刷新</a-button
        >
      </div>
      <p v-if="store.error" class="mw-subtle" role="alert">{{ store.error }}</p>
      <a-spin :loading="store.loading" class="w-full">
        <div v-for="l in store.logs" :key="l.id" class="mw-card p-4" data-testid="log-card">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[14px] font-medium flex-1 min-w-0 truncate">{{
              l.title || l.planTitle || '（无标题）'
            }}</span>
            <span class="mw-tag" :class="logTone(l.status)" data-testid="log-status">{{
              LOG_STATUS_LABELS[l.status]
            }}</span>
            <span v-if="l.source === 'manual'" class="mw-tag mw-tag-gray">补录</span>
          </div>
          <div class="mw-subtle mt-1 text-[12px]">
            {{ PLATFORM_LABELS[l.platform] }} · {{ l.accountName || '—' }} · 创建 {{ fmtTime(l.createdAt) }}
            <template v-if="l.finishedAt"> · 完成 {{ fmtTime(l.finishedAt) }}</template>
            <template v-if="l.status === 'verification_required' && l.windowExpiresAt">
              · 验证窗口至 {{ fmtTime(l.windowExpiresAt) }}</template
            >
          </div>
          <div
            v-if="l.errorMessage"
            class="mt-1.5 text-[13px]"
            :class="l.status === 'published' ? 'mw-subtle' : 'text-[rgb(var(--orange-6))]'"
          >
            {{ l.errorMessage }}
          </div>
          <div v-if="l.videoUrl" class="mt-1 text-[13px] truncate">
            <a :href="l.videoUrl" target="_blank" rel="noopener" class="text-[rgb(var(--arcoblue-6))]">{{
              l.videoUrl
            }}</a>
          </div>
          <div v-if="canWrite" class="mt-3 flex items-center gap-2 flex-wrap">
            <template v-if="l.status === 'verification_required'">
              <a-button
                size="mini"
                type="primary"
                data-testid="recheck"
                @click="withReload(() => recheckLog(l.id), '已重新检测')"
                >重新检测</a-button
              >
              <a-button size="mini" @click="markPublished(l)">标记已发布</a-button>
              <a-button size="mini" status="danger" @click="markFailed(l)">标记失败</a-button>
            </template>
            <template v-else-if="l.status === 'manual_pending'">
              <a-button size="mini" type="primary" @click="markPublished(l)">标记已发布</a-button>
              <a-button size="mini" status="danger" @click="markFailed(l)">标记失败</a-button>
              <a-button size="mini" @click="withReload(() => retryLog(l.id), '已重新入队')">重发</a-button>
            </template>
            <template v-else-if="['failed', 'failed_final', 'cancelled'].includes(l.status)">
              <a-button
                size="mini"
                type="primary"
                data-testid="retry"
                @click="withReload(() => retryLog(l.id), '已重新入队')"
                >重发</a-button
              >
            </template>
          </div>
        </div>
        <div v-if="!store.logs.length && !store.loading" class="mw-card p-8 text-center mw-subtle">暂无发布记录</div>
      </a-spin>
    </div>

    <!-- 账号管理抽屉 / 弹窗 -->
    <AccountDrawer
      v-model:visible="showAccountDrawer"
      :accounts="store.accounts"
      :loading="store.loading"
      @add="showAddAccount = true"
      @login="(a) => ((loginAccount = a), (showLoginDialog = true))"
      @check="onCheckAccount"
      @toggle="onToggleAccount"
      @delete="onDeleteAccount"
    />
    <LoginQrDialog v-model:visible="showLoginDialog" :account="loginAccount" @confirmed="loadAccounts" />
    <ManualRecordDialog v-model:visible="showManualDialog" :accounts="store.accounts" @saved="loadLogs" />

    <a-modal
      v-model:visible="showAddAccount"
      title="添加平台账号"
      :width="420"
      unmount-on-close
      @before-ok="submitAddAccount"
    >
      <a-form :model="{}" layout="vertical">
        <a-form-item label="平台" required>
          <a-select v-model="addForm.platform">
            <a-option v-for="(label, key) in PLATFORM_LABELS" :key="key" :value="key" :label="label" />
          </a-select>
        </a-form-item>
        <a-form-item label="所属生产线" required>
          <a-select v-model="addForm.line">
            <a-option v-for="(label, key) in LINE_LABELS" :key="key" :value="key" :label="label" />
          </a-select>
        </a-form-item>
        <a-form-item label="账号显示名" required>
          <a-input v-model="addForm.displayName" placeholder="如「王理财-主账号」" :max-length="60" />
        </a-form-item>
        <div class="mw-subtle text-[12px]">
          平台与生产线不匹配时无法创建（经理 IP 线：快手 / 视频号 / 小红书；KOS 与素人线：抖音）。
        </div>
      </a-form>
    </a-modal>
  </div>
</template>
