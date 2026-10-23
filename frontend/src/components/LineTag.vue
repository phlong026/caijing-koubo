<template>
  <span class="mw-tag" :class="cls"
    ><slot>{{ label }}</slot></span
  >
</template>

<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ line: 'manager' | 'kos' | 'persona' | string }>()
const cls = computed(
  () => ({ manager: 'mw-tag-deep', kos: 'mw-tag-blue', persona: 'mw-tag-purple' })[props.line] ?? 'mw-tag-gray',
)
const label = computed(() => ({ manager: '经理 IP', kos: '员工 KOS', persona: '素人矩阵' })[props.line as string] ?? '')
</script>
