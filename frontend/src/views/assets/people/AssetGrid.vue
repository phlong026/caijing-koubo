<template>
  <div>
    <div
      class="people-drop"
      :class="{ over: dragging, disabled: disabled }"
      role="button"
      tabindex="0"
      :aria-label="uploadLabel"
      :aria-disabled="disabled"
      @click="pick"
      @keydown.enter="pick"
      @keydown.space.prevent="pick"
      @dragover.prevent="dragging = !disabled"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <icon-upload :size="20" />
      <div class="mt-1">{{ disabled ? disabledText : uploadLabel }}</div>
      <div class="mw-subtle mt-0.5">{{ hint }}</div>
      <input ref="input" type="file" class="hidden" :accept="accept" multiple @change="onPick" />
    </div>

    <div v-if="uploads.length" class="mt-3 space-y-1.5" aria-live="polite">
      <div v-for="u in uploads" :key="u.id" class="flex items-center gap-2 text-[12.5px]">
        <span class="truncate flex-1">{{ u.name }}</span>
        <a-progress
          v-if="u.state === 'uploading'"
          :percent="0.5"
          :show-text="false"
          size="small"
          class="!w-[90px]"
          status="normal"
        />
        <span v-else-if="u.state === 'done'" class="text-[#1a7f4b]">{{ u.note || '已上传' }}</span>
        <span v-else class="text-[#c0392b]" role="alert">{{ u.note }}</span>
      </div>
    </div>

    <a-empty v-if="!items.length" class="mt-4" :description="emptyText" />
    <div v-else class="mt-4 grid grid-cols-3 gap-3 asset-grid">
      <div v-for="a in items" :key="a.id" class="asset-card" :class="{ cover: a.id === coverId }">
        <div class="asset-thumb" @click="$emit('preview', a)">
          <img v-if="isImage(a) && a.thumbKey" :src="assetFileUrl(a.id, 'thumb')" :alt="a.name" loading="lazy" />
          <img v-else-if="a.thumbKey" :src="assetFileUrl(a.id, 'thumb')" :alt="a.name" loading="lazy" />
          <div v-else class="asset-thumb-empty">
            <icon-image v-if="isImage(a)" :size="22" /><icon-video-camera v-else :size="22" />
          </div>
          <span class="mw-tag asset-status" :class="ASSET_STATUS[a.status].cls">{{ ASSET_STATUS[a.status].text }}</span>
          <span v-if="a.id === coverId" class="mw-tag mw-tag-deep asset-cover">封面</span>
          <span v-if="a.durationMs" class="asset-duration">{{ fmtDuration(a.durationMs) }}</span>
        </div>
        <div class="px-2 py-1.5">
          <div class="text-[12.5px] truncate" :title="a.name">{{ a.name }}</div>
          <div class="mw-subtle truncate">
            <template v-if="a.width && a.height">{{ a.width }}×{{ a.height }} · </template>{{ fmtSize(a.sizeBytes) }}
          </div>
          <div v-if="a.backgroundLabel" class="mw-subtle truncate">背景：{{ a.backgroundLabel }}</div>
          <div v-if="a.tags.length" class="mt-1 flex gap-1 flex-wrap">
            <span v-for="t in a.tags" :key="t" class="mw-tag mw-tag-gray">{{ t }}</span>
          </div>
          <div v-if="a.status === 'failed' || a.status === 'rejected'" class="mt-1 text-[12px] text-[#c0392b]">
            {{ reasonOf(a) }}
          </div>
          <div v-else-if="a.quality?.soft?.length" class="mt-1 text-[12px] text-[#b26a00]">
            {{ a.quality.soft.map((s) => s.message).join('；') }}
          </div>
          <div class="mt-1.5 flex items-center gap-1 flex-wrap">
            <a-button v-if="a.status === 'pending_review'" size="mini" type="primary" @click="$emit('approve', a)"
              >通过</a-button
            >
            <a-button v-if="a.status === 'pending_review'" size="mini" status="danger" @click="$emit('reject', a)"
              >驳回</a-button
            >
            <a-button
              v-if="allowCover && a.status === 'approved' && a.id !== coverId"
              size="mini"
              @click="$emit('cover', a)"
              >设为封面</a-button
            >
            <a-button v-if="allowEdit" size="mini" type="text" @click="$emit('edit', a)">编辑</a-button>
            <a-popconfirm content="删除后可重新上传同一文件，确认删除？" @ok="$emit('remove', a)">
              <a-button size="mini" type="text" status="danger">删除</a-button>
            </a-popconfirm>
          </div>
          <slot name="extra" :asset="a" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { assetFileUrl, type PersonaAsset } from '@/api/personas'
import { ASSET_STATUS, fmtDuration, fmtSize } from './shared'

const props = withDefaults(
  defineProps<{
    items: PersonaAsset[]
    accept: string
    uploadLabel: string
    hint: string
    emptyText: string
    coverId?: string | null
    allowCover?: boolean
    allowEdit?: boolean
    disabled?: boolean
    disabledText?: string
    /** 上传一个文件；返回提示文案（如「已存在，未重复上传」），抛错则标记失败 */
    uploader: (file: File) => Promise<string | void>
  }>(),
  { coverId: null, allowCover: false, allowEdit: false, disabled: false, disabledText: '当前不可上传' },
)

const emit = defineEmits<{
  (e: 'uploaded'): void
  (e: 'preview', a: PersonaAsset): void
  (e: 'approve', a: PersonaAsset): void
  (e: 'reject', a: PersonaAsset): void
  (e: 'cover', a: PersonaAsset): void
  (e: 'edit', a: PersonaAsset): void
  (e: 'remove', a: PersonaAsset): void
}>()

const input = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const uploads = ref<Array<{ id: number; name: string; state: 'uploading' | 'done' | 'error'; note?: string }>>([])
let seq = 0

function isImage(a: PersonaAsset): boolean {
  return a.kind === 'photo' || a.kind === 'background_image'
}
function reasonOf(a: PersonaAsset): string {
  if (a.reviewReason) return `驳回原因：${a.reviewReason}`
  const hard = a.quality?.hard?.map((h) => h.message).join('；')
  return hard || a.error || '处理失败'
}
function pick(): void {
  if (!props.disabled) input.value?.click()
}
function onPick(ev: Event): void {
  const el = ev.target as HTMLInputElement
  void run(Array.from(el.files ?? []))
  el.value = ''
}
function onDrop(ev: DragEvent): void {
  dragging.value = false
  if (props.disabled) return
  void run(Array.from(ev.dataTransfer?.files ?? []))
}

async function run(files: File[]): Promise<void> {
  for (const f of files) {
    const row = {
      id: ++seq,
      name: f.name,
      state: 'uploading' as 'uploading' | 'done' | 'error',
      note: '' as string | undefined,
    }
    uploads.value.unshift(row)
    try {
      row.note = (await props.uploader(f)) || undefined
      row.state = 'done'
    } catch (e) {
      row.state = 'error'
      row.note = e instanceof Error ? e.message : '上传失败'
    }
  }
  uploads.value = uploads.value.slice(0, 6)
  emit('uploaded')
}
</script>

<style scoped>
.people-drop {
  border: 1px dashed var(--mw-border);
  border-radius: 8px;
  padding: 14px;
  text-align: center;
  cursor: pointer;
  color: var(--mw-text2);
  transition:
    border-color 0.15s,
    background 0.15s;
}
.people-drop:hover,
.people-drop.over,
.people-drop:focus-visible {
  border-color: var(--mw-primary);
  background: var(--mw-primary-bg);
  outline: none;
}
.people-drop.disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.asset-card {
  border: 1px solid var(--mw-border-light);
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}
.asset-card.cover {
  border-color: var(--mw-primary);
}
.asset-thumb {
  position: relative;
  aspect-ratio: 4 / 3;
  background: #f1f3f1;
  cursor: pointer;
}
.asset-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.asset-thumb-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--mw-text3);
}
.asset-status {
  position: absolute;
  top: 6px;
  left: 6px;
}
.asset-cover {
  position: absolute;
  top: 6px;
  right: 6px;
}
.asset-duration {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
}
@media (max-width: 1100px) {
  .asset-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
