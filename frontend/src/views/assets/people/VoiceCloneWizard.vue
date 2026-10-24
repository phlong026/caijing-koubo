<template>
  <a-modal
    :visible="visible"
    title="克隆新声音"
    :width="580"
    unmount-on-close
    :footer="false"
    @cancel="$emit('update:visible', false)"
    @update:visible="(v: boolean) => !v && $emit('update:visible', false)"
  >
    <a-steps :current="step" small class="mb-4">
      <a-step title="上传样本" />
      <a-step title="授权确认" />
      <a-step title="命名与语种" />
    </a-steps>

    <!-- ① 样本 -->
    <div v-if="step === 1">
      <div class="mw-subtle mb-2">wav / mp3 / m4a，≤20MB，时长 5–180 秒；建议 30–60 秒清晰人声，无背景音乐。</div>
      <input ref="fileInput" type="file" accept=".wav,.mp3,.m4a,audio/*" aria-label="选择声音样本" @change="onFile" />
      <div v-if="sampleInfo" class="mt-3 text-[13px]">
        <div>
          已选择：{{ sampleInfo.name }}（{{ fmtSize(sampleInfo.size)
          }}<template v-if="sampleInfo.durationMs"> · {{ fmtDuration(sampleInfo.durationMs) }}</template
          >）
        </div>
      </div>
      <div v-if="fileError" class="mt-2 text-[12.5px] text-[#c0392b]" role="alert">{{ fileError }}</div>
      <div class="mt-4 flex justify-end">
        <a-button type="primary" :loading="uploading" :disabled="!file || !!fileError" @click="uploadSample"
          >上传并校验</a-button
        >
      </div>
    </div>

    <!-- ② 授权 -->
    <div v-else-if="step === 2">
      <a-form :model="form" layout="vertical">
        <a-form-item label="授权材料（须已核验、未过期，范围含「声音」）" required>
          <a-select v-model="form.authId" :disabled="!auths.length" placeholder="选择授权" aria-label="授权材料">
            <a-option v-for="a in auths" :key="a.id" :value="a.id"
              >{{ a.grantorName }} · 至 {{ fmtDate(a.expiresAt) }}</a-option
            >
          </a-select>
          <template #extra
            ><span v-if="!auths.length" class="text-[#c0392b]"
              >没有可用的声音授权，请先在「授权管理」上传并核验。</span
            ></template
          >
        </a-form-item>
        <a-checkbox v-model="form.agree" class="consent"
          ><span class="text-[12.5px] leading-5">{{ consentText }}</span></a-checkbox
        >
        <div v-if="persona.bindingMode === 'shared'" class="mw-alert-banner mt-3" role="note">
          共享人物的声音用于多个账号时，须在授权中勾选「允许共享」，否则不能设为默认声音。
        </div>
      </a-form>
      <div class="mt-4 flex justify-between">
        <a-button @click="step = 1">上一步</a-button>
        <a-button type="primary" :disabled="!form.authId || !form.agree" @click="step = 3">下一步</a-button>
      </div>
    </div>

    <!-- ③ 命名 -->
    <div v-else>
      <a-form :model="form" layout="vertical">
        <a-form-item label="声音名称" required
          ><a-input v-model="form.name" :max-length="60" show-word-limit :input-attrs="{ 'aria-label': '声音名称' }"
        /></a-form-item>
        <a-form-item label="语种">
          <a-select v-model="form.language" aria-label="语种">
            <a-option value="mandarin">普通话（默认）</a-option>
            <a-option v-for="l in languages" :key="l.code" :value="l.code">{{ l.label }}</a-option>
          </a-select>
        </a-form-item>
      </a-form>
      <div class="mw-subtle">
        提交后由飞影克隆，克隆完成后需人工试听确认才能设为默认；每人最多 5
        条有效声音，克隆会消耗飞影积分，请勿重复提交。
      </div>
      <div v-if="error" class="mw-alert-banner mt-3" role="alert">{{ error }}</div>
      <div class="mt-4 flex justify-between">
        <a-button @click="step = 2">上一步</a-button>
        <a-button type="primary" :loading="submitting" :disabled="!form.name.trim()" @click="submit"
          >确认并提交</a-button
        >
      </div>
    </div>
  </a-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { createConsent, createVoice, uploadVoiceSample, type PersonaDetail, type PersonaOptions } from '@/api/personas'
import { errMsg, fmtDate, fmtDuration, fmtSize, newIdempotencyKey, usableAuthorizations } from './shared'

const props = defineProps<{ visible: boolean; persona: PersonaDetail; options: PersonaOptions | null }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'submitted'): void }>()

const step = ref(1)
const file = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const fileError = ref('')
const sampleInfo = ref<{ name: string; size: number; durationMs: number | null } | null>(null)
const sampleId = ref('')
const uploading = ref(false)
const submitting = ref(false)
const error = ref('')
const form = reactive({ authId: '', agree: false, name: '', language: '' })
let idemKey = ''
let consentId = ''

const auths = computed(() => usableAuthorizations(props.persona.authorizations, 'voice'))
const languages = computed(() => props.options?.voiceLanguages ?? [])
const consentText = computed(
  () =>
    props.options?.consentTexts?.VOICE_CLONE ??
    '我确认已获得声音权利人的书面授权，同意将该样本提交给第三方服务克隆声音，并仅用于授权范围内的内容生产。',
)

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    step.value = 1
    file.value = null
    fileError.value = ''
    sampleInfo.value = null
    sampleId.value = ''
    error.value = ''
    form.authId = auths.value[0]?.id ?? ''
    form.agree = false
    form.name = `${props.persona.name}声音`.slice(0, 60)
    form.language = 'mandarin'
    idemKey = newIdempotencyKey('voice')
    consentId = ''
    if (fileInput.value) fileInput.value.value = ''
  },
)

/** 浏览器读元数据得到时长，提前拦截 <5 秒 / >180 秒（服务端仍会复核） */
function probeDuration(f: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f)
    const audio = new Audio()
    const done = (v: number | null): void => {
      URL.revokeObjectURL(url)
      resolve(v)
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null)
    audio.onerror = () => done(null)
    audio.src = url
  })
}

async function onFile(ev: Event): Promise<void> {
  const f = (ev.target as HTMLInputElement).files?.[0] ?? null
  file.value = f
  fileError.value = ''
  sampleInfo.value = null
  if (!f) return
  const ext = `.${f.name.split('.').pop()?.toLowerCase() ?? ''}`
  const max = props.options?.uploadLimits?.voice_sample?.maxBytes ?? 20 * 1024 * 1024
  if (!['.wav', '.mp3', '.m4a'].includes(ext)) fileError.value = '仅支持 wav / mp3 / m4a'
  else if (f.size > max) fileError.value = `文件超过 ${Math.round(max / 1024 / 1024)}MB 上限`
  const durationMs = await probeDuration(f)
  sampleInfo.value = { name: f.name, size: f.size, durationMs }
  if (!fileError.value && durationMs !== null) {
    if (durationMs < 5000) fileError.value = `样本时长 ${fmtDuration(durationMs)}，不足 5 秒`
    else if (durationMs > 180_000) fileError.value = `样本时长 ${fmtDuration(durationMs)}，超过 180 秒`
  }
}

async function uploadSample(): Promise<void> {
  if (!file.value) return
  uploading.value = true
  fileError.value = ''
  try {
    const r = await uploadVoiceSample(props.persona.id, file.value)
    sampleId.value = r.sampleId
    if (sampleInfo.value) sampleInfo.value.durationMs = r.durationMs
    step.value = 2
  } catch (e) {
    fileError.value = errMsg(e, '上传失败')
  } finally {
    uploading.value = false
  }
}

async function submit(): Promise<void> {
  submitting.value = true
  error.value = ''
  try {
    if (!consentId) {
      const c = await createConsent(props.persona.id, {
        authorizationId: form.authId,
        purpose: 'VOICE_CLONE',
        sourceKind: 'voice_sample',
        sourceId: sampleId.value,
        consentTextVersion: props.options?.consentTextVersion ?? '',
      })
      consentId = c.consentId
    }
    const r = await createVoice(
      props.persona.id,
      {
        name: form.name.trim(),
        sampleId: sampleId.value,
        consentId,
        ...(form.language && form.language !== 'mandarin' ? { language: form.language } : {}),
      },
      idemKey,
    )
    Message.success(r.replayed ? '该请求已提交过' : '已提交，声音克隆中')
    emit('submitted')
    emit('update:visible', false)
  } catch (e) {
    error.value = errMsg(e, '提交失败')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.consent {
  align-items: flex-start;
}
</style>
