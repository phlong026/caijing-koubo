<template>
  <a-modal
    :visible="visible"
    title="制作口播分身"
    :ok-loading="submitting"
    ok-text="确认并提交"
    :ok-button-props="{ disabled: !canSubmit }"
    unmount-on-close
    :width="560"
    :on-before-ok="submit"
    @cancel="$emit('update:visible', false)"
    @update:visible="(v: boolean) => !v && $emit('update:visible', false)"
  >
    <div v-if="source" class="flex items-center gap-3 mb-4">
      <img
        v-if="source.thumbKey"
        :src="assetFileUrl(source.id, 'thumb')"
        :alt="source.name"
        class="w-[96px] h-[72px] object-cover rounded"
      />
      <div class="min-w-0">
        <div class="font-medium truncate">{{ source.name }}</div>
        <div class="mw-subtle">
          {{ source.width }}×{{ source.height }} · {{ fmtDuration(source.durationMs)
          }}<template v-if="source.backgroundLabel"> · 背景：{{ source.backgroundLabel }}</template>
        </div>
      </div>
    </div>

    <a-form :model="form" layout="vertical">
      <a-form-item label="授权材料（须已核验、未过期，范围含「肖像」）" required>
        <a-select v-model="form.authId" placeholder="选择授权" :disabled="!auths.length" aria-label="授权材料">
          <a-option v-for="a in auths" :key="a.id" :value="a.id"
            >{{ a.grantorName }} · 至 {{ fmtDate(a.expiresAt) }}</a-option
          >
        </a-select>
        <template #extra>
          <span v-if="!auths.length" class="text-[#c0392b]">没有可用的肖像授权，请先在「授权管理」上传并核验。</span>
        </template>
      </a-form-item>

      <a-form-item label="分身名称" required>
        <a-input v-model="form.name" :max-length="60" show-word-limit :input-attrs="{ 'aria-label': '分身名称' }" />
      </a-form-item>

      <a-checkbox v-model="form.agree" class="consent">
        <span class="text-[12.5px] leading-5">{{ consentText }}</span>
      </a-checkbox>
    </a-form>

    <div class="mw-subtle mt-3">提交后由飞影制作，通常需要数分钟；制作会消耗飞影积分，请勿重复提交。</div>
    <div v-if="error" class="mw-alert-banner mt-3" role="alert">{{ error }}</div>
  </a-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import {
  assetFileUrl,
  createAvatar,
  createConsent,
  type PersonaAsset,
  type PersonaDetail,
  type PersonaOptions,
} from '@/api/personas'
import { errMsg, fmtDate, fmtDuration, isApiCode, newIdempotencyKey, usableAuthorizations } from './shared'

const props = defineProps<{
  visible: boolean
  persona: PersonaDetail
  source: PersonaAsset | null
  options: PersonaOptions | null
}>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'submitted'): void }>()

const form = reactive({ authId: '', name: '', agree: false })
const submitting = ref(false)
const error = ref('')
let idemKey = ''
let consentId = ''

const auths = computed(() => usableAuthorizations(props.persona.authorizations, 'portrait'))
const consentText = computed(
  () =>
    props.options?.consentTexts?.AVATAR_CLONE ??
    '我确认已获得肖像权人的书面授权，同意将该素材提交给第三方数字人服务制作口播分身，并仅用于授权范围内的内容生产。',
)
const canSubmit = computed(() => !!form.authId && !!form.name.trim() && form.agree && !submitting.value)

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    error.value = ''
    // 一次打开弹窗只生成一个幂等键：网络抖动后重试沿用同一个，不会产生第二条记录
    idemKey = newIdempotencyKey('avatar')
    consentId = ''
    form.agree = false
    form.authId = auths.value[0]?.id ?? ''
    const bg = props.source?.backgroundLabel
    form.name = `${props.persona.name}${bg ? ` · ${bg}` : ''}`.slice(0, 60)
  },
)

async function send(confirmDuplicate: boolean): Promise<void> {
  if (!props.source) return
  if (!consentId) {
    const c = await createConsent(props.persona.id, {
      authorizationId: form.authId,
      purpose: 'AVATAR_CLONE',
      sourceKind: 'avatar_source',
      sourceId: props.source.id,
      consentTextVersion: props.options?.consentTextVersion ?? '',
    })
    consentId = c.consentId
  }
  const r = await createAvatar(
    props.persona.id,
    {
      name: form.name.trim(),
      sourceAssetId: props.source.id,
      consentId,
      ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
    },
    idemKey,
  )
  Message.success(r.replayed ? '该请求已提交过，已为你定位到原记录' : '已提交，分身制作中')
  emit('submitted')
  emit('update:visible', false)
}

async function submit(): Promise<boolean> {
  if (!canSubmit.value) return false
  submitting.value = true
  error.value = ''
  try {
    await send(false)
    return true
  } catch (e) {
    // 同素材已有可用 / 进行中的分身：需用户二次确认才再提交（换新幂等键，因为请求内容变了）
    if (isApiCode(e, 'PERSONA_CONFLICT') && /已制作|已有|重复/.test((e as Error).message)) {
      Modal.confirm({
        title: '该素材已制作过分身',
        content: `${(e as Error).message}。再次制作会再次消耗飞影积分，确认继续？`,
        okText: '仍然制作',
        onOk: async () => {
          idemKey = newIdempotencyKey('avatar')
          submitting.value = true
          try {
            await send(true)
          } catch (e2) {
            error.value = errMsg(e2, '提交失败')
          } finally {
            submitting.value = false
          }
        },
      })
    } else {
      error.value = errMsg(e, '提交失败')
    }
    return false
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
