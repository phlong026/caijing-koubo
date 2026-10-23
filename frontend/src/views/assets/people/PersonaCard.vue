<template>
  <div
    class="mw-card p-4 cursor-pointer transition-all"
    :class="active ? 'border-[color:var(--mw-primary)] ring-1 ring-[color:var(--mw-primary)]' : 'hover:shadow-sm'"
    role="button"
    tabindex="0"
    :aria-pressed="active"
    @click="$emit('select')"
    @keydown.enter.self="$emit('select')"
  >
    <div class="relative rounded-[10px] overflow-hidden bg-[#eef1ee]" style="aspect-ratio: 16/9">
      <img v-if="coverUrl" :src="coverUrl" alt="" class="absolute inset-0 w-full h-full object-cover" />
      <div v-else class="absolute inset-0 flex items-center justify-center">
        <span class="people-initial">{{ persona.name.slice(0, 1) }}</span>
      </div>
      <button
        v-if="preview"
        type="button"
        class="absolute inset-0 flex items-center justify-center bg-transparent border-0 p-0 cursor-pointer"
        :aria-label="`播放${persona.name}的默认分身素材`"
        @click.stop="$emit('play', preview.assetId)"
      >
        <span class="w-10 h-10 rounded-full bg-black/35 flex items-center justify-center">
          <icon-play-arrow-fill :size="20" style="color: #fff" />
        </span>
      </button>
      <span
        v-if="preview?.durationMs"
        class="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-[4px] bg-black/50 text-white text-[11px]"
      >{{ formatDuration(preview.durationMs) }}</span>
    </div>

    <div class="mt-3 flex items-center gap-2 min-w-0">
      <span class="text-[15px] font-semibold truncate">{{ persona.name }}</span>
      <LineTag :line="persona.line" />
      <span v-if="persona.isStub" class="mw-tag mw-tag-gray">示例</span>
    </div>
    <div class="mw-subtle mt-1 truncate">{{ subtitle }}</div>
    <div class="mt-2 flex items-center gap-1.5 flex-wrap">
      <span v-for="t in tags" :key="t.text" class="mw-tag" :class="t.cls">{{ t.text }}</span>
    </div>
    <div class="mt-3 pt-2.5 border-t border-[#f2f4f7] flex items-center gap-4 text-[12px] text-[var(--mw-text2)]">
      <span class="flex items-center gap-1"><icon-image :size="14" class="text-[var(--mw-text3)]" />照片 {{ persona.counts.photos }}</span>
      <span class="flex items-center gap-1"><icon-play-circle :size="14" class="text-[var(--mw-text3)]" />分身 {{ persona.counts.avatars }}</span>
      <span class="flex items-center gap-1"><icon-sound :size="14" class="text-[var(--mw-text3)]" />声音 {{ persona.counts.voices }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import LineTag from '@/components/LineTag.vue'
import type { PersonaListItem } from '@/api/personas'
import { formatDuration, personaTags } from './labels'

const props = defineProps<{ persona: PersonaListItem; active: boolean }>()
defineEmits<{ (e: 'select'): void; (e: 'play', assetId: string): void }>()

const preview = computed(() => props.persona.defaultAvatarPreview ?? null)
const coverUrl = computed(() => preview.value?.coverUrl ?? props.persona.coverUrl)
const tags = computed(() => personaTags(props.persona))

/** 副标题：归属主体 / 一对一绑定 / 共享账号数（FR-L1） */
const subtitle = computed(() => {
  const p = props.persona
  if (p.bindingMode === 'shared') return `可供 ${p.counts.bindings} 个授权账号使用`
  if (p.ownerSubject && p.ownerSubject !== p.name) return p.ownerSubject
  return '专属形象 · 一对一绑定'
})
</script>

<style scoped>
.people-initial {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--mw-primary-bg);
  color: var(--mw-primary);
  font-size: 24px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
