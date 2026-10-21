<template>
  <div class="flex flex-col gap-3">
    <div v-if="!readonly" class="upload-box">
      <div class="flex gap-2 flex-wrap items-center">
        <a-select v-model="kind" :style="{ width: '130px' }" aria-label="素材类型">
          <a-option v-for="k in kinds" :key="k" :value="k" :label="options.assetKindLabels[k]" />
        </a-select>
        <a-input v-model="name" :max-length="60" placeholder="名称（可选）" :style="{ flex: 1, minWidth: '120px' }" />
        <a-input v-if="kind === 'avatar_source'" v-model="backgroundLabel" :max-length="20" placeholder="背景名（如：书房）" :style="{ width: '150px' }" />
        <a-input v-if="taggable" v-model="tags" placeholder="标签，逗号分隔" :style="{ width: '170px' }" />
      </div>
      <div class="flex items-center gap-3">
        <input ref="fileInput" type="file" :accept="accept" class="sr-only" aria-label="选择素材文件" @change="onFile" />
        <a-button size="small" @click="fileInput?.click()"><icon-upload />选择文件</a-button>
        <span class="mw-subtle truncate">{{ file ? `${file.name}（${fmtSize(file.size)}）` : limitHint }}</span>
        <div class="flex-1" />
        <a-button type="primary" size="small" :loading="uploading" :disabled="!file" @click="upload">上传</a-button>
      </div>
      <a-progress v-if="uploading" :percent="1" status="normal" :show-text="false" size="small" animation />
    </div>

    <div v-for="group in groups" :key="group.kind">
      <div class="group-head">{{ options.assetKindLabels[group.kind] }} <span class="mw-subtle">{{ group.items.length }} / {{ options.assetLimits[group.kind] }}</span></div>
      <div class="asset-grid">
        <div v-for="a in group.items" :key="a.id" class="asset-card" :class="{ cover: detail.coverAssetId === a.id }">
          <a class="asset-thumb" :href="assetFileUrl(a.id, a.compatKey ? 'compat' : 'original')" target="_blank" rel="noopener" :aria-label="`查看 ${a.name}`">
            <img v-if="a.thumbKey" :src="assetFileUrl(a.id, 'thumb')" :alt="a.name" loading="lazy" />
            <span v-else class="mw-subtle">{{ a.processing ? '处理中…' : '无预览' }}</span>
          </a>
          <div class="asset-meta">
            <div class="flex items-center gap-1">
              <span class="truncate flex-1" :title="a.name">{{ a.name }}</span>
              <span class="mw-tag" :class="toneClass(ASSET_STATUS[a.status].tone)">{{ ASSET_STATUS[a.status].label }}</span>
            </div>
            <div class="mw-subtle">
              <template v-if="a.width">{{ a.width }}×{{ a.height }}</template>
              <template v-if="a.durationMs"> · {{ fmtDuration(a.durationMs) }}</template>
              <template v-if="a.backgroundLabel"> · {{ a.backgroundLabel }}</template>
            </div>
            <div v-if="issues(a).length" class="asset-issues">{{ issues(a).join('；') }}</div>
            <div v-if="a.reviewReason" class="asset-issues">驳回原因：{{ a.reviewReason }}</div>
            <div v-if="a.error" class="asset-issues">{{ a.error }}</div>
            <div v-if="!readonly" class="flex gap-1 flex-wrap mt-1">
              <template v-if="canReview && a.status === 'pending_review'">
                <a-tooltip :content="a.createdBy === auth.user?.username ? '四眼原则：不能审核自己上传的素材' : ''">
                  <a-button size="mini" type="primary" :disabled="a.createdBy === auth.user?.username" @click="review(a.id, 'approved')">通过</a-button>
                </a-tooltip>
                <a-button size="mini" status="danger" :disabled="a.createdBy === auth.user?.username" @click="openReject(a.id)">驳回</a-button>
              </template>
              <a-button v-if="a.kind === 'photo' && a.status === 'approved' && detail.coverAssetId !== a.id" size="mini" @click="cover(a.id)">设为封面</a-button>
              <a-popconfirm content="删除后不可恢复，确认删除？" @ok="remove(a.id)">
                <a-button size="mini">删除</a-button>
              </a-popconfirm>
            </div>
          </div>
        </div>
      </div>
    </div>
    <p v-if="!detail.assets.length" class="mw-subtle text-center py-4">暂无素材</p>

    <a-modal v-model:visible="rejectVisible" title="驳回素材" @ok="submitReject">
      <a-textarea v-model="rejectReason" :max-length="255" placeholder="驳回原因（必填），如：画面模糊、人脸遮挡" :auto-size="{ minRows: 3 }" />
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import {
  assetFileUrl,
  deleteAsset,
  reviewAsset,
  setCoverAsset,
  uploadAsset,
  type AssetKind,
  type PersonaAsset,
  type PersonaDetail,
  type PersonaOptions,
} from '@/api/personas'
import { useAuthStore } from '@/stores/auth'
import { ASSET_STATUS, fmtDuration, fmtSize, toneClass } from './labels'

const props = defineProps<{ detail: PersonaDetail; options: PersonaOptions; readonly: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const auth = useAuthStore()
const canReview = computed(() => auth.hasRole('reviewer', 'admin'))
const kinds = computed<AssetKind[]>(() => {
  const all: AssetKind[] = ['photo', 'avatar_source', 'background_image', 'background_video', 'broll_video']
  return props.options.lineRules[props.detail.line].avatarAllowed ? all : all.filter((k) => k !== 'avatar_source')
})
const kind = ref<AssetKind>('photo')
const name = ref('')
const backgroundLabel = ref('')
const tags = ref('')
const file = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const rejectVisible = ref(false)
const rejectTarget = ref('')
const rejectReason = ref('')

const taggable = computed(() => ['background_image', 'background_video', 'broll_video'].includes(kind.value))
const limit = computed(() => props.options.uploadLimits[kind.value])
const accept = computed(() => (limit.value?.exts ?? []).join(','))
const limitHint = computed(() => {
  const l = limit.value
  if (!l) return ''
  const parts = [`${l.exts.map((e) => e.slice(1).toUpperCase()).join(' / ')}`, `≤ ${Math.round(l.maxBytes / 1024 / 1024)}MB`]
  if (l.minShortEdge) parts.push(`短边 ≥ ${l.minShortEdge}px`)
  if (l.minDurationMs || l.maxDurationMs) parts.push(`时长 ${fmtDuration(l.minDurationMs ?? 0) || '0秒'}–${fmtDuration(l.maxDurationMs)}`)
  return parts.join('，')
})

const groups = computed(() =>
  kinds.value
    .map((k) => ({ kind: k, items: props.detail.assets.filter((a) => a.kind === k) }))
    .filter((g) => g.items.length),
)

function issues(a: PersonaAsset): string[] {
  const q = a.quality
  if (!q) return []
  return [...(q.hard ?? []), ...(q.soft ?? [])].map((i) => i.message ?? i.code ?? '').filter(Boolean)
}

function onFile(e: Event): void {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null
  if (f && limit.value && f.size > limit.value.maxBytes) {
    Message.warning(`文件超过 ${Math.round(limit.value.maxBytes / 1024 / 1024)}MB 上限`)
    ;(e.target as HTMLInputElement).value = ''
    file.value = null
    return
  }
  file.value = f
}

async function upload(): Promise<void> {
  if (!file.value) return
  uploading.value = true
  try {
    const r = await uploadAsset(
      props.detail.id,
      {
        kind: kind.value,
        name: name.value.trim() || undefined,
        backgroundLabel: kind.value === 'avatar_source' ? backgroundLabel.value.trim() || undefined : undefined,
        tags: taggable.value ? tags.value : undefined,
      },
      file.value,
    )
    Message.success(r.deduplicated ? '相同文件已存在，未重复上传' : '已上传，正在自动质检，完成后等待审核员审核')
    file.value = null
    name.value = ''
    if (fileInput.value) fileInput.value.value = ''
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    uploading.value = false
  }
}

async function review(id: string, decision: 'approved' | 'rejected', reason?: string): Promise<void> {
  try {
    await reviewAsset(id, decision, reason)
    Message.success(decision === 'approved' ? '已审核通过' : '已驳回')
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

function openReject(id: string): void {
  rejectTarget.value = id
  rejectReason.value = ''
  rejectVisible.value = true
}

async function submitReject(): Promise<void> {
  if (!rejectReason.value.trim()) {
    Message.warning('请填写驳回原因')
    return
  }
  await review(rejectTarget.value, 'rejected', rejectReason.value.trim())
  rejectVisible.value = false
}

async function cover(id: string): Promise<void> {
  try {
    await setCoverAsset(id)
    Message.success('已设为封面')
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function remove(id: string): Promise<void> {
  try {
    await deleteAsset(id)
    Message.success('已删除')
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}
</script>

<style scoped>
.upload-box {
  border: 1px solid var(--mw-border-light);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.group-head {
  font-size: 13px;
  font-weight: 600;
  margin: 8px 0 6px;
}
.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}
.asset-card {
  border: 1px solid var(--mw-border-light);
  border-radius: 8px;
  overflow: hidden;
  font-size: 12px;
}
.asset-card.cover {
  border-color: var(--mw-primary);
}
.asset-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  background: #eef1ee;
}
.asset-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.asset-meta {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.asset-issues {
  color: #b45427;
  line-height: 1.5;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
