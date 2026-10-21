<template>
  <a-drawer :visible="visible" :width="460" title="版本历史" unmount-on-close @cancel="$emit('update:visible', false)">
    <div class="mw-subtle mb-3">
      定位、默认分身 / 声音与声音参数发生变化时自动生成快照；历史文案与视频引用的是当时的版本，不受后续修改影响。
    </div>
    <a-spin :loading="loading" class="w-full">
      <a-empty v-if="!loading && !versions.length" description="暂无版本" />
      <div class="space-y-2">
        <div v-for="v in versions" :key="v.id" class="mw-card p-3">
          <div class="flex items-center gap-2">
            <span class="font-semibold">v{{ v.versionNo }}</span>
            <span class="mw-tag mw-tag-gray">{{ TRIGGER_LABEL[v.trigger] ?? v.trigger }}</span>
            <span v-if="v.id === currentVersionId" class="mw-tag mw-tag-green">当前</span>
            <span class="flex-1" />
            <span class="mw-subtle">{{ fmtDateTime(v.createdAt) }}</span>
          </div>
          <a-button size="mini" type="text" class="mt-1" @click="toggle(v.id)">{{
            opened === v.id ? '收起快照' : '查看快照'
          }}</a-button>
          <pre
            v-if="opened === v.id"
            class="mt-1 text-[12px] leading-5 whitespace-pre-wrap break-all bg-[#f7f8f6] rounded p-2 max-h-[260px] overflow-auto"
            >{{ snapshotText }}</pre>
        </div>
      </div>
    </a-spin>
  </a-drawer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { getPersonaVersion, getPersonaVersions } from '@/api/personas'
import { fmtDateTime, toastError, TRIGGER_LABEL } from './shared'

const props = defineProps<{ visible: boolean; personaId: string; currentVersionId: string | null }>()
defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const versions = ref<Array<{ id: string; versionNo: number; trigger: string; createdAt: string | null }>>([])
const loading = ref(false)
const opened = ref<string | null>(null)
const snapshotText = ref('')

watch(
  () => props.visible,
  async (v) => {
    if (!v) return
    opened.value = null
    loading.value = true
    try {
      versions.value = await getPersonaVersions(props.personaId)
    } catch (e) {
      toastError(e, '加载版本失败')
    } finally {
      loading.value = false
    }
  },
)

async function toggle(id: string): Promise<void> {
  if (opened.value === id) {
    opened.value = null
    return
  }
  try {
    const v = await getPersonaVersion(id)
    snapshotText.value = JSON.stringify(v.snapshot ?? v, null, 2)
    opened.value = id
  } catch (e) {
    toastError(e, '加载快照失败')
  }
}
</script>
