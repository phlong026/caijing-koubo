<template>
  <div>
    <div class="mw-alert-banner mb-3" role="note">口播视频的背景由分身素材决定，此处素材用于剪辑、封面与混剪（可打标签供关键词匹配）。</div>

    <div v-for="g in groups" :key="g.kind" class="mb-6">
      <div class="font-semibold mb-2">{{ g.title }}<span class="mw-subtle ml-2">{{ countOf(g.kind) }} / {{ limitOf(g.kind) }}</span></div>
      <AssetGrid
        :items="itemsOf(g.kind)"
        :accept="g.accept"
        :upload-label="`上传${g.title}`"
        :hint="g.hint"
        :empty-text="`还没有${g.title}`"
        allow-edit
        :disabled="readonly"
        disabled-text="人物已归档，不能上传"
        :uploader="(f) => upload(g.kind, f)"
        @uploaded="$emit('changed')"
        @approve="approve"
        @reject="(a) => (rejecting = a)"
        @edit="openEdit"
        @remove="remove"
      />
    </div>

    <ReasonDialog :visible="!!rejecting" title="驳回素材" :loading="busy" @update:visible="(v: boolean) => !v && (rejecting = null)" @confirm="reject" />

    <a-modal :visible="!!editing" title="编辑素材" ok-text="保存" unmount-on-close :on-before-ok="saveEdit" @cancel="editing = null">
      <a-form :model="editForm" layout="vertical">
        <a-form-item label="名称"><a-input v-model="editForm.name" :max-length="60" /></a-form-item>
        <a-form-item label="背景名（≤20 字）"><a-input v-model="editForm.backgroundLabel" :max-length="20" /></a-form-item>
        <a-form-item label="标签（最多 10 个，供剪辑 / 混剪关键词匹配）">
          <a-input-tag v-model="editForm.tags" :max-tag-count="10" allow-clear placeholder="回车添加" aria-label="素材标签" />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { deleteAsset, patchAsset, reviewAsset, uploadAsset, type AssetKind, type PersonaAsset, type PersonaDetail, type PersonaOptions } from '@/api/personas'
import AssetGrid from './AssetGrid.vue'
import ReasonDialog from './ReasonDialog.vue'
import { checkUploadFile, toastError } from './shared'

const props = defineProps<{ persona: PersonaDetail; options: PersonaOptions | null }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const groups: Array<{ kind: AssetKind; title: string; accept: string; hint: string }> = [
  { kind: 'background_image', title: '背景图', accept: '.jpg,.jpeg,.png,.webp', hint: 'jpg / png / webp，≤10MB' },
  { kind: 'background_video', title: '背景视频', accept: '.mp4,.mov', hint: 'mp4 / mov，≤200MB，≤60 秒' },
  { kind: 'broll_video', title: '空镜视频', accept: '.mp4,.mov', hint: 'mp4 / mov，≤200MB，≤60 秒' },
]
const readonly = computed(() => props.persona.status === 'archived')
const itemsOf = (k: AssetKind): PersonaAsset[] => props.persona.assets.filter((a) => a.kind === k)
const countOf = (k: AssetKind): number => itemsOf(k).length
const limitOf = (k: AssetKind): number => props.options?.assetLimits?.[k] ?? 30

const rejecting = ref<PersonaAsset | null>(null)
const busy = ref(false)
const editing = ref<PersonaAsset | null>(null)
const editForm = reactive({ name: '', backgroundLabel: '', tags: [] as string[] })

async function upload(kind: AssetKind, file: File): Promise<string | void> {
  const bad = checkUploadFile(props.options, kind, file)
  if (bad) throw new Error(bad)
  const r = await uploadAsset(props.persona.id, { kind, name: file.name }, file)
  return r.deduplicated ? '已存在，未重复上传' : '已上传，处理中'
}
async function approve(a: PersonaAsset): Promise<void> {
  try { await reviewAsset(a.id, { decision: 'approved' }); Message.success('已通过'); emit('changed') } catch (e) { toastError(e) }
}
async function reject(reason: string): Promise<void> {
  if (!rejecting.value) return
  busy.value = true
  try { await reviewAsset(rejecting.value.id, { decision: 'rejected', reason }); rejecting.value = null; emit('changed') } catch (e) { toastError(e) } finally { busy.value = false }
}
async function remove(a: PersonaAsset): Promise<void> {
  try { await deleteAsset(a.id); emit('changed') } catch (e) { toastError(e) }
}
function openEdit(a: PersonaAsset): void {
  editing.value = a
  editForm.name = a.name
  editForm.backgroundLabel = a.backgroundLabel ?? ''
  editForm.tags = [...a.tags]
}
async function saveEdit(): Promise<boolean> {
  if (!editing.value) return true
  try {
    await patchAsset(editing.value.id, { name: editForm.name.trim() || undefined, backgroundLabel: editForm.backgroundLabel.trim(), tags: editForm.tags })
    Message.success('已保存')
    editing.value = null
    emit('changed')
    return true
  } catch (e) { toastError(e); return false }
}
</script>
