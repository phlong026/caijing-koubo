<template>
  <div>
    <div v-if="!supported" class="mw-card p-8 text-center" role="note">
      <icon-info-circle :size="22" />
      <div class="mt-2 font-medium">素人矩阵不使用数字人口播</div>
      <div class="mw-subtle mt-1">素人线不提供声音克隆；视频创作使用公共音色或素材库预置音色。</div>
    </div>

    <template v-else>
      <div class="flex items-center gap-2 mb-3">
        <a-button type="primary" :disabled="readonly" @click="wizard = true"
          ><template #icon><icon-plus /></template>克隆新声音</a-button
        >
        <span class="mw-subtle">声音共享须单独核验授权。每人最多 5 条有效声音。</span>
      </div>

      <a-empty v-if="!voices.length" description="还没有声音档案" />
      <div class="space-y-3">
        <div v-for="v in voices" :key="v.id" class="mw-card p-3">
          <div class="flex items-center gap-2 flex-wrap">
            <icon-sound :size="16" />
            <span class="font-medium">{{ v.name }}</span>
            <span class="mw-tag mw-tag-gray">{{ languageLabel(v.language) }}</span>
            <span v-if="v.status === 'ready' && !v.confirmed" class="mw-tag mw-tag-yellow">待确认</span>
            <span v-else class="mw-tag" :class="CLONE_STATUS[v.status].cls">{{ CLONE_STATUS[v.status].text }}</span>
            <span v-if="persona.defaultVoiceId === v.id" class="mw-tag mw-tag-deep">默认</span>
          </div>

          <div v-if="v.status === 'uncertain'" class="mt-1.5 text-[12.5px] text-[#b26a00]" role="alert">
            状态待核对，请先核对状态，勿重复创建。
          </div>
          <div v-else-if="v.status === 'failed'" class="mt-1.5 text-[12.5px] text-[#c0392b]">
            {{ v.error || '克隆失败' }}
          </div>
          <div
            v-else-if="['pending', 'submitting', 'running'].includes(v.status)"
            class="mt-1.5 flex items-center gap-2 text-[12.5px] text-[var(--mw-text2)]"
          >
            <a-spin :size="14" />飞影克隆中，页面会自动刷新
          </div>

          <div class="mt-2 flex items-center gap-1 flex-wrap">
            <template v-if="v.status === 'uncertain'">
              <a-button size="mini" type="primary" :loading="busyId === v.id" @click="reconcile(v)">核对状态</a-button>
            </template>
            <template v-else>
              <a-button v-if="v.status === 'ready' && v.demoKey" size="mini" @click="play(voiceDemoUrl(v.id), v.id)">
                <template #icon><icon-play-arrow-fill /></template>{{ playingId === v.id ? '停止' : '试听' }}
              </a-button>
              <a-button
                v-if="v.status === 'ready' && !v.confirmed"
                size="mini"
                type="primary"
                :loading="busyId === v.id"
                @click="confirm(v)"
                >试听后确认</a-button
              >
              <a-button v-if="v.status === 'running'" size="mini" :loading="busyId === v.id" @click="refresh(v)"
                >立即查询</a-button
              >
              <a-button
                v-if="v.status === 'ready' && v.confirmed && persona.defaultVoiceId !== v.id"
                size="mini"
                @click="setDefault(v)"
                >设为默认</a-button
              >
              <a-button v-if="v.status === 'ready'" size="mini" type="text" @click="toggleSettings(v)"
                >参数 / 试听文本</a-button
              >
              <a-button size="mini" type="text" @click="openRename(v)">重命名</a-button>
              <a-popconfirm
                v-if="!['pending', 'submitting', 'running'].includes(v.status)"
                content="删除后不再出现在列表中（飞影侧保留），确认？"
                @ok="remove(v)"
              >
                <a-button size="mini" type="text" status="danger">删除</a-button>
              </a-popconfirm>
            </template>
          </div>

          <div v-if="openId === v.id" class="mt-3 pt-3 border-t border-[#f2f4f7]">
            <div class="grid grid-cols-3 gap-4">
              <div v-for="s in SLIDERS" :key="s.key">
                <div class="text-[12.5px] mb-1">{{ s.label }}：{{ draft[s.key].toFixed(1) }}</div>
                <a-slider v-model="draft[s.key]" :min="s.min" :max="2" :step="0.1" :aria-label="s.label" />
              </div>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <a-button
                size="small"
                type="primary"
                :disabled="!settingsDirty(v)"
                :loading="savingSettings"
                @click="saveSettings(v)"
                >保存参数</a-button
              >
              <span class="mw-subtle">保存时先同步飞影，成功后才落库并生成新的人物版本。</span>
            </div>
            <div class="mt-3">
              <div class="text-[12.5px] mb-1">任意文本试听（≤100 字，会消耗飞影积分；同参数同文本 7 天内走缓存）</div>
              <div class="flex gap-2">
                <a-input
                  v-model="previewText"
                  :max-length="100"
                  show-word-limit
                  placeholder="输入一句话试听效果"
                  class="flex-1"
                  :input-attrs="{ 'aria-label': '试听文本' }"
                />
                <a-button :loading="previewing" :disabled="!previewText.trim()" @click="runPreview(v)"
                  >生成并试听</a-button
                >
              </div>
              <div v-if="previewMsg" class="mw-subtle mt-1" aria-live="polite">{{ previewMsg }}</div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <VoiceCloneWizard v-model:visible="wizard" :persona="persona" :options="options" @submitted="$emit('changed')" />
    <audio ref="audio" class="hidden" @ended="playingId = ''" @pause="playingId = ''" />

    <a-modal
      :visible="!!renaming"
      title="重命名声音"
      ok-text="保存"
      unmount-on-close
      :on-before-ok="saveRename"
      @cancel="renaming = null"
    >
      <a-input v-model="renameValue" :max-length="60" show-word-limit :input-attrs="{ 'aria-label': '声音名称' }" />
      <div class="mw-subtle mt-2">只修改本地显示名，不影响飞影侧标题。</div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import {
  confirmVoice,
  createVoicePreview,
  deleteVoice,
  getVoicePreview,
  patchVoice,
  reconcileVoice,
  refreshVoice,
  setDefaultVoice,
  updateVoiceSettings,
  voiceDemoUrl,
  voicePreviewUrl,
  type PersonaDetail,
  type PersonaOptions,
  type PersonaVoice,
} from '@/api/personas'
import VoiceCloneWizard from './VoiceCloneWizard.vue'
import { CLONE_STATUS, lineSupportsClone, toastError } from './shared'

const props = defineProps<{ persona: PersonaDetail; options: PersonaOptions | null }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const SLIDERS = [
  { key: 'speechRate', label: '语速', min: 0.5 },
  { key: 'volume', label: '音量', min: 0.1 },
  { key: 'pitch', label: '音调', min: 0.1 },
] as const

const supported = computed(() => lineSupportsClone(props.persona.line))
const readonly = computed(() => props.persona.status === 'archived')
const voices = computed(() => props.persona.voices)
const wizard = ref(false)
const busyId = ref('')
const openId = ref('')
const draft = reactive({ speechRate: 1, volume: 1, pitch: 1 })
const savingSettings = ref(false)
const previewText = ref('')
const previewing = ref(false)
const previewMsg = ref('')
const renaming = ref<PersonaVoice | null>(null)
const renameValue = ref('')
const audio = ref<HTMLAudioElement | null>(null)
const playingId = ref('')
let alive = true
onBeforeUnmount(() => {
  alive = false
  audio.value?.pause()
})

function languageLabel(code: string): string {
  if (!code || code === 'zh') return '普通话'
  return props.options?.voiceLanguages?.find((l) => l.code === code)?.label ?? code
}

function play(url: string, id: string): void {
  const el = audio.value
  if (!el) return
  if (playingId.value === id) {
    el.pause()
    return
  }
  el.src = url
  playingId.value = id
  void el.play().catch(() => {
    playingId.value = ''
    Message.warning('试听文件暂时无法播放')
  })
}

async function act(v: PersonaVoice, fn: () => Promise<unknown>, ok: string): Promise<void> {
  busyId.value = v.id
  try {
    await fn()
    if (ok) Message.success(ok)
    emit('changed')
  } catch (e) {
    toastError(e)
  } finally {
    busyId.value = ''
  }
}
const refresh = (v: PersonaVoice): Promise<void> => act(v, () => refreshVoice(v.id), '')
const confirm = (v: PersonaVoice): Promise<void> => act(v, () => confirmVoice(v.id), '已确认，可设为默认声音')
const setDefault = (v: PersonaVoice): Promise<void> => act(v, () => setDefaultVoice(v.id), '已设为默认声音')
const remove = (v: PersonaVoice): Promise<void> => act(v, () => deleteVoice(v.id), '已删除')
const reconcile = (v: PersonaVoice): Promise<void> =>
  act(
    v,
    async () => {
      const r = await reconcileVoice(v.id)
      Message.info(
        r.status === 'ready'
          ? '核对完成：飞影侧已有该声音'
          : r.status === 'failed'
            ? '核对完成：飞影侧没有该声音，可重新克隆'
            : '核对完成：任务仍在进行，请稍后再核对',
      )
    },
    '',
  )

function toggleSettings(v: PersonaVoice): void {
  if (openId.value === v.id) {
    openId.value = ''
    return
  }
  openId.value = v.id
  draft.speechRate = Number(v.speechRate)
  draft.volume = Number(v.volume)
  draft.pitch = Number(v.pitch)
  previewMsg.value = ''
}
function settingsDirty(v: PersonaVoice): boolean {
  return (['speechRate', 'volume', 'pitch'] as const).some((k) => Math.abs(Number(v[k]) - draft[k]) > 0.001)
}
async function saveSettings(v: PersonaVoice): Promise<void> {
  savingSettings.value = true
  try {
    const round = (n: number): number => Math.round(n * 10) / 10
    await updateVoiceSettings(v.id, {
      speechRate: round(draft.speechRate),
      volume: round(draft.volume),
      pitch: round(draft.pitch),
    })
    Message.success('参数已同步飞影并保存')
    emit('changed')
  } catch (e) {
    toastError(e)
  } finally {
    savingSettings.value = false
  }
}

async function runPreview(v: PersonaVoice): Promise<void> {
  previewing.value = true
  previewMsg.value = '生成中…'
  try {
    const r = await createVoicePreview(v.id, previewText.value.trim())
    let id = r.previewId
    // 轮询到就绪（飞影异步出音频，最长约 90 秒）
    for (let i = 0; i < 45 && alive; i++) {
      const p = await getVoicePreview(id)
      if (p.status === 'ready') {
        previewMsg.value = r.cached ? '命中缓存，未消耗积分' : '已生成'
        play(voicePreviewUrl(id), `${v.id}:preview`)
        return
      }
      if (p.status === 'failed') throw new Error(p.error || '试听生成失败')
      await new Promise((res) => setTimeout(res, 2000))
      if (i === 0) id = r.previewId
    }
    previewMsg.value = '仍在生成，请稍后重试（同一文本不会重复扣费）'
  } catch (e) {
    previewMsg.value = ''
    toastError(e)
  } finally {
    previewing.value = false
  }
}

function openRename(v: PersonaVoice): void {
  renaming.value = v
  renameValue.value = v.name
}
async function saveRename(): Promise<boolean> {
  if (!renaming.value || !renameValue.value.trim()) return false
  try {
    await patchVoice(renaming.value.id, renameValue.value.trim())
    renaming.value = null
    emit('changed')
    return true
  } catch (e) {
    toastError(e)
    return false
  }
}
</script>
