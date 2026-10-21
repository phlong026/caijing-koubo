<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="人物库">
      <template #sub>管理人物 IP 定位、授权材料、形象素材、口播分身与声音；授权核验与素材审核由审核员完成。</template>
      <template #actions>
        <a-popover trigger="click" position="br" @popup-visible-change="(v) => v && loadReminders()">
          <a-badge :count="unread" :max-count="99">
            <a-button><template #icon><icon-notification /></template>提醒</a-button>
          </a-badge>
          <template #content>
            <div class="reminder-pop">
              <div class="flex items-center justify-between mb-2">
                <strong>人物库提醒</strong>
                <a-button size="mini" type="text" :disabled="!unread" @click="readAll">全部已读</a-button>
              </div>
              <p v-if="!reminders.length" class="mw-subtle">暂无提醒</p>
              <ul v-else>
                <li v-for="r in reminders" :key="r.id" :class="{ unread: !r.readAt }" @click="openPersona(r.personaId)">
                  <span class="mw-tag" :class="r.kind.startsWith('clone') ? 'mw-tag-red' : 'mw-tag-yellow'">{{ REMINDER_LABELS[r.kind] }}</span>
                  <span class="reminder-msg">{{ r.message }}</span>
                  <span class="mw-subtle">{{ fmtTime(r.createdAt) }}</span>
                </li>
              </ul>
            </div>
          </template>
        </a-popover>
        <a-button type="primary" @click="createVisible = true"><template #icon><icon-plus /></template>新增人物</a-button>
      </template>
    </PageHead>

    <div class="flex items-center gap-4 mb-4 flex-wrap">
      <a-tabs v-model:active-key="lineTab" type="line" class="mw-tabs flex-1">
        <a-tab-pane key="all"><template #title>全部 <span class="mw-subtle">{{ stats.total }}</span></template></a-tab-pane>
        <a-tab-pane v-for="(label, key) in LINES" :key="key"><template #title>{{ label }} <span class="mw-subtle">{{ stats.lines[key] ?? 0 }}</span></template></a-tab-pane>
      </a-tabs>
      <a-select v-model="statusFilter" :style="{ width: '150px' }" aria-label="状态筛选">
        <a-option value="all" label="全部状态（含停用）" />
        <a-option value="usable" label="仅可用" />
        <a-option value="incomplete" label="可用但待完善" />
        <a-option value="disabled" label="已停用" />
        <a-option value="archived" label="已归档" />
      </a-select>
      <a-input-search v-model="keyword" :style="{ width: '220px' }" placeholder="搜索人物名称..." allow-clear @search="load" @press-enter="load" @clear="load" />
    </div>

    <div class="people-layout">
      <section aria-label="人物列表">
        <a-spin :loading="loading" class="w-full">
          <p v-if="error" class="mw-subtle" role="alert">{{ error }}</p>
          <div v-else-if="!items.length && !loading" class="mw-card p-8 text-center mw-subtle">没有符合条件的人物，可点击右上角「新增人物」。</div>
          <div class="people-grid">
            <button
              v-for="p in items"
              :key="p.id"
              type="button"
              class="mw-card people-card"
              :class="{ active: currentId === p.id }"
              :aria-pressed="currentId === p.id"
              @click="openPersona(p.id)"
            >
              <div class="people-cover">
                <img v-if="p.coverUrl" :src="p.coverUrl" :alt="`${p.name} 封面`" loading="lazy" />
                <span v-else class="people-cover-empty">{{ p.name.slice(0, 1) }}</span>
              </div>
              <div class="mt-3 flex items-center gap-2">
                <span class="text-[15px] font-semibold truncate">{{ p.name }}</span>
                <LineTag :line="p.line" />
              </div>
              <div class="mw-subtle mt-1 truncate">{{ p.description || p.ipProfile?.role || '未填写简介' }}</div>
              <div class="mt-2 flex items-center gap-1.5 flex-wrap">
                <span class="mw-tag" :class="toneClass(PERSONA_STATUS[p.status].tone)">{{ PERSONA_STATUS[p.status].label }}</span>
                <span v-for="t in p.extraTags" :key="t" class="mw-tag" :class="toneClass(EXTRA_TAGS[t].tone)">{{ EXTRA_TAGS[t].label }}</span>
              </div>
              <div class="people-counts">
                <span>照片 {{ p.counts.photos }}</span>
                <span>分身 {{ p.counts.avatars }}</span>
                <span>声音 {{ p.counts.voices }}</span>
                <span>账号 {{ p.counts.bindings }}</span>
              </div>
            </button>
          </div>
        </a-spin>
      </section>

      <section class="mw-card p-5 people-detail" aria-label="人物详情">
        <PersonaDetail v-if="currentId && options" :key="currentId" :persona-id="currentId" :options="options" @changed="onChanged" />
        <div v-else class="mw-subtle text-center py-16">从左侧选择一个人物查看详情</div>
      </section>
    </div>

    <CreatePersonaModal v-if="options" v-model:visible="createVisible" :options="options" @created="onCreated" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import LineTag from '@/components/LineTag.vue'
import PersonaDetail from './people/PersonaDetail.vue'
import CreatePersonaModal from './people/CreatePersonaModal.vue'
import {
  getPersonaOptions,
  getPersonas,
  getPersonaStats,
  getReminders,
  markRemindersRead,
  type PersonaLine,
  type PersonaListItem,
  type PersonaOptions,
  type PersonaReminder,
} from '@/api/personas'
import { EXTRA_TAGS, PERSONA_STATUS, REMINDER_LABELS, fmtTime, toneClass } from './people/labels'

const LINES: Record<PersonaLine, string> = { manager: '经理 IP', kos: '员工 KOS', persona: '素人矩阵' }

const route = useRoute()
const router = useRouter()
const options = ref<PersonaOptions | null>(null)
const items = ref<PersonaListItem[]>([])
const loading = ref(false)
const error = ref('')
const lineTab = ref<'all' | PersonaLine>('all')
const statusFilter = ref<'all' | 'usable' | 'incomplete' | 'disabled' | 'archived'>('all')
const keyword = ref('')
const currentId = ref<string | null>(typeof route.query.id === 'string' ? route.query.id : null)
const createVisible = ref(false)
const stats = ref<{ lines: Partial<Record<PersonaLine, number>>; total: number }>({ lines: {}, total: 0 })
const unread = ref(0)
const reminders = ref<PersonaReminder[]>([])

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const status = statusFilter.value === 'all' ? undefined : statusFilter.value
    const r = await getPersonas({
      line: lineTab.value === 'all' ? undefined : lineTab.value,
      keyword: keyword.value.trim() || undefined,
      includeDisabled: true,
      includeArchived: statusFilter.value === 'archived',
      status,
    })
    items.value = r.items
    if (!currentId.value && r.items.length) currentId.value = r.items[0]!.id
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function loadStats(): Promise<void> {
  try {
    const s = await getPersonaStats()
    stats.value = { lines: s.lines, total: s.total }
    unread.value = s.unreadReminders
  } catch {
    /* 统计失败不影响列表 */
  }
}

async function loadReminders(): Promise<void> {
  try {
    const r = await getReminders()
    reminders.value = r.items.slice(0, 30)
    unread.value = r.unread
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function readAll(): Promise<void> {
  try {
    await markRemindersRead()
    await loadReminders()
  } catch (e) {
    Message.error((e as Error).message)
  }
}

function openPersona(id: string): void {
  currentId.value = id
  void router.replace({ query: { ...route.query, id } })
}

function onChanged(): void {
  void load()
  void loadStats()
}

function onCreated(p: PersonaListItem): void {
  statusFilter.value = 'all'
  openPersona(p.id)
  onChanged()
}

watch([lineTab, statusFilter], () => void load())

onMounted(async () => {
  try {
    options.value = await getPersonaOptions()
  } catch (e) {
    error.value = (e as Error).message
  }
  await Promise.all([load(), loadStats()])
})
</script>

<style scoped>
.people-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(420px, 520px);
  gap: 20px;
  align-items: start;
}
.people-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}
.people-card {
  text-align: left;
  padding: 16px;
  cursor: pointer;
  background: #fff;
  font: inherit;
  color: inherit;
}
.people-card.active {
  border-color: var(--mw-primary);
  box-shadow: 0 0 0 1px var(--mw-primary);
}
.people-cover {
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  overflow: hidden;
  background: #eef1ee;
  display: flex;
  align-items: center;
  justify-content: center;
}
.people-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.people-cover-empty {
  font-size: 28px;
  color: var(--mw-text3);
}
.people-counts {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--mw-border-light);
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--mw-text2);
}
.people-detail {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow: auto;
}
.reminder-pop {
  width: 360px;
  max-height: 420px;
  overflow: auto;
}
.reminder-pop ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.reminder-pop li {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 4px;
  border-top: 1px solid var(--mw-border-light);
  cursor: pointer;
  font-size: 13px;
}
.reminder-pop li.unread .reminder-msg {
  font-weight: 600;
}
@media (max-width: 1100px) {
  .people-layout {
    grid-template-columns: 1fr;
  }
  .people-detail {
    position: static;
    max-height: none;
  }
}
</style>
