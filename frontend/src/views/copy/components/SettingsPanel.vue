<template>
  <div class="copy-settings">
    <div class="flex items-center justify-end mb-3">
      <a-link v-if="!readonly" @click="emit('preview', { ...model })">
        <template #icon><icon-eye /></template>
        确认创作要求
      </a-link>
    </div>

    <a-spin :loading="store.optionsLoading" class="copy-settings-fields w-full">
      <!-- 补充要求 -->
      <div class="creative-requirements">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[13px] text-[#4a5872]">本次创作要求</span>
          <span class="mw-subtle tabular-nums"
            >{{ (model.instructions ?? '').length }}/{{ limits.maxInstructions }}</span
          >
        </div>
        <a-textarea
          v-model="model.instructions"
          :max-length="limits.maxInstructions"
          :auto-size="{ minRows: 2, maxRows: 4 }"
          :disabled="readonly"
          placeholder="写给谁？这次讲什么角度？必须保留什么？不要出现什么？"
        />
      </div>

      <div class="mw-form-row items-start">
        <label class="mw-form-label pt-1" for="copy-template">内容模板</label>
        <div class="flex-1 min-w-0">
          <a-select
            id="copy-template"
            v-model="model.templateId"
            :disabled="readonly"
            placeholder="选择内容模板"
            class="w-full"
          >
            <a-option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</a-option>
          </a-select>
          <p v-if="currentTemplate" class="mw-subtle mt-2 leading-relaxed">{{ currentTemplate.description }}</p>
          <details v-if="currentTemplate?.structureHint" class="copy-structure">
            <summary>查看文案结构</summary>
            <p>{{ currentTemplate.structureHint }}</p>
          </details>
        </div>
      </div>

      <!-- 风格 -->
      <div class="mw-form-row items-start">
        <span class="mw-form-label pt-1">表达风格</span>
        <div class="flex-1">
          <a-select v-model="model.styleId" :disabled="readonly" placeholder="选择风格" class="w-full">
            <a-option v-for="s in styles" :key="s.id" :value="s.id">
              {{ s.name }}
              <span class="text-[11px] text-[#9aa6ba] ml-1">{{ s.description }}</span>
            </a-option>
          </a-select>
          <div v-if="!styles.length" class="mw-subtle mt-1">暂无适合当前人物的风格</div>
        </div>
      </div>

      <!-- 时长 -->
      <div class="mw-form-row duration-setting">
        <span class="mw-form-label pt-1">目标时长</span>
        <div class="flex-1">
          <a-radio-group v-model="model.durationTier" type="button" :disabled="readonly" size="small">
            <a-radio v-for="d in durationTiers" :key="d.key" :value="d.key" :aria-label="d.name">{{
              d.name.includes('（') ? d.name.split('（')[1].replace('）', '').replace(/\s/g, '') : d.name
            }}</a-radio>
          </a-radio-group>

          <!-- 自定义秒数 -->
          <div v-if="model.durationTier === 'custom'" class="mt-2 flex items-center gap-2">
            <a-input-number
              v-model="durationSecondsModel"
              :min="limits.customDurationMin"
              :max="limits.customDurationMax"
              :precision="0"
              :disabled="readonly"
              class="!w-[120px]"
            />
            <span class="mw-subtle">秒</span>
            <span class="mw-subtle">
              {{ limits.customDurationMin }}–{{ limits.customDurationMax }} 秒， 约 {{ wordRangeText }}
            </span>
          </div>
          <div v-else class="mt-1.5 mw-subtle">约 {{ wordRangeText }}</div>
        </div>
      </div>

      <!-- 份数 -->
      <div class="mw-form-row copy-generation-count">
        <span class="mw-form-label">生成份数</span>
        <a-input-number
          v-model="model.count"
          :min="1"
          :max="limits.maxBatchCount"
          :precision="0"
          :disabled="readonly"
          class="!w-[120px]"
        />
        <span class="mw-subtle">最多 {{ limits.maxBatchCount }} 份 / 次</span>
      </div>

      <!-- 操作 -->

      <!-- 生成进度：可感知的实时进度（真实模型单份 40–60 秒，静止的「正在生成…」会让用户以为卡住） -->
      <div
        v-if="store.activeGeneration"
        class="mt-3 px-3.5 py-3 rounded-lg border gen-panel"
        :class="{
          'gen-running': isGenerating,
          'gen-done': genStatus === 'done',
          'gen-warn': genStatus === 'partial' || genStatus === 'failed' || store.genTimedOut,
        }"
      >
        <!-- 状态行 -->
        <div class="flex items-center gap-2 text-[13px]">
          <a-spin v-if="isGenerating" :size="14" />
          <icon-check-circle-fill v-else-if="genStatus === 'done'" style="color: #12805c" />
          <icon-exclamation-circle-fill v-else style="color: #b95f1d" />
          <span class="flex-1 font-medium text-[#2b3752]">{{ genStatusText }}</span>
          <span v-if="isGenerating" class="mw-subtle tabular-nums">{{ elapsedText }}</span>
          <span class="mw-subtle tabular-nums"> {{ doneCount }}/{{ store.activeGeneration.count }} </span>
        </div>

        <!-- 进度条 -->
        <div v-if="isGenerating || genStatus === 'done' || genStatus === 'partial'" class="mt-2.5">
          <div class="gen-track">
            <div class="gen-fill" :style="{ width: `${store.genProgress}%` }" />
          </div>
          <div class="flex items-center justify-between mt-1.5 text-[11px] text-[#8894a8]">
            <span>{{ progressHint }}</span>
            <span v-if="store.genRemainMs !== null && isGenerating" class="tabular-nums">
              预计还需 {{ remainText }}
            </span>
          </div>
        </div>

        <!-- 已产出的稿 -->
        <div v-if="store.generatedDrafts.length" class="mt-2 flex flex-wrap gap-1.5">
          <span v-for="d in store.generatedDrafts" :key="d.id" class="gen-chip">
            稿 {{ d.draftNo }} · {{ d.wordCount }} 字
          </span>
          <span
            v-for="n in Math.max(0, (store.activeGeneration?.count ?? 0) - store.generatedDrafts.length)"
            :key="`ph-${n}`"
            class="gen-chip gen-chip-pending"
          >
            待产出
          </span>
        </div>

        <!-- 错误 -->
        <div v-if="store.activeGeneration.error" class="mt-1.5 text-[12px] text-[#c03e35] whitespace-pre-wrap">
          {{ store.activeGeneration.error }}
        </div>

        <!-- 超时兜底 -->
        <div v-if="store.genTimedOut" class="mt-2 flex items-center gap-2 text-[12px] text-[#8a6212]">
          <span>等待较久，可能仍在排队。</span>
          <a-link @click="store.resumePolling()">继续等待</a-link>
        </div>
      </div>
    </a-spin>
    <div class="copy-generate-actions">
      <div v-if="store.settingsError" role="alert" class="settings-error">
        <span>{{ store.settingsError }}</span
        ><a-link @click="store.saveCreativeSettings()">重试</a-link>
      </div>
      <div v-if="model.count > 1" class="mw-subtle">按误区、场景、问答等不同方向生成 {{ model.count }} 篇</div>
      <a-button type="primary" long :loading="store.generating" :disabled="!canGenerate" @click="onGenerate"
        ><template #icon><icon-edit /></template>生成文案</a-button
      >
      <span v-if="draftLimitReached" class="mw-subtle"
        >已有 {{ store.drafts.length }} 篇，本次最多可生成
        {{ Math.max(0, limits.maxDrafts - store.drafts.length) }} 篇，请减少份数</span
      >
      <span v-if="readonly" class="mw-subtle">审核中不可生成新稿</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import type { CreativeSettings } from '@/api/copy'

const emit = defineEmits<{ (e: 'preview', settings: CreativeSettings): void }>()
const store = useCopyStore()

const readonly = computed(() => !store.canEdit)

const templates = computed(() => store.options?.templates ?? [])
const styles = computed(() => store.availableStyles)
const durationTiers = computed(() => store.options?.durationTiers ?? [])
const limits = computed(
  () =>
    store.options?.limits ?? {
      charsPerSec: 3.5,
      maxDrafts: 10,
      maxBatchCount: 5,
      customDurationMin: 10,
      customDurationMax: 180,
      maxInstructions: 500,
      maxTitle: 60,
      maxManualSource: 5000,
      similarityThreshold: 0.3,
    },
)

const model = store.creativeSettings

const currentTemplate = computed(() => templates.value.find((t) => t.id === model.templateId) ?? null)

/**
 * a-input-number 的 v-model 不接受 null，这里做一层代理：
 * 组件侧空值用 undefined，业务侧统一用 null 提交给后端。
 */
const durationSecondsModel = computed<number | undefined>({
  get: () => model.durationSeconds ?? undefined,
  set: (v) => {
    model.durationSeconds = typeof v === 'number' && Number.isFinite(v) ? v : null
  },
})

/** 字数区间预览（与后端一致：秒数 × 3–4） */
const wordRangeText = computed(() => {
  const tier = durationTiers.value.find((d) => d.key === model.durationTier)
  if (!tier) return '—'
  if (tier.custom) {
    const sec = model.durationSeconds ?? 0
    if (!sec) return '请填写秒数'
    const min = Math.round(sec * (limits.value.charsPerSec - 0.5))
    const max = Math.round(sec * (limits.value.charsPerSec + 0.5))
    return `${min}–${max} 字（${sec} 秒）`
  }
  return `${tier.minWords}–${tier.maxWords} 字`
})

const draftLimitReached = computed(() => {
  const used = store.drafts.length
  return used + model.count > limits.value.maxDrafts
})

const canGenerate = computed(
  () =>
    !readonly.value &&
    !store.generating &&
    !!model.templateId &&
    !!model.styleId &&
    !draftLimitReached.value &&
    (model.durationTier !== 'custom' || !!model.durationSeconds),
)

const isGenerating = computed(
  () => store.generating || ['pending', 'running'].includes(store.activeGeneration?.status ?? ''),
)

const genStatus = computed(() => store.activeGeneration?.status ?? '')

/**
 * 已完成份数。
 * 后端 `succeeded` 只在收尾时写入，运行中恒为 0；过程展示必须用「已落库的稿数」，
 * 否则用户等了 60 秒看到的一直是 0/5，会以为卡死。
 */
const doneCount = computed(() => {
  const g = store.activeGeneration
  if (!g) return 0
  if (['done', 'partial', 'failed'].includes(g.status)) return g.succeeded ?? 0
  return store.generatedDrafts.length
})

const genStatusText = computed(() => {
  const g = store.activeGeneration
  switch (genStatus.value) {
    case 'pending':
      return '已提交，排队中…'
    case 'running': {
      const total = g?.count ?? 0
      if (doneCount.value > 0 && doneCount.value < total) return `正在生成… 已完成 ${doneCount.value}/${total} 份`
      return '正在创作…'
    }
    case 'done':
      return `生成完成 · ${g?.succeeded ?? 0} 份新稿已就绪`
    case 'partial':
      return `部分完成 · 成功 ${g?.succeeded ?? 0} 份，失败 ${g?.failed ?? 0} 份`
    case 'failed':
      return '生成失败'
    default:
      return '生成中'
  }
})

/** 已耗时 mm:ss */
const elapsedText = computed(() => fmtDuration(store.genElapsedMs))

/** 剩余时间 */
const remainText = computed(() => {
  const ms = store.genRemainMs
  if (ms === null) return ''
  if (ms < 5000) return '即将完成'
  return `约 ${Math.ceil(ms / 10000) * 10} 秒`
})

/** 进度条下方的一句话提示 */
const progressHint = computed(() => {
  const g = store.activeGeneration
  if (!g) return ''
  if (g.status === 'pending') return '正在排队，请稍候'
  if (genStatus.value === 'done') return '新稿已添加，可打开查看'
  if (genStatus.value === 'partial' || genStatus.value === 'failed') return '可查看失败原因后重试'
  if (doneCount.value > 0)
    return `已产出 ${doneCount.value} 份，剩余 ${Math.max(0, (g.count ?? 0) - doneCount.value)} 份正在写`
  return '正在整理素材并撰写文案，请稍候'
})

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r} 秒`
}

// 模板/风格选项异步到达后补默认值
watch(
  [templates, styles],
  () => {
    if (!model.templateId && templates.value.length) model.templateId = templates.value[0].id
    if (!model.styleId && styles.value.length) model.styleId = styles.value[0].id
    // 已选风格不在当前线的可选范围内时，回退到第一个可用风格
    if (model.styleId && !styles.value.some((s) => s.id === model.styleId)) {
      model.styleId = styles.value[0]?.id ?? ''
    }
  },
  { immediate: true },
)

async function onGenerate(): Promise<void> {
  if (!(await store.saveCreativeSettings())) {
    Message.error(store.settingsError || '请补全创作设置')
    return
  }
  if (model.durationTier === 'custom' && !model.durationSeconds) {
    Message.warning('请填写自定义时长（秒）')
    return
  }
  const ok = await store.generate({
    templateId: model.templateId,
    styleId: model.styleId,
    durationTier: model.durationTier,
    durationSeconds: model.durationTier === 'custom' ? model.durationSeconds : null,
    count: model.count,
    instructions: model.instructions.trim() || undefined,
  })
  if (ok) Message.success('已开始生成，完成后自动载入新稿')
}
</script>

<style scoped>
.tpl-chip {
  text-align: left;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid #e6ecf5;
  background: #fff;
  font-size: 13px;
  color: #3c4a63;
  transition: all 0.18s ease;
  cursor: pointer;
  max-width: 220px;
}
.tpl-chip:hover:not(:disabled) {
  border-color: #ccd9ef;
  box-shadow: 0 2px 6px rgba(23, 32, 52, 0.06);
}
.tpl-chip.active {
  border-color: #2f6bff;
  background: #eef4ff;
  color: #1d4ed8;
  box-shadow: 0 0 0 3px rgba(47, 107, 255, 0.1);
}
.tpl-chip:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/* ── 生成进度面板 ───────────────────────────────────────────── */
.gen-panel {
  background: #f8fafd;
  border-color: #eef2f8;
  transition:
    background 0.25s ease,
    border-color 0.25s ease;
}
.gen-running {
  background: var(--mw-primary-faint);
  border-color: #dbe8ff;
}
.gen-done {
  background: #f4fbf8;
  border-color: #d6efe6;
}
.gen-warn {
  background: #fffaf3;
  border-color: #fbe8d0;
}

.gen-track {
  height: 5px;
  border-radius: 999px;
  background: #e8eef8;
  overflow: hidden;
}
.gen-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--mw-primary);
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  /* 运行中给一条流动高光，明确「还在动」 */
  background-size: 200% 100%;
  animation: gen-flow 1.6s linear infinite;
}
.gen-done .gen-fill {
  background: #12805c;
  animation: none;
}
@keyframes gen-flow {
  0% {
    background-position: -100% 0;
  }
  100% {
    background-position: 100% 0;
  }
}

.gen-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  color: #1d4ed8;
  background: #eef4ff;
  border: 1px solid #dbe8ff;
  animation: chip-in 0.3s ease;
}
.gen-chip-pending {
  color: #93a0b5;
  background: transparent;
  border: 1px dashed #dbe2ee;
  animation: none;
}
@keyframes chip-in {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
