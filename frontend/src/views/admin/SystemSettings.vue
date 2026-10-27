<template>
  <div class="flex flex-col gap-4">
    <a-alert v-if="dirtyKeys.length" type="warning" class="sticky-top">
      有 {{ dirtyKeys.length }} 项未保存的修改。
      <a-button size="mini" status="danger" @click="discard">放弃</a-button>
    </a-alert>

    <a-spin :loading="loading" style="width: 100%">
      <a-collapse v-if="groups.length" v-model:active-key="activeGroups">
        <a-collapse-item v-for="g in groups" :key="g.key" :header="g.title">
          <template #extra>
            <span v-if="g.danger" class="mw-tag mw-tag-red mr-1">危险</span>
            <span class="mw-subtle text-xs">{{ groupItems(g.key).length }} 项</span>
          </template>
          <p v-if="g.desc" class="mw-subtle mb-3">{{ g.desc }}</p>
          <div class="grid gap-x-8 gap-y-4 md:grid-cols-2">
            <div v-for="item in groupItems(g.key)" :key="item.key" class="flex flex-col gap-1">
              <label class="flex items-center gap-1">
                <span>{{ item.label }}</span>
                <a-tooltip v-if="item.restart" content="修改后需重启服务完全生效"
                  ><icon-sync class="text-gray-400"
                /></a-tooltip>
                <a-tooltip v-if="item.readonly" content="部署级配置：请在 .env 修改后重启服务"
                  ><icon-lock class="text-gray-400"
                /></a-tooltip>
                <span v-if="item.isSet" class="mw-tag mw-tag-blue">界面配置</span>
                <span v-else-if="item.hasValue" class="mw-tag mw-tag-green">.env</span>
                <span v-else class="mw-tag mw-tag-gray">未配置</span>
              </label>

              <a-switch
                v-if="item.type === 'boolean' && !item.readonly"
                :model-value="draft[item.key] === 'true'"
                :disabled="!!item.readonly"
                @change="(v: any) => setDraft(item, v ? 'true' : 'false')"
              />
              <a-input-number
                v-else-if="item.type === 'number'"
                :model-value="item.readonly ? Number(item.value) : draftNum(item)"
                :disabled="!!item.readonly"
                class="w-full"
                @change="(v: any) => setDraft(item, String(v ?? ''))"
              />
              <a-input-password
                v-else-if="item.type === 'password'"
                v-model="draft[item.key]"
                :disabled="!!item.readonly"
                :placeholder="item.hasValue ? '已配置（留 •• 不变即不修改）' : '未配置'"
                autocomplete="new-password"
              />
              <a-input v-else v-model="draft[item.key]" :disabled="!!item.readonly" />
              <span v-if="item.desc" class="mw-subtle text-xs">{{ item.desc }}</span>
            </div>
          </div>
        </a-collapse-item>
      </a-collapse>
    </a-spin>

    <div class="flex items-center gap-3">
      <a-button type="primary" :loading="saving" :disabled="!dirtyKeys.length" @click="save">
        保存{{ dirtyKeys.length ? `（${dirtyKeys.length} 项）` : '' }}
      </a-button>
      <span class="mw-subtle">密钥类输入框保留 •••• 即不修改；保存后立即生效（标注 ⟳ 的项需重启完全生效）。</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { getSettings, saveSettings, type SettingItem } from '@/api/settings'

const loading = ref(false)
const saving = ref(false)
const groups = ref<Awaited<ReturnType<typeof getSettings>>['groups']>([])
const items = ref<SettingItem[]>([])
const draft = reactive<Record<string, string>>({})
/** password 原始回显：提交时未变（仍含 ••）则跳过 */
const maskedEcho = new Map<string, string>()

const activeGroups = ref<string[]>([])

function groupItems(key: string): SettingItem[] {
  return items.value.filter((i) => i.group === key)
}

function draftNum(item: SettingItem): number | undefined {
  const v = draft[item.key]
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function setDraft(item: SettingItem, value: string): void {
  draft[item.key] = value
}

const dirtyKeys = computed(() =>
  items.value
    .filter((i) => !i.readonly && draft[i.key] !== undefined && draft[i.key] !== original(i))
    .map((i) => i.key),
)

/** 初始对照值：boolean/number 经同一字符串化口径比较 */
function original(item: SettingItem): string {
  return item.value
}

function discard(): void {
  for (const i of items.value) draft[i.key] = initialDraft(i)
}

function initialDraft(item: SettingItem): string {
  if (item.type === 'password') {
    maskedEcho.set(item.key, item.value)
    return item.value
  }
  return item.value
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const doc = await getSettings()
    groups.value = doc.groups
    items.value = doc.items
    for (const i of doc.items) draft[i.key] = initialDraft(i)
    // 默认展开前两组（模型配置最常用），危险组默认折叠
    activeGroups.value = doc.groups.slice(0, 2).map((g) => g.key)
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  const changed = items.value.filter((i) => dirtyKeys.value.includes(i.key))
  if (!changed.length) return
  saving.value = true
  try {
    const res = await saveSettings(changed.map((i) => ({ key: i.key, value: draft[i.key] })))
    Message.success(
      `已保存 ${res.applied.length} 项${res.skipped.length ? `，跳过 ${res.skipped.length} 项（未变化）` : ''}`,
    )
    await load()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>
