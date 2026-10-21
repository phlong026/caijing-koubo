<template>
  <a-spin :loading="loading && !detail" class="w-full">
    <p v-if="error" class="mw-subtle" role="alert">{{ error }}</p>
    <template v-if="detail">
      <div class="flex items-start gap-2">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="detail-name">{{ detail.name }}</h2>
            <LineTag :line="detail.line" />
            <span class="mw-tag" :class="toneClass(PERSONA_STATUS[detail.status].tone)">{{ PERSONA_STATUS[detail.status].label }}</span>
          </div>
          <div class="mw-subtle mt-1">
            归属主体：{{ detail.ownerSubject || detail.name }} · 绑定方式：{{ detail.bindingMode === 'shared' ? '共享' : '一对一' }}
            <template v-if="currentVersionNo"> · 人物版本 v{{ currentVersionNo }}</template>
          </div>
        </div>
        <a-dropdown trigger="click" position="br">
          <a-button size="small">操作<icon-down /></a-button>
          <template #content>
            <a-doption :disabled="archived" @click="editVisible = true">编辑基础信息</a-doption>
            <a-doption v-if="!archived" @click="toggleEnabled">{{ detail.enabled ? '停用人物' : '启用人物' }}</a-doption>
            <a-doption v-if="!archived" @click="archive(false)">归档人物</a-doption>
          </template>
        </a-dropdown>
      </div>

      <div v-if="detail.statusReasons.length" class="detail-alert" role="status">
        <icon-exclamation-circle />
        <span>{{ detail.statusReasons.map((r) => r.message).join('；') }}</span>
      </div>

      <div class="readiness">
        <div v-for="r in readiness" :key="r.purpose" class="readiness-item">
          <div class="flex items-center gap-2">
            <strong>{{ PURPOSE_LABELS[r.purpose] }}</strong>
            <span class="mw-tag" :class="r.pass ? 'mw-tag-green' : 'mw-tag-yellow'">{{ r.pass ? '就绪' : '未就绪' }}</span>
          </div>
          <ul>
            <li v-for="c in r.checks.filter((c) => !c.pass)" :key="c.key" :class="c.level">{{ c.message }}</li>
          </ul>
        </div>
      </div>

      <a-tabs v-model:active-key="tab" size="small" class="mw-tabs mt-2" lazy-load>
        <a-tab-pane key="ip" title="IP 定位">
          <IpProfilePanel :detail="detail" :options="options" :readonly="archived" @changed="reload" />
        </a-tab-pane>
        <a-tab-pane key="auth">
          <template #title>授权材料<span v-if="pendingAuthCount" class="tab-dot">{{ pendingAuthCount }}</span></template>
          <AuthorizationPanel :detail="detail" :readonly="archived" @changed="reload" />
        </a-tab-pane>
        <a-tab-pane key="assets">
          <template #title>形象与素材<span v-if="pendingAssetCount" class="tab-dot">{{ pendingAssetCount }}</span></template>
          <AssetPanel :detail="detail" :options="options" :readonly="archived" @changed="reload" />
        </a-tab-pane>
        <a-tab-pane v-if="rule.avatarAllowed" key="avatar" title="口播分身">
          <AvatarPanel :detail="detail" :options="options" :readonly="archived" @changed="reload" />
        </a-tab-pane>
        <a-tab-pane v-if="rule.voiceAllowed" key="voice" title="声音档案">
          <VoicePanel :detail="detail" :options="options" :readonly="archived" @changed="reload" />
        </a-tab-pane>
        <a-tab-pane key="accounts" title="账号绑定">
          <BindingPanel :detail="detail" :options="options" :readonly="archived" @changed="reload" />
        </a-tab-pane>
        <a-tab-pane key="versions" title="版本">
          <ul class="version-list">
            <li v-for="v in detail.versions" :key="v.id">
              <strong>v{{ v.versionNo }}</strong>
              <span>{{ TRIGGER_LABELS[v.trigger] ?? v.trigger }}</span>
              <span class="mw-subtle">{{ v.createdBy ?? '' }} · {{ fmtTime(v.createdAt) }}</span>
            </li>
            <li v-if="!detail.versions.length" class="mw-subtle">暂无版本</li>
          </ul>
          <p class="mw-subtle mt-2">IP 定位或默认分身 / 声音变化时自动生成新版本；文案与视频引用生成时的版本快照，不受后续修改影响。</p>
        </a-tab-pane>
      </a-tabs>
    </template>

    <a-modal v-model:visible="editVisible" title="编辑基础信息" :ok-loading="saving" @ok="saveBasic" @before-open="fillEdit">
      <div class="flex flex-col gap-3">
        <a-input v-model="edit.name" :max-length="40" placeholder="人物名称" />
        <a-input v-model="edit.ownerSubject" :max-length="60" placeholder="归属主体" />
        <a-input v-model="edit.description" :max-length="120" placeholder="简介" />
        <a-radio-group v-if="rule.bindingModes.length > 1" v-model="edit.bindingMode">
          <a-radio value="exclusive">一对一</a-radio>
          <a-radio value="shared">共享</a-radio>
        </a-radio-group>
      </div>
    </a-modal>
  </a-spin>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import LineTag from '@/components/LineTag.vue'
import {
  archivePersona,
  getPersonaDetail,
  getReadiness,
  patchPersona,
  setPersonaEnabled,
  type BindingMode,
  type PersonaDetail,
  type PersonaOptions,
  type ReadinessCheck,
} from '@/api/personas'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import IpProfilePanel from './IpProfilePanel.vue'
import AuthorizationPanel from './AuthorizationPanel.vue'
import AssetPanel from './AssetPanel.vue'
import AvatarPanel from './AvatarPanel.vue'
import VoicePanel from './VoicePanel.vue'
import BindingPanel from './BindingPanel.vue'
import { PERSONA_STATUS, fmtTime, toneClass } from './labels'

const props = defineProps<{ personaId: string; options: PersonaOptions }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

type Purpose = 'copy' | 'avatar_video' | 'mixcut'
const PURPOSE_LABELS: Record<Purpose, string> = { copy: '文案', avatar_video: '数字人口播', mixcut: '素材混剪' }
const TRIGGER_LABELS: Record<string, string> = {
  initial: '初始版本',
  migrate: '存量迁移',
  profile: 'IP 定位变更',
  default_asset: '默认分身 / 声音变更',
  voice_settings: '声音参数调整',
}

const auth = useAuthStore()
const detail = ref<PersonaDetail | null>(null)
const readiness = ref<Array<{ purpose: Purpose; pass: boolean; checks: ReadinessCheck[] }>>([])
const loading = ref(false)
const error = ref('')
const tab = ref('ip')
const editVisible = ref(false)
const saving = ref(false)
const edit = reactive({ name: '', ownerSubject: '', description: '', bindingMode: 'exclusive' as BindingMode })

const rule = computed(() => props.options.lineRules[detail.value?.line ?? 'persona'])
const archived = computed(() => detail.value?.status === 'archived')
const currentVersionNo = computed(() => detail.value?.versions.find((v) => v.id === detail.value?.currentVersionId)?.versionNo)
const pendingAuthCount = computed(() =>
  auth.hasRole('reviewer', 'admin') ? (detail.value?.authorizations ?? []).filter((a) => a.status === 'pending').length : 0,
)
const pendingAssetCount = computed(() =>
  auth.hasRole('reviewer', 'admin') ? (detail.value?.assets ?? []).filter((a) => a.status === 'pending_review').length : 0,
)
const busy = computed(() => {
  const d = detail.value
  if (!d) return false
  return (
    d.assets.some((a) => a.processing) ||
    d.avatars.some((a) => ['pending', 'submitting', 'running'].includes(a.status)) ||
    d.voices.some((v) => ['pending', 'submitting', 'running'].includes(v.status))
  )
})

async function reload(notify = true): Promise<void> {
  loading.value = true
  try {
    const d = await getPersonaDetail(props.personaId)
    detail.value = d
    const purposes: Purpose[] = props.options.lineRules[d.line].avatarAllowed ? ['copy', 'avatar_video', 'mixcut'] : ['copy', 'mixcut']
    readiness.value = await Promise.all(
      purposes.map(async (purpose) => {
        const r = await getReadiness(props.personaId, purpose)
        return { purpose, pass: r.pass, checks: r.checks }
      }),
    )
    error.value = ''
    if (notify) emit('changed')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function fillEdit(): void {
  const d = detail.value
  if (!d) return
  Object.assign(edit, { name: d.name, ownerSubject: d.ownerSubject ?? '', description: d.description ?? '', bindingMode: d.bindingMode })
}

async function saveBasic(): Promise<void> {
  const d = detail.value
  if (!d) return
  saving.value = true
  try {
    await patchPersona(d.id, { ...edit, rev: d.rev })
    Message.success('已保存')
    editVisible.value = false
    await reload()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(): Promise<void> {
  const d = detail.value
  if (!d) return
  try {
    await setPersonaEnabled(d.id, !d.enabled)
    Message.success(d.enabled ? '已停用' : '已启用')
    await reload()
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function archive(force: boolean): Promise<void> {
  const d = detail.value
  if (!d) return
  Modal.confirm({
    title: force ? '强制归档' : '归档人物',
    content: force
      ? '存在进行中的任务，强制归档后这些任务的结果将无法再使用。仅管理员可执行。'
      : '归档后人物不再出现在选题和文案的人物列表中，已生成的文案和视频不受影响。',
    okText: force ? '强制归档' : '归档',
    onOk: async () => {
      try {
        await archivePersona(d.id, force)
        Message.success('已归档')
        await reload()
      } catch (e) {
        if (e instanceof ApiError && e.code === 'PERSONA_IN_USE' && !force && auth.hasRole('admin')) {
          Modal.confirm({ title: '不能直接归档', content: `${e.message}。是否强制归档？`, okText: '强制归档', onOk: () => archive(true) })
          return
        }
        Message.error((e as Error).message)
      }
    },
  })
}

// 有素材处理中 / 克隆进行中时每 5 秒刷新一次，状态由后台轮询推进
let timer: number | undefined
onMounted(async () => {
  await reload(false)
  timer = window.setInterval(() => {
    if (busy.value && !document.hidden) void reload(false)
  }, 5000)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<style scoped>
.detail-name {
  font-size: 18px;
  font-weight: 700;
  margin: 0;
}
.detail-alert {
  margin-top: 12px;
  display: flex;
  gap: 6px;
  align-items: flex-start;
  padding: 8px 10px;
  border-radius: 6px;
  background: #fff7e8;
  color: #8a5a00;
  font-size: 13px;
}
.readiness {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
}
.readiness-item {
  border: 1px solid var(--mw-border-light);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
}
.readiness-item ul {
  margin: 6px 0 0;
  padding-left: 16px;
  color: var(--mw-text2);
}
.readiness-item li.soft {
  color: var(--mw-text3);
}
.tab-dot {
  margin-left: 4px;
  font-size: 11px;
  background: #b42318;
  color: #fff;
  border-radius: 8px;
  padding: 0 5px;
}
.version-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.version-list li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 6px 0;
  border-bottom: 1px solid var(--mw-border-light);
  font-size: 13px;
}
</style>
