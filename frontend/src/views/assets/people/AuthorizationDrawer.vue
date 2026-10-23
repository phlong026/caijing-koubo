<template>
  <a-drawer :visible="visible" :width="480" title="授权材料" :footer="false" @cancel="$emit('update:visible', false)">
    <div class="mw-subtle mb-3">
      经理 IP / 员工 KOS 必须有已核验、未过期的授权才能使用；分身制作需含「肖像」，声音克隆需含「声音」，共享使用需含「允许共享」。
    </div>

    <div v-if="!readonly" class="mb-4 p-3 rounded-[10px] border border-[var(--mw-border)]">
      <div class="text-[13px] font-medium mb-2">上传新授权</div>
      <div class="mw-form-row"><div class="mw-form-label">授权人</div><a-input v-model="form.grantorName" :max-length="40" placeholder="授权人姓名" /></div>
      <div class="mw-form-row">
        <div class="mw-form-label">授权范围</div>
        <a-checkbox-group v-model="form.scopes">
          <a-checkbox v-for="(label, key) in SCOPE_LABELS" :key="key" :value="key">{{ label }}</a-checkbox>
        </a-checkbox-group>
      </div>
      <div class="mw-form-row">
        <div class="mw-form-label">有效期</div>
        <a-range-picker v-model="form.range" value-format="YYYY-MM-DD" class="flex-1" />
      </div>
      <div class="mw-form-row"><div class="mw-form-label">备注</div><a-input v-model="form.note" :max-length="200" /></div>
      <div class="mw-form-row">
        <div class="mw-form-label">文件</div>
        <a-upload accept=".pdf,.jpg,.jpeg,.png" :auto-upload="false" :limit="1" :file-list="fileList" @change="onFileChange" />
      </div>
      <div class="flex justify-end mt-1">
        <a-button type="primary" size="small" :loading="submitting" @click="submit">提交核验</a-button>
      </div>
    </div>

    <div v-if="!authorizations.length" class="mw-subtle text-center py-6">暂无授权记录</div>
    <div v-for="a in authorizations" :key="a.id" class="p-3 mb-2 rounded-[10px] border border-[var(--mw-border)]">
      <div class="flex items-center gap-2">
        <span class="text-[13.5px] font-medium">{{ a.grantorName }}</span>
        <span class="mw-tag" :class="AUTH_STATUS_TAG[a.status].cls">{{ AUTH_STATUS_TAG[a.status].text }}</span>
        <div class="flex-1"></div>
        <a :href="authorizationFileUrl(a.id)" target="_blank" rel="noopener" class="mw-link text-[12.5px]">查看文件</a>
      </div>
      <div class="mw-subtle mt-1">{{ scopeText(a.scopes) }} · {{ dateOnly(a.effectiveFrom) }} 至 {{ dateOnly(a.expiresAt) }}</div>
      <div v-if="a.verifiedBy" class="mw-subtle">核验人 {{ a.verifiedBy }} · {{ dateOnly(a.verifiedAt) }}</div>
      <div v-if="a.decisionReason" class="text-[12px] text-[#c2410c] mt-0.5">原因：{{ a.decisionReason }}</div>
      <div v-if="a.note" class="mw-subtle">备注：{{ a.note }}</div>
      <div v-if="!readonly && (a.status === 'pending' || a.status === 'verified')" class="mt-2 flex gap-1.5">
        <template v-if="a.status === 'pending'">
          <a-button size="mini" type="primary" @click="decide(a, 'verified')">核验通过</a-button>
          <a-button size="mini" @click="decide(a, 'rejected')">驳回</a-button>
        </template>
        <a-button v-else size="mini" @click="revoke(a)">撤销</a-button>
      </div>
    </div>
  </a-drawer>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import type { FileItem } from '@arco-design/web-vue'
import {
  authorizationFileUrl,
  revokeAuthorization,
  uploadAuthorization,
  verifyAuthorization,
  type AuthorizationScope,
  type PersonaAuthorization,
} from '@/api/personas'
import { AUTH_STATUS_TAG, SCOPE_LABELS, dateOnly, scopeText } from './labels'
import { promptText } from './prompt'

const props = defineProps<{
  visible: boolean
  personaId: string
  authorizations: PersonaAuthorization[]
  readonly: boolean
}>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'changed'): void }>()

const form = reactive({
  grantorName: '',
  scopes: ['portrait', 'voice'] as AuthorizationScope[],
  range: [] as string[],
  note: '',
})
const fileList = ref<FileItem[]>([])
const submitting = ref(false)

function onFileChange(list: FileItem[]) {
  fileList.value = list.slice(-1)
}

async function submit() {
  const file = fileList.value[0]?.file
  if (!form.grantorName.trim()) return Message.warning('请填写授权人')
  if (!form.scopes.length) return Message.warning('请选择授权范围')
  if (form.range.length !== 2) return Message.warning('请选择有效期')
  if (!file) return Message.warning('请选择授权文件')
  submitting.value = true
  try {
    await uploadAuthorization(
      props.personaId,
      {
        grantorName: form.grantorName.trim(),
        scopes: form.scopes,
        effectiveFrom: form.range[0],
        expiresAt: form.range[1],
        note: form.note.trim() || undefined,
      },
      file,
    )
    Message.success('已上传，等待核验')
    Object.assign(form, { grantorName: '', note: '', range: [] })
    fileList.value = []
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    submitting.value = false
  }
}

async function decide(a: PersonaAuthorization, decision: 'verified' | 'rejected') {
  let reason: string | undefined
  if (decision === 'rejected') {
    const r = await promptText({ title: '驳回授权', placeholder: '驳回原因', required: true })
    if (r === null) return
    reason = r
  }
  try {
    await verifyAuthorization(a.id, decision, reason)
    Message.success(decision === 'verified' ? '已核验通过' : '已驳回')
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function revoke(a: PersonaAuthorization) {
  const reason = await promptText({ title: '撤销授权（不可恢复）', placeholder: '撤销原因', required: true, okText: '撤销' })
  if (reason === null) return
  try {
    await revokeAuthorization(a.id, reason)
    Message.success('已撤销，依赖该授权的分身与声音将立即不可用')
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}
</script>
