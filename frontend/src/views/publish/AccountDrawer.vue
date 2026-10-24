<script setup lang="ts">
import { computed } from 'vue'
import { PLATFORM_LABELS, ACCOUNT_STATUS_LABELS, LINE_LABELS, type PlatformAccount, type Platform } from '@/api/publish'

const props = defineProps<{ accounts: PlatformAccount[]; loading?: boolean }>()
const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'add'): void
  (e: 'login', account: PlatformAccount): void
  (e: 'check', account: PlatformAccount): void
  (e: 'toggle', account: PlatformAccount, enabled: boolean): void
  (e: 'delete', account: PlatformAccount): void
}>()

const grouped = computed(() => {
  const groups: Array<{ platform: Platform; items: PlatformAccount[] }> = []
  for (const p of Object.keys(PLATFORM_LABELS) as Platform[]) {
    const items = props.accounts.filter((a) => a.platform === p)
    if (items.length) groups.push({ platform: p, items })
  }
  return groups
})

const statusTone = (s: PlatformAccount['loginStatus']): string =>
  s === 'active'
    ? 'mw-tag-green'
    : s === 'expired' || s === 'failed'
      ? 'mw-tag-red'
      : s === 'disabled'
        ? 'mw-tag-gray'
        : 'mw-tag-orange'

async function onToggle(a: PlatformAccount, enabled: boolean): Promise<void> {
  emit('toggle', a, enabled)
}
</script>

<template>
  <a-drawer :width="520" :header="true" unmount-on-close v-bind="$attrs">
    <template #title>
      <div class="flex items-center justify-between w-full">
        <span>平台账号管理</span>
        <a-button type="primary" size="small" data-testid="add-account" @click="emit('add')">添加账号</a-button>
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <div v-if="props.loading" class="text-center py-10 mw-subtle">加载中…</div>
      <template v-else-if="grouped.length">
        <section v-for="g in grouped" :key="g.platform">
          <div class="text-[13px] font-semibold mb-2 mw-subtle">{{ PLATFORM_LABELS[g.platform] }}</div>
          <div class="flex flex-col gap-2">
            <div v-for="a in g.items" :key="a.id" class="mw-card p-3.5">
              <div class="flex items-center gap-2">
                <span class="text-[14px] font-medium flex-1 truncate">{{ a.displayName }}</span>
                <span class="mw-tag" :class="statusTone(a.loginStatus)">{{
                  ACCOUNT_STATUS_LABELS[a.loginStatus]
                }}</span>
                <a-switch
                  :model-value="a.enabled"
                  size="small"
                  :aria-label="`启停 ${a.displayName}`"
                  @change="(v: string | number | boolean) => onToggle(a, !!v)"
                />
              </div>
              <div class="mw-subtle mt-1 text-[12px]">
                {{ LINE_LABELS[a.line] }}<template v-if="a.uid"> · uid {{ a.uid.slice(0, 18) }}</template> · 最近检测
                {{ a.lastCheckedAt ? new Date(a.lastCheckedAt).toLocaleString('zh-CN', { hour12: false }) : '—' }}
                <template v-if="a.publishedToday !== undefined"> · 今日已发 {{ a.publishedToday }}</template>
              </div>
              <div class="mt-2 flex items-center gap-2 flex-wrap">
                <a-button size="mini" :disabled="a.loginStatus === 'disabled'" @click="emit('login', a)">{{
                  a.loginStatus === 'active' ? '重新扫码' : '扫码登录'
                }}</a-button>
                <a-button size="mini" :disabled="a.loginStatus === 'disabled'" @click="emit('check', a)"
                  >检测登录</a-button
                >
                <a-popconfirm content="删除后不可恢复，确认删除该账号？" type="warning" @ok="emit('delete', a)">
                  <a-button size="mini" status="danger">删除</a-button>
                </a-popconfirm>
              </div>
            </div>
          </div>
        </section>
      </template>
      <div v-else class="mw-card p-8 text-center mw-subtle">
        还没有平台账号。点击右上角「添加账号」，选择平台与生产线后扫码登录。
      </div>
    </div>
  </a-drawer>
</template>
