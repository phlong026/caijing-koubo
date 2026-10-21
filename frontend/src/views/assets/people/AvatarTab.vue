<template>
  <div>
    <div v-if="!supported" class="mw-card p-8 text-center" role="note">
      <icon-info-circle :size="22" />
      <div class="mt-2 font-medium">素人矩阵不使用数字人口播</div>
      <div class="mw-subtle mt-1">素人线只维护形象照片、背景与空镜，不提供分身制作。</div>
    </div>

    <template v-else>
      <div class="font-semibold mb-2">分身素材</div>
      <div class="flex items-center gap-2 mb-2">
        <a-input v-model="backgroundLabel" :max-length="20" placeholder="背景名（如：办公室 / 书房，≤20 字）" class="!w-[260px]" :input-attrs="{ 'aria-label': '背景名' }" />
        <span class="mw-subtle">飞影分身的背景由素材决定，登记背景名便于视频创作时挑选。</span>
      </div>
      <AssetGrid
        :items="sources"
        accept=".mp4,.mov"
        upload-label="点击或拖拽上传分身素材视频"
        hint="mp4 / mov，≤200MB，10 秒–10 分钟，短边 ≥720px，建议 9:16 竖屏；每人最多 10 个"
        empty-text="还没有分身素材"
        :disabled="readonly"
        disabled-text="人物已归档，不能上传"
        :uploader="upload"
        @uploaded="$emit('changed')"
        @preview="(a) => (playing = a)"
        @approve="approve"
        @reject="(a) => (rejecting = a)"
        @remove="removeAsset"
      >
        <template #extra="{ asset }">
          <a-button v-if="asset.status === 'approved' && !readonly" class="mt-1.5" size="mini" type="primary" long @click="openClone(asset)">制作分身</a-button>
        </template>
      </AssetGrid>

      <a-divider />
      <div class="font-semibold mb-2">飞影分身</div>
      <a-empty v-if="!avatars.length" description="还没有分身。审核通过分身素材后，点击「制作分身」" />
      <div class="space-y-3">
        <div v-for="a in avatars" :key="a.id" class="mw-card p-3 flex gap-3">
          <div class="w-[96px] h-[72px] rounded overflow-hidden bg-[#f1f3f1] shrink-0">
            <img v-if="coverOf(a)" :src="coverOf(a)!" :alt="a.name" class="w-full h-full object-cover" loading="lazy" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-medium truncate">{{ a.name }}</span>
              <span class="mw-tag" :class="CLONE_STATUS[a.status].cls">{{ CLONE_STATUS[a.status].text }}</span>
              <span v-if="persona.defaultAvatarId === a.id" class="mw-tag mw-tag-deep">默认</span>
            </div>
            <div class="mw-subtle mt-0.5">
              <template v-if="a.backgroundLabel">背景：{{ a.backgroundLabel }} · </template>创建于 {{ fmtDateTime(a.createdAt) }}
            </div>

            <div v-if="a.status === 'uncertain'" class="mt-1.5 text-[12.5px] text-[#b26a00]" role="alert">
              状态待核对，请先核对状态，勿重复创建。
            </div>
            <div v-else-if="a.status === 'failed'" class="mt-1.5 text-[12.5px] text-[#c0392b]">
              {{ a.error || '制作失败' }}
              <a-link v-if="a.error" @click="failure = a">详情</a-link>
            </div>
            <div v-else-if="a.status === 'running' || a.status === 'pending' || a.status === 'submitting'" class="mt-1.5 flex items-center gap-2 text-[12.5px] text-[var(--mw-text2)]">
              <a-spin :size="14" />飞影制作中，通常需要数分钟，页面会自动刷新
            </div>

            <div class="mt-2 flex items-center gap-1 flex-wrap">
              <template v-if="a.status === 'uncertain'">
                <a-button size="mini" type="primary" :loading="busyId === a.id" @click="reconcile(a)">核对状态</a-button>
              </template>
              <template v-else>
                <a-button v-if="a.status === 'running'" size="mini" :loading="busyId === a.id" @click="refresh(a)">立即查询</a-button>
                <a-button v-if="a.status === 'ready' && persona.defaultAvatarId !== a.id" size="mini" @click="setDefault(a)">设为默认</a-button>
                <a-button size="mini" type="text" @click="openRename(a)">重命名</a-button>
                <a-popconfirm v-if="!['pending', 'submitting', 'running'].includes(a.status)" content="删除后不再出现在列表中（飞影侧保留），确认？" @ok="remove(a)">
                  <a-button size="mini" type="text" status="danger">删除</a-button>
                </a-popconfirm>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>

    <AvatarCloneDialog v-model:visible="cloneVisible" :persona="persona" :source="cloneSource" :options="options" @submitted="$emit('changed')" />
    <ReasonDialog :visible="!!rejecting" title="驳回分身素材" :loading="busy" @update:visible="(v: boolean) => !v && (rejecting = null)" @confirm="reject" />

    <a-modal :visible="!!playing" :title="playing?.name" :footer="false" :width="480" unmount-on-close @cancel="playing = null">
      <video v-if="playing" :src="assetFileUrl(playing.id, playing.compatKey ? 'compat' : 'original')" controls class="w-full max-h-[70vh] bg-black" />
    </a-modal>

    <a-modal :visible="!!renaming" title="重命名分身" ok-text="保存" unmount-on-close :on-before-ok="saveRename" @cancel="renaming = null">
      <a-input v-model="renameValue" :max-length="60" show-word-limit :input-attrs="{ 'aria-label': '分身名称' }" />
      <div class="mw-subtle mt-2">只修改本地显示名，不影响飞影侧标题。</div>
    </a-modal>

    <a-modal :visible="!!failure" title="制作失败原因" :footer="false" unmount-on-close @cancel="failure = null">
      <div class="text-[13.5px] leading-6">{{ failure?.error }}</div>
      <div class="mw-subtle mt-2">可删除该记录后，修正素材或授权，再重新制作。</div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import {
  assetFileUrl, deleteAsset, deleteAvatar, patchAvatar, reconcileAvatar, refreshAvatar, reviewAsset, setDefaultAvatar, uploadAsset,
  type PersonaAsset, type PersonaAvatar, type PersonaDetail, type PersonaOptions,
} from '@/api/personas'
import AssetGrid from './AssetGrid.vue'
import AvatarCloneDialog from './AvatarCloneDialog.vue'
import ReasonDialog from './ReasonDialog.vue'
import { CLONE_STATUS, checkUploadFile, fmtDateTime, lineSupportsClone, toastError } from './shared'

const props = defineProps<{ persona: PersonaDetail; options: PersonaOptions | null }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const supported = computed(() => lineSupportsClone(props.persona.line))
const readonly = computed(() => props.persona.status === 'archived')
const sources = computed(() => props.persona.assets.filter((a) => a.kind === 'avatar_source'))
const avatars = computed(() => props.persona.avatars)

const backgroundLabel = ref('')
const cloneVisible = ref(false)
const cloneSource = ref<PersonaAsset | null>(null)
const rejecting = ref<PersonaAsset | null>(null)
const playing = ref<PersonaAsset | null>(null)
const renaming = ref<PersonaAvatar | null>(null)
const renameValue = ref('')
const failure = ref<PersonaAvatar | null>(null)
const busy = ref(false)
const busyId = ref('')

function coverOf(a: PersonaAvatar): string | null {
  const src = props.persona.assets.find((x) => x.id === a.sourceAssetId)
  return src?.thumbKey ? assetFileUrl(src.id, 'thumb') : null
}

async function upload(file: File): Promise<string | void> {
  const bad = checkUploadFile(props.options, 'avatar_source', file)
  if (bad) throw new Error(bad)
  const r = await uploadAsset(props.persona.id, { kind: 'avatar_source', name: file.name, backgroundLabel: backgroundLabel.value.trim() || undefined }, file)
  return r.deduplicated ? '已存在，未重复上传' : '已上传，正在转码与质检'
}

async function approve(a: PersonaAsset): Promise<void> {
  try { await reviewAsset(a.id, { decision: 'approved' }); Message.success('已通过'); emit('changed') } catch (e) { toastError(e) }
}
async function reject(reason: string): Promise<void> {
  if (!rejecting.value) return
  busy.value = true
  try { await reviewAsset(rejecting.value.id, { decision: 'rejected', reason }); rejecting.value = null; emit('changed') } catch (e) { toastError(e) } finally { busy.value = false }
}
async function removeAsset(a: PersonaAsset): Promise<void> {
  try { await deleteAsset(a.id); emit('changed') } catch (e) { toastError(e) }
}
function openClone(a: PersonaAsset): void {
  cloneSource.value = a
  cloneVisible.value = true
}

async function act(a: PersonaAvatar, fn: () => Promise<unknown>, ok: string): Promise<void> {
  busyId.value = a.id
  try {
    await fn()
    if (ok) Message.success(ok)
    emit('changed')
  } catch (e) { toastError(e) } finally { busyId.value = '' }
}
const refresh = (a: PersonaAvatar): Promise<void> => act(a, () => refreshAvatar(a.id), '')
const reconcile = (a: PersonaAvatar): Promise<void> => act(a, async () => {
  const r = await reconcileAvatar(a.id)
  Message.info(r.status === 'ready' ? '核对完成：飞影侧已有该分身，已可用' : r.status === 'failed' ? '核对完成：飞影侧没有该分身，可重新制作' : '核对完成：任务仍在进行，请稍后再核对')
}, '')
const setDefault = (a: PersonaAvatar): Promise<void> => act(a, () => setDefaultAvatar(a.id), '已设为默认分身')
const remove = (a: PersonaAvatar): Promise<void> => act(a, () => deleteAvatar(a.id), '已删除')

function openRename(a: PersonaAvatar): void {
  renaming.value = a
  renameValue.value = a.name
}
async function saveRename(): Promise<boolean> {
  if (!renaming.value || !renameValue.value.trim()) return false
  try {
    await patchAvatar(renaming.value.id, renameValue.value.trim())
    renaming.value = null
    emit('changed')
    return true
  } catch (e) { toastError(e); return false }
}
</script>
