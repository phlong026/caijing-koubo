<template>
  <a-modal :visible="visible" title="账号绑定" :ok-loading="saving" :mask-closable="false" @before-ok="save" @cancel="$emit('update:visible', false)">
    <div class="mw-subtle mb-3">{{ ruleText }}</div>
    <div v-for="(row, i) in rows" :key="i" class="flex items-center gap-2 mb-2">
      <a-select v-model="row.platform" style="width: 96px">
        <a-option v-for="(label, key) in platformLabels" :key="key" :value="key">{{ label }}</a-option>
      </a-select>
      <a-input v-model="row.accountKey" placeholder="账号标识" :max-length="80" class="flex-1" />
      <a-input v-model="row.displayName" placeholder="显示名" :max-length="40" style="width: 120px" />
      <a-button type="text" aria-label="移除账号" @click="rows.splice(i, 1)"><icon-close /></a-button>
    </div>
    <a-button v-if="rows.length < limit" size="small" @click="addRow"><template #icon><icon-plus /></template>添加账号</a-button>
  </a-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { setPersonaAccounts, type AccountBinding, type PersonaDetail, type PersonaOptions, type Platform } from '@/api/personas'

const props = defineProps<{ visible: boolean; persona: PersonaDetail; options: PersonaOptions | null }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'changed'): void }>()

interface Row {
  platform: Platform
  accountKey: string
  displayName: string
}

const DEFAULT_PLATFORMS: Record<Platform, string> = { douyin: '抖音', xiaohongshu: '小红书', kuaishou: '快手', shipinhao: '视频号' }
const platformLabels = computed(() => props.options?.platformLabels ?? DEFAULT_PLATFORMS)

/** 账号上限（FR-U5）：经理 1；KOS 共享 5 / 一对一 1；素人 1 */
const limit = computed(() => (props.persona.line === 'kos' && props.persona.bindingMode === 'shared' ? 5 : 1))
const ruleText = computed(() =>
  limit.value > 1
    ? `共享人物最多绑定 ${limit.value} 个账号。`
    : props.persona.line === 'manager'
      ? '经理人物只能绑定 1 个账号，且该账号不能再绑定其他经理人物。'
      : '一对一人物只能绑定 1 个账号。',
)

const rows = ref<Row[]>([])
const saving = ref(false)

function toRows(bindings: AccountBinding[]): Row[] {
  return bindings.map((b) => ({ platform: b.platform, accountKey: b.accountKey, displayName: b.displayName }))
}

watch(
  () => props.visible,
  (v) => {
    if (v) rows.value = toRows(props.persona.bindings)
  },
  { immediate: true },
)

function addRow() {
  rows.value.push({ platform: 'douyin', accountKey: '', displayName: '' })
}

async function save(done: (closed: boolean) => void) {
  const accounts = rows.value
    .map((r) => ({ ...r, accountKey: r.accountKey.trim(), displayName: r.displayName.trim() }))
    .filter((r) => r.accountKey)
  saving.value = true
  try {
    await setPersonaAccounts(props.persona.id, accounts)
    Message.success('账号绑定已保存')
    emit('changed')
    emit('update:visible', false)
    done(true)
  } catch (e) {
    Message.error((e as Error).message)
    done(false)
  } finally {
    saving.value = false
  }
}
</script>
