<template>
  <div class="mw-card p-5">
    <div class="flex items-center gap-2 min-w-0">
      <span class="text-[18px] font-bold truncate">{{ persona.name }}</span>
      <LineTag :line="persona.line" />
      <span v-if="persona.isStub" class="mw-tag mw-tag-gray">示例</span>
      <div class="flex-1"></div>
      <a-switch
        v-if="!archived"
        :model-value="persona.enabled"
        size="small"
        :loading="toggling"
        :aria-label="persona.enabled ? '停用人物' : '启用人物'"
        @change="toggleEnabled"
      />
      <a-dropdown trigger="click" @select="(v) => onMore(String(v))">
        <a-button size="mini" aria-label="更多操作"><icon-more /></a-button>
        <template #content>
          <a-doption v-if="!archived" value="edit">编辑基本信息</a-doption>
          <a-doption value="versions">版本历史</a-doption>
          <a-doption v-if="!archived" value="archive" class="text-[#c2410c]">归档</a-doption>
        </template>
      </a-dropdown>
    </div>
    <div class="mt-1 flex items-center gap-1.5 flex-wrap">
      <span v-for="t in tags" :key="t.text" class="mw-tag" :class="t.cls">{{ t.text }}</span>
    </div>
    <div v-if="persona.statusReasons.length" class="mt-1 text-[12px] text-[#c2410c]">
      {{ persona.statusReasons.map((r) => r.message).join('；') }}
    </div>

    <a-tabs v-model:active-key="tab" size="small" class="mw-tabs people-tabs mt-2">
      <a-tab-pane key="ip" title="IP 定位" />
      <a-tab-pane key="photo" title="形象照片" />
      <a-tab-pane key="avatar" title="口播分身" />
      <a-tab-pane key="voice" title="声音档案" />
      <a-tab-pane key="bg" title="背景与空镜" />
    </a-tabs>

    <template v-if="tab === 'ip'">
      <ProfileTab :persona="persona" :options="options" :readonly="archived" @saved="$emit('changed')" @reload="$emit('changed')" />
      <div class="mt-4 pt-3 border-t border-[var(--mw-border)] flex flex-col gap-2.5 text-[13px]">
        <div class="flex"><span class="w-[76px] shrink-0 text-[var(--mw-text3)]">归属主体</span><span class="truncate">{{ persona.ownerSubject || persona.name }}</span></div>
        <div
          class="flex items-center"
          :class="archived ? '' : 'cursor-pointer'"
          :role="archived ? undefined : 'button'"
          :tabindex="archived ? undefined : 0"
          @click="!archived && (bindingVisible = true)"
          @keydown.enter="!archived && (bindingVisible = true)"
        >
          <span class="w-[76px] shrink-0 text-[var(--mw-text3)]">可用范围</span>
          <span class="truncate">{{ scopeSummary }}</span>
          <div class="flex-1"></div>
          <icon-right v-if="!archived" :size="13" class="text-[var(--mw-text3)]" />
        </div>
        <div class="flex items-center cursor-pointer" role="button" tabindex="0" @click="authVisible = true" @keydown.enter="authVisible = true">
          <span class="w-[76px] shrink-0 text-[var(--mw-text3)]">授权材料</span>
          <span class="mw-tag" :class="authTag.cls">{{ authTag.text }}</span>
          <div class="flex-1"></div>
          <icon-right :size="13" class="text-[var(--mw-text3)]" />
        </div>
      </div>
    </template>

    <AssetList
      v-else-if="tab === 'photo'"
      :persona-id="persona.id"
      kind="photo"
      :assets="persona.assets"
      title="形象照片"
      :limit="50"
      accept=".jpg,.jpeg,.png,.webp"
      :cover-asset-id="persona.coverAssetId"
      :readonly="archived"
      empty-text="上传最短边 ≥720px 的 jpg / png / webp 照片"
      @changed="$emit('changed')"
      @view="(a) => $emit('view-asset', a)"
    />

    <AvatarTab
      v-else-if="tab === 'avatar'"
      :persona="persona"
      :options="options"
      :readonly="archived"
      @changed="$emit('changed')"
      @view-asset="(a) => $emit('view-asset', a)"
    />

    <VoiceTab v-else-if="tab === 'voice'" :persona="persona" :options="options" :readonly="archived" @changed="$emit('changed')" />

    <div v-else class="flex flex-col gap-4">
      <div class="mw-subtle">口播视频的背景由分身素材决定，此处素材用于剪辑、封面与混剪。</div>
      <AssetList
        v-for="g in backgroundGroups"
        :key="g.kind"
        :persona-id="persona.id"
        :kind="g.kind"
        :assets="persona.assets"
        :title="g.title"
        :limit="30"
        :accept="g.accept"
        :layout="g.kind === 'background_image' ? 'grid' : 'list'"
        :readonly="archived"
        :empty-text="g.empty"
        @changed="$emit('changed')"
        @view="(a) => $emit('view-asset', a)"
      />
    </div>

    <AuthorizationDrawer
      v-model:visible="authVisible"
      :persona-id="persona.id"
      :authorizations="persona.authorizations"
      :readonly="archived"
      @changed="$emit('changed')"
    />
    <AccountBindingDialog v-model:visible="bindingVisible" :persona="persona" :options="options" @changed="$emit('changed')" />

    <a-drawer v-model:visible="versionsVisible" :width="360" title="版本历史" :footer="false">
      <div class="mw-subtle mb-3">IP 定位、默认分身 / 声音或声音参数变化时生成版本；文案与视频会记录生成时用的版本。</div>
      <div v-for="v in persona.versions" :key="v.id" class="py-2 border-b border-[var(--mw-border)]">
        <div class="flex items-center gap-2">
          <span class="text-[13.5px] font-medium">v{{ v.versionNo }}</span>
          <span class="mw-tag mw-tag-gray">{{ TRIGGER_LABELS[v.trigger] ?? v.trigger }}</span>
          <span v-if="persona.currentVersionId === v.id" class="mw-tag mw-tag-deep">当前</span>
        </div>
        <div class="mw-subtle mt-0.5">{{ dateOnly(v.createdAt) }} · {{ v.createdBy || 'system' }}</div>
      </div>
    </a-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import LineTag from '@/components/LineTag.vue'
import {
  archivePersona,
  setPersonaEnabled,
  type AssetKind,
  type PersonaAsset,
  type PersonaDetail,
  type PersonaOptions,
} from '@/api/personas'
import ProfileTab from './ProfileTab.vue'
import AssetList from './AssetList.vue'
import AvatarTab from './AvatarTab.vue'
import VoiceTab from './VoiceTab.vue'
import AuthorizationDrawer from './AuthorizationDrawer.vue'
import AccountBindingDialog from './AccountBindingDialog.vue'
import { authorizationSummary, dateOnly, personaTags } from './labels'
import { confirmAction } from './prompt'

const props = defineProps<{ persona: PersonaDetail; options: PersonaOptions | null }>()
const emit = defineEmits<{ (e: 'changed'): void; (e: 'edit'): void; (e: 'view-asset', asset: PersonaAsset): void }>()

const TRIGGER_LABELS: Record<string, string> = {
  profile: 'IP 定位变更',
  default_asset: '默认分身 / 声音变更',
  voice_settings: '声音参数变更',
  migrate: '存量迁移',
}

const tab = ref('ip')
const toggling = ref(false)
const authVisible = ref(false)
const bindingVisible = ref(false)
const versionsVisible = ref(false)

// 切换人物时回到第一个 Tab，避免停在素人线没有内容的分身 / 声音页
watch(
  () => props.persona.id,
  () => {
    tab.value = 'ip'
  },
)

const archived = computed(() => !!props.persona.archivedAt)
const tags = computed(() => personaTags(props.persona))
const authTag = computed(() => authorizationSummary(props.persona.authorizations))

const scopeSummary = computed(() => {
  const n = props.persona.bindings.length
  if (!n) return props.persona.bindingMode === 'shared' ? '共享 · 未绑定账号' : '一对一 · 未绑定账号'
  const names = props.persona.bindings.map((b) => b.displayName || b.accountKey).join('、')
  return `${props.persona.bindingMode === 'shared' ? '共享' : '一对一'} · ${names}`
})

const backgroundGroups: Array<{ kind: AssetKind; title: string; accept: string; empty: string }> = [
  { kind: 'background_image', title: '背景图', accept: '.jpg,.jpeg,.png,.webp', empty: 'jpg / png / webp，≤10MB' },
  { kind: 'background_video', title: '背景视频', accept: '.mp4,.mov', empty: 'mp4 / mov，≤60 秒' },
  { kind: 'broll_video', title: '空镜视频', accept: '.mp4,.mov', empty: 'mp4 / mov，≤60 秒，可打标签供混剪匹配' },
]

async function toggleEnabled(value: string | number | boolean) {
  const enable = Boolean(value)
  if (!enable && !(await confirmAction('停用人物', '停用后该人物不会出现在选题与文案的人物选择中，已有文案和视频不受影响。', '停用'))) return
  toggling.value = true
  try {
    await setPersonaEnabled(props.persona.id, enable)
    Message.success(enable ? '已启用' : '已停用')
    emit('changed')
  } catch (e) {
    // 启用失败时后端会列出缺项（FR-L4）
    Modal.warning({ title: enable ? '暂时不能启用' : '停用失败', content: (e as Error).message })
  } finally {
    toggling.value = false
  }
}

async function onMore(action: string) {
  if (action === 'edit') emit('edit')
  else if (action === 'versions') versionsVisible.value = true
  else if (action === 'archive') await archive()
}

async function archive() {
  const ok = await confirmAction(
    '归档人物',
    '归档后人物默认隐藏、只读，名称可被新人物使用；历史文案仍显示该人物。存在进行中的克隆或审核中的文案时不能归档。',
    '归档',
  )
  if (!ok) return
  try {
    await archivePersona(props.persona.id)
    Message.success('已归档')
    emit('changed')
  } catch (e) {
    Modal.warning({ title: '不能归档', content: (e as Error).message })
  }
}
</script>
