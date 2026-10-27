<template>
  <section class="candidate-shelf" aria-label="候选稿与定稿">
    <div class="candidate-heading">
      <div>
        <strong>选稿与定稿</strong><span class="mw-subtle">{{ store.drafts.length }} 篇候选</span>
      </div>
      <span v-if="final" class="final-status" :class="{ stale: !finalValid }">{{
        finalValid
          ? `已选用：${store.drafts.find((d) => d.id === final?.draftId)?.name || '定稿'}`
          : '内容有修改，请重新定稿'
      }}</span>
      <div class="candidate-actions">
        <a-button size="small" :disabled="picked.length !== 2" @click="compareOpen = true"
          >对比 {{ picked.length }}/2</a-button
        >
        <a-button
          size="small"
          :disabled="!store.canEdit || !store.editor || store.generating"
          :loading="finalizing"
          @click="finalize"
          >定稿当前稿</a-button
        >
        <button class="shelf-toggle" :aria-expanded="expanded" @click="expanded = !expanded">
          {{ expanded ? '收起候选' : '展开候选稿' }}<icon-down />
        </button>
      </div>
    </div>
    <div v-if="expanded" class="candidate-grid">
      <article
        v-for="d in store.drafts"
        :key="d.id"
        class="candidate-card"
        :class="{ selected: d.id === store.editor?.draftId }"
      >
        <div class="candidate-card-top">
          <a-checkbox
            :model-value="picked.includes(d.id)"
            :disabled="!picked.includes(d.id) && picked.length >= 2"
            @change="toggle(d.id)"
            ><span class="mw-subtle">加入对比</span></a-checkbox
          ><span v-if="d.isFinal" class="mw-tag mw-tag-gray">定稿</span>
        </div>
        <div class="candidate-direction">{{ d.name }}</div>
        <h3>{{ d.title || '未命名' }}</h3>
        <p>{{ d.sections[0]?.text }}</p>
        <div class="candidate-card-bottom">
          <span>{{ bodyCount(d) }} 字 · 约 {{ seconds(d) }} 秒</span
          ><a-button
            size="mini"
            :type="d.id === store.editor?.draftId ? 'primary' : 'secondary'"
            @click="emit('open', d.id)"
            >{{ d.id === store.editor?.draftId ? '正在编辑' : '打开编辑' }}</a-button
          >
        </div>
      </article>
    </div>
    <a-modal v-model:visible="compareOpen" title="候选稿对比" :width="1040" :footer="false" class="copy-compare-modal">
      <div class="compare-columns">
        <article v-for="d in compared" :key="d.id">
          <div class="mw-subtle">{{ d.name }} · 正文 {{ bodyCount(d) }} 字 · 约 {{ seconds(d) }} 秒</div>
          <h2>{{ d.title }}</h2>
          <section v-for="(s, i) in d.sections" :key="i">
            <p>{{ s.text }}</p>
          </section>
          <a-button type="primary" @click="adopt(d.id)">采用并编辑这篇</a-button>
        </article>
      </div>
    </a-modal>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { copyApi, type Draft } from '@/api/copy'
import { useCopyStore } from '@/stores/copy'
const emit = defineEmits<{ (e: 'open', id: string): void }>()
const store = useCopyStore()
const expanded = ref(false),
  picked = ref<string[]>([]),
  compareOpen = ref(false),
  finalizing = ref(false)
const final = computed(() => store.copy?.settings?.finalSelection as { draftId: string; versionNo: number } | undefined)
const finalValid = computed(
  () =>
    !!store.drafts.find((d) => d.id === final.value?.draftId && d.isFinal) &&
    !(store.editor?.draftId === final.value?.draftId && store.isDirty),
)
const compared = computed(() =>
  picked.value.map((id) => store.drafts.find((d) => d.id === id)).filter((d): d is Draft => !!d),
)
function count(text: string) {
  return (text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[a-zA-Z0-9]+/g) ?? []).length
}
function bodyCount(d: Draft) {
  return d.sections.reduce((n, s) => n + count(s.text), 0)
}
function seconds(d: Draft) {
  return (bodyCount(d) / (store.options?.limits.charsPerSec ?? 3.5)).toFixed(1)
}
function toggle(id: string) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id].slice(0, 2)
}
function adopt(id: string) {
  emit('open', id)
  compareOpen.value = false
}
watch(
  () => store.copy?.id,
  () => {
    picked.value = []
    expanded.value = false
  },
)
async function finalize() {
  if (!store.copy || !store.editor) return
  finalizing.value = true
  try {
    if (store.isDirty && (await store.save()) !== 'ok') throw new Error(store.error ?? '请先保存当前改动')
    if (!(await store.saveCreativeSettings())) throw new Error(store.settingsError || '设置尚未保存')
    await copyApi.finalize(store.copy.id, { draftId: store.editor.draftId, rev: store.editor.rev })
    await store.load(store.copy.id)
    Message.success('已定稿，可提交审核')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    finalizing.value = false
  }
}
</script>
<style scoped>
.candidate-shelf {
  margin-bottom: 12px;
  padding: 14px 16px;
  border: 1px solid var(--mw-border);
  border-radius: 10px;
  background: #fff;
}
.candidate-heading,
.candidate-heading > div:first-child,
.candidate-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.candidate-heading {
  flex-wrap: wrap;
}
.candidate-heading > div:first-child {
  flex: 1;
}
.candidate-heading strong {
  font-size: 14px;
}
.shelf-toggle {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--mw-primary);
  border: 0;
  background: transparent;
  cursor: pointer;
}
.final-status {
  font-size: 11px;
  background: #eaf6ef;
  color: #267052;
  padding: 3px 8px;
  border-radius: 5px;
}
.final-status.stale {
  background: #fff4df;
  color: #946010;
}
.candidate-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.candidate-card {
  padding: 14px;
  border: 1px solid #e4e9ed;
  border-radius: 8px;
  background: #fcfdfd;
  min-width: 0;
}
.candidate-card.selected {
  border-color: var(--mw-primary);
  background: var(--mw-primary-faint);
}
.candidate-card-top,
.candidate-card-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.candidate-direction {
  font-size: 11px;
  color: #71817b;
  margin: 12px 0 5px;
}
.candidate-card h3 {
  font-size: 14px;
  line-height: 1.6;
  margin: 0;
  min-height: 44px;
}
.candidate-card p {
  font-size: 12px;
  line-height: 1.8;
  color: #69776f;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 43px;
  margin: 8px 0 12px;
}
.candidate-card-bottom {
  font-size: 11px;
  color: #7a8781;
}
.compare-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
.compare-columns > article {
  padding: 18px;
  background: #f8faf9;
  border: 1px solid #e5ebe7;
  border-radius: 10px;
  min-width: 0;
}
.compare-columns h2 {
  font-size: 19px;
  line-height: 1.6;
  margin: 12px 0 20px;
}
.compare-columns section {
  margin-bottom: 20px;
  font-size: 14px;
  line-height: 1.9;
}
.compare-columns section strong {
  font-size: 12px;
  color: #7c8881;
}
.compare-columns p {
  white-space: pre-wrap;
  margin-top: 6px;
}
@media (max-width: 700px) {
  .compare-columns {
    grid-template-columns: 1fr;
  }
  .candidate-actions {
    flex-wrap: wrap;
  }
  .candidate-grid {
    grid-template-columns: 1fr;
  }
}
</style>
<style scoped>
@media (max-width: 600px) {
  .candidate-heading > div:first-child {
    flex: 1 0 100%;
  }
  .candidate-heading strong,
  .final-status {
    white-space: nowrap;
  }
  .candidate-actions {
    width: 100%;
    gap: 8px;
  }
  .candidate-actions .shelf-toggle {
    margin-left: auto;
  }
}
</style>
