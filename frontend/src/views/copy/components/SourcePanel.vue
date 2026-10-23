<template>
  <section class="copy-source" aria-label="来源材料">
    <div class="copy-source-heading">
      <div class="mw-card-title">来源材料</div>
      <span v-if="c" class="mw-tag mw-tag-gray">{{ c.sourceLabel }}</span>
    </div>

    <!-- 加载 -->
    <a-skeleton v-if="loading" :animation="true">
      <a-skeleton-line :rows="4" />
    </a-skeleton>

    <!-- 空态 -->
    <a-empty v-else-if="!c" description="未选择文案" />

    <template v-else>
      <!-- 标题 -->
      <div class="mb-3">
        <div class="text-[15px] font-semibold text-[#131f38] leading-relaxed">
          {{ c.title || '（未命名文案）' }}
        </div>
        <div class="mw-subtle mt-1">
          {{ personaName }}
          <template v-if="c.lineLabel"> · {{ c.lineLabel }}</template>
          <template v-if="c.createdAt"> · {{ fmtTime(c.createdAt) }}</template>
        </div>
      </div>

      <!-- 来源摘要 -->
      <div v-if="summary" class="copy-source-summary">
        <div class="mw-subtle mb-1">{{ summary.label }}</div>
        <div class="copy-source-fulltext text-[13px] leading-[1.85] text-[#3c4a63] whitespace-pre-wrap">
          {{ summary.text }}
        </div>
      </div>

      <!-- 文章大纲（article 模式） -->
      <div v-if="article?.outline?.length" class="mb-3">
        <div class="mw-subtle mb-2">原文大纲 · {{ article.charCount }} 字</div>
        <div class="space-y-1">
          <div
            v-for="node in article.outline"
            :key="node.index"
            class="flex items-start gap-2 text-[13px] leading-[1.7] text-[#3c4a63]"
            :style="{ paddingLeft: `${(node.level - 1) * 12}px` }"
          >
            <span class="shrink-0 w-[22px] text-[#9aa6ba] tabular-nums">{{ node.index }}</span>
            <span class="flex-1">{{ node.title }}</span>
            <span class="shrink-0 mw-subtle tabular-nums">{{ node.chars }}字</span>
          </div>
        </div>
      </div>

      <!-- 关联选题 -->
      <div v-if="topic" class="mw-form-row">
        <span class="mw-form-label">关联选题</span>
        <span class="text-[13px] text-[#3c4a63] flex-1 truncate">{{ topic.title }}</span>
      </div>

      <!-- 关键词 -->
      <div v-if="c.keywords" class="mw-form-row">
        <span class="mw-form-label">关键词</span>
        <div class="flex flex-wrap gap-1.5 flex-1">
          <a-tag v-for="k in keywordList" :key="k" size="small">{{ k }}</a-tag>
        </div>
      </div>

      <!-- 状态说明 -->
      <div v-if="c.status === 'in_review'" class="mt-3 px-3 py-2 rounded-lg bg-[#fdf4e3] text-[12px] text-[#a26a08]">
        文案正在审核中，内容已锁定，不可编辑。
      </div>
      <div
        v-else-if="c.status === 'rejected'"
        class="mt-3 px-3 py-2 rounded-lg bg-[#fdeeee] text-[12px] text-[#c03e35]"
      >
        审核未通过<template v-if="c.rejectReason">：{{ c.rejectReason }}</template
        >，修改后可重新提交。
      </div>
      <div
        v-else-if="c.status === 'approved'"
        class="mt-3 px-3 py-2 rounded-lg bg-[#e9f7ef] text-[12px] text-[#12805c]"
      >
        已审核通过。再次编辑将回到「修订中」，并保留原通过版本。
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useCopyStore } from '@/stores/copy'

const store = useCopyStore()
const loading = computed(() => store.loading)
const c = computed(() => store.copy)
/**
 * 人物名：`persona` 在详情接口的**顶层**（与 copy 平级），不在 copy 对象里。
 * 早期这里写成 `c.persona?.name`，取到的永远是 undefined，
 * 于是所有文案（包括从爆款选题送入、明确绑定了人物的）都显示「未绑定人物」。
 */
const personaName = computed(() => {
  const p = store.detail?.persona ?? (c.value as any)?.persona
  return p?.name || '未绑定人物'
})
const summary = computed(() => store.detail?.sourceSummary ?? null)
const article = computed(() => store.detail?.article ?? null)
const topic = computed(() => store.detail?.topic ?? null)

const keywordList = computed(() =>
  (c.value?.keywords ?? '')
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 12),
)

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>
