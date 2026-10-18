<template>
  <div class="mw-thumb mw-media-placeholder" aria-hidden="true" :style="{ width: width + 'px', height: height + 'px' }">
    <IconFile :size="Math.max(16, Math.round(height / 3))" />
  </div>
</template>
<script setup lang="ts">
import { IconFile } from '@arco-design/web-vue/es/icon'
withDefaults(defineProps<{ seed?: string; width?: number; height?: number }>(), { seed: 'a', width: 72, height: 72 })
</script>
