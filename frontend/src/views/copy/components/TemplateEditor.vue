<template>
  <a-drawer :visible="visible" :width="720" title="文案配置" unmount-on-close @cancel="emit('update:visible', false)">
    <a-tabs v-model:active-key="tab" size="medium" class="mw-tabs">
      <!-- 模板 -->
      <a-tab-pane key="templates" title="内容模板">
        <div class="flex items-center justify-between mb-3">
          <span class="mw-subtle">模板决定文案的结构与硬性约束，改动后新生成即生效</span>
          <a-button size="small" @click="editTemplate(null)">
            <template #icon><icon-plus /></template>
            新建
          </a-button>
        </div>
        <a-spin :loading="loading">
          <div class="space-y-2">
            <div v-for="t in templates" :key="t.id" class="cfg-row">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-[13.5px] font-medium text-[#131f38]">{{ t.name }}</span>
                <a-tag v-if="t.isBuiltin" size="small">内置</a-tag>
                <span class="mw-subtle">rev {{ t.revision }}</span>
                <span class="flex-1" />
                <a-link @click="editTemplate(t)">编辑</a-link>
                <a-link v-if="!t.isBuiltin" status="danger" @click="removeTemplate(t)">删除</a-link>
              </div>
              <div class="mw-subtle leading-[1.7]">{{ t.description }}</div>
            </div>
          </div>
        </a-spin>
      </a-tab-pane>

      <!-- 风格 -->
      <a-tab-pane key="styles" title="表达风格">
        <div class="flex items-center justify-between mb-3">
          <span class="mw-subtle">风格按线隔离：管理人与 KOS 的风格互不通用</span>
          <a-button size="small" @click="editStyle(null)">
            <template #icon><icon-plus /></template>
            新建
          </a-button>
        </div>
        <a-spin :loading="loading">
          <div class="space-y-2">
            <div v-for="s in styles" :key="s.id" class="cfg-row">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-[13.5px] font-medium text-[#131f38]">{{ s.name }}</span>
                <a-tag v-if="s.line" size="small" :color="lineColor(s.line)">{{ lineLabel(s.line) }}</a-tag>
                <a-tag v-else size="small" color="gray">通用</a-tag>
                <a-tag v-if="s.isBuiltin" size="small">内置</a-tag>
                <span class="flex-1" />
                <a-link @click="editStyle(s)">编辑</a-link>
                <a-link v-if="!s.isBuiltin" status="danger" @click="removeStyle(s)">删除</a-link>
              </div>
              <div class="mw-subtle leading-[1.7]">{{ s.description }}</div>
            </div>
          </div>
        </a-spin>
      </a-tab-pane>

      <!-- 合规词库 -->
      <a-tab-pane key="words" title="合规词库">
        <div class="flex items-center justify-between mb-3">
          <span class="mw-subtle">硬禁用词会阻断提交；软提示词仅提示不拦截</span>
          <a-button size="small" @click="editWord(null)">
            <template #icon><icon-plus /></template>
            添加
          </a-button>
        </div>
        <a-spin :loading="loading">
          <div class="space-y-1.5 max-h-[560px] overflow-auto">
            <div v-for="w in words" :key="w.id" class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#fbfcfe]">
              <a-tag :color="w.level === 'hard' ? 'red' : 'orange'" size="small">
                {{ w.level === 'hard' ? '禁用' : '提示' }}
              </a-tag>
              <span class="text-[13px] text-[#131f38] font-medium">{{ w.word }}</span>
              <span v-if="w.note" class="mw-subtle flex-1 truncate">{{ w.note }}</span>
              <span v-else class="flex-1" />
              <a-switch
                :model-value="w.enabled"
                size="small"
                :disabled="w.isBuiltin"
                @change="(v: unknown) => toggleWord(w, !!v)"
              />
              <a-link v-if="!w.isBuiltin" status="danger" @click="removeWord(w)">删除</a-link>
            </div>
          </div>
        </a-spin>
      </a-tab-pane>
    </a-tabs>

    <!-- 模板编辑 -->
    <a-modal
      v-model:visible="tplModal.visible"
      :title="tplModal.id ? '编辑模板' : '新建模板'"
      :width="640"
      :footer="false"
      unmount-on-close
    >
      <a-form :model="tplModal" layout="vertical">
        <a-form-item label="名称" required><a-input v-model="tplModal.name" /></a-form-item>
        <a-form-item label="一句话说明"><a-input v-model="tplModal.description" /></a-form-item>
        <a-form-item label="结构提示"
          ><a-input v-model="tplModal.structureHint" placeholder="开场 / 要点 / 收尾"
        /></a-form-item>
        <a-form-item label="风险提示话术">
          <a-textarea v-model="tplModal.riskHint" :auto-size="{ minRows: 2, maxRows: 4 }" />
        </a-form-item>
        <a-form-item label="提示词" required>
          <a-textarea v-model="tplModal.prompt" :auto-size="{ minRows: 6, maxRows: 12 }" />
        </a-form-item>
        <div class="flex justify-end gap-2">
          <a-button @click="tplModal.visible = false">取消</a-button>
          <a-button type="primary" :loading="saving" @click="saveTemplate">保存</a-button>
        </div>
      </a-form>
    </a-modal>

    <!-- 风格编辑 -->
    <a-modal
      v-model:visible="styleModal.visible"
      :title="styleModal.id ? '编辑风格' : '新建风格'"
      :width="640"
      :footer="false"
      unmount-on-close
    >
      <a-form :model="styleModal" layout="vertical">
        <a-form-item label="名称" required><a-input v-model="styleModal.name" /></a-form-item>
        <a-form-item label="适用线">
          <a-select v-model="styleLineModel" allow-clear placeholder="不选表示通用">
            <a-option value="manager">管理人</a-option>
            <a-option value="kos">员工 KOS</a-option>
            <a-option value="persona">素人</a-option>
          </a-select>
        </a-form-item>
        <a-form-item label="一句话说明"><a-input v-model="styleModal.description" /></a-form-item>
        <a-form-item label="提示词" required>
          <a-textarea v-model="styleModal.prompt" :auto-size="{ minRows: 5, maxRows: 10 }" />
        </a-form-item>
        <div class="flex justify-end gap-2">
          <a-button @click="styleModal.visible = false">取消</a-button>
          <a-button type="primary" :loading="saving" @click="saveStyle">保存</a-button>
        </div>
      </a-form>
    </a-modal>

    <!-- 词条编辑 -->
    <a-modal v-model:visible="wordModal.visible" title="添加词条" :width="440" :footer="false" unmount-on-close>
      <a-form :model="wordModal" layout="vertical">
        <a-form-item label="词条" required><a-input v-model="wordModal.word" /></a-form-item>
        <a-form-item label="级别">
          <a-radio-group v-model="wordModal.level" type="button" size="small">
            <a-radio value="hard">硬禁用（阻断提交）</a-radio>
            <a-radio value="soft">软提示</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="备注"><a-input v-model="wordModal.note" placeholder="为什么不能用" /></a-form-item>
        <div class="flex justify-end gap-2">
          <a-button @click="wordModal.visible = false">取消</a-button>
          <a-button type="primary" :loading="saving" @click="saveWord">保存</a-button>
        </div>
      </a-form>
    </a-modal>
  </a-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { configApi, type ComplianceWord, type CopyLine, type CopyStyle, type CopyTemplate } from '@/api/copy'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const tab = ref('templates')
const loading = ref(false)
const saving = ref(false)

const templates = ref<CopyTemplate[]>([])
const styles = ref<CopyStyle[]>([])
const words = ref<ComplianceWord[]>([])

const tplModal = reactive<{
  visible: boolean
  id: string | null
  name: string
  description: string
  structureHint: string
  riskHint: string
  prompt: string
}>({ visible: false, id: null, name: '', description: '', structureHint: '', riskHint: '', prompt: '' })

const styleModal = reactive<{
  visible: boolean
  id: string | null
  name: string
  description: string
  prompt: string
  line: CopyLine | null
}>({ visible: false, id: null, name: '', description: '', prompt: '', line: null })

const wordModal = reactive<{ visible: boolean; word: string; level: 'hard' | 'soft'; note: string }>({
  visible: false,
  word: '',
  level: 'hard',
  note: '',
})

watch(
  () => props.visible,
  async (v) => {
    if (v) await reloadAll()
  },
)

async function reloadAll(): Promise<void> {
  loading.value = true
  try {
    const [t, s, w] = await Promise.all([configApi.templates(), configApi.styles(), configApi.words()])
    templates.value = t
    styles.value = s
    words.value = w
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

function lineLabel(l: CopyLine | null): string {
  return { manager: '管理人', kos: '员工 KOS', persona: '素人' }[l as string] ?? '通用'
}

/** a-select 不接受 null，空值用 undefined 表示「通用」 */
const styleLineModel = computed<CopyLine | undefined>({
  get: () => styleModal.line ?? undefined,
  set: (v) => {
    styleModal.line = (v as CopyLine | undefined) ?? null
  },
})

function lineColor(l: CopyLine): string {
  return { manager: 'arcoblue', kos: 'green', persona: 'purple' }[l] ?? 'gray'
}

/* ── 模板 ── */
function editTemplate(t: CopyTemplate | null): void {
  tplModal.id = t?.id ?? null
  tplModal.name = t?.name ?? ''
  tplModal.description = t?.description ?? ''
  tplModal.structureHint = t?.structureHint ?? ''
  tplModal.riskHint = t?.riskHint ?? ''
  tplModal.prompt = t?.prompt ?? ''
  tplModal.visible = true
}

async function saveTemplate(): Promise<void> {
  if (!tplModal.name.trim() || !tplModal.prompt.trim()) {
    Message.warning('名称与提示词必填')
    return
  }
  saving.value = true
  try {
    const body = {
      name: tplModal.name.trim(),
      description: tplModal.description,
      structureHint: tplModal.structureHint,
      riskHint: tplModal.riskHint,
      prompt: tplModal.prompt,
    }
    if (tplModal.id) await configApi.updateTemplate(tplModal.id, body)
    else await configApi.createTemplate(body)
    Message.success('已保存')
    tplModal.visible = false
    await reloadAll()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

function removeTemplate(t: CopyTemplate): void {
  Modal.confirm({
    title: `删除模板「${t.name}」？`,
    content: '已生成的文案不受影响，但之后再也不能用它生成。',
    okText: '删除',
    cancelText: '取消',
    onOk: async () => {
      try {
        await configApi.deleteTemplate(t.id)
        Message.success('已删除')
        await reloadAll()
      } catch (e) {
        Message.error((e as Error).message)
      }
    },
  })
}

/* ── 风格 ── */
function editStyle(s: CopyStyle | null): void {
  styleModal.id = s?.id ?? null
  styleModal.name = s?.name ?? ''
  styleModal.description = s?.description ?? ''
  styleModal.prompt = s?.prompt ?? ''
  styleModal.line = s?.line ?? null
  styleModal.visible = true
}

async function saveStyle(): Promise<void> {
  if (!styleModal.name.trim() || !styleModal.prompt.trim()) {
    Message.warning('名称与提示词必填')
    return
  }
  saving.value = true
  try {
    const body = {
      name: styleModal.name.trim(),
      description: styleModal.description,
      prompt: styleModal.prompt,
      line: styleModal.line,
    }
    if (styleModal.id) await configApi.updateStyle(styleModal.id, body)
    else await configApi.createStyle(body)
    Message.success('已保存')
    styleModal.visible = false
    await reloadAll()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

function removeStyle(s: CopyStyle): void {
  Modal.confirm({
    title: `删除风格「${s.name}」？`,
    content: '使用该风格的生成记录会保留，但之后不可再选。',
    okText: '删除',
    cancelText: '取消',
    onOk: async () => {
      try {
        await configApi.deleteStyle(s.id)
        Message.success('已删除')
        await reloadAll()
      } catch (e) {
        Message.error((e as Error).message)
      }
    },
  })
}

/* ── 词条 ── */
function editWord(_w: ComplianceWord | null): void {
  wordModal.word = ''
  wordModal.level = 'hard'
  wordModal.note = ''
  wordModal.visible = true
}

async function saveWord(): Promise<void> {
  if (!wordModal.word.trim()) {
    Message.warning('请填写词条')
    return
  }
  saving.value = true
  try {
    await configApi.createWord({
      word: wordModal.word.trim(),
      level: wordModal.level,
      note: wordModal.note || undefined,
    })
    Message.success('已添加')
    wordModal.visible = false
    await reloadAll()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

async function toggleWord(w: ComplianceWord, enabled: boolean): Promise<void> {
  try {
    await configApi.updateWord(w.id, { enabled })
    w.enabled = enabled
  } catch (e) {
    Message.error((e as Error).message)
  }
}

function removeWord(w: ComplianceWord): void {
  Modal.confirm({
    title: `删除「${w.word}」？`,
    content: '删除后该词不再参与合规扫描。',
    okText: '删除',
    cancelText: '取消',
    onOk: async () => {
      try {
        await configApi.deleteWord(w.id)
        Message.success('已删除')
        await reloadAll()
      } catch (e) {
        Message.error((e as Error).message)
      }
    },
  })
}
</script>

<style scoped>
.cfg-row {
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid #eef2f8;
  background: #fbfcfe;
  transition: all 0.16s ease;
}
.cfg-row:hover {
  background: #fff;
  border-color: #e6ecf5;
}
</style>
