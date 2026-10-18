<template>
  <div class="mw-page-head">
    <div>
      <h1 class="mw-page-title">{{ title }}</h1>
      <div v-if="$slots.sub || subtitle" class="mw-page-sub">
        <slot name="sub">{{ subtitle }}</slot>
      </div>
    </div>
    <div class="mw-page-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>()
</script>
