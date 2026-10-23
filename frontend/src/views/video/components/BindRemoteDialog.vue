<template>
  <a-modal
    :visible="visible"
    title="补录生成服务任务号"
    :width="520"
    unmount-on-close
    @cancel="emit('close')"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-3">
      <a-alert type="warning">
        提交结果待确认：请先在飞影后台按下方标题检索，确认该任务是否已受理。
        <div class="mt-1 font-mono text-[12.5px] select-all">{{ vendorTitle || '（无飞影标题）' }}</div>
      </a-alert>

      <template v-if="remoteTaskId">
        <div class="text-[13.5px]">
          任务已有生成服务任务号：<span class="font-mono select-all">{{ remoteTaskId }}</span
          >，可直接「查询原任务」。
        </div>
      </template>
      <template v-else>
        <div class="text-[13.5px]">
          若在飞影后台找到该任务（标题含短引用 <span class="font-mono">#{{ shortRef || '——' }}</span
          >），把任务号填到下面：
        </div>
        <a-input v-model="taskId" placeholder="飞影任务号（task_id）" allow-clear />
      </template>

      <a-divider class="my-2" />
      <div class="text-[13.5px] text-[var(--mw-text2)]">
        确认飞影后台<strong>没有</strong>该任务（提交未受理）？可确认后重新提交。
        <span class="text-[#b45309]">重新提交可能产生额外费用。</span>
      </div>
    </div>

    <template #footer>
      <div class="flex items-center gap-2">
        <a-button @click="emit('close')">取消</a-button>
        <div class="flex-1"></div>
        <a-button v-if="remoteTaskId" type="primary" :loading="busy" @click="act('query-original')"
          >查询原任务</a-button
        >
        <template v-else>
          <a-button :disabled="!taskId.trim()" :loading="busy" @click="act('bind-remote')">补录并查询</a-button>
          <a-popconfirm content="确认未提交并重新提交？可能产生额外费用。" type="warning" @ok="act('confirm-resubmit')">
            <a-button status="warning" :loading="busy">确认未提交并重新提交</a-button>
          </a-popconfirm>
        </template>
      </div>
    </template>
  </a-modal>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { postJobAction } from '@/api/video'

const props = defineProps<{
  visible: boolean
  jobId: string
  vendorTitle: string | null
  shortRef: string | null
  remoteTaskId: string | null
}>()
const emit = defineEmits<{ close: []; done: [] }>()

const taskId = ref('')
const busy = ref(false)

async function act(action: string): Promise<void> {
  busy.value = true
  try {
    await postJobAction(
      props.jobId,
      action,
      action === 'bind-remote' ? { remoteTaskId: taskId.value.trim() } : { confirm: true },
    )
    Message.success(action === 'confirm-resubmit' ? '已确认重新提交' : '已发起查询')
    emit('done')
    emit('close')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>
