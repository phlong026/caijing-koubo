<template>
  <div class="flex flex-col gap-3">
    <div class="field">
      <label>角色类型</label>
      <a-select v-model="form.role" allow-create allow-clear :disabled="readonly" placeholder="选择或输入角色">
        <a-option v-for="o in options.ipOptions.role" :key="o" :value="o" />
      </a-select>
    </div>
    <div class="field">
      <label>专业方向</label>
      <a-select v-model="form.serviceScope" allow-create allow-clear :disabled="readonly" placeholder="选择或输入专业方向">
        <a-option v-for="o in options.ipOptions.serviceScope" :key="o" :value="o" />
      </a-select>
    </div>
    <div class="field">
      <label>表达风格</label>
      <a-select v-model="form.expressionStyle" allow-create allow-clear :disabled="readonly" placeholder="选择或输入表达风格">
        <a-option v-for="o in options.ipOptions.expressionStyle" :key="o" :value="o" />
      </a-select>
    </div>
    <div class="field">
      <label>目标受众</label>
      <a-input v-model="form.targetAudience" :max-length="600" :disabled="readonly" placeholder="例如：刚开始接触基金的上班族" />
    </div>
    <div class="field">
      <label>内容方向 <span class="mw-subtle">最多 8 项</span></label>
      <a-select v-model="form.contentDirections" multiple allow-create :limit="8" :disabled="readonly" placeholder="选择或输入内容方向">
        <a-option v-for="o in options.ipOptions.contentDirection" :key="o" :value="o" />
      </a-select>
    </div>
    <div class="field">
      <label>内容配比 <span class="mw-subtle">最多 6 项；填写比例时合计须为 100</span></label>
      <div v-for="(m, i) in form.contentMix" :key="i" class="mix-row">
        <a-select v-model="m.label" allow-create :disabled="readonly" placeholder="方向" :style="{ flex: 1 }">
          <a-option v-for="o in options.contentMixPresets" :key="o" :value="o" />
        </a-select>
        <a-input-number v-model="m.ratio" :min="1" :max="100" :precision="0" :disabled="readonly" placeholder="比例" :style="{ width: '110px' }">
          <template #suffix>%</template>
        </a-input-number>
        <a-button v-if="!readonly" size="small" type="text" status="danger" aria-label="删除该项" @click="form.contentMix.splice(i, 1)"><icon-delete /></a-button>
      </div>
      <div class="flex items-center gap-3">
        <a-button v-if="!readonly && form.contentMix.length < 6" size="small" @click="form.contentMix.push({ label: '', ratio: undefined })"><icon-plus />添加</a-button>
        <span v-if="mixSum !== null" class="mw-subtle" :class="{ 'text-[#b42318]': mixSum !== 100 }">合计 {{ mixSum }}%</span>
      </div>
    </div>
    <div class="field">
      <label>合规禁用表达 <span class="mw-subtle">生成文案时作为硬约束，最多 30 条</span></label>
      <a-input-tag v-model="form.forbiddenClaims" :max-tag-count="30" allow-clear unique-value :disabled="readonly" placeholder="输入后回车添加" />
    </div>
    <a-collapse :bordered="false" :default-active-key="[]">
      <a-collapse-item key="more" header="更多人设资料（受众需求 / 事实背景 / 代表样稿）">
        <div class="flex flex-col gap-3">
          <div class="field">
            <label>受众需求</label>
            <a-textarea v-model="form.audienceNeeds" :max-length="600" show-word-limit :auto-size="{ minRows: 2, maxRows: 6 }" :disabled="readonly" />
          </div>
          <div class="field">
            <label>事实背景 <span class="mw-subtle">真实资料，生成时只按相关性引用，不扩写为经历</span></label>
            <a-textarea v-model="form.factualBackground" :max-length="2000" show-word-limit :auto-size="{ minRows: 3, maxRows: 8 }" :disabled="readonly" />
          </div>
          <div class="field">
            <label>代表口播样稿 <span class="mw-subtle">只学句式语气，不移植内容</span></label>
            <a-textarea v-model="form.sampleScript" :max-length="2000" show-word-limit :auto-size="{ minRows: 3, maxRows: 8 }" :disabled="readonly" />
          </div>
        </div>
      </a-collapse-item>
    </a-collapse>
    <div class="flex items-center gap-3">
      <a-button type="primary" :loading="saving" :disabled="readonly || !dirty" @click="save">保存定位</a-button>
      <span v-if="dirty" class="mw-subtle">有未保存的修改</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { savePersonaProfile, type PersonaDetail, type PersonaOptions } from '@/api/personas'

const props = defineProps<{ detail: PersonaDetail; options: PersonaOptions; readonly: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

interface Form {
  role: string
  serviceScope: string
  targetAudience: string
  expressionStyle: string
  forbiddenClaims: string[]
  audienceNeeds: string
  factualBackground: string
  sampleScript: string
  contentDirections: string[]
  contentMix: Array<{ label: string; ratio?: number }>
}

function fromDetail(): Form {
  const p = props.detail.ipProfile ?? ({} as PersonaDetail['ipProfile'])
  return {
    role: p.role ?? '',
    serviceScope: p.serviceScope ?? '',
    targetAudience: p.targetAudience ?? '',
    expressionStyle: p.expressionStyle ?? '',
    forbiddenClaims: [...(p.forbiddenClaims ?? [])],
    audienceNeeds: p.audienceNeeds ?? '',
    factualBackground: p.factualBackground ?? '',
    sampleScript: p.sampleScript ?? '',
    contentDirections: [...(p.contentDirections ?? [])],
    contentMix: (p.contentMix ?? []).map((m) => ({ label: m.label, ratio: m.ratio })),
  }
}

const form = reactive<Form>(fromDetail())
const baseline = ref(JSON.stringify(fromDetail()))
const saving = ref(false)
const dirty = computed(() => JSON.stringify(form) !== baseline.value)
const mixSum = computed(() => {
  const withRatio = form.contentMix.filter((m) => m.ratio !== undefined && m.ratio !== null)
  return withRatio.length ? withRatio.reduce((s, m) => s + Number(m.ratio), 0) : null
})

// 详情刷新（轮询）时，只在没有未保存修改的情况下同步表单
watch(
  () => props.detail.ipProfile,
  () => {
    if (dirty.value) return
    Object.assign(form, fromDetail())
    baseline.value = JSON.stringify(fromDetail())
  },
)

async function save(): Promise<void> {
  saving.value = true
  try {
    const payload = {
      ...form,
      contentMix: form.contentMix.filter((m) => m.label?.trim()).map((m) => (m.ratio ? { label: m.label, ratio: m.ratio } : { label: m.label })),
    }
    const r = await savePersonaProfile(props.detail.id, payload, props.detail.rev)
    Message.success(r.changed ? '已保存，并生成新的人物版本' : '内容未变化，无需保存')
    baseline.value = JSON.stringify(form)
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field > label {
  font-size: 13px;
  color: var(--mw-text2);
}
.mix-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
