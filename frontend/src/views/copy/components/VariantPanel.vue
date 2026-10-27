<template>
  <a-modal
    :visible="visible"
    title="换一种写法"
    :width="640"
    :footer="false"
    unmount-on-close
    @cancel="emit('update:visible', false)"
  >
    <!-- 目标段落 -->
    <div class="mb-4">
      <div class="mw-subtle mb-1.5">当前段落（第 {{ sectionIndex + 1 }} 段）</div>
      <div
        class="px-3.5 py-2.5 rounded-lg bg-[#fbfcfe] border border-[#eef2f8] text-[13px] leading-[1.8] text-[#3c4a63] max-h-[120px] overflow-auto"
      >
        {{ sectionText || '（该段为空）' }}
      </div>
    </div>

    <!-- 变体类型 -->
    <div class="mb-4">
      <div class="mw-subtle mb-2">想要哪种改法</div>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="k in KINDS"
          :key="k.value"
          type="button"
          class="kind-chip"
          :class="{ active: selected.includes(k.value) }"
          :disabled="loading"
          @click="toggleKind(k.value)"
        >
          {{ k.label }}
        </button>
      </div>
    </div>

    <a-button type="primary" long :loading="loading" :disabled="!selected.length" @click="onGenerate">
      <template #icon><icon-swap /></template>
      生成 {{ selected.length }} 种写法
    </a-button>

    <!-- 结果 -->
    <div v-if="variants.length" class="mt-4 space-y-2.5">
      <div v-for="v in variants" :key="v.id" class="variant-card">
        <div class="flex items-center gap-2 mb-1.5">
          <a-tag size="small" color="arcoblue">{{ kindLabel(v.kind) }}</a-tag>
          <span class="mw-subtle tabular-nums">{{ v.text.length }} 字符</span>
          <span class="flex-1" />
          <a-button size="mini" :loading="applying === v.id" @click="onApply(v, 'replace')">替换本段</a-button>
          <a-button size="mini" type="text" :loading="applying === v.id" @click="onApply(v, 'new_draft')">
            另存新稿
          </a-button>
        </div>
        <div class="text-[13px] leading-[1.85] text-[#3c4a63] whitespace-pre-wrap">{{ v.text }}</div>
      </div>
    </div>
  </a-modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type Variant } from '@/api/copy'

const props = defineProps<{ visible: boolean; sectionIndex: number }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()
const store = useCopyStore()

const KINDS = [
  { value: 'shorter', label: '更短更利落' },
  { value: 'plainer', label: '更口语' },
  { value: 'data', label: '加数据支撑' },
  { value: 'question', label: '改成提问式' },
  { value: 'emotion', label: '更有情绪' },
] as const

const loading = ref(false)
const applying = ref<string | null>(null)
const selected = ref<string[]>(['plainer', 'shorter'])
const variants = ref<Variant[]>([])

const sectionText = ref('')

watch(
  () => props.visible,
  (v) => {
    if (!v) {
      variants.value = []
      return
    }
    sectionText.value = store.editor?.sections[props.sectionIndex]?.text ?? ''
    variants.value = []
  },
)

function toggleKind(k: string): void {
  const i = selected.value.indexOf(k)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(k)
}

function kindLabel(k: string): string {
  return KINDS.find((x) => x.value === k)?.label ?? k
}

async function onGenerate(): Promise<void> {
  if (!store.copy || !store.editor) return
  // 变体基于已保存内容生成，先落盘
  if (store.isDirty) {
    const r = await store.save()
    if (r !== 'ok') {
      Message.warning('请先保存当前稿')
      return
    }
  }
  loading.value = true
  variants.value = []
  try {
    const accepted = await copyApi.variants(store.copy.id, store.editor.draftId, {
      sectionIndex: props.sectionIndex,
      kinds: selected.value,
      count: selected.value.length,
    })
    // 轮询变体产出
    const started = Date.now()
    const timer = setInterval(async () => {
      try {
        const g = await copyApi.generation(accepted.generationId)
        if (g.status === 'done' || g.status === 'partial' || g.status === 'failed' || Date.now() - started > 60_000) {
          clearInterval(timer)
          loading.value = false
          const fresh = await copyApi.detail(store.copy!.id)
          variants.value = fresh.variants
            .filter((v) => v.sectionIndex === props.sectionIndex && !v.appliedAt)
            .slice(-10)
          if (!variants.value.length) Message.warning(g.error || '未生成有效变体，请换个改法试试')
        }
      } catch {
        clearInterval(timer)
        loading.value = false
      }
    }, 1000)
  } catch (e) {
    Message.error((e as Error).message)
    loading.value = false
  }
}

function onApply(v: Variant, mode: 'replace' | 'new_draft'): void {
  Modal.confirm({
    title: mode === 'replace' ? '替换当前段落？' : '另存为新稿？',
    content:
      mode === 'replace' ? '原段落内容会被覆盖，可通过「历史版本」找回。' : '会用该写法生成一份新稿，原稿保持不变。',
    okText: '确认',
    cancelText: '取消',
    onOk: () => applyVariant(v, mode, false),
  })
}

async function applyVariant(v: Variant, mode: 'replace' | 'new_draft', confirmChanged: boolean): Promise<void> {
  if (!store.copy) return
  applying.value = v.id
  try {
    // 后端按已保存内容判断段落是否被改过，先落盘本地改动
    if (store.isDirty && (await store.save()) !== 'ok') {
      Message.warning('请先保存当前稿')
      return
    }
    const r = await copyApi.applyVariant(v.id, { mode, confirmChanged })
    if (r.requiresConfirm) {
      Modal.confirm({
        title: '这一段在生成变体后已修改',
        content: '继续将用变体覆盖修改后的内容。',
        okText: '继续',
        cancelText: '取消',
        onOk: () => applyVariant(v, mode, true),
      })
      return
    }
    Message.success(mode === 'replace' ? '已替换' : '已另存为新稿')
    emit('update:visible', false)
    await store.load(store.copy.id)
    store.syncEditorFromCurrent()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    applying.value = null
  }
}
</script>

<style scoped>
.kind-chip {
  padding: 5px 13px;
  border-radius: 999px;
  border: 1px solid #e6ecf5;
  background: #fff;
  font-size: 13px;
  color: #4a5872;
  cursor: pointer;
  transition: all 0.16s ease;
}
.kind-chip:hover:not(:disabled) {
  border-color: #ccd9ef;
}
.kind-chip.active {
  border-color: #2f6bff;
  background: #eef4ff;
  color: #1d4ed8;
}
.kind-chip:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.variant-card {
  padding: 11px 13px;
  border-radius: 9px;
  border: 1px solid #eef2f8;
  background: #fbfcfe;
  transition: all 0.16s ease;
}
.variant-card:hover {
  background: #fff;
  border-color: #dbe6f7;
}
</style>
