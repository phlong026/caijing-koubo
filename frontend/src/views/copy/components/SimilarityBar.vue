<template>
  <div v-if="result?.applicable" class="similarity-bar" :class="state" aria-label="与原文相似度">
    <div class="similarity-head">
      <span>与原文相似度</span>
      <b class="tabular-nums">{{ pct }}%</b>
      <span class="similarity-limit">{{ limitText }}</span>
    </div>
    <a-progress
      :percent="Math.min(1, result.similarity ?? 0)"
      :show-text="false"
      size="small"
      :color="barColor"
      track-color="#e9eef5"
    />
    <div v-if="items.length" class="similarity-chips">
      <button v-for="(it, i) in items" :key="i" type="button" @click="emit('locate', it)">
        <span class="mw-subtle">{{ it.where }}</span
        >{{ it.excerpt }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { OriginalityResult } from '@/api/copy'

export interface SimilarityItem {
  sectionIndex: number
  start: number
  end: number
  where: string
  excerpt: string
}

const props = defineProps<{ result: OriginalityResult | null; items: SimilarityItem[] }>()
const emit = defineEmits<{ (e: 'locate', item: SimilarityItem): void }>()

const pct = computed(() => Math.round((props.result?.similarity ?? 0) * 1000) / 10)
const over = computed(() => (props.result?.similarity ?? 0) > (props.result?.threshold ?? 1))
/** 素人线超限会被拦；其他线超限只是提醒；未超限为正常 */
const state = computed(() => (over.value ? (props.result?.blocked ? 'is-blocked' : 'is-warn') : 'is-ok'))
const barColor = computed(() => ({ 'is-blocked': '#c03e35', 'is-warn': '#b95f1d', 'is-ok': '#12805c' })[state.value])
const limitText = computed(() => {
  const limit = `${Math.round((props.result?.threshold ?? 0) * 100)}%`
  if (props.result?.blocked) return `超过素人线上限 ${limit}，需继续改写后才能提交`
  if (over.value) return `超过 ${limit}，建议继续改写`
  return `上限 ${limit}`
})
</script>

<style scoped>
.similarity-bar {
  margin-top: 10px;
  padding: 10px 14px;
  border: 1px solid var(--mw-border);
  border-radius: 8px;
  background: #fbfcfb;
  font-size: 13px;
}
.similarity-bar.is-blocked {
  border-color: #f0c8c4;
  background: #fef9f8;
}
.similarity-bar.is-warn {
  border-color: #f0dcc0;
  background: #fffaf2;
}
.similarity-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.similarity-head b {
  font-size: 15px;
}
.is-blocked .similarity-head b,
.is-blocked .similarity-limit {
  color: #c03e35;
}
.is-warn .similarity-head b,
.is-warn .similarity-limit {
  color: #b95f1d;
}
.similarity-limit {
  color: var(--mw-text3);
  font-size: 12px;
}
.similarity-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.similarity-chips button {
  display: inline-flex;
  gap: 6px;
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid #f0dcc0;
  border-radius: 5px;
  background: #fff7ea;
  color: #7a4a10;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.is-blocked .similarity-chips button {
  border-color: #f0c8c4;
  background: #fdeeee;
  color: #9a2f27;
}
.similarity-chips button:hover {
  filter: brightness(0.97);
}
</style>
