<template>
  <div v-if="!lineAllowsClone" class="mw-subtle text-center py-8">素人矩阵不使用数字人口播</div>
  <div v-else class="flex flex-col gap-4">
    <AssetList
      :persona-id="persona.id"
      kind="avatar_source"
      :assets="persona.assets"
      title="分身素材"
      :limit="10"
      accept=".mp4,.mov"
      layout="list"
      :readonly="readonly"
      empty-text="上传 10 秒–10 分钟的口播视频，审核通过后可制作分身"
      @changed="$emit('changed')"
      @view="(a) => $emit('view-asset', a)"
    >
      <template #actions="{ asset }">
        <a-button v-if="asset.status === 'approved'" size="mini" type="primary" @click="openClone(asset)">制作分身</a-button>
      </template>
    </AssetList>

    <div>
      <div class="flex items-center gap-2 mb-2">
        <span class="text-[13px] font-medium">飞影分身</span>
        <span class="mw-subtle">{{ persona.avatars.length }}</span>
      </div>
      <div v-if="!persona.avatars.length" class="mw-subtle text-center py-5 border border-dashed border-[var(--mw-border)] rounded-[10px]">
        暂无口播分身
      </div>
      <div v-for="av in persona.avatars" :key="av.id" class="p-2.5 mb-2 rounded-[10px] border border-[var(--mw-border)]">
        <div class="flex items-center gap-2.5">
          <div class="w-[56px] h-[40px] rounded-[6px] overflow-hidden bg-[#eef1ee] shrink-0">
            <img v-if="av.coverUrl" :src="av.coverUrl" alt="" class="w-full h-full object-cover" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="text-[13px] font-medium truncate">{{ av.name }}</span>
              <span v-if="persona.defaultAvatarId === av.id" class="mw-tag mw-tag-deep">默认</span>
            </div>
            <div class="mw-subtle truncate">
              {{ [av.backgroundLabel, sizeText(av), formatDuration(av.sourceDurationMs)].filter(Boolean).join(' · ') }}
            </div>
          </div>
          <span class="mw-tag" :class="cloneStatusTag(av.status, 'avatar').cls">{{ cloneStatusTag(av.status, 'avatar').text }}</span>
        </div>
        <div v-if="av.status === 'uncertain'" class="mt-1.5 text-[12px] text-[#c2410c]">状态待核对，请先核对状态，勿重复创建</div>
        <div v-else-if="av.status === 'failed' && av.error" class="mt-1.5 text-[12px] text-[#c2410c]">{{ av.error }}</div>
        <div v-if="!readonly" class="mt-2 flex gap-1.5 flex-wrap">
          <a-button v-if="av.status === 'ready' && persona.defaultAvatarId !== av.id" size="mini" @click="run(() => setDefaultAvatar(av.id), '已设为默认分身')">设为默认</a-button>
          <a-button v-if="av.status === 'running'" size="mini" @click="run(() => refreshAvatar(av.id), '已刷新状态')">立即查询</a-button>
          <a-button v-if="av.status === 'uncertain'" size="mini" type="primary" @click="run(() => reconcileAvatar(av.id), '已核对')">核对状态</a-button>
          <a-button size="mini" @click="rename(av)">重命名</a-button>
          <a-button v-if="!busyStatuses.includes(av.status)" size="mini" @click="remove(av)">删除</a-button>
        </div>
      </div>
    </div>

    <a-modal
      v-model:visible="clone.visible"
      :title="consentText.title"
      :ok-loading="clone.submitting"
      ok-text="提交制作"
      :mask-closable="false"
      @before-ok="submitClone"
    >
      <div v-if="!portraitAuths.length" class="text-[13px] text-[#c2410c]">
        该人物没有已核验、未过期且范围含「肖像」的授权，请先在授权材料中上传并核验。
      </div>
      <template v-else>
        <div class="mw-form-row">
          <div class="mw-form-label">授权材料</div>
          <a-select v-model="clone.authorizationId" class="flex-1">
            <a-option v-for="a in portraitAuths" :key="a.id" :value="a.id">{{ a.grantorName }} · {{ scopeText(a.scopes) }} · 至 {{ dateOnly(a.expiresAt) }}</a-option>
          </a-select>
        </div>
        <div class="mw-form-row">
          <div class="mw-form-label">分身名称</div>
          <a-input v-model="clone.name" :max-length="60" show-word-limit />
        </div>
        <div class="mt-2 p-3 rounded-[8px] bg-[#f6f7f5] text-[12.5px] leading-relaxed text-[var(--mw-text2)]">{{ consentText.body }}</div>
        <a-checkbox v-model="clone.agreed" class="mt-2">我已阅读并确认以上授权内容</a-checkbox>
        <div class="mw-subtle mt-2">提交后由飞影制作，会消耗飞影积分；制作时间以飞影实际为准。</div>
      </template>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import { Message } from '@arco-design/web-vue'
import { ApiError } from '@/api/client'
import {
  createAvatar,
  createConsent,
  deleteAvatar,
  patchAvatar,
  reconcileAvatar,
  refreshAvatar,
  setDefaultAvatar,
  type AvatarWithSource,
  type PersonaAsset,
  type PersonaDetail,
  type PersonaOptions,
} from '@/api/personas'
import AssetList from './AssetList.vue'
import { cloneStatusTag, dateOnly, formatDuration, newIdempotencyKey, scopeText, usableAuthorizations } from './labels'
import { confirmAction, promptText } from './prompt'

const props = defineProps<{ persona: PersonaDetail; options: PersonaOptions | null; readonly: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void; (e: 'view-asset', asset: PersonaAsset): void }>()

const busyStatuses = ['pending', 'submitting', 'running', 'uncertain']
const lineAllowsClone = computed(() => props.persona.line !== 'persona')
const portraitAuths = computed(() => usableAuthorizations(props.persona.authorizations, 'portrait'))
const consentText = computed(
  () => props.options?.consentTexts.AVATAR_CLONE ?? { title: '口播分身制作授权确认', body: '' },
)

const clone = reactive({
  visible: false,
  submitting: false,
  source: null as PersonaAsset | null,
  authorizationId: '',
  name: '',
  agreed: false,
  idempotencyKey: '',
  /** 「仍要制作」（confirmDuplicate）用的键：每次打开弹窗只生成一次，超时后重试会被服务端识别为重放 */
  confirmKey: '',
  /** 同一次弹窗内已生成的 consent 及其授权，重复提交时复用；换了授权就重新生成 */
  consentId: '',
  consentAuthId: '',
})

function sizeText(av: AvatarWithSource): string {
  return av.sourceWidth && av.sourceHeight ? `${av.sourceWidth}×${av.sourceHeight}` : ''
}

function openClone(source: PersonaAsset) {
  Object.assign(clone, {
    visible: true,
    submitting: false,
    source,
    authorizationId: portraitAuths.value[0]?.id ?? '',
    name: `${props.persona.name} · ${source.backgroundLabel || '默认背景'}`.slice(0, 60),
    agreed: false,
    idempotencyKey: newIdempotencyKey('avatar'),
    confirmKey: newIdempotencyKey('avatar-dup'),
    consentId: '',
    consentAuthId: '',
  })
}

async function submitClone(done: (closed: boolean) => void) {
  if (!clone.source || !portraitAuths.value.length) return done(false)
  if (!clone.authorizationId) {
    Message.warning('请选择授权材料')
    return done(false)
  }
  if (!clone.agreed) {
    Message.warning('请先勾选确认授权内容')
    return done(false)
  }
  clone.submitting = true
  try {
    if (!clone.consentId || clone.consentAuthId !== clone.authorizationId) {
      const c = await createConsent(props.persona.id, {
        authorizationId: clone.authorizationId,
        purpose: 'AVATAR_CLONE',
        sourceKind: 'avatar_source',
        sourceId: clone.source.id,
        consentTextVersion: props.options?.consentTextVersion ?? 'v1',
      })
      clone.consentId = c.consentId
      clone.consentAuthId = clone.authorizationId
    }
    const input = { name: clone.name.trim() || undefined, sourceAssetId: clone.source.id, consentId: clone.consentId }
    try {
      const r = await createAvatar(props.persona.id, input, clone.idempotencyKey)
      Message.success(r.replayed ? '该请求已提交过，未重复制作' : '已提交制作，完成后会自动更新状态')
    } catch (e) {
      // 同素材已有分身：需要用户二次确认才再制作一个（FR-C1）
      const details = e instanceof ApiError ? (e.details as { requireConfirm?: boolean } | null) : null
      if (!details?.requireConfirm) throw e
      if (!(await confirmAction('该素材已制作过分身', (e as Error).message, '仍要制作'))) return done(false)
      await createAvatar(props.persona.id, { ...input, confirmDuplicate: true }, clone.confirmKey)
      Message.success('已提交制作，完成后会自动更新状态')
    }
    done(true)
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
    done(false)
  } finally {
    clone.submitting = false
  }
}

async function run(action: () => Promise<unknown>, okText: string) {
  try {
    await action()
    Message.success(okText)
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function rename(av: AvatarWithSource) {
  const name = await promptText({ title: '重命名分身', initial: av.name, maxLength: 60, required: true, placeholder: '分身名称' })
  if (name === null || name === av.name) return
  await run(() => patchAvatar(av.id, name), '已重命名')
}

async function remove(av: AvatarWithSource) {
  if (!(await confirmAction('删除分身', `确定删除「${av.name}」？飞影侧的分身不会被删除。`, '删除'))) return
  await run(() => deleteAvatar(av.id), '已删除')
}
</script>
