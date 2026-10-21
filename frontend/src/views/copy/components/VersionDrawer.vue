<template>
  <a-drawer
    :visible="visible"
    :width="480"
    title="稿件历史版本"
    unmount-on-close
    @cancel="emit('update:visible', false)"
  >
    <a-spin :loading="loading" class="w-full">
      <a-empty v-if="!loading && !items.length" description="暂无版本记录" />

      <div class="flex items-center gap-3 mb-4"><a-checkbox v-model="onlyCurrent">只看当前候选稿</a-checkbox><span class="mw-subtle">{{ visibleItems.length }} 个版本</span></div>
      <div v-if="items.length" class="space-y-2.5">
        <div
          v-for="v in visibleItems"
          :key="v.id"
          class="version-row"
          :class="{ expanded: expandedId === v.id }"
        >
          <button type="button" class="flex items-center gap-2 cursor-pointer w-full border-0 bg-transparent p-0 text-left" :aria-expanded="expandedId === v.id" @click="toggle(v.id)">
            <a-tag :color="originColor(v.origin)" size="small">{{ originLabel(v.origin) }}</a-tag>
            <span class="text-[13px] font-medium text-[#131f38]">第 {{ v.versionNo }} 版</span>
            <span v-if="v.isLocked" class="mw-tag mw-tag-blue">已提审</span>
            <span class="flex-1" />
            <span class="mw-subtle tabular-nums">{{ v.wordCount }}字</span>
            <span class="mw-subtle">{{ fmtTime(v.createdAt) }}</span>
            <icon-down class="text-[#9aa6ba] transition-transform" :class="{ 'rotate-180': expandedId === v.id }" />
          </button>

          <div class="mw-subtle mt-2">{{ v.draftName || store.drafts.find(d=>d.id===v.draftId)?.name || '候选稿' }}</div>
          <!-- 版本摘要 -->
          <div v-if="v.title" class="mt-1.5 text-[13px] text-[#4a5872] pl-1">{{ v.title }}</div>

          <!-- 命中统计 -->
          <div v-if="v.complianceHits?.length" class="mt-1.5 flex flex-wrap gap-1.5 pl-1">
            <a-tag
              v-for="(h, i) in v.complianceHits.slice(0, 6)"
              :key="i"
              :color="h.level === 'hard' ? 'red' : 'orange'"
              size="small"
            >
              {{ h.word }}
            </a-tag>
            <span v-if="v.complianceHits.length > 6" class="mw-subtle">+{{ v.complianceHits.length - 6 }}</span>
          </div>

          <!-- 展开：内容与操作 -->
          <div v-if="expandedId === v.id" class="mt-3 pt-3 border-t border-[#f0f3f8]">
            <a-spin :loading="detailLoading">
              <div v-if="detail?.sections?.length" class="space-y-2 max-h-[320px] overflow-auto">
                <div v-for="(s, i) in detail.sections" :key="i" class="text-[13px] leading-[1.8] text-[#3c4a63]">
                  {{ s.text }}
                </div>
              </div>
              <div v-else class="mw-subtle">（该版本无正文）</div>
            </a-spin>

            <div class="mt-3 flex items-center gap-2">
              <a-button size="small" :disabled="v.isLocked" @click="onRestore(v)">恢复此版本</a-button>
              <a-button size="small" type="text" @click="onDiff(v)">与当前稿对比</a-button>
            </div>
          </div>
        </div>
      </div>
    </a-spin>

    <!-- 差异对比 -->
    <a-modal v-model:visible="diffVisible" title="版本对比" :width="720" :footer="false" unmount-on-close>
      <div v-if="diffLoading" class="py-12 text-center"><a-spin /></div>
      <div v-else-if="diff" class="space-y-2 max-h-[480px] overflow-auto">
        <div
          v-for="(d, i) in diff.sections"
          :key="i"
          class="diff-row"
          :class="`diff-${d.change}`"
        >
          <div class="flex items-center gap-2 mb-1">
            <a-tag :color="diffColor(d.change)" size="small">{{ diffLabel(d.change) }}</a-tag>
            <span class="text-[13px] font-medium text-[#131f38]">第 {{ i + 1 }} 段</span>
          </div>
          <div v-if="d.change !== 'added'" class="text-[12px] leading-[1.75] text-[#9aa6ba] line-through whitespace-pre-wrap">
            {{ d.base || '（空）' }}
          </div>
          <div v-if="d.change !== 'removed'" class="text-[13px] leading-[1.75] text-[#3c4a63] whitespace-pre-wrap">
            {{ d.target || '（空）' }}
          </div>
        </div>
      </div>
    </a-modal>
  </a-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type CopyVersion, type Section, type VersionOrigin } from '@/api/copy'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()
const store = useCopyStore()
const onlyCurrent=ref(true)
const visibleItems=computed(()=>onlyCurrent.value?items.value.filter(v=>v.draftId===store.editor?.draftId):items.value)

const loading = ref(false)
const items = ref<CopyVersion[]>([])
const expandedId = ref<string | null>(null)
const detail = ref<{ sections: Section[] } | null>(null)
const detailLoading = ref(false)

const diffVisible = ref(false)
const diffLoading = ref(false)
const diff = ref<{
  baseVersionNo: number | null
  targetVersionNo: number
  sections: Array<{ label: string; change: 'added' | 'removed' | 'modified' | 'same'; base: string; target: string }>
} | null>(null)

watch(
  () => props.visible,
  async (v) => {
    if (!v || !store.copy) return
    expandedId.value = null
    detail.value = null
    loading.value = true
    try {
      items.value = await copyApi.versions(store.copy.id)
    } catch (e) {
      Message.error((e as Error).message)
    } finally {
      loading.value = false
    }
  },
)

async function toggle(id: string): Promise<void> {
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  expandedId.value = id
  detail.value = null
  detailLoading.value = true
  try {
    const v = await copyApi.version(id)
    detail.value = { sections: v.sections ?? [] }
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    detailLoading.value = false
  }
}

function originLabel(o: VersionOrigin): string {
  const map: Record<VersionOrigin, string> = {
    ai_generate: 'AI 生成',
    manual_save: '手动保存',
    restore: '版本恢复',
    submit: '提交审核',
  }
  return map[o] ?? o
}

function originColor(o: VersionOrigin): string {
  const map: Record<VersionOrigin, string> = {
    ai_generate: 'arcoblue',
    manual_save: 'gray',
    restore: 'purple',
    submit: 'green',
  }
  return map[o] ?? 'gray'
}

function diffLabel(c: string): string {
  return { added: '新增', removed: '删除', modified: '修改', same: '未变' }[c] ?? c
}

function diffColor(c: string): string {
  return { added: 'green', removed: 'red', modified: 'orange', same: 'gray' }[c] ?? 'gray'
}

async function onDiff(v: CopyVersion): Promise<void> {
  diffVisible.value = true
  diffLoading.value = true
  diff.value = null
  try {
    diff.value = await copyApi.versionDiff(v.id)
  } catch (e) {
    Message.error((e as Error).message)
    diffVisible.value = false
  } finally {
    diffLoading.value = false
  }
}

function onRestore(v: CopyVersion): void {
  Modal.confirm({
    title: `恢复到 v${v.versionNo}？`,
    content: '当前稿内容将被该版本覆盖，恢复动作会记入历史版本。',
    okText: '恢复',
    cancelText: '取消',
    onOk: async () => {
      try {
        await copyApi.restoreVersion(v.id)
        Message.success('已恢复')
        if (store.copy) {
          await store.load(store.copy.id)
          items.value = await copyApi.versions(store.copy.id)
        }
        emit('update:visible', false)
      } catch (e) {
        Message.error((e as Error).message)
      }
    },
  })
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<style scoped>
.version-row {
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid #eef2f8;
  background: #fbfcfe;
  transition: all 0.16s ease;
}
.version-row:hover {
  background: #fff;
  border-color: #e6ecf5;
}
.version-row.expanded {
  background: #fff;
  border-color: #dbe6f7;
}

.diff-row {
  padding: 10px 12px;
  border-radius: 8px;
  border-left: 3px solid transparent;
  background: #fbfcfe;
}
.diff-added {
  border-left-color: #12805c;
}
.diff-removed {
  border-left-color: #c03e35;
}
.diff-modified {
  border-left-color: #b95f1d;
}
.diff-same {
  border-left-color: #dfe6f0;
}
</style>
