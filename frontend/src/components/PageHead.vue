<template>
  <div class="flex items-start justify-between mb-5">
    <div>
      <h1 class="mw-page-title">{{ title }}</h1>
      <div v-if="$slots.sub || subtitle" class="mw-page-sub">
        <slot name="sub">{{ subtitle }}</slot>
      </div>
    </div>
    <div class="flex items-center gap-3 pt-1.5">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>()
</script>
