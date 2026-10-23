<template>
  <div class="people-profile">
    <div class="mw-form-row">
      <div class="mw-form-label">角色类型</div>
      <a-select v-model="form.role" allow-create allow-clear placeholder="选择或输入" :disabled="readonly" class="flex-1 min-w-0">
        <a-option v-for="o in ipOptions.role" :key="o" :value="o">{{ o }}</a-option>
      </a-select>
    </div>
    <div class="mw-form-row">
      <div class="mw-form-label">专业方向</div>
      <a-select v-model="form.serviceScope" allow-create allow-clear placeholder="选择或输入" :disabled="readonly" class="flex-1 min-w-0">
        <a-option v-for="o in ipOptions.serviceScope" :key="o" :value="o">{{ o }}</a-option>
      </a-select>
    </div>
    <div class="mw-form-row">
      <div class="mw-form-label">表达风格</div>
      <a-select v-model="form.expressionStyle" allow-create allow-clear placeholder="选择或输入" :disabled="readonly" class="flex-1 min-w-0">
        <a-option v-for="o in ipOptions.expressionStyle" :key="o" :value="o">{{ o }}</a-option>
      </a-select>
    </div>
    <div class="mw-form-row">
      <div class="mw-form-label">内容方向</div>
      <a-select
        v-model="form.contentDirections"
        multiple
        allow-create
        :limit="8"
        :max-tag-count="3"
        placeholder="最多 8 项"
        :disabled="readonly"
        class="flex-1"
      >
        <a-option v-for="o in ipOptions.contentDirection" :key="o" :value="o">{{ o }}</a-option>
      </a-select>
    </div>
    <div class="mw-form-row items-start">
      <div class="mw-form-label pt-1">内容配比</div>
      <div class="flex-1 min-w-0">
        <div v-for="(m, i) in form.contentMix" :key="i" class="flex items-center gap-1.5 mb-1.5">
          <a-input v-model="m.label" size="small" :max-length="20" placeholder="标签" :disabled="readonly" class="flex-1" />
          <a-input-number v-model="m.ratio" size="small" :min="0" :max="100" placeholder="%" :disabled="readonly" style="width: 76px" />
          <a-button v-if="!readonly" size="mini" type="text" aria-label="移除配比项" @click="form.contentMix.splice(i, 1)"><icon-close /></a-button>
        </div>
        <div v-if="!readonly && form.contentMix.length < 6" class="flex gap-1.5 flex-wrap">
          <span
            v-for="p in mixPresets"
            :key="p"
            class="mw-tag mw-tag-gray cursor-pointer"
            role="button"
            @click="form.contentMix.push({ label: p, ratio: undefined })"
          >+ {{ p }}</span>
        </div>
        <div class="mw-subtle mt-1">比例可不填；填写时每项都要填，合计 100。</div>
      </div>
    </div>

    <a-collapse :bordered="false" class="people-collapse mt-1">
      <a-collapse-item key="persona" header="文案人设">
        <div class="mw-form-row"><div class="mw-form-label">目标受众</div><a-input v-model="form.targetAudience" :max-length="80" :disabled="readonly" /></div>
        <div class="mw-form-row items-start"><div class="mw-form-label pt-1">受众需求</div><a-textarea v-model="form.audienceNeeds" :auto-size="{ minRows: 2, maxRows: 4 }" :max-length="300" :disabled="readonly" /></div>
        <div class="mw-form-row items-start"><div class="mw-form-label pt-1">事实背景</div><a-textarea v-model="form.factualBackground" :auto-size="{ minRows: 2, maxRows: 5 }" :max-length="1000" :disabled="readonly" /></div>
        <div class="mw-form-row items-start"><div class="mw-form-label pt-1">口播样稿</div><a-textarea v-model="form.sampleScript" :auto-size="{ minRows: 3, maxRows: 6 }" :max-length="2000" :disabled="readonly" /></div>
        <div class="mw-form-row items-start">
          <div class="mw-form-label pt-1">禁用表达</div>
          <a-input-tag v-model="form.forbiddenClaims" allow-clear unique-value placeholder="输入后回车" :disabled="readonly" />
        </div>
      </a-collapse-item>
    </a-collapse>

    <a-button
      v-if="!readonly"
      type="primary"
      long
      class="mt-3"
      :disabled="!dirty"
      :loading="saving"
      @click="save"
    >保存定位</a-button>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { ApiError } from '@/api/client'
import { getPersonaVersions, savePersonaProfile, type IpProfile, type PersonaDetail, type PersonaOptions } from '@/api/personas'

const props = defineProps<{ persona: PersonaDetail; options: PersonaOptions | null; readonly: boolean }>()
const emit = defineEmits<{ (e: 'saved'): void; (e: 'reload'): void }>()

interface MixRow {
  label: string
  ratio?: number
}

interface ProfileForm {
  role: string
  serviceScope: string
  expressionStyle: string
  targetAudience: string
  audienceNeeds: string
  factualBackground: string
  sampleScript: string
  forbiddenClaims: string[]
  contentDirections: string[]
  contentMix: MixRow[]
}

const ipOptions = computed(() => props.options?.ipOptions ?? { role: [], serviceScope: [], expressionStyle: [], contentDirection: [] })
const mixPresets = computed(() => {
  const used = new Set(form.contentMix.map((m) => m.label))
  return (props.options?.contentMixPresets ?? []).filter((p) => !used.has(p))
})

function toForm(p: IpProfile): ProfileForm {
  return {
    role: p.role ?? '',
    serviceScope: p.serviceScope ?? '',
    expressionStyle: p.expressionStyle ?? '',
    targetAudience: p.targetAudience ?? '',
    audienceNeeds: p.audienceNeeds ?? '',
    factualBackground: p.factualBackground ?? '',
    sampleScript: p.sampleScript ?? '',
    forbiddenClaims: [...(p.forbiddenClaims ?? [])],
    contentDirections: [...(p.contentDirections ?? [])],
    contentMix: (p.contentMix ?? []).map((m) => ({ label: m.label, ratio: m.ratio ?? undefined })),
  }
}

/** 规范化后比较：去首尾空白、去空项，与服务端 hash 口径一致，避免「没改也能保存」 */
function normalize(f: ProfileForm): IpProfile {
  const clean = (s: string) => s.trim()
  return {
    role: clean(f.role),
    serviceScope: clean(f.serviceScope),
    expressionStyle: clean(f.expressionStyle),
    targetAudience: clean(f.targetAudience),
    audienceNeeds: clean(f.audienceNeeds),
    factualBackground: clean(f.factualBackground),
    sampleScript: clean(f.sampleScript),
    forbiddenClaims: f.forbiddenClaims.map(clean).filter(Boolean),
    contentDirections: f.contentDirections.map(clean).filter(Boolean),
    contentMix: f.contentMix
      .filter((m) => clean(m.label))
      .map((m) => (m.ratio === undefined || m.ratio === null ? { label: clean(m.label) } : { label: clean(m.label), ratio: m.ratio })),
  }
}

const form = reactive<ProfileForm>(toForm(props.persona.ipProfile))
const baseline = ref(JSON.stringify(normalize(form)))
/** 表单载入时的 rev：保存时提交它而不是最新刷新到的 rev，别人改过就会触发冲突而不是被静默覆盖 */
const baseRev = ref(props.persona.rev)
const saving = ref(false)

const dirty = computed(() => JSON.stringify(normalize(form)) !== baseline.value)

/** 冲突后用户选择「载入最新」：下一次服务端数据到达时无条件覆盖本地修改 */
let forceReset = false

/** 切换人物或服务端数据变化时重置表单；同一人物有未保存修改时不覆盖（轮询刷新不打断编辑） */
watch(
  () => [props.persona.id, props.persona.rev] as const,
  ([id], [prevId]) => {
    if (id === prevId && dirty.value && !forceReset) return
    forceReset = false
    Object.assign(form, toForm(props.persona.ipProfile))
    baseline.value = JSON.stringify(normalize(form))
    baseRev.value = props.persona.rev
  },
)

/** 保存接口只返回版本 id，版本号从版本列表取；取不到时不影响保存结果 */
async function versionNoOf(versionId: string | null): Promise<string> {
  if (!versionId) return '—'
  try {
    const list = await getPersonaVersions(props.persona.id)
    return String(list.find((v) => v.id === versionId)?.versionNo ?? '—')
  } catch {
    return '—'
  }
}

function mixError(profile: IpProfile): string | null {
  const mix = profile.contentMix ?? []
  const withRatio = mix.filter((m) => m.ratio !== undefined)
  if (!withRatio.length) return null
  if (withRatio.length !== mix.length) return '内容配比：填写比例时每一项都要填'
  const sum = withRatio.reduce((s, m) => s + (m.ratio ?? 0), 0)
  return sum === 100 ? null : `内容配比合计为 ${sum}，需要等于 100`
}

async function save(): Promise<void> {
  const profile = normalize(form)
  const invalid = mixError(profile)
  if (invalid) {
    Message.warning(invalid)
    return
  }
  saving.value = true
  try {
    const r = await savePersonaProfile(props.persona.id, profile, baseRev.value)
    baseline.value = JSON.stringify(profile)
    baseRev.value = r.persona.rev
    Message.success(r.changed ? `已保存，生成人物版本 v${await versionNoOf(r.versionId)}` : '内容未变化，未生成新版本')
    emit('saved')
  } catch (e) {
    if (e instanceof ApiError && e.code === 'PERSONA_CONFLICT') {
      Modal.warning({
        title: '人物已在别处修改',
        content: '当前编辑基于旧数据。载入最新内容后，你的未保存修改会被丢弃。',
        okText: '载入最新',
        hideCancel: false,
        onOk: () => {
          forceReset = true
          emit('reload')
        },
      })
    } else {
      Message.error((e as Error).message)
    }
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.people-profile :deep(.mw-form-row) {
  padding: 5px 0;
}
.people-collapse :deep(.arco-collapse-item-header) {
  padding-left: 0;
  font-size: 13px;
}
.people-collapse :deep(.arco-collapse-item-content) {
  padding: 0;
  background: transparent;
}
</style>
