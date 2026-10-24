<template>
  <a-modal
    :visible="visible"
    :title="title"
    :ok-loading="loading"
    ok-text="确认"
    unmount-on-close
    :on-before-ok="submit"
    @cancel="$emit('update:visible', false)"
    @update:visible="(v: boolean) => !v && $emit('update:visible', false)"
  >
    <a-textarea
      v-model="reason"
      :placeholder="placeholder"
      :max-length="200"
      show-word-limit
      :auto-size="{ minRows: 3, maxRows: 6 }"
      aria-label="原因"
    />
    <div v-if="error" class="mt-2 text-[12.5px] text-[#c0392b]" role="alert">{{ error }}</div>
  </a-modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{ visible: boolean; title: string; placeholder?: string; loading?: boolean }>(),
  {
    placeholder: '请填写原因（必填）',
    loading: false,
  },
)
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'confirm', reason: string): void }>()

const reason = ref('')
const error = ref('')
watch(
  () => props.visible,
  (v) => {
    if (v) {
      reason.value = ''
      error.value = ''
    }
  },
)

function submit(): boolean {
  if (!reason.value.trim()) {
    error.value = '请填写原因'
    return false
  }
  emit('confirm', reason.value.trim())
  return false // 由父级在请求完成后关闭，失败时保留输入
}
</script>
