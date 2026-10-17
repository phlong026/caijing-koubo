<template>
  <div
    class="mw-thumb flex items-center justify-center flex-shrink-0"
    :style="{ width: px(width), height: px(height), background: grad }"
  >
    <span :style="{ fontSize: iconSize + 'px', opacity: 0.55 }">📊</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
const props = withDefaults(
  defineProps<{ seed?: string; width?: number; height?: number }>(),
  { seed: 'a', width: 72, height: 72 },
)
const grads = [
  'linear-gradient(135deg,#dbe6f6,#eef3fa)',
  'linear-gradient(135deg,#e3eddc,#f2f7ec)',
  'linear-gradient(135deg,#f6e8d6,#faf1e6)',
  'linear-gradient(135deg,#e6def5,#f0ebfa)',
]
const grad = computed(() => {
  let n = 0
  for (const c of (props.seed || 'a')) n = (n * 31 + c.charCodeAt(0)) % 997
  return grads[n % grads.length]
})
const px = (v: number) => `${v}px`
const iconSize = computed(() => Math.max(14, Math.round(props.height / 4)))
</script>
