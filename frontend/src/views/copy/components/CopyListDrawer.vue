<template>
  <a-drawer
    :visible="visible"
    :width="520"
    title="文案列表"
    unmount-on-close
    @cancel="emit('update:visible', false)"
  >
    <template #footer>
      <a-button type="primary" long @click="openCreate">
        <template #icon><icon-plus /></template>
        新建文案
      </a-button>
    </template>

    <!-- 筛选 -->
    <div class="flex items-center gap-2 mb-3">
      <a-input v-model="keyword" placeholder="搜索标题" allow-clear size="small" class="flex-1" @press-enter="reload">
        <template #prefix><icon-search /></template>
      </a-input>
      <a-select v-model="derivedStatus" size="small" placeholder="状态" allow-clear class="!w-[110px]" @change="reload">
        <a-option v-for="(label, key) in statusOptions" :key="key" :value="key">{{ label }}</a-option>
      </a-select>
      <a-select v-model="line" size="small" placeholder="线" allow-clear class="!w-[90px]" @change="reload">
        <a-option value="manager">管理人</a-option>
        <a-option value="kos">员工 KOS</a-option>
        <a-option value="persona">素人</a-option>
      </a-select>
    </div>

    <a-spin :loading="loading" class="w-full">
      <a-empty v-if="!loading && !items.length" description="还没有文案" />

      <div class="space-y-2">
        <div
          v-for="it in items"
          :key="it.id"
          class="list-row"
          :class="{ active: it.id === store.copy?.id }"
          @click="onPick(it.id)"
        >
          <div class="flex items-start gap-2">
            <div class="flex-1 min-w-0">
              <div class="text-[13.5px] font-medium text-[#131f38] truncate">
                {{ it.title || '（未命名文案）' }}
              </div>
              <div class="flex items-center gap-2 mt-1 flex-wrap">
                <span class="mw-tag" :class="statusClass(it.derivedStatus)">{{ it.derivedStatusLabel }}</span>
                <span class="mw-subtle">{{ it.sourceLabel }}</span>
                <span v-if="it.persona" class="mw-subtle">· {{ it.persona.name }}</span>
                <span class="mw-subtle">· {{ it.draftCount }} 稿</span>
              </div>
            </div>
            <span class="mw-subtle shrink-0 tabular-nums">{{ fmtTime(it.updatedAt || it.createdAt) }}</span>
          </div>
        </div>
      </div>

      <div v-if="total > items.length" class="mt-3 text-center">
        <a-link @click="loadMore">加载更多（{{ items.length }}/{{ total }}）</a-link>
      </div>
    </a-spin>

    <!-- 新建弹窗 -->
    <a-modal v-model:visible="createVisible" title="新建文案" :width="560" :footer="false" unmount-on-close>
      <a-form :model="form" layout="vertical">
        <a-form-item label="人物" required>
          <a-select v-model="form.personaId" placeholder="选择人物" @change="onPersonaChange">
            <a-option v-for="p in personas" :key="p.id" :value="p.id" :label="`${p.name}（${p.lineLabel || p.line}）`" />
          </a-select>
        </a-form-item>

        <a-form-item label="创作方式">
          <a-radio-group v-model="form.mode" type="button" size="small">
            <a-radio value="manual">手动输入</a-radio>
            <a-radio value="article">上传文章</a-radio>
          </a-radio-group>
        </a-form-item>

        <a-form-item label="标题">
          <a-input v-model="form.title" placeholder="给这条文案起个标题" :max-length="60" show-word-limit />
        </a-form-item>

        <!-- 手动输入 -->
        <a-form-item v-if="form.mode === 'manual'" label="素材内容">
          <a-textarea
            v-model="form.sourceText"
            :auto-size="{ minRows: 4, maxRows: 10 }"
            :max-length="5000"
            show-word-limit
            placeholder="把你的想法、要点或完整素材贴进来"
          />
        </a-form-item>

        <!-- 造文章 -->
        <a-form-item v-else label="文章文件">
          <div class="w-full">
            <a-upload
              :auto-upload="false"
              :limit="1"
              accept=".docx,.pdf,.txt,.md"
              @change="onFileChange"
            />
            <div class="mw-subtle mt-1">支持 .docx / .pdf / .txt / .md，单个文件不超过 10MB</div>
          </div>
        </a-form-item>

        <a-form-item label="关键词（可选）">
          <a-input v-model="form.keywords" placeholder="用逗号分隔，例如：定投, 上班族" />
        </a-form-item>

        <div class="flex justify-end gap-2 pt-1">
          <a-button @click="createVisible = false">取消</a-button>
          <a-button type="primary" :loading="creating" :disabled="!canCreate" @click="onCreate">创建</a-button>
        </div>
      </a-form>
    </a-modal>
  </a-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { articleApi, copyApi, type CopyDerivedStatus, type CopyLine, type CopyListItem } from '@/api/copy'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'picked', copyId: string): void
}>()

const store = useCopyStore()

const loading = ref(false)
const items = ref<CopyListItem[]>([])
const total = ref(0)
const page = ref(1)
const keyword = ref('')
const derivedStatus = ref<CopyDerivedStatus | undefined>()
const line = ref<CopyLine | undefined>()

const statusOptions: Record<string, string> = {
  pending_write: '待写作',
  writing: '写作中',
  in_review: '审核中',
  rejected: '已驳回',
  approved: '已通过',
  revising: '修订中',
}

const personas = computed(() => (store.options?.personas ?? []).filter((p) => p.enabled))

watch(
  () => props.visible,
  (v) => {
    if (v) {
      page.value = 1
      void reload()
    }
  },
)

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = await copyApi.list({
      page: page.value,
      pageSize: 20,
      keyword: keyword.value || undefined,
      derivedStatus: derivedStatus.value,
      line: line.value,
    })
    items.value = page.value === 1 ? r.items : [...items.value, ...r.items]
    total.value = r.total
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

function reload(): void {
  page.value = 1
  void load()
}

function loadMore(): void {
  page.value += 1
  void load()
}

function statusClass(s: string): string {
  switch (s) {
    case 'approved':
      return 'mw-tag-green'
    case 'rejected':
      return 'mw-tag-red'
    case 'in_review':
      return 'mw-tag-yellow'
    case 'revising':
      return 'mw-tag-purple'
    case 'writing':
      return 'mw-tag-blue'
    default:
      return 'mw-tag-gray'
  }
}

function onPick(id: string): void {
  emit('picked', id)
  emit('update:visible', false)
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ── 新建 ── */

const createVisible = ref(false)
const creating = ref(false)
const form = reactive({
  mode: 'manual' as 'manual' | 'article',
  personaId: '',
  title: '',
  sourceText: '',
  keywords: '',
})
const file = ref<File | null>(null)

function openCreate(): void {
  form.mode = 'manual'
  form.personaId = personas.value[0]?.id ?? ''
  form.title = ''
  form.sourceText = ''
  form.keywords = ''
  file.value = null
  createVisible.value = true
}

function onPersonaChange(): void {
  // 人物决定所属线，重新拉取可用的风格
  void store.loadOptions(form.personaId)
}

function onFileChange(_files: unknown, currentFile: { file?: File }): void {
  file.value = currentFile?.file ?? null
}

const canCreate = computed(() => {
  if (!form.personaId) return false
  if (form.mode === 'manual') return form.sourceText.trim().length > 0
  return !!file.value
})

async function onCreate(): Promise<void> {
  creating.value = true
  try {
    let articleId: string | undefined
    if (form.mode === 'article' && file.value) {
      const a = await articleApi.uploadEdit(file.value)
      articleId = a.articleId
      if (!form.title) form.title = file.value.name.replace(/\.[^.]+$/, '')
    }
    const r = await copyApi.create({
      source: form.mode,
      personaIds: [form.personaId],
      title: form.title || undefined,
      sourceText: form.mode === 'manual' ? form.sourceText : undefined,
      keywords: form.keywords || undefined,
      articleId,
    })
    Message.success('已创建文案')
    createVisible.value = false
    emit('picked', r.copyIds[0])
    emit('update:visible', false)
    reload()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.list-row {
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid #eef2f8;
  background: #fff;
  cursor: pointer;
  transition: all 0.16s ease;
}
.list-row:hover {
  border-color: #dbe6f7;
  box-shadow: 0 2px 8px rgba(23, 32, 52, 0.05);
}
.list-row.active {
  border-color: #2f6bff;
  background: #f7faff;
}
</style>
