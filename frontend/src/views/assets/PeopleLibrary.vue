<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="人物库" subtitle="管理人物形象、口播分身与声音绑定">
      <template #actions>
        <span v-if="creditText" class="mw-tag" :class="creditLow ? 'mw-tag-yellow' : 'mw-tag-gray'" :title="creditTitle">飞影积分 {{ creditText }}</span>
        <a-popover trigger="click" position="br" :content-style="{ width: '340px' }" @popup-visible-change="onRemindersOpen">
          <a-badge :count="store.unread" :offset="[-4, 4]">
            <a-button aria-label="授权提醒"><template #icon><icon-notification /></template></a-button>
          </a-badge>
          <template #content>
            <div class="font-semibold mb-2">授权提醒</div>
            <a-empty v-if="!store.reminders.length" description="暂无提醒" />
            <div v-for="r in store.reminders.slice(0, 8)" :key="r.id" class="text-[12.5px] py-1.5 border-b border-[#f2f4f7]" :class="{ 'font-medium': !r.readAt }">
              {{ r.message }}
              <div class="mw-subtle">{{ fmtDateTime(r.createdAt) }}</div>
            </div>
            <a-button v-if="store.unread" size="mini" class="mt-2" @click="markRead">全部标为已读</a-button>
          </template>
        </a-popover>
        <a-button type="primary" @click="createVisible = true"><template #icon><icon-plus /></template>新增人物</a-button>
      </template>
    </PageHead>

    <div class="flex items-center gap-4 mb-4 flex-wrap">
      <a-tabs :active-key="store.line" type="line" class="mw-tabs flex-1" @change="(k: string | number) => store.setLine(k as 'all' | PersonaLine)">
        <a-tab-pane key="all"><template #title>全部 <span class="mw-subtle">{{ store.lineCounts.all }}</span></template></a-tab-pane>
        <a-tab-pane key="manager"><template #title>经理 IP <span class="mw-subtle">{{ store.lineCounts.manager }}</span></template></a-tab-pane>
        <a-tab-pane key="kos"><template #title>员工 KOS <span class="mw-subtle">{{ store.lineCounts.kos }}</span></template></a-tab-pane>
        <a-tab-pane key="persona"><template #title>素人 <span class="mw-subtle">{{ store.lineCounts.persona }}</span></template></a-tab-pane>
      </a-tabs>
      <a-select :model-value="store.status" :style="{ width: '130px' }" aria-label="状态筛选" @change="(v: unknown) => store.setStatus(v as StatusFilter)">
        <a-option value="all">全部状态</a-option>
        <a-option value="usable">可用</a-option>
        <a-option value="incomplete">待完善</a-option>
        <a-option value="disabled">已停用</a-option>
        <a-option value="archived">已归档</a-option>
      </a-select>
      <a-input-search
        v-model="keyword"
        :style="{ width: '220px' }"
        placeholder="搜索人物名称..."
        allow-clear
        :input-attrs="{ 'aria-label': '搜索人物名称' }"
        @search="store.search(keyword)"
        @press-enter="store.search(keyword)"
        @clear="store.search('')"
      />
    </div>

    <div class="grid grid-cols-[1fr_minmax(380px,460px)] gap-5 items-start people-layout">
      <PersonaCardGrid :items="store.items" :current-id="store.currentId" :loading="store.loading" :error="store.error" @select="store.select" @create="createVisible = true" @retry="store.loadList()" />

      <div>
        <a-spin :loading="store.detailLoading && !store.detail" class="w-full">
          <PersonaDetailPanel
            v-if="store.detail"
            :persona="store.detail"
            :options="store.options"
            @changed="store.afterMutation()"
            @reload="store.refreshDetail(false)"
            @archived="onArchived"
          />
          <div v-else-if="store.detailError" class="mw-card p-6 text-center" role="alert">
            {{ store.detailError }}
            <div class="mt-2"><a-button size="small" @click="store.refreshDetail(false)">重试</a-button></div>
          </div>
          <div v-else-if="!store.loading" class="mw-card p-10 text-center"><a-empty description="选择左侧人物查看详情" /></div>
        </a-spin>
      </div>
    </div>

    <div class="mw-subtle text-center mt-8">素人矩阵不使用数字人口播。声音共享须单独核验授权。</div>

    <PersonaFormDialog v-model:visible="createVisible" :persona="null" :options="store.options" @saved="onCreated" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import PageHead from '@/components/PageHead.vue'
import { readAllReminders, type PersonaLine } from '@/api/personas'
import { usePeopleLibraryStore, type StatusFilter } from '@/stores/peopleLibrary'
import PersonaCardGrid from './people/PersonaCardGrid.vue'
import PersonaDetailPanel from './people/PersonaDetailPanel.vue'
import PersonaFormDialog from './people/PersonaFormDialog.vue'
import { fmtDateTime } from './people/shared'

const store = usePeopleLibraryStore()
const keyword = ref('')
const createVisible = ref(false)

const LOW_CREDIT = 1000
const credit = computed(() => store.options?.hifly?.credit ?? null)
const creditText = computed(() => {
  const h = store.options?.hifly
  if (!h) return ''
  if (h.mock) return '（模拟）'
  return credit.value === null ? '未知' : String(credit.value)
})
const creditLow = computed(() => credit.value !== null && credit.value < LOW_CREDIT)
const creditTitle = computed(() => store.options?.hifly?.creditError ?? (creditLow.value ? '积分偏低，请及时充值' : '飞影剩余积分'))

onMounted(() => { void store.init() })
onBeforeUnmount(() => store.dispose())

async function onCreated(id: string): Promise<void> {
  await store.loadStats()
  await store.loadList()
  await store.select(id)
}
async function onArchived(): Promise<void> {
  await store.loadStats()
  await store.loadList()
}
function onRemindersOpen(open: boolean): void {
  if (open) void store.loadReminders()
}
async function markRead(): Promise<void> {
  await readAllReminders()
  await store.loadReminders()
}
</script>

<style scoped>
@media (max-width: 1100px) {
  .people-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
