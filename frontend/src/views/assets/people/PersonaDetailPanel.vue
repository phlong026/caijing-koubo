<template>
  <div class="mw-card p-5 people-detail">
    <div class="flex items-center gap-2 flex-wrap">
      <span class="text-[18px] font-bold">{{ persona.name }}</span>
      <LineTag :line="persona.line" />
      <span v-if="persona.isStub" class="mw-tag mw-tag-gray">示例</span>
      <span class="flex-1" />
      <a-switch
        :model-value="persona.enabled"
        :disabled="persona.status === 'archived' || toggling"
        :loading="toggling"
        aria-label="启用人物"
        @change="toggle"
      />
      <a-dropdown trigger="click" @select="onMore">
        <a-button size="small" type="text" aria-label="更多操作"><icon-more /></a-button>
        <template #content>
          <a-doption value="edit" :disabled="persona.status === 'archived'">编辑基本信息</a-doption>
          <a-doption value="versions">版本历史</a-doption>
          <a-doption value="auth">授权管理</a-doption>
          <a-doption value="archive" :disabled="persona.status === 'archived'">归档人物</a-doption>
        </template>
      </a-dropdown>
    </div>

    <div class="mt-2 flex items-center gap-1.5 flex-wrap">
      <span class="mw-tag" :class="STATUS_TAG[persona.status]">{{ persona.statusLabel }}</span>
      <span v-for="t in extraTags" :key="t.text" class="mw-tag" :class="t.cls">{{ t.text }}</span>
      <span v-if="persona.currentVersionId" class="mw-subtle">人物版本 {{ versionLabel }}</span>
    </div>
    <div v-if="persona.statusReasons.length" class="mw-alert-banner mt-3" role="alert">
      <div v-for="r in persona.statusReasons" :key="r.code">{{ r.message }}</div>
      <a-button v-if="needsAuth" size="mini" type="text" class="mt-1" @click="authVisible = true">去处理授权</a-button>
    </div>

    <a-tabs v-model:active-key="tab" size="small" class="mw-tabs people-tabs mt-3" lazy-load>
      <a-tab-pane key="ip" title="IP 定位">
        <ProfileTab
          :persona="persona"
          :options="options"
          @saved="$emit('changed')"
          @reload="$emit('reload')"
          @open-bindings="bindingVisible = true"
          @open-authorizations="authVisible = true"
        />
      </a-tab-pane>
      <a-tab-pane key="photo" title="形象照片"
        ><PhotoTab :persona="persona" :options="options" @changed="$emit('changed')"
      /></a-tab-pane>
      <a-tab-pane key="avatar" title="口播分身"
        ><AvatarTab :persona="persona" :options="options" @changed="$emit('changed')"
      /></a-tab-pane>
      <a-tab-pane key="voice" title="声音档案"
        ><VoiceTab :persona="persona" :options="options" @changed="$emit('changed')"
      /></a-tab-pane>
      <a-tab-pane key="bg" title="背景与空镜"
        ><BackgroundTab :persona="persona" :options="options" @changed="$emit('changed')"
      /></a-tab-pane>
    </a-tabs>

    <AuthorizationDrawer v-model:visible="authVisible" :persona="persona" @changed="$emit('changed')" />
    <AccountBindingDialog v-model:visible="bindingVisible" :persona="persona" @saved="$emit('changed')" />
    <VersionDrawer
      v-model:visible="versionVisible"
      :persona-id="persona.id"
      :current-version-id="persona.currentVersionId"
    />
    <PersonaFormDialog
      v-model:visible="editVisible"
      :persona="persona"
      :options="options"
      @saved="$emit('changed')"
      @conflict="$emit('reload')"
    />

    <a-modal v-model:visible="blockVisible" title="暂时不能归档" :footer="false">
      <div class="text-[13.5px] leading-6" role="alert">{{ blockReason }}</div>
      <div class="mw-subtle mt-2">处理完上述事项后再归档；归档后名称可被新人物使用，历史文案仍会显示人物名。</div>
    </a-modal>
    <a-modal v-model:visible="enableVisible" title="暂时不能启用" :footer="false">
      <div class="text-[13.5px] leading-6" role="alert">{{ enableReason }}</div>
      <div v-if="enableList.length" class="mt-2">
        <div v-for="r in enableList" :key="r" class="text-[13px]">· {{ r }}</div>
      </div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import LineTag from '@/components/LineTag.vue'
import { archivePersona, setPersonaEnabled, type PersonaDetail, type PersonaOptions } from '@/api/personas'
import { ApiError } from '@/api/client'
import AccountBindingDialog from './AccountBindingDialog.vue'
import AuthorizationDrawer from './AuthorizationDrawer.vue'
import AvatarTab from './AvatarTab.vue'
import BackgroundTab from './BackgroundTab.vue'
import PersonaFormDialog from './PersonaFormDialog.vue'
import PhotoTab from './PhotoTab.vue'
import ProfileTab from './ProfileTab.vue'
import VersionDrawer from './VersionDrawer.vue'
import VoiceTab from './VoiceTab.vue'
import { EXTRA_TAGS, STATUS_TAG, isApiCode, toastError } from './shared'

const props = defineProps<{ persona: PersonaDetail; options: PersonaOptions | null }>()
const emit = defineEmits<{ (e: 'changed'): void; (e: 'reload'): void; (e: 'archived'): void }>()

const tab = ref('ip')
const toggling = ref(false)
const authVisible = ref(false)
const bindingVisible = ref(false)
const versionVisible = ref(false)
const editVisible = ref(false)
const blockVisible = ref(false)
const blockReason = ref('')
const enableVisible = ref(false)
const enableReason = ref('')
const enableList = ref<string[]>([])

watch(
  () => props.persona.id,
  () => {
    tab.value = 'ip'
  },
)

const extraTags = computed(() => {
  if (props.persona.status === 'archived' || props.persona.status === 'disabled') return []
  return props.persona.extraTags.map((t) => EXTRA_TAGS[t]).filter(Boolean)
})
const needsAuth = computed(() => ['auth_pending', 'auth_expired', 'auth_revoked'].includes(props.persona.status))
const versionLabel = computed(
  () => props.persona.versions.find((v) => v.id === props.persona.currentVersionId)?.versionNo ?? '',
)

async function toggle(next: string | number | boolean): Promise<void> {
  toggling.value = true
  try {
    await setPersonaEnabled(props.persona.id, !!next)
    Message.success(next ? '已启用' : '已停用')
    emit('changed')
  } catch (e) {
    // 启用被拒：列出缺项（FR-L4）；开关保持原状（受控）
    if (e instanceof ApiError && e.status === 409) {
      enableReason.value = e.message
      enableList.value = []
      enableVisible.value = true
    } else toastError(e)
  } finally {
    toggling.value = false
  }
}

function onMore(v: string | number | Record<string, unknown> | undefined): void {
  if (v === 'edit') editVisible.value = true
  else if (v === 'versions') versionVisible.value = true
  else if (v === 'auth') authVisible.value = true
  else if (v === 'archive') confirmArchive()
}

function confirmArchive(): void {
  Modal.confirm({
    title: `归档「${props.persona.name}」？`,
    content: '归档后列表默认隐藏、只读，名称占用释放；历史文案仍显示人物名。不提供物理删除。',
    okText: '归档',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try {
        await archivePersona(props.persona.id)
        Message.success('已归档')
        emit('archived')
      } catch (e) {
        if (isApiCode(e, 'PERSONA_IN_USE')) {
          blockReason.value = (e as Error).message
          blockVisible.value = true
        } else toastError(e)
      }
    },
  })
}
</script>
