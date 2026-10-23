<script setup lang="ts">
import { ref, onUnmounted, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { startLoginSession, latestLoginSession, type PlatformAccount } from '@/api/publish'

/**
 * 扫码登录弹窗（FR-L1）：发起登录 → 轮询最新会话（1.5s）→ confirmed 关闭并提示。
 * data URL 模式（无 OSS）二维码不持久化，过期/失败须重新发起。
 */
const props = defineProps<{ account: PlatformAccount | null }>()
const emit = defineEmits<{ (e: 'confirmed', account: PlatformAccount): void }>()

const visible = defineModel<boolean>('visible', { default: false })
const qrSrc = ref<string | null>(null)
const statusText = ref('正在获取二维码…')
const failed = ref(false)
let timer: number | null = null

function stopPolling(): void {
  if (timer) {
    window.clearInterval(timer)
    timer = null
  }
}

async function start(): Promise<void> {
  if (!props.account) return
  failed.value = false
  qrSrc.value = null
  statusText.value = '正在获取二维码…'
  try {
    const r = await startLoginSession(props.account.id)
    qrSrc.value = r.qrDataUrl ?? r.qrUrl
    statusText.value = '请使用平台 App 扫码登录（约 2 小时内有效）'
    stopPolling()
    timer = window.setInterval(poll, 1500)
  } catch (e) {
    failed.value = true
    statusText.value = (e as Error).message
  }
}

async function poll(): Promise<void> {
  if (!props.account) return
  try {
    const r = await latestLoginSession(props.account.id)
    const s = r.session
    if (!s) return
    if (s.status === 'confirmed') {
      stopPolling()
      visible.value = false
      Message.success(`「${props.account.displayName}」登录成功`)
      emit('confirmed', props.account)
    } else if (s.status === 'scanned') {
      statusText.value = '已扫码，请在手机上确认登录…'
    } else if (s.status === 'failed' || s.status === 'expired') {
      stopPolling()
      failed.value = true
      statusText.value = s.error ?? '登录会话已结束，请重新发起扫码'
    }
  } catch {
    /* 轮询失败忽略，下一轮继续 */
  }
}

watch(visible, (v) => {
  if (v) void start()
  else stopPolling()
})

onUnmounted(stopPolling)
</script>

<template>
  <a-modal v-model:visible="visible" title="扫码登录" :width="380" :footer="false" unmount-on-close>
    <div class="flex flex-col items-center gap-4 py-2">
      <div
        class="w-[220px] h-[220px] rounded-lg border border-[var(--mw-border)] flex items-center justify-center bg-white overflow-hidden"
      >
        <img v-if="qrSrc" :src="qrSrc" alt="登录二维码" class="w-full h-full object-contain" data-testid="login-qr" />
        <icon-image v-else class="text-[40px] text-[var(--mw-border)]" />
      </div>
      <div class="text-[13px]" :class="failed ? 'text-[rgb(var(--red-6))]' : 'mw-subtle'">{{ statusText }}</div>
      <a-button size="small" type="outline" @click="start">刷新二维码</a-button>
    </div>
  </a-modal>
</template>
