<template>
  <a-drawer :visible="visible" :width="560" title="授权材料" unmount-on-close @cancel="$emit('update:visible', false)">
    <div class="mw-subtle mb-3">
      肖像、声音属于敏感个人信息：材料私有存储，查看会留下审计记录。{{
        persona.line === 'persona'
          ? '素人矩阵不强制授权，可上传留档。'
          : '经理 IP / 员工 KOS 须有已核验且未过期的授权才可使用。'
      }}
    </div>

    <a-spin :loading="loading" class="w-full">
      <a-empty v-if="!loading && !auths.length" description="还没有授权材料" />
      <div class="space-y-3">
        <div v-for="a in auths" :key="a.id" class="mw-card p-3">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold">{{ a.grantorName }}</span>
            <span class="mw-tag" :class="AUTH_STATUS[a.status].cls">{{ AUTH_STATUS[a.status].text }}</span>
            <span v-for="s in a.scopes" :key="s" class="mw-tag mw-tag-gray">{{ SCOPE_LABEL[s] ?? s }}</span>
          </div>
          <div class="mw-subtle mt-1">
            有效期 {{ fmtDate(a.effectiveFrom) }} ~ {{ fmtDate(a.expiresAt) }}
            <template v-if="a.verifiedBy"> · 核验人 {{ a.verifiedBy }}</template>
          </div>
          <div v-if="a.decisionReason" class="mt-1 text-[12.5px] text-[var(--mw-text2)]">
            原因：{{ a.decisionReason }}
          </div>
          <div v-if="a.note" class="mt-1 text-[12.5px] text-[var(--mw-text2)]">备注：{{ a.note }}</div>
          <div class="mt-2 flex items-center gap-2 flex-wrap">
            <a-button size="mini" type="outline" @click="openFile(a.id)">查看文件</a-button>
            <!-- 核验 / 驳回 / 撤销与后端 ROLE_RULES 对齐：仅 reviewer / admin -->
            <template v-if="a.status === 'pending' && canReview">
              <a-button size="mini" type="primary" :loading="busyId === a.id" @click="decide(a.id, 'verified')"
                >核验通过</a-button
              >
              <a-button size="mini" status="danger" @click="askReason('reject', a.id)">驳回</a-button>
            </template>
            <a-button
              v-if="a.status === 'verified' && canReview"
              size="mini"
              status="danger"
              @click="askReason('revoke', a.id)"
              >撤销</a-button
            >
          </div>
        </div>
      </div>
    </a-spin>

    <a-divider />
    <div class="font-semibold mb-2">上传新授权</div>
    <a-form :model="form" layout="vertical" auto-label-width>
      <a-form-item label="授权人姓名" required><a-input v-model="form.grantorName" :max-length="40" /></a-form-item>
      <a-form-item label="授权范围" required>
        <a-checkbox-group v-model="form.scopes">
          <a-checkbox value="portrait">肖像</a-checkbox>
          <a-checkbox value="voice">声音</a-checkbox>
          <a-checkbox value="share">允许共享（声音多账号使用）</a-checkbox>
        </a-checkbox-group>
      </a-form-item>
      <div class="grid grid-cols-2 gap-3">
        <a-form-item label="生效日期" required
          ><a-input v-model="form.effectiveFrom" placeholder="YYYY-MM-DD"
        /></a-form-item>
        <a-form-item label="到期日期（最长 3 年）" required
          ><a-input v-model="form.expiresAt" placeholder="YYYY-MM-DD"
        /></a-form-item>
      </div>
      <a-form-item label="备注"><a-input v-model="form.note" :max-length="200" /></a-form-item>
      <a-form-item label="授权文件（pdf / jpg / png，≤20MB）" required>
        <input ref="fileInput" type="file" accept=".pdf,.jpg,.jpeg,.png" aria-label="选择授权文件" @change="onFile" />
      </a-form-item>
      <div v-if="formError" class="mw-alert-banner mb-2" role="alert">{{ formError }}</div>
      <a-button type="primary" :loading="uploading" @click="upload">上传授权</a-button>
    </a-form>

    <a-modal
      v-model:visible="reasonVisible"
      :title="reasonKind === 'revoke' ? '撤销授权' : '驳回授权'"
      ok-text="确认"
      :on-before-ok="submitReason"
      @cancel="reasonVisible = false"
    >
      <a-textarea
        v-model="reason"
        placeholder="请填写原因（必填）"
        :max-length="200"
        show-word-limit
        :auto-size="{ minRows: 3 }"
      />
    </a-modal>
  </a-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useAuthStore } from '@/stores/auth'
import {
  authorizationFileUrl,
  getAuthorizations,
  revokeAuthorization,
  uploadAuthorization,
  verifyAuthorization,
  type AuthorizationScope,
  type PersonaAuthorization,
  type PersonaDetail,
} from '@/api/personas'
import { AUTH_STATUS, dayOffset, errMsg, fmtDate, SCOPE_LABEL, toastError } from './shared'

const props = defineProps<{ visible: boolean; persona: PersonaDetail }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'changed'): void }>()

const auth = useAuthStore()
/** 授权核验 / 驳回 / 撤销（POST /persona-authorizations/:id/*）后端限 reviewer / admin */
const canReview = computed(() => auth.hasRole('reviewer', 'admin'))

const auths = ref<PersonaAuthorization[]>([])
const loading = ref(false)
const busyId = ref('')
const uploading = ref(false)
const formError = ref('')
const file = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const form = reactive({
  grantorName: '',
  scopes: ['portrait', 'voice'] as AuthorizationScope[],
  effectiveFrom: dayOffset(0),
  expiresAt: dayOffset(365),
  note: '',
})
const reasonVisible = ref(false)
const reasonKind = ref<'reject' | 'revoke'>('reject')
const reasonTarget = ref('')
const reason = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    auths.value = await getAuthorizations(props.persona.id)
  } catch (e) {
    toastError(e, '加载授权失败')
  } finally {
    loading.value = false
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      formError.value = ''
      void load()
    }
  },
)

function onFile(ev: Event): void {
  file.value = (ev.target as HTMLInputElement).files?.[0] ?? null
}

/** 新窗口查看（后端记敏感访问审计，不暴露存储路径） */
function openFile(id: string): void {
  window.open(authorizationFileUrl(id), '_blank', 'noopener')
}

async function decide(id: string, decision: 'verified' | 'rejected', why?: string): Promise<void> {
  busyId.value = id
  try {
    await verifyAuthorization(id, decision, why)
    Message.success(decision === 'verified' ? '已核验通过' : '已驳回')
    await load()
    emit('changed')
  } catch (e) {
    toastError(e)
  } finally {
    busyId.value = ''
  }
}

function askReason(kind: 'reject' | 'revoke', id: string): void {
  reasonKind.value = kind
  reasonTarget.value = id
  reason.value = ''
  reasonVisible.value = true
}

async function submitReason(): Promise<boolean> {
  if (!reason.value.trim()) {
    Message.warning('请填写原因')
    return false
  }
  try {
    if (reasonKind.value === 'revoke') {
      await revokeAuthorization(reasonTarget.value, reason.value.trim())
      Message.success('已撤销')
      await load()
      emit('changed')
    } else {
      await decide(reasonTarget.value, 'rejected', reason.value.trim())
    }
    reasonVisible.value = false
    return true
  } catch (e) {
    toastError(e)
    return false
  }
}

async function upload(): Promise<void> {
  formError.value = ''
  if (!form.grantorName.trim()) return void (formError.value = '请填写授权人姓名')
  if (!form.scopes.length) return void (formError.value = '请至少选择一个授权范围')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.effectiveFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(form.expiresAt))
    return void (formError.value = '日期格式应为 YYYY-MM-DD')
  if (!file.value) return void (formError.value = '请选择授权文件')
  uploading.value = true
  try {
    await uploadAuthorization(
      props.persona.id,
      {
        grantorName: form.grantorName.trim(),
        scopes: form.scopes,
        effectiveFrom: form.effectiveFrom,
        expiresAt: form.expiresAt,
        note: form.note.trim() || undefined,
      },
      file.value,
    )
    Message.success('已上传，等待核验')
    form.grantorName = ''
    form.note = ''
    file.value = null
    if (fileInput.value) fileInput.value.value = ''
    await load()
    emit('changed')
  } catch (e) {
    formError.value = errMsg(e, '上传失败')
  } finally {
    uploading.value = false
  }
}
</script>
