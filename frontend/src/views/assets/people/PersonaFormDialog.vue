<template>
  <a-modal
    :visible="visible"
    :title="editing ? '编辑基本信息' : '新增人物'"
    :ok-loading="saving"
    :mask-closable="false"
    @before-ok="save"
    @cancel="$emit('update:visible', false)"
  >
    <div class="mw-form-row"><div class="mw-form-label">名称</div><a-input v-model="form.name" :max-length="40" show-word-limit /></div>
    <div class="mw-form-row">
      <div class="mw-form-label">生产线</div>
      <a-radio-group v-model="form.line" type="button" :disabled="!!editing">
        <a-radio value="manager">经理 IP</a-radio>
        <a-radio value="kos">员工 KOS</a-radio>
        <a-radio value="persona">素人</a-radio>
      </a-radio-group>
    </div>
    <div v-if="editing" class="mw-subtle -mt-1 mb-1 pl-[88px]">生产线创建后不可修改，换线请新建人物。</div>
    <div class="mw-form-row">
      <div class="mw-form-label">绑定方式</div>
      <a-radio-group v-model="form.bindingMode" type="button" :disabled="form.line !== 'kos'">
        <a-radio value="exclusive">一对一</a-radio>
        <a-radio value="shared">共享</a-radio>
      </a-radio-group>
    </div>
    <div class="mw-form-row"><div class="mw-form-label">归属主体</div><a-input v-model="form.ownerSubject" :max-length="60" placeholder="默认同名称" /></div>
    <div class="mw-form-row items-start"><div class="mw-form-label pt-1">简介</div><a-textarea v-model="form.description" :max-length="120" show-word-limit :auto-size="{ minRows: 2, maxRows: 4 }" /></div>
  </a-modal>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import {
  createPersona,
  patchPersona,
  type BindingMode,
  type PersonaDetail,
  type PersonaLine,
  type PersonaListItem,
  type PersonaOptions,
} from '@/api/personas'

const props = defineProps<{ visible: boolean; editing: PersonaDetail | null; options: PersonaOptions | null }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'saved', persona: PersonaListItem): void }>()

const form = reactive({
  name: '',
  line: 'kos' as PersonaLine,
  bindingMode: 'shared' as BindingMode,
  ownerSubject: '',
  description: '',
})
const saving = ref(false)

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    const p = props.editing
    Object.assign(form, {
      name: p?.name ?? '',
      line: p?.line ?? 'kos',
      bindingMode: p?.bindingMode ?? 'shared',
      ownerSubject: p?.ownerSubject && p.ownerSubject !== p.name ? p.ownerSubject : '',
      description: p?.description ?? '',
    })
  },
)

/** 经理固定一对一、素人一对一、KOS 默认共享（FR-L2） */
watch(
  () => form.line,
  (line) => {
    if (props.editing) return
    form.bindingMode = props.options?.lineRules[line].defaultBindingMode ?? (line === 'kos' ? 'shared' : 'exclusive')
  },
)

async function save(done: (closed: boolean) => void) {
  if (!form.name.trim()) {
    Message.warning('请填写人物名称')
    return done(false)
  }
  saving.value = true
  try {
    const common = {
      name: form.name.trim(),
      ownerSubject: form.ownerSubject.trim() || undefined,
      description: form.description.trim() || undefined,
      bindingMode: form.bindingMode,
    }
    let saved: PersonaListItem
    if (props.editing) {
      saved = await patchPersona(props.editing.id, { ...common, rev: props.editing.rev })
    } else {
      // 新建时按线预填内容方向与合规基线（FR-I2 / FR-I4）
      const opts = props.options
      saved = await createPersona({
        ...common,
        line: form.line,
        ipProfile: opts
          ? {
              contentDirections: opts.lineDefaultDirections[form.line],
              forbiddenClaims: opts.lineDefaultForbidden[form.line],
            }
          : undefined,
      })
    }
    Message.success(props.editing ? '已保存' : '已新增人物')
    emit('saved', saved)
    emit('update:visible', false)
    done(true)
  } catch (e) {
    Message.error((e as Error).message)
    done(false)
  } finally {
    saving.value = false
  }
}
</script>
