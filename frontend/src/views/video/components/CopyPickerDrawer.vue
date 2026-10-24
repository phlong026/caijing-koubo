<template>
  <a-drawer
    :visible="visible"
    title="选择文案"
    :width="560"
    unmount-on-close
    @cancel="emit('close')"
    @close="emit('close')"
  >
    <div class="flex items-center gap-2 mb-3">
      <a-input-search
        v-model="keyword"
        placeholder="搜索文案标题"
        :style="{ width: '220px' }"
        allow-clear
        @search="reload"
        @clear="reload"
      />
      <a-select v-model="line" placeholder="全部线" allow-clear :style="{ width: '140px' }" @change="reload">
        <a-option value="manager">经理</a-option>
        <a-option value="kos">员工 KOS</a-option>
        <a-option value="persona">素人矩阵</a-option>
      </a-select>
    </div>
    <a-spin :loading="loading" class="block">
      <div class="flex flex-col gap-2 min-h-[200px]">
        <div
          v-for="c in items"
          :key="c.id"
          class="p-3 rounded-[10px] border border-[var(--mw-border)] hover:border-[color:var(--mw-primary-soft)] cursor-pointer flex items-center gap-3"
          @click="emit('pick', c.id)"
        >
          <div class="w-9 h-9 rounded-[8px] bg-[var(--mw-primary-bg)] flex items-center justify-center">
            <icon-file :size="18" class="text-[color:var(--mw-primary)]" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-[14px] font-medium truncate">{{ c.title || '（无标题）' }}</div>
            <div class="mw-subtle mt-0.5">{{ lineLabel(c.line) }} · 更新于 {{ formatDate(c.updated_at) }}</div>
          </div>
          <icon-right :size="14" class="text-[var(--mw-text3)]" />
        </div>
        <div v-if="!loading && !items.length" class="text-center mw-subtle py-8">
          没有可用的文案（只有审核通过的文案才能用于视频创作）
        </div>
      </div>
    </a-spin>
    <div class="mt-3 flex items-center justify-end gap-2">
      <a-button size="small" :disabled="page <= 1" @click="goPage(page - 1)">上一页</a-button>
      <span class="mw-subtle text-[12px]">第 {{ page }} 页 · 共 {{ total }} 条</span>
      <a-button size="small" :disabled="page * 20 >= total" @click="goPage(page + 1)">下一页</a-button>
    </div>
  </a-drawer>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { getVideoCopies } from '@/api/video'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ close: []; pick: [copyId: string] }>()

const items = ref<Array<{ id: string; title: string | null; line: string | null; updated_at: string | null }>>([])
const total = ref(0)
const page = ref(1)
const keyword = ref('')
const line = ref<string | undefined>(undefined)
const loading = ref(false)

watch(
  () => props.visible,
  (v) => {
    if (v) reload()
  },
)

function lineLabel(line?: string | null): string {
  return line === 'manager' ? '经理' : line === 'kos' ? '员工 KOS' : line === 'persona' ? '素人矩阵' : '—'
}
function formatDate(s?: string | null): string {
  return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }).slice(0, 16) : '—'
}

async function reload(): Promise<void> {
  loading.value = true
  try {
    const r = await getVideoCopies({
      keyword: keyword.value || undefined,
      line: line.value || undefined,
      page: page.value,
      pageSize: 20,
    })
    items.value = r.items
    total.value = r.total
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

function goPage(p: number): void {
  page.value = p
  void reload()
}

onMounted(reload)
</script>
