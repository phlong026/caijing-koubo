<template>
  <div class="flex flex-col gap-3">
    <p class="mw-subtle">
      {{ rule.label }} · {{ detail.bindingMode === 'shared' ? `共享人物最多绑定 ${rule.accountLimit} 个账号` : '一对一人物只绑定 1 个账号' }}。
      同一平台账号同时只能绑定一个人物。
    </p>
    <div v-for="(row, i) in rows" :key="i" class="binding-row">
      <a-select v-model="row.platform" :disabled="readonly" :style="{ width: '110px' }" aria-label="平台">
        <a-option v-for="(label, key) in options.platformLabels" :key="key" :value="key" :label="label" />
      </a-select>
      <a-input v-model="row.accountKey" :disabled="readonly" :max-length="128" placeholder="账号标识（抖音号 / 小红书号等）" />
      <a-input v-model="row.displayName" :disabled="readonly" :max-length="60" placeholder="显示名（可选）" />
      <a-button v-if="!readonly" type="text" status="danger" aria-label="移除该账号" @click="rows.splice(i, 1)"><icon-delete /></a-button>
    </div>
    <p v-if="!rows.length" class="mw-subtle text-center py-2">尚未绑定账号</p>
    <div v-if="!readonly" class="flex gap-2">
      <a-button size="small" :disabled="rows.length >= limit" @click="rows.push({ platform: 'douyin', accountKey: '', displayName: '' })"><icon-plus />添加账号</a-button>
      <div class="flex-1" />
      <a-button size="small" type="primary" :loading="saving" :disabled="!dirty" @click="save">保存绑定</a-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { setBindings, type PersonaDetail, type PersonaOptions, type Platform } from '@/api/personas'

const props = defineProps<{ detail: PersonaDetail; options: PersonaOptions; readonly: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const rule = computed(() => props.options.lineRules[props.detail.line])
const limit = computed(() => (props.detail.bindingMode === 'shared' ? rule.value.accountLimit : 1))

type Row = { platform: Platform; accountKey: string; displayName: string }
const fromDetail = (): Row[] =>
  props.detail.bindings.map((b) => ({ platform: b.platform, accountKey: b.accountKey, displayName: b.displayName }))
const rows = ref<Row[]>(fromDetail())
const baseline = ref(JSON.stringify(fromDetail()))
const saving = ref(false)
const dirty = computed(() => JSON.stringify(rows.value) !== baseline.value)

watch(
  () => props.detail.bindings,
  () => {
    if (dirty.value) return
    rows.value = fromDetail()
    baseline.value = JSON.stringify(rows.value)
  },
)

async function save(): Promise<void> {
  saving.value = true
  try {
    const accounts = rows.value
      .filter((r) => r.accountKey.trim())
      .map((r) => ({ platform: r.platform, accountKey: r.accountKey.trim(), displayName: r.displayName.trim() || undefined }))
    await setBindings(props.detail.id, accounts)
    baseline.value = JSON.stringify(rows.value)
    Message.success('绑定已保存')
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.binding-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
