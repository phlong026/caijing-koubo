<template>
  <div>
    <div class="flex items-center gap-2 mb-2">
      <span class="text-[13px] font-medium">{{ title }}</span>
      <span class="mw-subtle">{{ items.length }} / {{ limitText }}</span>
      <div class="flex-1"></div>
      <a-input
        v-if="!readonly && extraField"
        v-model="extraValue"
        size="mini"
        :placeholder="extraField.placeholder"
        :max-length="extraField.maxLength"
        style="width: 128px"
      />
      <a-upload
        v-if="!readonly"
        :accept="accept"
        :multiple="kind === 'photo'"
        :show-file-list="false"
        :custom-request="upload"
      >
        <template #upload-button>
          <a-button size="mini" :loading="uploading > 0"><template #icon><icon-upload /></template>上传</a-button>
        </template>
      </a-upload>
    </div>

    <div v-if="!items.length" class="mw-subtle text-center py-5 border border-dashed border-[var(--mw-border)] rounded-[10px]">
      {{ emptyText }}
    </div>

    <div v-else :class="layout === 'grid' ? 'grid grid-cols-3 gap-2' : 'flex flex-col gap-2'">
      <div
        v-for="a in items"
        :key="a.id"
        :class="layout === 'grid' ? 'people-tile' : 'people-row'"
      >
        <div :class="layout === 'grid' ? 'people-tile-media' : 'people-row-media'">
          <img v-if="a.thumbKey" :src="assetFileUrl(a.id, 'thumb')" alt="" class="w-full h-full object-cover" />
          <div v-else class="w-full h-full flex items-center justify-center text-[var(--mw-text3)]">
            <a-spin v-if="isProcessing(a)" :size="16" />
            <icon-file v-else :size="18" />
          </div>
          <span v-if="a.durationMs" class="people-duration">{{ formatDuration(a.durationMs) }}</span>
          <span v-if="coverAssetId === a.id" class="people-cover-mark">封面</span>
        </div>

        <div :class="layout === 'grid' ? 'mt-1' : 'flex-1 min-w-0'">
          <div class="flex items-center gap-1 min-w-0">
            <span class="mw-tag" :class="ASSET_STATUS_TAG[a.status].cls">{{ ASSET_STATUS_TAG[a.status].text }}</span>
            <span v-if="layout === 'list'" class="text-[13px] truncate">{{ a.backgroundLabel || a.name }}</span>
          </div>
          <div v-if="layout === 'list'" class="mw-subtle mt-0.5 truncate">
            {{ metaText(a) }}
          </div>
          <div v-if="issues(a).length" class="mt-0.5 text-[11.5px] leading-snug" :class="a.status === 'failed' ? 'text-[#c2410c]' : 'text-[var(--mw-text3)]'">
            {{ issues(a).join('；') }}
          </div>
          <div v-if="a.status === 'rejected' && a.reviewReason" class="mt-0.5 text-[11.5px] text-[#c2410c]">驳回：{{ a.reviewReason }}</div>
          <div v-if="a.tags.length" class="mt-1 flex gap-1 flex-wrap">
            <span v-for="t in a.tags" :key="t" class="mw-tag mw-tag-gray">{{ t }}</span>
          </div>
        </div>

        <div v-if="!readonly" :class="layout === 'grid' ? 'mt-1 flex gap-1 flex-wrap' : 'people-row-actions'">
          <slot name="actions" :asset="a" />
          <template v-if="a.status === 'pending_review'">
            <a-button size="mini" type="primary" @click="review(a, 'approved')">通过</a-button>
            <a-button size="mini" @click="review(a, 'rejected')">驳回</a-button>
          </template>
          <a-dropdown trigger="click" @select="(v) => onMore(a, String(v))">
            <a-button size="mini" :aria-label="`更多操作：${a.name}`"><icon-more /></a-button>
            <template #content>
              <a-doption v-if="a.thumbKey || a.compatKey" value="view">查看</a-doption>
              <a-doption v-if="kind === 'photo' && a.status === 'approved' && coverAssetId !== a.id" value="cover">设为封面</a-doption>
              <a-doption v-if="tagEditable" value="tags">编辑标签</a-doption>
              <a-doption value="delete" class="text-[#c2410c]">删除</a-doption>
            </template>
          </a-dropdown>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import type { RequestOption } from '@arco-design/web-vue'
import {
  assetFileUrl,
  deleteAsset,
  patchAsset,
  reviewAsset,
  setCoverAsset,
  uploadAsset,
  type AssetKind,
  type PersonaAsset,
} from '@/api/personas'
import { ASSET_STATUS_TAG, formatDuration } from './labels'
import { confirmAction, promptText } from './prompt'

const props = withDefaults(
  defineProps<{
    personaId: string
    kind: AssetKind
    assets: PersonaAsset[]
    title: string
    limit: number
    accept: string
    readonly: boolean
    layout?: 'grid' | 'list'
    coverAssetId?: string | null
    emptyText?: string
  }>(),
  { layout: 'grid', coverAssetId: null, emptyText: '暂无素材' },
)
const emit = defineEmits<{ (e: 'changed'): void; (e: 'view', asset: PersonaAsset): void }>()

const items = computed(() => props.assets.filter((a) => a.kind === props.kind))
const limitText = computed(() => String(props.limit))
const uploading = ref(0)
const extraValue = ref('')

/** 分身素材登记背景名（L15）；背景与空镜登记标签（混剪匹配用） */
const extraField = computed(() => {
  if (props.kind === 'avatar_source') return { placeholder: '背景名（如白色简洁）', maxLength: 20 }
  if (props.kind !== 'photo') return { placeholder: '标签，逗号分隔', maxLength: 120 }
  return null
})
const tagEditable = computed(() => props.kind !== 'photo' && props.kind !== 'avatar_source')

function isProcessing(a: PersonaAsset): boolean {
  return a.processing || a.status === 'uploaded' || a.status === 'processing'
}

function issues(a: PersonaAsset): string[] {
  const q = a.quality
  if (!q) return a.error ? [a.error] : []
  return [...q.hard, ...q.soft].map((i) => i.message)
}

function metaText(a: PersonaAsset): string {
  const parts: string[] = []
  if (a.width && a.height) parts.push(`${a.width}×${a.height}`)
  if (a.durationMs) parts.push(formatDuration(a.durationMs))
  if (a.fps) parts.push(`${Math.round(a.fps)}fps`)
  return parts.join(' · ') || a.name
}

function upload(option: RequestOption) {
  const file = option.fileItem.file
  if (!file) return {}
  uploading.value += 1
  const fields =
    props.kind === 'avatar_source'
      ? { kind: props.kind, name: file.name, backgroundLabel: extraValue.value.trim() || undefined }
      : props.kind === 'photo'
        ? { kind: props.kind, name: file.name }
        : { kind: props.kind, name: file.name, tags: extraValue.value.trim() || undefined }
  uploadAsset(props.personaId, fields, file)
    .then((r) => {
      Message.success(r.deduplicated ? `「${file.name}」已存在，未重复上传` : `「${file.name}」已上传，正在处理`)
      // 背景名 / 标签只对这一次上传生效，避免下一个文件沿用
      extraValue.value = ''
      option.onSuccess(r)
      emit('changed')
    })
    .catch((e: Error) => {
      Message.error(`「${file.name}」上传失败：${e.message}`)
      option.onError(e)
    })
    .finally(() => {
      uploading.value -= 1
    })
  return {}
}

async function review(a: PersonaAsset, decision: 'approved' | 'rejected') {
  let reason: string | undefined
  if (decision === 'rejected') {
    const r = await promptText({ title: '驳回素材', placeholder: '驳回原因', required: true })
    if (r === null) return
    reason = r
  }
  try {
    await reviewAsset(a.id, decision, reason)
    Message.success(decision === 'approved' ? '已通过' : '已驳回')
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function onMore(a: PersonaAsset, action: string) {
  try {
    if (action === 'view') {
      emit('view', a)
    } else if (action === 'cover') {
      await setCoverAsset(a.id)
      Message.success('已设为封面')
      emit('changed')
    } else if (action === 'tags') {
      const v = await promptText({ title: '编辑标签', placeholder: '标签，逗号分隔', initial: a.tags.join(','), maxLength: 120 })
      if (v === null) return
      await patchAsset(a.id, { tags: v.split(/[,，]/).map((t) => t.trim()).filter(Boolean) })
      emit('changed')
    } else if (action === 'delete') {
      if (!(await confirmAction('删除素材', `确定删除「${a.name}」？删除后不可在人物库中使用。`, '删除'))) return
      await deleteAsset(a.id)
      Message.success('已删除')
      emit('changed')
    }
  } catch (e) {
    Message.error((e as Error).message)
  }
}
</script>

<style scoped>
.people-tile {
  min-width: 0;
}
.people-tile-media,
.people-row-media {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  background: #eef1ee;
}
.people-tile-media {
  aspect-ratio: 1 / 1;
}
.people-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: flex-start;
  padding: 8px;
  border: 1px solid var(--mw-border);
  border-radius: 10px;
}
.people-row-media {
  width: 64px;
  height: 44px;
  flex-shrink: 0;
}
/* 操作按钮单独一行，与缩略图右侧的文字对齐，避免挤压名称与元信息 */
.people-row-actions {
  width: 100%;
  padding-left: 74px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.people-duration,
.people-cover-mark {
  position: absolute;
  bottom: 3px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10.5px;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
}
.people-duration {
  right: 3px;
}
.people-cover-mark {
  left: 3px;
}
</style>
