<template>
  <a-drawer :visible="visible" :width="520" title="文案任务" unmount-on-close @cancel="emit('update:visible', false)">
    <template #footer>
      <a-button type="primary" long @click="onCreate">
        <template #icon><icon-plus /></template>
        新建文案
      </a-button>
    </template>

    <!-- 筛选 -->
    <div class="flex items-center gap-2 mb-3">
      <a-input v-model="keyword" placeholder="搜索标题" allow-clear size="small" class="flex-1" @press-enter="reload">
        <template #prefix><icon-search /></template>
      </a-input>
      <a-select v-model="derivedStatus" size="small" placeholder="状态" allow-clear class="!w-[110px]" @change="reload">
        <a-option v-for="(label, key) in statusOptions" :key="key" :value="key">{{ label }}</a-option>
      </a-select>
      <a-select v-model="line" size="small" placeholder="线" allow-clear class="!w-[90px]" @change="reload">
        <a-option value="manager">经理 IP</a-option>
        <a-option value="kos">员工 KOS</a-option>
        <a-option value="persona">素人矩阵</a-option>
      </a-select>
    </div>

    <a-spin :loading="loading" class="w-full">
      <a-empty v-if="!loading && !items.length" description="还没有文案" />

      <div class="space-y-2">
        <div
          v-for="it in items"
          :key="it.id"
          class="list-row"
          role="button"
          tabindex="0"
          @keydown.enter="onPick(it.id)"
          @keydown.space.prevent="onPick(it.id)"
          :class="{ active: it.id === store.copy?.id }"
          @click="onPick(it.id)"
        >
          <div class="flex items-start gap-2">
            <div class="flex-1 min-w-0">
              <div class="text-[13.5px] font-medium text-[#131f38] truncate">
                {{ it.title || '（未命名文案）' }}
              </div>
              <div class="flex items-center gap-2 mt-1 flex-wrap">
                <span class="mw-tag" :class="statusClass(it.derivedStatus)">{{ it.derivedStatusLabel }}</span>
                <span class="mw-subtle">{{ it.sourceLabel }}</span>
                <span v-if="it.persona" class="mw-subtle">· {{ it.persona.name }}</span>
                <span class="mw-subtle">· {{ it.draftCount }} 稿</span>
              </div>
            </div>
            <span class="mw-subtle shrink-0 tabular-nums">{{ fmtTime(it.updatedAt || it.createdAt) }}</span>
          </div>
        </div>
      </div>

      <div v-if="total > items.length" class="mt-3 text-center">
        <a-link @click="loadMore">加载更多（{{ items.length }}/{{ total }}）</a-link>
      </div>
    </a-spin>
  </a-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type CopyDerivedStatus, type CopyLine, type CopyListItem } from '@/api/copy'

const props = defineProps<{
  visible: boolean
  /** P1-20 / FR-S1：从爆款选题一次送入多条时，按 ids 过滤列表 */
  initialIds?: string[]
}>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'picked', copyId: string): void
  /** 新建统一走完整的来源入口（爆款选题 / 文章 / 视频改写 / 手动输入） */
  (e: 'create'): void
}>()

const store = useCopyStore()

const loading = ref(false)
const items = ref<CopyListItem[]>([])
const total = ref(0)
const page = ref(1)
const keyword = ref('')
const derivedStatus = ref<CopyDerivedStatus | undefined>()
const line = ref<CopyLine | undefined>()

const statusOptions: Record<string, string> = {
  pending_write: '待写作',
  writing: '写作中',
  in_review: '审核中',
  rejected: '已驳回',
  approved: '已通过',
  revising: '修订中',
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      page.value = 1
      void reload()
    }
  },
)

/** P1-20：只在这批 ids 里筛选 */
const idFilter = computed(() => (props.initialIds?.length ? props.initialIds.join(',') : undefined))

watch(
  () => props.initialIds?.join(','),
  () => {
    if (props.visible) {
      page.value = 1
      void load()
    }
  },
)

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = await copyApi.list({
      page: page.value,
      pageSize: 20,
      keyword: keyword.value || undefined,
      derivedStatus: derivedStatus.value,
      line: line.value,
      ids: idFilter.value,
    })
    items.value = page.value === 1 ? r.items : [...items.value, ...r.items]
    total.value = r.total
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

function reload(): void {
  page.value = 1
  void load()
}

function loadMore(): void {
  page.value += 1
  void load()
}

function statusClass(s: string): string {
  switch (s) {
    case 'approved':
      return 'mw-tag-green'
    case 'rejected':
      return 'mw-tag-red'
    case 'in_review':
      return 'mw-tag-yellow'
    case 'revising':
      return 'mw-tag-purple'
    case 'writing':
      return 'mw-tag-blue'
    default:
      return 'mw-tag-gray'
  }
}

function onPick(id: string): void {
  emit('picked', id)
  emit('update:visible', false)
}

function onCreate(): void {
  emit('create')
  emit('update:visible', false)
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<style scoped>
.list-row {
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid #eef2f8;
  background: #fff;
  cursor: pointer;
  transition: all 0.16s ease;
}
.list-row:hover {
  border-color: #dbe6f7;
  box-shadow: 0 2px 8px rgba(23, 32, 52, 0.05);
}
.list-row.active {
  border-color: #2f6bff;
  background: #f7faff;
}
</style>
