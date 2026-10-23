<template>
  <div>
    <a-spin :loading="loading" class="w-full">
      <div v-if="error" class="mw-alert-banner mb-3" role="alert">
        {{ error }}
        <a-button size="mini" type="text" @click="$emit('retry')">重试</a-button>
      </div>

      <div v-if="!loading && !items.length && !error" class="mw-card p-10 text-center">
        <a-empty>
          <!-- 默认插槽会覆盖 description，所以文案与按钮都放在插槽里 -->
          <div class="mb-3">还没有符合条件的人物</div>
          <a-button type="primary" @click="$emit('create')">
            <template #icon><icon-plus /></template>
            新增人物
          </a-button>
        </a-empty>
      </div>

      <div v-else class="grid grid-cols-2 gap-4 people-grid">
        <div
          v-for="p in items"
          :key="p.id"
          class="mw-card p-4 cursor-pointer transition-all people-card"
          :class="
            currentId === p.id
              ? 'border-[color:var(--mw-primary)] ring-1 ring-[color:var(--mw-primary)]'
              : 'hover:shadow-sm'
          "
          role="button"
          tabindex="0"
          :aria-pressed="currentId === p.id"
          :aria-label="`选择人物 ${p.name}`"
          @click="$emit('select', p.id)"
          @keydown.enter="$emit('select', p.id)"
          @keydown.space.prevent="$emit('select', p.id)"
        >
          <div class="people-cover" style="aspect-ratio: 16/9">
            <img
              v-if="p.coverUrl"
              :src="p.coverUrl"
              :alt="`${p.name} 封面`"
              class="w-full h-full object-cover"
              loading="lazy"
            />
            <div v-else class="w-full h-full flex items-center justify-center text-[28px] font-semibold people-initial">
              {{ p.name.slice(0, 1) }}
            </div>
          </div>

          <div class="mt-3 flex items-center gap-2 flex-wrap">
            <span class="text-[15px] font-semibold">{{ p.name }}</span>
            <LineTag :line="p.line" />
            <span v-if="p.isStub" class="mw-tag mw-tag-gray">示例</span>
          </div>
          <div class="mw-subtle mt-1 truncate">{{ subtitle(p) }}</div>

          <div class="mt-2 flex items-center gap-1.5 flex-wrap">
            <span class="mw-tag" :class="STATUS_TAG[p.status]">{{ p.statusLabel }}</span>
            <span v-for="t in extraTags(p)" :key="t.text" class="mw-tag" :class="t.cls">{{ t.text }}</span>
          </div>

          <div class="mt-3 pt-2.5 border-t border-[#f2f4f7] flex items-center gap-4 text-[12px] text-[var(--mw-text2)]">
            <span class="flex items-center gap-1"
              ><icon-image :size="14" class="text-[var(--mw-text3)]" />照片 {{ p.counts.photos }}</span
            >
            <span class="flex items-center gap-1"
              ><icon-play-circle :size="14" class="text-[var(--mw-text3)]" />分身 {{ p.counts.avatars }}</span
            >
            <span class="flex items-center gap-1"
              ><icon-sound :size="14" class="text-[var(--mw-text3)]" />声音 {{ p.counts.voices }}</span
            >
          </div>
        </div>
      </div>
    </a-spin>
  </div>
</template>

<script setup lang="ts">
import LineTag from '@/components/LineTag.vue'
import type { PersonaListItem } from '@/api/personas'
import { EXTRA_TAGS, STATUS_TAG } from './shared'

defineProps<{ items: PersonaListItem[]; currentId: string | null; loading: boolean; error: string | null }>()
defineEmits<{ (e: 'select', id: string): void; (e: 'create'): void; (e: 'retry'): void }>()

/** 副标题（FR-L1）：归属主体 / 专属一对一 / 可供 N 个账号使用 */
function subtitle(p: PersonaListItem): string {
  if (p.bindingMode === 'shared') {
    const n = p.counts.bindings
    return n ? `可供 ${n} 个授权账号使用` : '共享人物 · 尚未绑定账号'
  }
  if (p.line === 'manager') return `${p.ownerSubject || p.name} · 专属形象 · 一对一绑定`
  return p.ownerSubject || p.description || '一对一绑定'
}

function extraTags(p: PersonaListItem): Array<{ text: string; cls: string }> {
  // 已归档 / 已停用时附加标签没有意义
  if (p.status === 'archived' || p.status === 'disabled') return []
  return p.extraTags.map((t) => EXTRA_TAGS[t]).filter(Boolean)
}
</script>

<style scoped>
.people-cover {
  border-radius: 10px;
  overflow: hidden;
  background: linear-gradient(150deg, #e8edf2, #f3f5f4);
}
.people-initial {
  color: var(--mw-text3);
}
.people-card:focus-visible {
  outline: 2px solid var(--mw-primary);
  outline-offset: 2px;
}
@media (max-width: 1100px) {
  .people-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
