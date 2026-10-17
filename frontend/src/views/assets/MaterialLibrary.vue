<template>
  <div class="p-7 pb-10 max-w-[1200px] mx-auto">
    <PageHead title="素材库">
      <template #sub>字体、声音、素材包与数字人形象的统一管理入口 · 仅管理员可上传与管理</template>
    </PageHead>

    <div class="flex items-center gap-4 mb-4">
      <div class="flex-1 min-w-0">
        <a-tabs v-model:active-key="tabKey" type="line" class="mw-tabs">
          <a-tab-pane key="fonts"><template #title>字体库 <span class="mw-subtle">{{ materials.fonts.length }}</span></template></a-tab-pane>
          <a-tab-pane key="voices"><template #title>声音库 <span class="mw-subtle">{{ materials.voices.length }}</span></template></a-tab-pane>
          <a-tab-pane key="packs"><template #title>素材库 <span class="mw-subtle">{{ materials.packs.length }}</span></template></a-tab-pane>
          <a-tab-pane key="avatars"><template #title>数字人形象 <span class="mw-subtle">{{ materials.avatars.length }}</span></template></a-tab-pane>
        </a-tabs>
      </div>
      <a-input-search :style="{ width: '200px' }" :placeholder="`搜索${tabName}...`" allow-clear />
      <a-button type="primary"><template #icon><icon-plus /></template>上传{{ tabName }}</a-button>
    </div>

    <div class="mw-card">
      <div class="grid grid-cols-[3fr_3.4fr_2fr_1.4fr] text-[12px] mw-thead px-5 py-2.5 border-b border-[var(--mw-border)]">
        <span>名称</span><span>格式 / 信息</span><span>授权 / 归属</span><span class="text-right">启用状态</span>
      </div>
      <div v-for="m in lists[tabKey]" :key="m.name" class="grid grid-cols-[3fr_3.4fr_2fr_1.4fr] items-center px-5 py-3.5 border-b border-[#f2f4f7] last:border-none">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-[8px] bg-[var(--mw-primary-bg)] flex items-center justify-center flex-shrink-0">
            <component :is="typeIcon" :size="17" class="text-[color:var(--mw-primary)]" />
          </div>
          <span class="text-[14px] font-medium truncate">{{ m.name }}</span>
        </div>
        <span class="mw-subtle">{{ m.meta }}</span>
        <span><span class="mw-tag" :class="m.auth.includes('已确认') ? 'mw-tag-green' : 'mw-tag-yellow'">{{ m.auth }}</span></span>
        <div class="flex items-center justify-end gap-2">
          <span class="mw-tag" :class="m.enabled ? 'mw-tag-blue' : 'mw-tag-gray'">{{ m.enabled ? '启用中' : '未启用' }}</span>
          <a-switch v-model="m.enabled" size="small" />
        </div>
      </div>
    </div>

    <div class="mt-4 mw-subtle flex items-center gap-1">
      <icon-info-circle :size="13" />上传后默认"未启用"，手动启用后进入视频创作/剪辑的可选列表；停用不影响已在生成流程中使用的素材。
    </div>
    <div class="mw-corner-note">原型预览 · 演示数据</div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { IconFile, IconSound, IconFolder, IconUser } from '@arco-design/web-vue/es/icon'
import PageHead from '@/components/PageHead.vue'
import { materials } from '@/mocks/data'

const tabKey = ref<keyof typeof materials>('fonts')
const tabName = computed(() => ({ fonts: '字体', voices: '声音', packs: '素材包', avatars: '形象' }[tabKey.value] ?? '素材'))
const lists = reactive(
  Object.fromEntries(
    Object.entries(materials).map(([k, v]) => [k, v.map((x) => reactive({ ...x }))]),
  ) as Record<keyof typeof materials, (typeof materials)['fonts']>,
)
const typeIcon = computed(() => ({ fonts: IconFile, voices: IconSound, packs: IconFolder, avatars: IconUser }[tabKey.value] ?? IconFile))
</script>
