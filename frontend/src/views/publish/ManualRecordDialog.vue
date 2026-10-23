<script setup lang="ts">
import { reactive, ref, watch, computed } from 'vue'
import { Message } from '@arco-design/web-vue'
import { createManualLog, PLATFORM_LABELS, type PlatformAccount, type Platform } from '@/api/publish'

/** 手动补录对话框（PB14 / FR-S5）：平台手动发布后登记，source=manual */
const props = defineProps<{ accounts: PlatformAccount[] }>()
const visible = defineModel<boolean>('visible', { default: false })
const emit = defineEmits<{ (e: 'saved'): void }>()

const form = reactive({ platform: 'douyin' as Platform, accountId: '', title: '', videoUrl: '' })
const saving = ref(false)

const accountOptions = computed(() => props.accounts.filter((a) => a.platform === form.platform && a.enabled))

watch(
  () => form.platform,
  () => {
    if (!accountOptions.value.some((a) => a.id === form.accountId)) form.accountId = accountOptions.value[0]?.id ?? ''
  },
)
watch(visible, (v) => {
  if (v) {
    form.platform = (props.accounts[0]?.platform ?? 'douyin') as Platform
    form.accountId = accountOptions.value[0]?.id ?? ''
    form.title = ''
    form.videoUrl = ''
  }
})

async function submit(): Promise<void> {
  if (!form.accountId) return void Message.warning('请选择账号')
  if (!form.title.trim()) return void Message.warning('请填写标题')
  saving.value = true
  try {
    await createManualLog({
      platform: form.platform,
      accountId: form.accountId,
      title: form.title.trim(),
      videoUrl: form.videoUrl.trim() || undefined,
    })
    Message.success('已登记发布记录')
    visible.value = false
    emit('saved')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-modal v-model:visible="visible" title="手动补录发布记录" :width="440" unmount-on-close @before-ok="submit">
    <div class="flex flex-col gap-3 py-1">
      <div class="mw-subtle">在平台手动发布后登记，保证数据看板口径完整。补录记录不占用发布额度、不参与自动重试。</div>
      <a-form :model="{}" layout="vertical">
        <a-form-item label="平台" required>
          <a-select v-model="form.platform">
            <a-option v-for="(label, key) in PLATFORM_LABELS" :key="key" :value="key" :label="label" />
          </a-select>
        </a-form-item>
        <a-form-item label="账号" required>
          <a-select v-model="form.accountId" placeholder="选择账号">
            <a-option v-for="a in accountOptions" :key="a.id" :value="a.id" :label="a.displayName" />
          </a-select>
        </a-form-item>
        <a-form-item label="标题" required>
          <a-input v-model="form.title" placeholder="发布时使用的标题" :max-length="255" />
        </a-form-item>
        <a-form-item label="视频链接">
          <a-input v-model="form.videoUrl" placeholder="发布后的视频链接（选填）" />
        </a-form-item>
      </a-form>
    </div>
  </a-modal>
</template>
