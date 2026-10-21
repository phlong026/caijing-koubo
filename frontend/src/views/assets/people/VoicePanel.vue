<template>
  <div class="flex flex-col gap-3">
    <div v-if="!readonly" class="upload-box">
      <strong>声音样本</strong>
      <div class="flex items-center gap-3">
        <input ref="fileInput" type="file" accept=".wav,.mp3,.m4a" class="sr-only" aria-label="选择声音样本" @change="onFile" />
        <a-button size="small" @click="fileInput?.click()"><icon-upload />选择样本</a-button>
        <span class="mw-subtle truncate">{{ file ? `${file.name}（${fmtSize(file.size)}）` : 'WAV / MP3 / M4A，5 秒–3 分钟，清晰无背景音' }}</span>
        <div class="flex-1" />
        <a-button type="primary" size="small" :loading="uploading" :disabled="!file" @click="uploadSample">上传样本</a-button>
      </div>
      <ul v-if="detail.voiceSamples.length" class="sample-list">
        <li v-for="s in detail.voiceSamples" :key="s.id">{{ s.name }} · {{ fmtDuration(s.sampleDurationMs) }} · {{ fmtTime(s.createdAt) }}</li>
      </ul>
    </div>

    <div v-if="!readonly && detail.voiceSamples.length" class="upload-box">
      <strong>克隆声音</strong>
      <p v-if="!voiceAuths.length" class="mw-subtle">需要一份已核验、未过期且包含「声音」范围的授权材料。</p>
      <template v-else>
        <div class="grid-2">
          <a-select v-model="form.sampleId" placeholder="选择声音样本">
            <a-option v-for="s in detail.voiceSamples" :key="s.id" :value="s.id" :label="`${s.name}（${fmtDuration(s.sampleDurationMs)}）`" />
          </a-select>
          <a-select v-model="form.authorizationId" placeholder="选择授权材料（含声音）">
            <a-option v-for="a in voiceAuths" :key="a.id" :value="a.id" :label="`${a.grantorName}（至 ${fmtDate(a.expiresAt)}）`" />
          </a-select>
          <a-input v-model="form.name" :max-length="60" placeholder="声音名称（可选）" />
          <a-select v-model="form.language">
            <a-option v-for="l in options.voiceLanguages" :key="l.code" :value="l.code" :label="l.label" />
          </a-select>
        </div>
        <div class="consent">
          <strong>{{ consent.title }}</strong>
          <p>{{ consent.body }}</p>
          <a-checkbox v-model="form.agreed">本人已阅读并确认以上内容（确认文本 {{ options.consentTextVersion }}）</a-checkbox>
        </div>
        <p v-if="detail.bindingMode === 'shared'" class="mw-subtle">共享人物的声音要设为默认，授权范围还须包含「允许共享」。</p>
        <div class="flex justify-end">
          <a-button type="primary" size="small" :loading="submitting" :disabled="!form.sampleId || !form.authorizationId || !form.agreed" @click="submit">提交克隆</a-button>
        </div>
      </template>
    </div>

    <div v-for="v in detail.voices" :key="v.id" class="voice-card">
      <div class="flex items-center gap-2 flex-wrap">
        <strong>{{ v.name }}</strong>
        <span class="mw-tag" :class="toneClass(CLONE_STATUS[v.status]?.tone ?? 'gray')">{{ CLONE_STATUS[v.status]?.label ?? v.status }}</span>
        <span v-if="v.status === 'ready'" class="mw-tag" :class="v.confirmed ? 'mw-tag-green' : 'mw-tag-yellow'">{{ v.confirmed ? '已确认' : '待试听确认' }}</span>
        <span v-if="detail.defaultVoiceId === v.id" class="mw-tag mw-tag-deep">默认</span>
        <span class="mw-subtle">{{ languageLabel(v.language) }}</span>
      </div>
      <div v-if="v.error" class="voice-error">{{ v.error }}</div>
      <audio v-if="v.demoKey" :src="voiceDemoUrl(v.id)" controls preload="none" class="w-full mt-1" />

      <template v-if="v.status === 'ready' && !readonly">
        <div class="settings">
          <label>语速 <a-input-number v-model="settings[v.id]!.speechRate" :min="0.5" :max="2" :step="0.1" :precision="1" size="mini" /></label>
          <label>音量 <a-input-number v-model="settings[v.id]!.volume" :min="0.5" :max="2" :step="0.1" :precision="1" size="mini" /></label>
          <label>音调 <a-input-number v-model="settings[v.id]!.pitch" :min="0.5" :max="2" :step="0.1" :precision="1" size="mini" /></label>
          <a-button size="mini" :disabled="!settingsChanged(v)" @click="saveSettings(v.id)">保存参数</a-button>
        </div>
        <div class="flex gap-2 items-center">
          <a-input v-model="previewText[v.id]" :max-length="100" placeholder="输入任意文本试听（≤100 字）" size="small" />
          <a-button size="small" :loading="previewing[v.id]" :disabled="!previewText[v.id]?.trim()" @click="preview(v.id)">试听</a-button>
        </div>
        <audio v-if="previewUrl[v.id]" :src="previewUrl[v.id]" controls autoplay class="w-full" />
      </template>

      <div v-if="!readonly" class="flex gap-1 flex-wrap mt-1">
        <a-button v-if="v.status === 'running'" size="mini" @click="act(v.id, 'refresh')">立即查询</a-button>
        <a-button v-if="v.status === 'uncertain'" size="mini" type="primary" @click="act(v.id, 'reconcile')">核对状态</a-button>
        <a-button v-if="v.status === 'ready' && !v.confirmed" size="mini" type="primary" @click="act(v.id, 'confirm')">试听无误，确认可用</a-button>
        <a-button v-if="v.status === 'ready' && v.confirmed && detail.defaultVoiceId !== v.id" size="mini" @click="act(v.id, 'default')">设为默认</a-button>
        <a-popconfirm v-if="!['pending', 'submitting', 'running', 'uncertain'].includes(v.status)" content="确认删除该声音？" @ok="act(v.id, 'delete')">
          <a-button size="mini">删除</a-button>
        </a-popconfirm>
      </div>
    </div>
    <p v-if="!detail.voices.length" class="mw-subtle text-center py-4">暂无克隆声音</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import {
  confirmVoice,
  createConsent,
  createVoice,
  createVoicePreview,
  deleteVoice,
  getVoicePreview,
  reconcileVoice,
  refreshVoice,
  setDefaultVoice,
  updateVoiceSettings,
  uploadVoiceSample,
  voiceDemoUrl,
  voicePreviewFileUrl,
  type PersonaDetail,
  type PersonaOptions,
  type PersonaVoice,
} from '@/api/personas'
import { CLONE_STATUS, fmtDate, fmtDuration, fmtSize, fmtTime, newIdempotencyKey, toneClass } from './labels'

const props = defineProps<{ detail: PersonaDetail; options: PersonaOptions; readonly: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const consent = computed(() => props.options.consentTexts.VOICE_CLONE)
const voiceAuths = computed(() => props.detail.authorizations.filter((a) => a.status === 'verified' && a.scopes.includes('voice')))
const fileInput = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const uploading = ref(false)
const submitting = ref(false)
const form = reactive({ sampleId: '', authorizationId: '', name: '', language: 'zh', agreed: false })

const settings = reactive<Record<string, { speechRate: number; volume: number; pitch: number }>>({})
const previewText = reactive<Record<string, string>>({})
const previewing = reactive<Record<string, boolean>>({})
const previewUrl = reactive<Record<string, string>>({})
const timers: number[] = []

watch(
  () => props.detail.voices,
  (voices) => {
    for (const v of voices) {
      // 只在首次出现或未修改时同步，避免轮询刷新覆盖正在调整的参数
      if (!settings[v.id] || !settingsChanged(v)) settings[v.id] = { speechRate: v.speechRate, volume: v.volume, pitch: v.pitch }
    }
  },
  { immediate: true },
)

function settingsChanged(v: PersonaVoice): boolean {
  const s = settings[v.id]
  return !!s && (s.speechRate !== v.speechRate || s.volume !== v.volume || s.pitch !== v.pitch)
}

function languageLabel(code: string): string {
  return props.options.voiceLanguages.find((l) => l.code === code)?.label ?? code
}

function onFile(e: Event): void {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null
}

async function uploadSample(): Promise<void> {
  if (!file.value) return
  uploading.value = true
  try {
    const r = await uploadVoiceSample(props.detail.id, file.value)
    Message.success(`样本已上传（${fmtDuration(r.durationMs)}）`)
    file.value = null
    if (fileInput.value) fileInput.value.value = ''
    form.sampleId = r.sampleId
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    uploading.value = false
  }
}

// 与分身相同：同一次提交（含失败重试）复用幂等键与授权确认，保证参数哈希不变
let idemKey = newIdempotencyKey('voice')
let idemFor = ''
let consentCache: { key: string; id: string } | null = null

async function submit(): Promise<void> {
  submitting.value = true
  try {
    const key = `${form.sampleId}|${form.authorizationId}`
    const signature = `${key}|${form.name.trim()}|${form.language}`
    if (signature !== idemFor) {
      idemKey = newIdempotencyKey('voice')
      idemFor = signature
    }
    if (consentCache?.key !== key) {
      const c = await createConsent(props.detail.id, {
        authorizationId: form.authorizationId,
        purpose: 'VOICE_CLONE',
        sourceKind: 'voice_sample',
        sourceId: form.sampleId,
        consentTextVersion: props.options.consentTextVersion,
      })
      consentCache = { key, id: c.consentId }
    }
    await createVoice(
      props.detail.id,
      { name: form.name.trim() || undefined, sampleId: form.sampleId, consentId: consentCache.id, language: form.language },
      idemKey,
    )
    Message.success('已提交克隆，完成后请试听并确认')
    Object.assign(form, { sampleId: '', authorizationId: '', name: '', language: 'zh', agreed: false })
    idemFor = ''
    consentCache = null
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    submitting.value = false
  }
}

async function saveSettings(id: string): Promise<void> {
  try {
    await updateVoiceSettings(id, settings[id]!)
    Message.success('参数已更新')
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function preview(id: string): Promise<void> {
  previewing[id] = true
  delete previewUrl[id]
  try {
    const r = await createVoicePreview(id, previewText[id]!.trim())
    const started = Date.now()
    const tick = async (): Promise<void> => {
      try {
        const p = await getVoicePreview(r.previewId)
        if (p.status === 'ready') {
          previewUrl[id] = voicePreviewFileUrl(r.previewId)
          previewing[id] = false
          return
        }
        if (p.status === 'failed') throw new Error(p.error || '试听生成失败')
        if (Date.now() - started > 5 * 60_000) throw new Error('试听生成超时，请稍后重试')
        timers.push(window.setTimeout(() => void tick(), 3000))
      } catch (e) {
        Message.error((e as Error).message)
        previewing[id] = false
      }
    }
    await tick()
  } catch (e) {
    Message.error((e as Error).message)
    previewing[id] = false
  }
}

async function act(id: string, action: 'refresh' | 'reconcile' | 'confirm' | 'default' | 'delete'): Promise<void> {
  try {
    if (action === 'refresh') await refreshVoice(id)
    if (action === 'reconcile') await reconcileVoice(id)
    if (action === 'confirm') await confirmVoice(id)
    if (action === 'default') await setDefaultVoice(id)
    if (action === 'delete') await deleteVoice(id)
    Message.success({ refresh: '已查询最新状态', reconcile: '核对完成', confirm: '已确认可用', default: '已设为默认声音', delete: '已删除' }[action])
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

onBeforeUnmount(() => timers.forEach((t) => window.clearTimeout(t)))
</script>

<style scoped>
.upload-box,
.voice-card {
  border: 1px solid var(--mw-border-light);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.consent {
  background: #f6f8f6;
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
  line-height: 1.7;
}
.consent p {
  margin: 4px 0 8px;
  color: var(--mw-text2);
}
.sample-list {
  margin: 0;
  padding-left: 18px;
  color: var(--mw-text2);
  font-size: 12px;
}
.settings {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  font-size: 12px;
}
.settings label {
  display: flex;
  gap: 4px;
  align-items: center;
  white-space: nowrap;
}
.settings :deep(.arco-input-number) {
  width: 92px;
}
.voice-error {
  color: #b45427;
  font-size: 12px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
