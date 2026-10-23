<template>
  <a-modal
    :visible="visible"
    :title="persona ? '编辑人物' : '新增人物'"
    :ok-loading="saving"
    :ok-text="persona ? '保存' : '创建'"
    unmount-on-close
    :on-before-ok="submit"
    @cancel="close"
    @update:visible="(v: boolean) => !v && close()"
  >
    <a-form :model="form" layout="vertical" auto-label-width>
      <a-form-item label="名称" required :validate-status="errors.name ? 'error' : undefined" :help="errors.name">
        <a-input v-model="form.name" :max-length="40" show-word-limit placeholder="如：张经理" />
      </a-form-item>

      <a-form-item label="生产线" required>
        <a-radio-group v-model="form.line" :disabled="!!persona" type="button" @change="onLineChange">
          <a-radio v-for="l in LINES" :key="l.value" :value="l.value">{{ l.label }}</a-radio>
        </a-radio-group>
        <template #extra>
          <span v-if="persona">生产线创建后不可修改，如需换线请新建人物。</span>
          <span v-else-if="form.line === 'persona'">素人矩阵不使用数字人口播，也不强制授权材料。</span>
          <span v-else>经理 IP / 员工 KOS 必须有已核验的授权材料后才可用。</span>
        </template>
      </a-form-item>

      <a-form-item label="归属主体">
        <a-input v-model="form.ownerSubject" :max-length="60" placeholder="默认同名称" />
      </a-form-item>

      <a-form-item label="绑定方式">
        <a-radio-group v-model="form.bindingMode" type="button" :disabled="bindingModes.length < 2">
          <a-radio v-for="m in bindingModes" :key="m" :value="m">{{
            m === 'shared' ? '共享（可供多个账号）' : '一对一（专属）'
          }}</a-radio>
        </a-radio-group>
        <template #extra>{{ bindingHint }}</template>
      </a-form-item>

      <a-form-item label="简介">
        <a-textarea
          v-model="form.description"
          :max-length="120"
          show-word-limit
          :auto-size="{ minRows: 2, maxRows: 4 }"
        />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import {
  createPersona,
  patchPersona,
  type BindingMode,
  type PersonaDetail,
  type PersonaLine,
  type PersonaOptions,
} from '@/api/personas'
import { isApiCode, toastError } from './shared'

const props = defineProps<{
  visible: boolean
  persona: PersonaDetail | null
  options: PersonaOptions | null
}>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'saved', id: string): void
  (e: 'conflict'): void
}>()

const LINES: Array<{ value: PersonaLine; label: string }> = [
  { value: 'manager', label: '经理 IP' },
  { value: 'kos', label: '员工 KOS' },
  { value: 'persona', label: '素人矩阵' },
]

const form = reactive({
  name: '',
  line: 'kos' as PersonaLine,
  ownerSubject: '',
  description: '',
  bindingMode: 'shared' as BindingMode,
})
const errors = reactive({ name: '' })
const saving = ref(false)

const bindingModes = computed<BindingMode[]>(() => {
  const rule = props.options?.lineRules?.[form.line]
  if (rule?.bindingModes?.length) return rule.bindingModes
  return form.line === 'kos' ? ['shared', 'exclusive'] : ['exclusive']
})
const bindingHint = computed(() => {
  if (form.line === 'manager') return '经理 IP 固定一对一，最多绑定 1 个账号。'
  if (form.line === 'persona') return '素人矩阵一对一，最多绑定 1 个账号。'
  return form.bindingMode === 'shared'
    ? '共享人物最多可供 5 个授权账号使用；声音共享须单独核验授权。'
    : '一对一最多绑定 1 个账号。'
})

function onLineChange(): void {
  const rule = props.options?.lineRules?.[form.line]
  form.bindingMode = rule?.defaultBindingMode ?? bindingModes.value[0]
}

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    errors.name = ''
    if (props.persona) {
      form.name = props.persona.name
      form.line = props.persona.line
      form.ownerSubject = props.persona.ownerSubject ?? ''
      form.description = props.persona.description ?? ''
      form.bindingMode = props.persona.bindingMode
    } else {
      form.name = ''
      form.line = 'kos'
      form.ownerSubject = ''
      form.description = ''
      onLineChange()
    }
  },
)

function close(): void {
  emit('update:visible', false)
}

async function submit(): Promise<boolean> {
  errors.name = ''
  const name = form.name.trim()
  if (!name) {
    errors.name = '请填写人物名称'
    return false
  }
  saving.value = true
  try {
    if (props.persona) {
      const r = await patchPersona(props.persona.id, {
        name,
        ownerSubject: form.ownerSubject.trim() || undefined,
        description: form.description.trim(),
        bindingMode: form.bindingMode,
        rev: props.persona.rev,
      })
      Message.success('已保存')
      emit('saved', r.id)
    } else {
      const defaults = props.options?.lineDefaultForbidden?.[form.line] ?? []
      const directions = props.options?.lineDefaultDirections?.[form.line] ?? []
      const r = await createPersona({
        name,
        line: form.line,
        ownerSubject: form.ownerSubject.trim() || undefined,
        description: form.description.trim() || undefined,
        bindingMode: form.bindingMode,
        // 按线预填合规基线与内容方向（FR-I2 / FR-I4）
        ipProfile: { forbiddenClaims: defaults, contentDirections: directions },
      })
      Message.success('已创建')
      emit('saved', r.id)
    }
    close()
    return true
  } catch (e) {
    if (isApiCode(e, 'PERSONA_NAME_DUPLICATE')) errors.name = (e as Error).message
    else if (isApiCode(e, 'PERSONA_CONFLICT')) emit('conflict')
    else toastError(e)
    return false
  } finally {
    saving.value = false
  }
}
</script>
