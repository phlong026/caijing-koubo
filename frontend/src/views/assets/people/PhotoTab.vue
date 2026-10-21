<template>
  <div>
    <AssetGrid
      :items="photos"
      accept=".jpg,.jpeg,.png,.webp"
      upload-label="点击或拖拽上传形象照片（可多选）"
      hint="jpg / png / webp，≤10MB，最短边 ≥720px；每人最多 50 张，同一文件不会重复上传"
      empty-text="还没有形象照片"
      :cover-id="persona.coverAssetId"
      allow-cover
      :disabled="readonly"
      disabled-text="人物已归档，不能上传"
      :uploader="upload"
      @uploaded="$emit('changed')"
      @preview="(a) => (previewing = a)"
      @approve="approve"
      @reject="(a) => (rejecting = a)"
      @cover="setCover"
      @remove="remove"
    />

    <ReasonDialog :visible="!!rejecting" title="驳回照片" :loading="busy" @update:visible="(v: boolean) => !v && (rejecting = null)" @confirm="reject" />

    <a-modal :visible="!!previewing" :title="previewing?.name" :footer="false" :width="720" unmount-on-close @cancel="previewing = null">
      <img v-if="previewing" :src="assetFileUrl(previewing.id, 'original')" :alt="previewing.name" class="w-full max-h-[70vh] object-contain" />
      <div class="mw-subtle mt-2">查看原图会留下敏感访问记录。</div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { assetFileUrl, deleteAsset, reviewAsset, setAssetCover, uploadAsset, type PersonaAsset, type PersonaDetail, type PersonaOptions } from '@/api/personas'
import AssetGrid from './AssetGrid.vue'
import ReasonDialog from './ReasonDialog.vue'
import { checkUploadFile, toastError } from './shared'

const props = defineProps<{ persona: PersonaDetail; options: PersonaOptions | null }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const photos = computed(() => props.persona.assets.filter((a) => a.kind === 'photo'))
const readonly = computed(() => props.persona.status === 'archived')
const rejecting = ref<PersonaAsset | null>(null)
const previewing = ref<PersonaAsset | null>(null)
const busy = ref(false)

async function upload(file: File): Promise<string | void> {
  const bad = checkUploadFile(props.options, 'photo', file)
  if (bad) throw new Error(bad)
  const r = await uploadAsset(props.persona.id, { kind: 'photo', name: file.name }, file)
  return r.deduplicated ? '已存在，未重复上传' : '已上传，处理中'
}

async function approve(a: PersonaAsset): Promise<void> {
  try {
    await reviewAsset(a.id, { decision: 'approved' })
    Message.success('已通过')
    emit('changed')
  } catch (e) { toastError(e) }
}
async function reject(reason: string): Promise<void> {
  if (!rejecting.value) return
  busy.value = true
  try {
    await reviewAsset(rejecting.value.id, { decision: 'rejected', reason })
    Message.success('已驳回')
    rejecting.value = null
    emit('changed')
  } catch (e) { toastError(e) } finally { busy.value = false }
}
async function setCover(a: PersonaAsset): Promise<void> {
  try {
    await setAssetCover(a.id)
    Message.success('已设为封面')
    emit('changed')
  } catch (e) { toastError(e) }
}
async function remove(a: PersonaAsset): Promise<void> {
  try {
    await deleteAsset(a.id)
    emit('changed')
  } catch (e) { toastError(e) }
}
</script>
