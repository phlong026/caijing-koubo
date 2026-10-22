<template>
  <a-modal
    :visible="visible"
    title="可用范围 · 账号绑定"
    :ok-loading="saving"
    ok-text="保存"
    :width="640"
    unmount-on-close
    :on-before-ok="save"
    @cancel="$emit('update:visible', false)"
    @update:visible="(v: boolean) => !v && $emit('update:visible', false)"
  >
    <div class="mw-subtle mb-3">{{ ruleText }}</div>
    <div v-for="(row, i) in rows" :key="i" class="flex items-center gap-2 mb-2">
      <a-select v-model="row.platform" class="!w-[110px]" :aria-label="`第 ${i + 1} 个账号的平台`">
        <a-option v-for="(label, key) in platforms" :key="key" :value="key">{{ label }}</a-option>
      </a-select>
      <a-input
        v-model="row.accountKey"
        placeholder="账号标识（如抖音号）"
        class="flex-1"
        :input-attrs="{ 'aria-label': `第 ${i + 1} 个账号标识` }"
      />
      <a-input
        v-model="row.displayName"
        placeholder="显示名"
        class="!w-[140px]"
        :input-attrs="{ 'aria-label': `第 ${i + 1} 个账号显示名` }"
      />
      <a-button status="danger" type="text" :aria-label="`移除第 ${i + 1} 个账号`" @click="rows.splice(i, 1)"
        ><icon-delete
      /></a-button>
    </div>
    <a-button type="outline" size="small" :disabled="rows.length >= limit" @click="add">
      <template #icon><icon-plus /></template>添加账号
    </a-button>
    <span v-if="rows.length >= limit" class="mw-subtle ml-2">已达上限 {{ limit }} 个</span>
    <div v-if="serverError" class="mw-alert-banner mt-3" role="alert">{{ serverError }}</div>
  </a-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { setAccounts, type PersonaDetail, type Platform } from '@/api/personas'
import { errMsg, PLATFORM_LABEL } from './shared'

const props = defineProps<{ visible: boolean; persona: PersonaDetail }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'saved'): void }>()

const platforms = PLATFORM_LABEL
const rows = ref<Array<{ platform: Platform; accountKey: string; displayName: string }>>([])
const saving = ref(false)
const serverError = ref('')

/** FR-U5：经理 ≤1；KOS 共享 ≤5，一对一 ≤1；素人 ≤1 */
const limit = computed(() => (props.persona.line === 'kos' && props.persona.bindingMode === 'shared' ? 5 : 1))
const ruleText = computed(() => {
  if (props.persona.line === 'manager') return '经理 IP 一对一：最多绑定 1 个账号，且同一账号只能绑定 1 个经理人物。'
  if (props.persona.line === 'persona') return '素人矩阵一对一：最多绑定 1 个账号。'
  return props.persona.bindingMode === 'shared'
    ? '员工 KOS 共享：最多可供 5 个授权账号使用；声音共享须单独核验授权。'
    : '员工 KOS 一对一：最多绑定 1 个账号。'
})

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    serverError.value = ''
    rows.value = props.persona.bindings.map((b) => ({
      platform: b.platform,
      accountKey: b.accountKey,
      displayName: b.displayName,
    }))
  },
)

function add(): void {
  rows.value.push({ platform: 'douyin', accountKey: '', displayName: '' })
}

async function save(): Promise<boolean> {
  serverError.value = ''
  const cleaned = rows.value.map((r) => ({ ...r, accountKey: r.accountKey.trim(), displayName: r.displayName.trim() }))
  if (cleaned.some((r) => !r.accountKey || !r.displayName)) {
    serverError.value = '每个账号都需要填写账号标识和显示名'
    return false
  }
  saving.value = true
  try {
    await setAccounts(props.persona.id, cleaned)
    Message.success('已保存绑定')
    emit('saved')
    emit('update:visible', false)
    return true
  } catch (e) {
    serverError.value = errMsg(e, '保存失败')
    return false
  } finally {
    saving.value = false
  }
}
</script>
