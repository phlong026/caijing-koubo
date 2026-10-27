<template>
  <section class="structure-panel" aria-label="对标结构拆解">
    <div class="structure-head">
      <strong>结构拆解</strong>
      <span v-if="!structure" class="mw-subtle">拆出钩子、段落分工和节奏，生成时可沿用</span>
      <span class="flex-1" />
      <a-button
        v-if="!structure"
        size="small"
        type="primary"
        :loading="analyzing"
        :disabled="!store.canEdit"
        @click="analyze(false)"
        >拆解结构</a-button
      >
      <a-link v-else-if="store.canEdit" :loading="analyzing" @click="analyze(true)">重新拆解</a-link>
    </div>

    <template v-if="structure">
      <div class="structure-row">
        <span class="structure-label">钩子</span>
        <div class="structure-body">
          <a-tag size="small" color="arcoblue">{{ structure.hook.type }}</a-tag>
          <span v-if="structure.hook.note" class="mw-subtle">{{ structure.hook.note }}</span>
          <p v-if="structure.hook.text" class="structure-quote">「{{ structure.hook.text }}」</p>
        </div>
      </div>

      <div class="structure-row">
        <span class="structure-label">段落分工</span>
        <ol class="structure-sections">
          <li v-for="(s, i) in structure.sections" :key="i">
            <a-tag size="small">{{ s.role }}</a-tag>
            <span>{{ s.summary }}</span>
          </li>
        </ol>
      </div>

      <div class="structure-row">
        <span class="structure-label">节奏</span>
        <span class="structure-body">{{ rhythmText }}</span>
      </div>

      <div v-if="structure.reusable.length" class="structure-row">
        <span class="structure-label">可借鉴</span>
        <ul class="structure-list">
          <li v-for="(t, i) in structure.reusable" :key="i">{{ t }}</li>
        </ul>
      </div>
      <div v-if="structure.forbidden.length" class="structure-row">
        <span class="structure-label">不可挪用</span>
        <ul class="structure-list structure-forbidden">
          <li v-for="(t, i) in structure.forbidden" :key="i">{{ t }}</li>
        </ul>
      </div>

      <div class="structure-use">
        <span class="structure-label">生成时沿用</span>
        <a-checkbox :model-value="use.hook" :disabled="!store.canEdit || savingUse" @change="(v) => toggle('hook', v)"
          >钩子</a-checkbox
        >
        <a-checkbox
          :model-value="use.sections"
          :disabled="!store.canEdit || savingUse"
          @change="(v) => toggle('sections', v)"
          >段落分工</a-checkbox
        >
        <a-checkbox
          :model-value="use.rhythm"
          :disabled="!store.canEdit || savingUse"
          @change="(v) => toggle('rhythm', v)"
          >节奏</a-checkbox
        >
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type ScriptStructure, type StructureUse } from '@/api/copy'

const props = defineProps<{ structure?: ScriptStructure | null; use?: StructureUse }>()
const store = useCopyStore()

const structure = ref<ScriptStructure | null>(props.structure ?? null)
const use = ref<StructureUse>({ hook: true, sections: true, rhythm: true, ...(props.use ?? {}) })
const analyzing = ref(false)
const savingUse = ref(false)

// 切换文案 / 重新载入素材后，以服务端为准
watch(
  () => [props.structure, props.use],
  () => {
    structure.value = props.structure ?? null
    use.value = { hook: true, sections: true, rhythm: true, ...(props.use ?? {}) }
  },
)

const rhythmText = computed(() => {
  const r = structure.value?.rhythm
  if (!r) return ''
  const parts = [`共 ${r.sentenceCount} 句`]
  if (r.seconds) parts.push(`全片约 ${r.seconds} 秒`)
  if (r.charsPerSecond) parts.push(`约 ${r.charsPerSecond} 字/秒`)
  parts.push(`平均每句 ${r.charsPerSentence} 字`)
  if (r.hookSeconds) parts.push(`开场 ${r.hookSeconds} 秒内点明主题`)
  return parts.join(' · ')
})

async function analyze(refresh: boolean): Promise<void> {
  if (!store.copy) return
  analyzing.value = true
  try {
    const r = await copyApi.analyzeStructure(store.copy.id, refresh)
    structure.value = r.structure
    use.value = r.use
    Message.success(r.cached ? '已有拆解结果' : '已拆解')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    analyzing.value = false
  }
}

async function toggle(key: keyof StructureUse, value: boolean | (string | number | boolean)[]): Promise<void> {
  if (!store.copy) return
  const prev = use.value
  const next = { ...prev, [key]: !!value }
  use.value = next
  savingUse.value = true
  try {
    await copyApi.saveStructureUse(store.copy.id, next)
  } catch (e) {
    use.value = prev
    Message.error((e as Error).message)
  } finally {
    savingUse.value = false
  }
}
</script>

<style scoped>
.structure-panel {
  margin-top: 14px;
  padding: 14px 16px;
  border: 1px solid var(--mw-border);
  border-radius: 8px;
  background: #fbfcfb;
}
.structure-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.structure-row {
  display: flex;
  gap: 14px;
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.8;
}
.structure-label {
  flex: 0 0 64px;
  color: var(--mw-text3);
  font-size: 12px;
  padding-top: 2px;
}
.structure-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.structure-quote {
  flex: 1 0 100%;
  margin: 2px 0 0;
  color: var(--mw-text2);
}
.structure-sections,
.structure-list {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.structure-sections li {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.structure-list li::before {
  content: '·';
  margin-right: 6px;
  color: var(--mw-text3);
}
.structure-forbidden li {
  color: #946010;
}
.structure-use {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--mw-border);
  font-size: 13px;
}
.structure-use .structure-label {
  padding-top: 0;
}
@media (max-width: 650px) {
  .structure-row {
    flex-direction: column;
    gap: 4px;
  }
  .structure-label {
    flex-basis: auto;
  }
}
</style>
