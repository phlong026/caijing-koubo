<template>
  <div>
    <a-form :model="draft" layout="vertical" auto-label-width>
      <a-form-item label="角色类型">
        <a-auto-complete
          v-model="draft.role"
          :data="opt('roles')"
          :max-length="160"
          placeholder="如：基金经理 / 投资者教育专员（可自由输入）"
        />
      </a-form-item>
      <a-form-item label="专业方向">
        <a-auto-complete
          v-model="draft.serviceScope"
          :data="opt('serviceScopes')"
          :max-length="600"
          placeholder="如：宏观与市场解读、资产配置框架"
        />
      </a-form-item>
      <a-form-item label="表达风格">
        <a-auto-complete
          v-model="draft.expressionStyle"
          :data="opt('expressionStyles')"
          :max-length="600"
          placeholder="如：沉稳克制、数据先行"
        />
      </a-form-item>

      <a-form-item label="内容方向（最多 8 项，每项 ≤20 字）">
        <a-input-tag
          v-model="draft.contentDirections"
          :max-tag-count="8"
          allow-clear
          placeholder="回车添加"
          aria-label="内容方向"
        />
        <div v-if="suggestDirections.length" class="mt-1 flex gap-1.5 flex-wrap">
          <a-link v-for="d in suggestDirections" :key="d" @click="addDirection(d)">+ {{ d }}</a-link>
        </div>
      </a-form-item>

      <a-form-item
        label="内容配比（最多 6 项；填比例则全部必填且合计 100）"
        :validate-status="mixError ? 'error' : undefined"
        :help="mixError"
      >
        <div v-for="(m, i) in draft.contentMix" :key="i" class="flex items-center gap-2 mb-1.5">
          <a-input
            v-model="m.label"
            :max-length="20"
            placeholder="标签，如：知识科普"
            class="flex-1"
            :input-attrs="{ 'aria-label': `配比标签 ${i + 1}` }"
          />
          <a-input-number
            v-model="m.ratio"
            :min="0"
            :max="100"
            :precision="0"
            placeholder="比例%"
            class="!w-[110px]"
            :input-attrs="{ 'aria-label': `配比比例 ${i + 1}` }"
          />
          <a-button type="text" status="danger" :aria-label="`移除配比 ${i + 1}`" @click="draft.contentMix.splice(i, 1)"
            ><icon-delete
          /></a-button>
        </div>
        <a-button
          size="small"
          type="outline"
          :disabled="draft.contentMix.length >= 6"
          @click="draft.contentMix.push({ label: '', ratio: undefined })"
        >
          <template #icon><icon-plus /></template>添加
        </a-button>
      </a-form-item>

      <a-collapse :default-active-key="[]" :bordered="false" class="mb-3">
        <a-collapse-item key="persona" header="文案人设（注入文案改写，不得虚构经历 / 资质 / 承诺）">
          <a-form-item label="目标受众"
            ><a-textarea
              v-model="draft.targetAudience"
              :max-length="600"
              show-word-limit
              :auto-size="{ minRows: 2, maxRows: 5 }"
          /></a-form-item>
          <a-form-item label="受众需求"
            ><a-textarea
              v-model="draft.audienceNeeds"
              :max-length="600"
              show-word-limit
              :auto-size="{ minRows: 2, maxRows: 5 }"
          /></a-form-item>
          <a-form-item label="事实背景（真实素材，防止模型虚构）"
            ><a-textarea
              v-model="draft.factualBackground"
              :max-length="2000"
              show-word-limit
              :auto-size="{ minRows: 3, maxRows: 8 }"
          /></a-form-item>
          <a-form-item label="代表口播样稿（只学句式语气，不移植内容）"
            ><a-textarea
              v-model="draft.sampleScript"
              :max-length="2000"
              show-word-limit
              :auto-size="{ minRows: 3, maxRows: 8 }"
          /></a-form-item>
          <a-form-item label="禁用表达（作为硬禁用词参与合规扫描与选题约束）">
            <a-input-tag
              v-model="draft.forbiddenClaims"
              allow-clear
              placeholder="回车添加，如：稳赚不赔"
              aria-label="禁用表达"
            />
          </a-form-item>
        </a-collapse-item>
      </a-collapse>
    </a-form>

    <div class="flex items-center gap-2 mb-5">
      <a-button type="primary" :disabled="!dirty" :loading="saving" @click="save">保存定位</a-button>
      <a-button v-if="dirty" @click="reset">放弃修改</a-button>
      <span class="mw-subtle">
        <template v-if="dirty">有未保存的修改</template>
        <template v-else>已保存 · 定位版本 {{ persona.profileRevision }}</template>
      </span>
    </div>

    <a-divider />
    <div class="space-y-3 text-[13px]">
      <div class="flex items-center gap-2">
        <span class="w-[72px] text-[var(--mw-text3)]">归属主体</span>
        <span>{{ persona.ownerSubject || persona.name }}</span>
        <span v-if="persona.bindingMode === 'shared'" class="mw-tag mw-tag-blue">共享</span>
        <span v-else class="mw-tag mw-tag-gray">一对一</span>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <span class="w-[72px] text-[var(--mw-text3)]">可用范围</span>
        <template v-if="persona.bindings.length">
          <span v-for="b in persona.bindings" :key="b.id" class="mw-tag mw-tag-gray"
            >{{ PLATFORM_LABEL[b.platform] }} · {{ b.displayName }}</span
          >
        </template>
        <span v-else class="mw-subtle">尚未绑定账号</span>
        <a-button size="mini" type="text" :disabled="persona.status === 'archived'" @click="$emit('open-bindings')"
          >管理</a-button
        >
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <span class="w-[72px] text-[var(--mw-text3)]">授权材料</span>
        <span class="mw-tag" :class="authTag.cls">{{ authTag.text }}</span>
        <span v-if="authTag.hint" class="mw-subtle">{{ authTag.hint }}</span>
        <a-button size="mini" type="text" @click="$emit('open-authorizations')">授权管理</a-button>
      </div>
    </div>

    <a-modal
      v-model:visible="conflictVisible"
      title="已被其他人修改"
      ok-text="载入最新"
      cancel-text="继续编辑"
      @ok="reload"
    >
      该人物的定位已在别处更新。载入最新会丢弃你当前未保存的修改；也可以先复制需要保留的内容再载入。
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { savePersonaProfile, type IpProfile, type PersonaDetail, type PersonaOptions } from '@/api/personas'
import { AUTH_STATUS, fmtDate, isApiCode, PLATFORM_LABEL, toastError } from './shared'

const props = defineProps<{ persona: PersonaDetail; options: PersonaOptions | null }>()
const emit = defineEmits<{
  (e: 'saved'): void
  (e: 'open-bindings'): void
  (e: 'open-authorizations'): void
  (e: 'reload'): void
}>()

interface Draft {
  role: string
  serviceScope: string
  expressionStyle: string
  targetAudience: string
  audienceNeeds: string
  factualBackground: string
  sampleScript: string
  forbiddenClaims: string[]
  contentDirections: string[]
  contentMix: Array<{ label: string; ratio?: number }>
}

function fromProfile(p: IpProfile): Draft {
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
    contentMix: (p.contentMix ?? []).map((m) => ({ label: m.label, ratio: m.ratio })),
  }
}

const draft = reactive<Draft>(fromProfile(props.persona.ipProfile))
const saving = ref(false)
const conflictVisible = ref(false)

/** 序列化比较：规范化与后端一致（空串 / 空项不计） */
function norm(d: Draft): string {
  return JSON.stringify({
    ...d,
    forbiddenClaims: d.forbiddenClaims.map((s) => s.trim()).filter(Boolean),
    contentDirections: d.contentDirections.map((s) => s.trim()).filter(Boolean),
    contentMix: d.contentMix
      .filter((m) => m.label.trim())
      .map((m) => ({ label: m.label.trim(), ratio: m.ratio ?? null })),
  })
}
const baseline = ref(norm(draft))
const dirty = computed(() => norm(draft) !== baseline.value)

// 切换人物、或后端版本变化（保存 / 他处修改后刷新）时重置草稿；有未保存修改时不被轮询覆盖
watch(
  () => [props.persona.id, props.persona.profileRevision] as const,
  ([id], [prevId]) => {
    // 换人物：无条件重置；同一人物版本变化：仅在没有未保存修改时同步，避免轮询冲掉正在编辑的内容
    if (id !== prevId || !dirty.value) reset()
  },
)

function reset(): void {
  Object.assign(draft, fromProfile(props.persona.ipProfile))
  baseline.value = norm(draft)
}

function opt(key: 'roles' | 'serviceScopes' | 'expressionStyles'): string[] {
  const o = props.options?.ipOptions as Record<string, string[]> | undefined
  return o?.[key] ?? []
}

const suggestDirections = computed(() => {
  const defaults = props.options?.lineDefaultDirections?.[props.persona.line] ?? []
  return defaults.filter((d) => !draft.contentDirections.includes(d)).slice(0, 6)
})
function addDirection(d: string): void {
  if (draft.contentDirections.length < 8) draft.contentDirections.push(d)
}

const mixError = computed(() => {
  const items = draft.contentMix.filter((m) => m.label.trim())
  const withRatio = items.filter((m) => m.ratio !== undefined && m.ratio !== null)
  if (!withRatio.length) return ''
  if (withRatio.length !== items.length) return '填写了比例的话，所有配比项都需要填写比例'
  const sum = withRatio.reduce((a, m) => a + Number(m.ratio), 0)
  return sum === 100 ? '' : `比例合计需为 100（当前 ${sum}）`
})

const authTag = computed(() => {
  if (props.persona.line === 'persona') {
    const n = props.persona.authorizations.length
    return { text: n ? '已留档' : '不强制', cls: 'mw-tag-gray', hint: '素人矩阵不强制授权' }
  }
  const auths = props.persona.authorizations
  const valid = auths.filter((a) => a.status === 'verified')
  if (valid.length) {
    const sorted = valid.map((a) => a.expiresAt ?? '').sort()
    const latest = sorted[sorted.length - 1]
    const expiring = props.persona.extraTags.includes('auth_expiring')
    return {
      text: expiring ? '即将到期' : '已核验',
      cls: expiring ? 'mw-tag-orange' : AUTH_STATUS.verified.cls,
      hint: `至 ${fmtDate(latest)}`,
    }
  }
  if (auths.some((a) => a.status === 'expired'))
    return { text: AUTH_STATUS.expired.text, cls: AUTH_STATUS.expired.cls, hint: '' }
  if (auths.some((a) => a.status === 'revoked'))
    return { text: AUTH_STATUS.revoked.text, cls: AUTH_STATUS.revoked.cls, hint: '' }
  if (auths.some((a) => a.status === 'pending'))
    return { text: AUTH_STATUS.pending.text, cls: AUTH_STATUS.pending.cls, hint: '' }
  return { text: '未上传', cls: 'mw-tag-yellow', hint: '需上传并核验授权后人物才可用' }
})

async function save(): Promise<void> {
  if (mixError.value) {
    Message.warning(mixError.value)
    return
  }
  saving.value = true
  try {
    const clean = JSON.parse(norm(draft)) as Record<string, unknown>
    // 比例统一还原：null 表示未填
    clean.contentMix = (clean.contentMix as Array<{ label: string; ratio: number | null }>).map((m) =>
      m.ratio === null ? { label: m.label } : m,
    )
    const r = await savePersonaProfile(props.persona.id, clean, props.persona.rev)
    Message.success(r.changed ? `已保存，生成人物版本` : '内容没有变化')
    baseline.value = norm(draft)
    emit('saved')
  } catch (e) {
    if (isApiCode(e, 'PERSONA_CONFLICT')) conflictVisible.value = true
    else toastError(e)
  } finally {
    saving.value = false
  }
}

function reload(): void {
  emit('reload')
  conflictVisible.value = false
}
</script>
