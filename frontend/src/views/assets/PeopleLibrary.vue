<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="人物库" subtitle="管理人物形象、口播分身与声音绑定">
      <template #actions>
        <span v-if="hifly" class="mw-tag" :class="creditLow ? 'mw-tag-yellow' : 'mw-tag-gray'" :title="hifly.creditError ?? ''">
          飞影积分 {{ hifly.credit ?? '—' }}<template v-if="hifly.mock">（mock）</template><template v-else-if="!hifly.configured">（未配置）</template>
        </span>
        <a-popover trigger="click" position="br" @popup-visible-change="(v) => v && store.loadReminders()">
          <a-badge :count="store.unreadReminders" :max-count="99">
            <a-button aria-label="人物库提醒"><icon-notification /></a-button>
          </a-badge>
          <template #content>
            <div class="w-[320px]">
              <div class="flex items-center mb-2">
                <span class="text-[13px] font-medium">提醒</span>
                <div class="flex-1"></div>
                <a-button v-if="store.unreadReminders" size="mini" type="text" @click="store.markRemindersRead()">全部已读</a-button>
              </div>
              <div v-if="!store.reminders.length" class="mw-subtle py-3 text-center">暂无提醒</div>
              <div class="max-h-[360px] overflow-auto">
                <div v-for="r in store.reminders.slice(0, 50)" :key="r.id" class="py-1.5 border-b border-[var(--mw-border)] text-[12.5px]" :class="r.readAt ? 'text-[var(--mw-text3)]' : ''">
                  {{ r.message }}
                  <div class="mw-subtle">{{ dateOnly(r.createdAt) }}</div>
                </div>
              </div>
            </div>
          </template>
        </a-popover>
        <a-button type="primary" @click="openCreate"><template #icon><icon-plus /></template>新增人物</a-button>
      </template>
    </PageHead>

    <div class="flex items-center gap-3 mb-4">
      <a-tabs v-model:active-key="store.lineTab" type="line" class="mw-tabs flex-1" @change="store.loadList()">
        <a-tab-pane key="all"><template #title>全部 <span class="mw-subtle">{{ store.totalCount }}</span></template></a-tab-pane>
        <a-tab-pane key="manager"><template #title>经理 IP <span class="mw-subtle">{{ store.lineCounts.manager }}</span></template></a-tab-pane>
        <a-tab-pane key="kos"><template #title>员工 KOS <span class="mw-subtle">{{ store.lineCounts.kos }}</span></template></a-tab-pane>
        <a-tab-pane key="persona"><template #title>素人 <span class="mw-subtle">{{ store.lineCounts.persona }}</span></template></a-tab-pane>
      </a-tabs>
      <a-select v-model="store.statusFilter" :style="{ width: '120px' }" aria-label="按状态筛选" @change="store.loadList()">
        <a-option value="all">全部状态</a-option>
        <a-option value="usable">可用</a-option>
        <a-option value="incomplete">待完善</a-option>
        <a-option value="disabled">已停用</a-option>
        <a-option value="archived">已归档</a-option>
      </a-select>
      <a-input-search
        v-model="store.keyword"
        :style="{ width: '220px' }"
        placeholder="搜索人物名称..."
        allow-clear
        @search="store.loadList()"
        @press-enter="store.loadList()"
        @clear="store.loadList()"
      />
    </div>

    <a-alert v-if="store.error" type="error" class="mb-4" closable @close="store.error = null">{{ store.error }}</a-alert>

    <div class="grid grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
      <a-spin :loading="store.loading" class="block">
        <div v-if="store.items.length" class="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <PersonaCard
            v-for="p in store.items"
            :key="p.id"
            :persona="p"
            :active="store.selectedId === p.id"
            @select="store.select(p.id)"
            @play="playAsset"
          />
        </div>
        <div v-else-if="!store.loading" class="mw-card py-14 text-center">
          <div class="text-[14px]">{{ emptyText }}</div>
          <a-button v-if="isUnfiltered" type="primary" class="mt-3" @click="openCreate">新增人物</a-button>
        </div>
      </a-spin>

      <a-spin :loading="store.detailLoading" class="block">
        <PersonaDetailPanel
          v-if="store.detail"
          :persona="store.detail"
          :options="store.options"
          @changed="store.afterMutation()"
          @edit="openEdit"
          @view-asset="viewAsset"
        />
        <div v-else class="mw-card p-5 mw-subtle text-center">选择左侧人物查看详情</div>
      </a-spin>
    </div>

    <div class="mt-4 mw-subtle flex items-center gap-1"><icon-info-circle :size="13" />素人矩阵不使用数字人口播。声音共享须单独核验授权。</div>

    <PersonaFormDialog v-model:visible="formVisible" :editing="editing" :options="store.options" @saved="onSaved" />

    <a-modal v-model:visible="media.visible" :title="media.title" :footer="false" width="720px" unmount-on-close>
      <video v-if="media.kind === 'video'" :src="media.url" controls autoplay class="w-full max-h-[70vh] bg-black rounded-[8px]" />
      <img v-else :src="media.url" alt="" class="w-full max-h-[70vh] object-contain" />
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import PageHead from '@/components/PageHead.vue'
import { assetFileUrl, type PersonaAsset, type PersonaDetail, type PersonaListItem } from '@/api/personas'
import { usePeopleLibraryStore } from '@/stores/peopleLibrary'
import PersonaCard from './people/PersonaCard.vue'
import PersonaDetailPanel from './people/PersonaDetailPanel.vue'
import PersonaFormDialog from './people/PersonaFormDialog.vue'
import { dateOnly } from './people/labels'

/** 飞影积分低于该值标黄提醒（一次分身制作约消耗数百积分，以 PoC 实测为准） */
const CREDIT_WARN_THRESHOLD = 1000

const store = usePeopleLibraryStore()

const hifly = computed(() => store.options?.hifly ?? null)
const creditLow = computed(() => {
  const c = hifly.value?.credit
  return typeof c === 'number' && c < CREDIT_WARN_THRESHOLD
})

const isUnfiltered = computed(() => store.lineTab === 'all' && store.statusFilter === 'all' && !store.keyword.trim())
const emptyText = computed(() => (isUnfiltered.value ? '还没有人物，先新增一个' : '没有符合条件的人物'))

const formVisible = ref(false)
const editing = ref<PersonaDetail | null>(null)

function openCreate() {
  editing.value = null
  formVisible.value = true
}

function openEdit() {
  editing.value = store.detail
  formVisible.value = true
}

async function onSaved(p: PersonaListItem) {
  if (editing.value) {
    await store.afterMutation()
    return
  }
  // 新建后切到「全部」并选中新人物，方便直接补 IP 定位与素材
  store.lineTab = 'all'
  store.statusFilter = 'all'
  store.keyword = ''
  await Promise.all([store.loadList(), store.loadStats()])
  await store.select(p.id)
}

const media = reactive({ visible: false, title: '', url: '', kind: 'video' as 'video' | 'image' })

function playAsset(assetId: string) {
  Object.assign(media, { visible: true, title: '默认分身素材', url: assetFileUrl(assetId, 'compat'), kind: 'video' })
}

function viewAsset(a: PersonaAsset) {
  const isVideo = a.mime.startsWith('video/')
  Object.assign(media, {
    visible: true,
    title: a.name,
    // 视频优先播兼容版本（H.264 mp4），图片看原图
    url: assetFileUrl(a.id, isVideo ? (a.compatKey ? 'compat' : 'original') : 'original'),
    kind: isVideo ? 'video' : 'image',
  })
}

onMounted(() => {
  void store.init()
})

onBeforeUnmount(() => {
  store.dispose()
})
</script>
