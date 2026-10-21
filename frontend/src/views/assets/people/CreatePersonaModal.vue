<template>
  <a-modal :visible="visible" title="新增人物" :ok-loading="saving" ok-text="创建" @ok="submit" @cancel="emit('update:visible', false)">
    <div class="flex flex-col gap-3">
      <label class="form-label" for="new-persona-name">人物名称 <span class="req">必填</span></label>
      <a-input v-model="form.name" :input-attrs="{ id: 'new-persona-name' }" :max-length="40" show-word-limit placeholder="例如：张经理" />
      <label class="form-label">生产线 <span class="req">必填</span></label>
      <a-radio-group v-model="form.line" type="button">
        <a-radio v-for="(label, key) in options.lineLabels" :key="key" :value="key">{{ label }}</a-radio>
      </a-radio-group>
      <p class="mw-subtle">{{ lineHint }}</p>
      <template v-if="rule.bindingModes.length > 1">
        <label class="form-label">账号绑定方式</label>
        <a-radio-group v-model="form.bindingMode">
          <a-radio value="exclusive">一对一</a-radio>
          <a-radio value="shared">共享（最多 {{ rule.accountLimit }} 个账号）</a-radio>
        </a-radio-group>
      </template>
      <label class="form-label" for="new-persona-owner">归属主体</label>
      <a-input v-model="form.ownerSubject" :input-attrs="{ id: 'new-persona-owner' }" :max-length="60" placeholder="缺省与人物名称相同" />
      <label class="form-label" for="new-persona-desc">简介</label>
      <a-input v-model="form.description" :input-attrs="{ id: 'new-persona-desc' }" :max-length="120" show-word-limit placeholder="一句话说明人物定位" />
      <p class="mw-subtle">创建后按生产线预填内容方向与合规禁用表达，可在「IP 定位」中修改。</p>
    </div>
  </a-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { createPersona, type BindingMode, type PersonaLine, type PersonaListItem, type PersonaOptions } from '@/api/personas'

const props = defineProps<{ visible: boolean; options: PersonaOptions }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'created', p: PersonaListItem): void }>()

const form = reactive({ name: '', line: 'kos' as PersonaLine, bindingMode: 'shared' as BindingMode, ownerSubject: '', description: '' })
const saving = ref(false)
const rule = computed(() => props.options.lineRules[form.line])
const lineHint = computed(() => {
  const r = rule.value
  if (!r.authRequired) return '素人矩阵：不强制授权材料，不提供数字人口播（不能上传分身素材、不能克隆声音）。'
  return `${r.label}：须上传并核验授权材料后才可用于文案与视频；可制作口播分身与克隆声音。`
})

watch(
  () => form.line,
  (line) => {
    form.bindingMode = props.options.lineRules[line].defaultBindingMode
  },
)
watch(
  () => props.visible,
  (v) => {
    if (v) Object.assign(form, { name: '', line: 'kos', bindingMode: 'shared', ownerSubject: '', description: '' })
  },
)

async function submit(): Promise<void> {
  if (!form.name.trim()) {
    Message.warning('请填写人物名称')
    return
  }
  saving.value = true
  try {
    const p = await createPersona({
      name: form.name.trim(),
      line: form.line,
      bindingMode: form.bindingMode,
      ownerSubject: form.ownerSubject.trim() || undefined,
      description: form.description.trim() || undefined,
      ipProfile: {
        role: '',
        serviceScope: '',
        targetAudience: '',
        expressionStyle: '',
        forbiddenClaims: props.options.lineDefaultForbidden[form.line],
        contentDirections: props.options.lineDefaultDirections[form.line],
      },
    })
    Message.success('人物已创建')
    emit('update:visible', false)
    emit('created', p)
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.form-label {
  font-size: 13px;
  color: var(--mw-text2);
}
.req {
  font-size: 11px;
  color: #b42318;
  margin-left: 4px;
}
</style>
