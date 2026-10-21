<template>
  <div class="flex flex-col gap-3">
    <p class="mw-subtle">
      授权材料是分身制作、声音克隆与人物可用的前提。上传后需由<strong>上传人以外</strong>的审核员核验；到期后自动失效。
    </p>

    <div v-if="!readonly" class="upload-box">
      <div class="grid-2">
        <a-input v-model="form.grantorName" :max-length="60" placeholder="授权人姓名" />
        <a-checkbox-group v-model="form.scopes">
          <a-checkbox v-for="(label, key) in SCOPE_LABELS" :key="key" :value="key">{{ label }}</a-checkbox>
        </a-checkbox-group>
        <a-date-picker v-model="form.effectiveFrom" placeholder="生效日期" value-format="YYYY-MM-DD" />
        <a-date-picker v-model="form.expiresAt" placeholder="到期日期（最长 3 年）" value-format="YYYY-MM-DD" />
      </div>
      <a-input v-model="form.note" :max-length="255" placeholder="备注（可选）" />
      <div class="flex items-center gap-3">
        <input ref="fileInput" type="file" accept=".pdf,.jpg,.jpeg,.png" class="sr-only" aria-label="选择授权材料文件" @change="onFile" />
        <a-button size="small" @click="fileInput?.click()"><icon-upload />选择文件</a-button>
        <span class="mw-subtle truncate">{{ file ? `${file.name}（${fmtSize(file.size)}）` : 'PDF / JPG / PNG，不超过 20MB' }}</span>
        <div class="flex-1" />
        <a-button type="primary" size="small" :loading="uploading" :disabled="!canUpload" @click="upload">上传授权材料</a-button>
      </div>
    </div>

    <div v-for="a in detail.authorizations" :key="a.id" class="auth-card">
      <div class="flex items-center gap-2 flex-wrap">
        <strong>{{ a.grantorName }}</strong>
        <span class="mw-tag" :class="toneClass(AUTH_STATUS[a.status]?.tone ?? 'gray')">{{ AUTH_STATUS[a.status]?.label ?? a.status }}</span>
        <span v-for="s in a.scopes" :key="s" class="mw-tag mw-tag-gray">{{ SCOPE_LABELS[s] }}</span>
        <div class="flex-1" />
        <a :href="authorizationFileUrl(a.id)" target="_blank" rel="noopener" class="text-[12px]">查看材料</a>
      </div>
      <div class="mw-subtle mt-1">
        有效期 {{ fmtDate(a.effectiveFrom) }} 至 {{ fmtDate(a.expiresAt) }} · 上传人 {{ a.createdBy ?? '—' }} · {{ fmtTime(a.createdAt) }}
      </div>
      <div v-if="a.verifiedBy && a.status !== 'pending'" class="mw-subtle">核验人 {{ a.verifiedBy }} · {{ fmtTime(a.verifiedAt) }}</div>
      <div v-if="a.decisionReason" class="mw-subtle">原因：{{ a.decisionReason }}</div>
      <div v-if="a.note" class="mw-subtle">备注：{{ a.note }}</div>
      <div v-if="!readonly" class="flex gap-2 mt-2">
        <template v-if="canReview && a.status === 'pending'">
          <a-tooltip :content="a.createdBy === auth.user?.username ? '四眼原则：不能核验自己上传的材料' : ''">
            <a-button size="mini" type="primary" :disabled="a.createdBy === auth.user?.username" @click="decide(a.id, 'verified')">核验通过</a-button>
          </a-tooltip>
          <a-button size="mini" status="danger" :disabled="a.createdBy === auth.user?.username" @click="openReason(a.id, 'reject')">驳回</a-button>
        </template>
        <a-button v-if="canReview && ['verified', 'pending', 'expired'].includes(a.status)" size="mini" @click="openReason(a.id, 'revoke')">撤销授权</a-button>
      </div>
    </div>
    <p v-if="!detail.authorizations.length" class="mw-subtle text-center py-4">尚未上传授权材料</p>

    <a-modal v-model:visible="reasonVisible" :title="reasonMode === 'reject' ? '驳回授权材料' : '撤销授权'" :ok-loading="deciding" @ok="submitReason">
      <a-textarea v-model="reason" :max-length="255" placeholder="请填写原因（必填）" :auto-size="{ minRows: 3 }" />
      <p v-if="reasonMode === 'revoke'" class="mw-subtle mt-2">撤销后不可恢复，依赖该授权的分身与声音将立即不可用。</p>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import {
  authorizationFileUrl,
  revokeAuthorization,
  uploadAuthorization,
  verifyAuthorization,
  type AuthorizationScope,
  type PersonaDetail,
} from '@/api/personas'
import { useAuthStore } from '@/stores/auth'
import { AUTH_STATUS, SCOPE_LABELS, fmtDate, fmtSize, fmtTime, toneClass } from './labels'

const props = defineProps<{ detail: PersonaDetail; readonly: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const auth = useAuthStore()
const canReview = computed(() => auth.hasRole('reviewer', 'admin'))
const fileInput = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const uploading = ref(false)
const form = reactive({
  grantorName: '',
  scopes: ['portrait', 'voice'] as AuthorizationScope[],
  effectiveFrom: new Date().toISOString().slice(0, 10),
  expiresAt: '',
  note: '',
})
const canUpload = computed(() => !!file.value && !!form.grantorName.trim() && form.scopes.length > 0 && !!form.effectiveFrom && !!form.expiresAt)

const reasonVisible = ref(false)
const reasonMode = ref<'reject' | 'revoke'>('reject')
const reasonTarget = ref('')
const reason = ref('')
const deciding = ref(false)

function onFile(e: Event): void {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null
}

async function upload(): Promise<void> {
  if (!file.value) return
  uploading.value = true
  try {
    await uploadAuthorization(props.detail.id, { ...form, grantorName: form.grantorName.trim() }, file.value)
    Message.success('授权材料已上传，等待审核员核验')
    file.value = null
    if (fileInput.value) fileInput.value.value = ''
    form.grantorName = ''
    form.note = ''
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    uploading.value = false
  }
}

async function decide(id: string, decision: 'verified' | 'rejected', why?: string): Promise<void> {
  deciding.value = true
  try {
    await verifyAuthorization(id, decision, why)
    Message.success(decision === 'verified' ? '已核验通过' : '已驳回')
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    deciding.value = false
  }
}

function openReason(id: string, mode: 'reject' | 'revoke'): void {
  reasonTarget.value = id
  reasonMode.value = mode
  reason.value = ''
  reasonVisible.value = true
}

async function submitReason(): Promise<void> {
  if (!reason.value.trim()) {
    Message.warning('请填写原因')
    return
  }
  if (reasonMode.value === 'reject') {
    await decide(reasonTarget.value, 'rejected', reason.value.trim())
  } else {
    deciding.value = true
    try {
      await revokeAuthorization(reasonTarget.value, reason.value.trim())
      Message.success('授权已撤销')
      emit('changed')
    } catch (e) {
      Message.error((e as Error).message)
    } finally {
      deciding.value = false
    }
  }
  reasonVisible.value = false
}
</script>

<style scoped>
.upload-box,
.auth-card {
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
  align-items: center;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
