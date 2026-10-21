<template>
  <div class="flex flex-col gap-3">
    <div v-if="!readonly" class="upload-box">
      <strong>制作口播分身</strong>
      <p v-if="!sources.length" class="mw-subtle">需要先在「形象与素材」上传分身素材（10 秒–10 分钟正面口播视频），并由审核员审核通过。</p>
      <p v-else-if="!portraitAuths.length" class="mw-subtle">需要一份已核验、未过期且包含「肖像」范围的授权材料。</p>
      <template v-else>
        <a-select v-model="form.sourceAssetId" placeholder="选择已审核通过的分身素材">
          <a-option v-for="a in sources" :key="a.id" :value="a.id" :label="`${a.name}${a.backgroundLabel ? ' · ' + a.backgroundLabel : ''}`" />
        </a-select>
        <a-select v-model="form.authorizationId" placeholder="选择授权材料（含肖像）">
          <a-option v-for="a in portraitAuths" :key="a.id" :value="a.id" :label="`${a.grantorName}（至 ${fmtDate(a.expiresAt)}）`" />
        </a-select>
        <a-input v-model="form.name" :max-length="60" placeholder="分身名称（缺省为「人物名 · 背景名」）" />
        <div class="consent">
          <strong>{{ consent.title }}</strong>
          <p>{{ consent.body }}</p>
          <a-checkbox v-model="form.agreed">本人已阅读并确认以上内容（确认文本 {{ options.consentTextVersion }}）</a-checkbox>
        </div>
        <div class="flex justify-end">
          <a-button type="primary" size="small" :loading="submitting" :disabled="!form.sourceAssetId || !form.authorizationId || !form.agreed" @click="submit(false)">提交制作</a-button>
        </div>
      </template>
    </div>

    <div v-for="a in detail.avatars" :key="a.id" class="avatar-card">
      <div class="avatar-cover">
        <img v-if="a.coverUrl" :src="a.coverUrl" :alt="a.name" loading="lazy" />
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <strong class="truncate">{{ a.name }}</strong>
          <span class="mw-tag" :class="toneClass(CLONE_STATUS[a.status]?.tone ?? 'gray')">{{ CLONE_STATUS[a.status]?.label ?? a.status }}</span>
          <span v-if="detail.defaultAvatarId === a.id" class="mw-tag mw-tag-deep">默认</span>
        </div>
        <div class="mw-subtle">
          短引用 {{ a.shortRef }}<template v-if="a.sourceWidth"> · {{ a.sourceWidth }}×{{ a.sourceHeight }}</template> · {{ fmtTime(a.createdAt) }}
        </div>
        <div v-if="a.error" class="avatar-error">{{ a.error }}</div>
        <div v-if="!readonly" class="flex gap-1 flex-wrap mt-1">
          <a-button v-if="a.status === 'running'" size="mini" :loading="busyId === a.id" @click="act(a.id, 'refresh')">立即查询</a-button>
          <a-button v-if="a.status === 'uncertain'" size="mini" type="primary" :loading="busyId === a.id" @click="act(a.id, 'reconcile')">核对状态</a-button>
          <a-button v-if="a.status === 'ready' && detail.defaultAvatarId !== a.id" size="mini" @click="act(a.id, 'default')">设为默认</a-button>
          <a-button size="mini" @click="rename(a.id, a.name)">重命名</a-button>
          <a-popconfirm v-if="!['pending', 'submitting', 'running', 'uncertain'].includes(a.status)" content="确认删除该分身？" @ok="act(a.id, 'delete')">
            <a-button size="mini">删除</a-button>
          </a-popconfirm>
        </div>
      </div>
    </div>
    <p v-if="!detail.avatars.length" class="mw-subtle text-center py-4">暂无口播分身</p>
    <a-modal v-model:visible="renameVisible" title="重命名分身" @ok="submitRename">
      <a-input v-model="renameValue" :max-length="60" />
      <p class="mw-subtle mt-2">只修改本地名称，飞影侧标题与短引用不变。</p>
    </a-modal>
    <p class="mw-subtle">制作由飞影在后台完成，通常需要几分钟到几十分钟，页面会自动刷新状态。「待核对」表示提交结果未知，请先核对，勿重复创建。</p>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { ApiError } from '@/api/client'
import {
  createAvatar,
  createConsent,
  deleteAvatar,
  patchAvatar,
  reconcileAvatar,
  refreshAvatar,
  setDefaultAvatar,
  type PersonaDetail,
  type PersonaOptions,
} from '@/api/personas'
import { CLONE_STATUS, fmtDate, fmtTime, newIdempotencyKey, toneClass } from './labels'

const props = defineProps<{ detail: PersonaDetail; options: PersonaOptions; readonly: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const consent = computed(() => props.options.consentTexts.AVATAR_CLONE)
const sources = computed(() => props.detail.assets.filter((a) => a.kind === 'avatar_source' && a.status === 'approved'))
const portraitAuths = computed(() => props.detail.authorizations.filter((a) => a.status === 'verified' && a.scopes.includes('portrait')))
const form = reactive({ sourceAssetId: '', authorizationId: '', name: '', agreed: false })
const submitting = ref(false)
const busyId = ref('')
// 同一次表单提交（含失败重试、二次确认）复用同一个幂等键和同一份授权确认，
// 保证请求参数哈希不变：网络抖动后重试只会拿回原记录，不会重复制作
let idemKey = newIdempotencyKey('avatar')
let consentCache: { key: string; id: string } | null = null
let idemFor = ''

async function submit(confirmDuplicate: boolean): Promise<void> {
  submitting.value = true
  try {
    const key = `${form.sourceAssetId}|${form.authorizationId}`
    // 表单内容变了就是一次新的制作请求，换新幂等键
    const signature = `${key}|${form.name.trim()}`
    if (signature !== idemFor) {
      idemKey = newIdempotencyKey('avatar')
      idemFor = signature
    }
    if (consentCache?.key !== key) {
      const c = await createConsent(props.detail.id, {
        authorizationId: form.authorizationId,
        purpose: 'AVATAR_CLONE',
        sourceKind: 'avatar_source',
        sourceId: form.sourceAssetId,
        consentTextVersion: props.options.consentTextVersion,
      })
      consentCache = { key, id: c.consentId }
    }
    await createAvatar(
      props.detail.id,
      { name: form.name.trim() || undefined, sourceAssetId: form.sourceAssetId, consentId: consentCache.id, confirmDuplicate },
      idemKey,
    )
    Message.success('已提交制作，完成后状态会自动更新')
    Object.assign(form, { sourceAssetId: '', authorizationId: '', name: '', agreed: false })
    idemFor = ''
    consentCache = null
    emit('changed')
  } catch (e) {
    if (e instanceof ApiError && e.code === 'PERSONA_CONFLICT' && !confirmDuplicate) {
      Modal.confirm({ title: '重复制作确认', content: e.message, okText: '继续制作', onOk: () => submit(true) })
      return
    }
    Message.error((e as Error).message)
  } finally {
    submitting.value = false
  }
}

async function act(id: string, action: 'refresh' | 'reconcile' | 'default' | 'delete'): Promise<void> {
  busyId.value = id
  try {
    if (action === 'refresh') await refreshAvatar(id)
    if (action === 'reconcile') await reconcileAvatar(id)
    if (action === 'default') await setDefaultAvatar(id)
    if (action === 'delete') await deleteAvatar(id)
    Message.success({ refresh: '已查询最新状态', reconcile: '核对完成', default: '已设为默认分身', delete: '已删除' }[action])
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

const renameVisible = ref(false)
const renameTarget = ref('')
const renameValue = ref('')

function rename(id: string, current: string): void {
  renameTarget.value = id
  renameValue.value = current
  renameVisible.value = true
}

async function submitRename(): Promise<void> {
  if (!renameValue.value.trim()) {
    Message.warning('名称不能为空')
    return
  }
  try {
    await patchAvatar(renameTarget.value, renameValue.value.trim())
    renameVisible.value = false
    emit('changed')
  } catch (e) {
    Message.error((e as Error).message)
  }
}
</script>

<style scoped>
.upload-box {
  border: 1px solid var(--mw-border-light);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.consent {
  background: #f6f8f6;
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
  line-height: 1.7;
}
.consent p {
  margin: 4px 0 8px;
  color: var(--mw-text2);
}
.avatar-card {
  display: flex;
  gap: 10px;
  border: 1px solid var(--mw-border-light);
  border-radius: 8px;
  padding: 10px;
  font-size: 13px;
}
.avatar-cover {
  width: 72px;
  height: 96px;
  border-radius: 6px;
  overflow: hidden;
  background: #eef1ee;
  flex-shrink: 0;
}
.avatar-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar-error {
  color: #b45427;
  font-size: 12px;
}
</style>
