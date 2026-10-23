<template>
  <div v-if="!lineAllowsClone" class="mw-subtle text-center py-8">素人矩阵不使用数字人口播，不做声音克隆</div>
  <div v-else class="flex flex-col gap-2.5">
    <div class="flex items-center gap-2">
      <span class="text-[13px] font-medium">声音档案</span>
      <span class="mw-subtle">{{ persona.voices.length }} / 5</span>
      <div class="flex-1"></div>
      <a-button v-if="!readonly" size="mini" type="primary" @click="openWizard"><template #icon><icon-plus /></template>克隆新声音</a-button>
    </div>

    <div v-if="!persona.voices.length" class="mw-subtle text-center py-5 border border-dashed border-[var(--mw-border)] rounded-[10px]">
      暂无声音，上传 30–60 秒清晰人声样本即可克隆
    </div>

    <div v-for="v in persona.voices" :key="v.id" class="p-2.5 rounded-[10px] border border-[var(--mw-border)]">
      <div class="flex items-center gap-2.5">
        <icon-sound :size="18" class="text-[color:var(--mw-primary)] shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-[13px] font-medium truncate">{{ v.name }}</span>
            <span v-if="persona.defaultVoiceId === v.id" class="mw-tag mw-tag-deep">默认</span>
          </div>
          <div class="mw-subtle">{{ languageLabel(v.language) }} · 语速 {{ v.speechRate }} · 音量 {{ v.volume }} · 音调 {{ v.pitch }}</div>
        </div>
        <span class="mw-tag" :class="voiceTag(v).cls">{{ voiceTag(v).text }}</span>
      </div>
      <audio v-if="v.demoKey" :src="voiceDemoUrl(v.id)" controls preload="none" class="w-full h-8 mt-2" />
      <div v-if="v.status === 'uncertain'" class="mt-1.5 text-[12px] text-[#c2410c]">状态待核对，请先核对状态，勿重复创建</div>
      <div v-else-if="v.status === 'failed' && v.error" class="mt-1.5 text-[12px] text-[#c2410c]">{{ v.error }}</div>
      <div v-if="!readonly" class="mt-2 flex gap-1.5 flex-wrap">
        <a-button v-if="v.status === 'ready' && !v.confirmed" size="mini" type="primary" @click="run(() => confirmVoice(v.id), '已确认声音')">试听无误，确认</a-button>
        <a-button v-if="v.status === 'ready' && v.confirmed && persona.defaultVoiceId !== v.id" size="mini" @click="run(() => setDefaultVoice(v.id), '已设为默认声音')">设为默认</a-button>
        <a-button v-if="v.status === 'ready'" size="mini" @click="openSettings(v)">参数</a-button>
        <a-button v-if="v.status === 'ready'" size="mini" @click="openPreview(v)">文本试听</a-button>
        <a-button v-if="v.status === 'running'" size="mini" @click="run(() => refreshVoice(v.id), '已刷新状态')">立即查询</a-button>
        <a-button v-if="v.status === 'uncertain'" size="mini" type="primary" @click="run(() => reconcileVoice(v.id), '已核对')">核对状态</a-button>
        <a-button size="mini" @click="rename(v)">重命名</a-button>
        <a-button v-if="!busyStatuses.includes(v.status)" size="mini" @click="remove(v)">删除</a-button>
      </div>
    </div>
    <div class="mw-subtle">声音共享须单独核验授权。<template v-if="persona.bindingMode === 'shared'">该人物为共享绑定，设为默认的声音需要授权范围含「允许共享」。</template></div>

    <!-- 克隆向导 -->
    <a-modal v-model:visible="wizard.visible" title="克隆新声音" :footer="false" :mask-closable="false" width="520px">
      <a-steps :current="wizard.step" size="small" class="mb-4">
        <a-step title="上传样本" />
        <a-step title="授权确认" />
        <a-step title="命名提交" />
      </a-steps>

      <div v-if="wizard.step === 1">
        <a-upload accept=".wav,.mp3,.m4a" :show-file-list="false" :custom-request="uploadSample" draggable>
          <template #upload-button>
            <div class="py-6 text-center border border-dashed border-[var(--mw-border)] rounded-[10px] cursor-pointer">
              <a-spin v-if="wizard.uploading" />
              <template v-else>
                <div class="text-[13px]">点击或拖拽上传声音样本</div>
                <div class="mw-subtle mt-1">wav / mp3 / m4a，≤20MB，时长 5–180 秒，建议 30–60 秒清晰人声</div>
              </template>
            </div>
          </template>
        </a-upload>
        <div v-if="wizard.sampleId" class="mt-2 text-[13px]">已上传样本，时长 {{ formatDuration(wizard.sampleDurationMs) }}</div>
        <div class="mt-4 flex justify-end">
          <a-button type="primary" :disabled="!wizard.sampleId" @click="wizard.step = 2">下一步</a-button>
        </div>
      </div>

      <div v-else-if="wizard.step === 2">
        <div v-if="!voiceAuths.length" class="text-[13px] text-[#c2410c]">
          该人物没有已核验、未过期且范围含「声音」的授权，请先在授权材料中上传并核验。
        </div>
        <template v-else>
          <div class="mw-form-row">
            <div class="mw-form-label">授权材料</div>
            <a-select v-model="wizard.authorizationId" class="flex-1">
              <a-option v-for="a in voiceAuths" :key="a.id" :value="a.id">{{ a.grantorName }} · {{ scopeText(a.scopes) }} · 至 {{ dateOnly(a.expiresAt) }}</a-option>
            </a-select>
          </div>
          <div class="mt-2 p-3 rounded-[8px] bg-[#f6f7f5] text-[12.5px] leading-relaxed text-[var(--mw-text2)]">{{ consentText.body }}</div>
          <a-checkbox v-model="wizard.agreed" class="mt-2">我已阅读并确认以上授权内容</a-checkbox>
        </template>
        <div class="mt-4 flex justify-between">
          <a-button @click="wizard.step = 1">上一步</a-button>
          <a-button type="primary" :disabled="!wizard.authorizationId || !wizard.agreed" @click="wizard.step = 3">下一步</a-button>
        </div>
      </div>

      <div v-else>
        <div class="mw-form-row">
          <div class="mw-form-label">声音名称</div>
          <a-input v-model="wizard.name" :max-length="60" show-word-limit />
        </div>
        <div class="mw-form-row">
          <div class="mw-form-label">语种</div>
          <a-select v-model="wizard.language" class="flex-1">
            <a-option v-for="l in languages" :key="l.code" :value="l.code">{{ l.label }}</a-option>
          </a-select>
        </div>
        <div class="mw-subtle mt-2">提交后由飞影克隆，会消耗飞影积分；完成后需人工试听确认才能设为默认。</div>
        <div class="mt-4 flex justify-between">
          <a-button @click="wizard.step = 2">上一步</a-button>
          <a-button type="primary" :loading="wizard.submitting" @click="submitClone">提交克隆</a-button>
        </div>
      </div>
    </a-modal>

    <!-- 参数 -->
    <a-modal v-model:visible="settings.visible" title="声音参数" :ok-loading="settings.saving" @before-ok="saveSettings">
      <div v-for="f in settingFields" :key="f.key" class="mw-form-row">
        <div class="mw-form-label">{{ f.label }}</div>
        <a-slider v-model="settings.values[f.key]" :min="f.min" :max="2" :step="0.1" class="flex-1" />
        <span class="w-8 text-right text-[13px]">{{ settings.values[f.key] }}</span>
      </div>
      <div class="mw-subtle mt-2">保存时先同步到飞影，飞影成功后才落库并生成新的人物版本。</div>
    </a-modal>

    <!-- 任意文本试听 -->
    <a-modal v-model:visible="preview.visible" title="文本试听" :footer="false" width="480px">
      <a-textarea v-model="preview.text" :max-length="100" show-word-limit :auto-size="{ minRows: 3, maxRows: 5 }" placeholder="输入不超过 100 字的试听文本" />
      <div class="mt-3 flex items-center gap-2">
        <a-button type="primary" :loading="preview.running" :disabled="!preview.text.trim()" @click="startPreview">生成试听</a-button>
        <span class="mw-subtle">同一声音、参数和文本 7 天内直接复用，不重复消耗积分</span>
      </div>
      <div v-if="preview.error" class="mt-2 text-[12px] text-[#c2410c]">{{ preview.error }}</div>
      <audio v-if="preview.audioUrl" :src="preview.audioUrl" controls autoplay class="w-full mt-3" />
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive } from 'vue'
import { Message } from '@arco-design/web-vue'
import { ApiError } from '@/api/client'
import type { RequestOption } from '@arco-design/web-vue'
import {
  confirmVoice,
  createConsent,
  createVoice,
  createVoicePreview,
  deleteVoice,
  getVoicePreview,
  patchVoice,
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
import { cloneStatusTag, dateOnly, formatDuration, newIdempotencyKey, scopeText, usableAuthorizations, type TagView } from './labels'
import { confirmAction, promptText } from './prompt'

const props = defineProps<{ persona: PersonaDetail; options: PersonaOptions | null; readonly: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const PREVIEW_POLL_MS = 3000
const busyStatuses = ['pending', 'submitting', 'running', 'uncertain']
const lineAllowsClone = computed(() => props.persona.line !== 'persona')
const voiceAuths = computed(() => usableAuthorizations(props.persona.authorizations, 'voice'))
const languages = computed(() => props.options?.voiceLanguages ?? [{ code: 'zh', label: '普通话' }])
const consentText = computed(() => props.options?.consentTexts.VOICE_CLONE ?? { title: '声音克隆授权确认', body: '' })

function languageLabel(code: string): string {
  return languages.value.find((l) => l.code === code)?.label ?? code
}

function voiceTag(v: PersonaVoice): TagView {
  if (v.status === 'ready' && !v.confirmed) return { text: '待确认', cls: 'mw-tag-yellow' }
  return cloneStatusTag(v.status, 'voice')
}

async function run(action: () => Promise<unknown>, okText: string) {
  try {
    await action()
    Message.success(okText)
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

/* ── 克隆向导 ─────────────────────────────────────────────── */

const wizard = reactive({
  visible: false,
  step: 1,
  uploading: false,
  submitting: false,
  sampleId: '',
  sampleDurationMs: 0,
  authorizationId: '',
  agreed: false,
  name: '',
  language: 'zh',
  /** 幂等键绑定到「这一份样本」：换样本才换键，重试同一份样本始终复用 */
  idempotencyKey: '',
  /** 已生成的 consent 及其对应的（样本, 授权）；两者都没变时重试复用，保证请求 hash 不变 */
  consentId: '',
  consentFor: '',
})

function openWizard() {
  Object.assign(wizard, {
    visible: true,
    step: 1,
    uploading: false,
    submitting: false,
    sampleId: '',
    sampleDurationMs: 0,
    authorizationId: voiceAuths.value[0]?.id ?? '',
    agreed: false,
    name: `${props.persona.name} · 声音`.slice(0, 60),
    language: 'zh',
    idempotencyKey: newIdempotencyKey('voice'),
    consentId: '',
    consentFor: '',
  })
}

function uploadSample(option: RequestOption) {
  const file = option.fileItem.file
  if (!file) return {}
  wizard.uploading = true
  uploadVoiceSample(props.persona.id, file)
    .then((r) => {
      // 换了样本就是新的克隆请求：重新生成幂等键，旧 consent 作废
      if (r.sampleId !== wizard.sampleId) {
        wizard.idempotencyKey = newIdempotencyKey('voice')
        wizard.consentId = ''
        wizard.consentFor = ''
      }
      wizard.sampleId = r.sampleId
      wizard.sampleDurationMs = r.durationMs
      option.onSuccess(r)
    })
    .catch((e: Error) => {
      Message.error(`样本上传失败：${e.message}`)
      option.onError(e)
    })
    .finally(() => {
      wizard.uploading = false
    })
  return {}
}

async function submitClone() {
  wizard.submitting = true
  try {
    const consentFor = `${wizard.sampleId}|${wizard.authorizationId}`
    if (!wizard.consentId || wizard.consentFor !== consentFor) {
      const consent = await createConsent(props.persona.id, {
        authorizationId: wizard.authorizationId,
        purpose: 'VOICE_CLONE',
        sourceKind: 'voice_sample',
        sourceId: wizard.sampleId,
        consentTextVersion: props.options?.consentTextVersion ?? 'v1',
      })
      wizard.consentId = consent.consentId
      wizard.consentFor = consentFor
    }
    const r = await createVoice(
      props.persona.id,
      { name: wizard.name.trim() || undefined, sampleId: wizard.sampleId, consentId: wizard.consentId, language: wizard.language },
      wizard.idempotencyKey,
    )
    Message.success(r.replayed ? '该请求已提交过，未重复克隆' : '已提交克隆，完成后会自动更新状态')
    wizard.visible = false
    emit('changed')
  } catch (e) {
    // 幂等键冲突说明这份样本可能已经提交过：不换键重试，避免重复扣积分
    if (e instanceof ApiError && e.code === 'IDEMPOTENCY_CONFLICT') {
      Message.error('这份样本可能已提交过克隆（修改过名称或语种）。请关闭向导，在列表中确认后再操作，避免重复扣积分。')
      emit('changed')
    } else {
      Message.error((e as Error).message)
    }
  } finally {
    wizard.submitting = false
  }
}

/* ── 参数 ─────────────────────────────────────────────────── */

type SettingKey = 'speechRate' | 'volume' | 'pitch'
const settingFields: Array<{ key: SettingKey; label: string; min: number }> = [
  { key: 'speechRate', label: '语速', min: 0.5 },
  { key: 'volume', label: '音量', min: 0.1 },
  { key: 'pitch', label: '音调', min: 0.1 },
]
const settings = reactive({
  visible: false,
  saving: false,
  voiceId: '',
  values: { speechRate: 1, volume: 1, pitch: 1 } as Record<SettingKey, number>,
})

function openSettings(v: PersonaVoice) {
  Object.assign(settings, {
    visible: true,
    saving: false,
    voiceId: v.id,
    values: { speechRate: v.speechRate, volume: v.volume, pitch: v.pitch },
  })
}

async function saveSettings(done: (closed: boolean) => void) {
  settings.saving = true
  try {
    // 滑杆步进 0.1 仍可能出现浮点尾差，按一位小数提交（R17）
    const round = (n: number) => Math.round(n * 10) / 10
    await updateVoiceSettings(settings.voiceId, {
      speechRate: round(settings.values.speechRate),
      volume: round(settings.values.volume),
      pitch: round(settings.values.pitch),
    })
    Message.success('参数已同步到飞影')
    emit('changed')
    done(true)
  } catch (e) {
    Message.error((e as Error).message)
    done(false)
  } finally {
    settings.saving = false
  }
}

/* ── 任意文本试听 ─────────────────────────────────────────── */

const preview = reactive({
  visible: false,
  voiceId: '',
  text: '',
  running: false,
  audioUrl: '',
  error: '',
})
let previewTimer: ReturnType<typeof setTimeout> | null = null
/** 每次开始 / 停止试听都换代：在途请求回来时代次不符就丢弃，不会写进别的声音的弹窗 */
let previewGeneration = 0

function stopPreviewPolling() {
  previewGeneration += 1
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = null
}

function openPreview(v: PersonaVoice) {
  stopPreviewPolling()
  Object.assign(preview, { visible: true, voiceId: v.id, text: preview.text, running: false, audioUrl: '', error: '' })
}

async function pollPreview(previewId: string, generation: number) {
  try {
    const p = await getVoicePreview(previewId)
    if (generation !== previewGeneration) return
    if (p.status === 'ready') {
      preview.audioUrl = voicePreviewFileUrl(previewId)
      preview.running = false
      return
    }
    if (p.status === 'failed') {
      preview.error = p.error || '试听生成失败'
      preview.running = false
      return
    }
    // 弹窗关掉就不再继续查询
    if (preview.visible) previewTimer = setTimeout(() => void pollPreview(previewId, generation), PREVIEW_POLL_MS)
    else preview.running = false
  } catch (e) {
    if (generation !== previewGeneration) return
    preview.error = (e as Error).message
    preview.running = false
  }
}

async function startPreview() {
  stopPreviewPolling()
  const generation = previewGeneration
  preview.running = true
  preview.audioUrl = ''
  preview.error = ''
  try {
    const r = await createVoicePreview(preview.voiceId, preview.text.trim())
    if (generation !== previewGeneration) return
    await pollPreview(r.previewId, generation)
  } catch (e) {
    if (generation !== previewGeneration) return
    preview.error = (e as Error).message
    preview.running = false
  }
}

onBeforeUnmount(stopPreviewPolling)

/* ── 重命名 / 删除 ───────────────────────────────────────── */

async function rename(v: PersonaVoice) {
  const name = await promptText({ title: '重命名声音', initial: v.name, maxLength: 60, required: true, placeholder: '声音名称' })
  if (name === null || name === v.name) return
  await run(() => patchVoice(v.id, name), '已重命名')
}

async function remove(v: PersonaVoice) {
  if (!(await confirmAction('删除声音', `确定删除「${v.name}」？飞影侧的声音不会被删除。`, '删除'))) return
  await run(() => deleteVoice(v.id), '已删除')
}
</script>
