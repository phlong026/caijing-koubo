<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="人物库">
      <template #sub>
        <div>
          <div>管理人物形象、口播分身与声音绑定</div>
          <div>演示数据 · 2026年10月12日</div>
        </div>
      </template>
      <template #actions>
        <a-button type="primary"><template #icon><icon-plus /></template>新增人物</a-button>
      </template>
    </PageHead>

    <div class="flex items-center gap-4 mb-4">
      <a-tabs v-model:active-key="tab" type="line" class="mw-tabs flex-1">
        <a-tab-pane key="all"><template #title>全部 <span class="mw-subtle">4</span></template></a-tab-pane>
        <a-tab-pane key="manager"><template #title>经理 IP <span class="mw-subtle">1</span></template></a-tab-pane>
        <a-tab-pane key="kos"><template #title>员工 KOS <span class="mw-subtle">3</span></template></a-tab-pane>
        <a-tab-pane key="persona"><template #title>素人 <span class="mw-subtle">0</span></template></a-tab-pane>
      </a-tabs>
      <a-input-search :style="{ width: '220px' }" placeholder="搜索人物名称..." allow-clear />
    </div>

    <div class="grid grid-cols-[1fr_380px] gap-5 items-start">
      <!-- ============ 人物卡片 ============ -->
      <div class="grid grid-cols-2 gap-4">
        <div
          v-for="p in filtered"
          :key="p.id"
          class="mw-card p-4 cursor-pointer transition-all"
          :class="currentId === p.id ? 'border-[color:var(--mw-primary)] ring-1 ring-[color:var(--mw-primary)]' : 'hover:shadow-sm'"
          @click="currentId = p.id"
        >
          <div class="relative rounded-[10px] overflow-hidden" style="aspect-ratio: 16/9; background: linear-gradient(150deg,#42506266,#8a97a855), linear-gradient(#c8d3e2,#e7edf4)">
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="w-10 h-10 rounded-full bg-black/25 flex items-center justify-center"><icon-play-arrow-fill :size="20" style="color:#fff" /></div>
            </div>
            <span class="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-[4px] bg-black/50 text-white text-[11px]">{{ p.duration }}</span>
          </div>
          <div class="mt-3 flex items-center gap-2">
            <span class="text-[15px] font-semibold">{{ p.name }}</span>
            <LineTag :line="p.line" />
          </div>
          <div class="mw-subtle mt-1">{{ p.desc }}</div>
          <div class="mt-2 flex items-center gap-1.5 flex-wrap">
            <span v-for="s in p.status" :key="s.text" class="mw-tag" :class="s.cls">{{ s.text }}</span>
          </div>
          <div class="mt-3 pt-2.5 border-t border-[#f2f4f7] flex items-center gap-4 text-[12px] text-[var(--mw-text2)]">
            <span class="flex items-center gap-1"><icon-image :size="14" class="text-[var(--mw-text3)]" />照片 {{ p.photo }}</span>
            <span class="flex items-center gap-1"><icon-play-circle :size="14" class="text-[var(--mw-text3)]" />分身 {{ p.avatar }}</span>
            <span class="flex items-center gap-1"><icon-sound :size="14" class="text-[var(--mw-text3)]" />声音 {{ p.voice }}</span>
          </div>
        </div>
      </div>

      <!-- ============ 详情面板 ============ -->
      <div class="mw-card p-5" v-if="current">
        <div class="flex items-center gap-2">
          <span class="text-[18px] font-bold">{{ current.name }}</span>
          <LineTag :line="current.line" />
        </div>
        <div class="mw-subtle mt-0.5">当前选中 · 人物资产</div>

        <a-tabs v-model:active-key="detailTab" size="small" class="mw-tabs people-tabs mt-2">
          <a-tab-pane key="ip" title="IP 定位" />
          <a-tab-pane key="photo" title="形象照片" />
          <a-tab-pane key="avatar" title="口播分身" />
          <a-tab-pane key="voice" title="声音档案" />
          <a-tab-pane key="bg" title="背景与空镜" />
        </a-tabs>

        <!-- IP 定位 -->
        <div v-if="detailTab === 'ip'">
          <div class="flex justify-end"><span class="mw-tag mw-tag-gray">示例配置</span></div>
          <div class="flex flex-col">
            <div class="mw-form-row"><div class="mw-form-label">角色类型</div><a-select v-model="current.positioning.role" :style="{ width: '200px' }" /></div>
            <div class="mw-form-row"><div class="mw-form-label">专业方向</div><a-select v-model="current.positioning.major" :style="{ width: '200px' }" /></div>
            <div class="mw-form-row"><div class="mw-form-label">表达风格</div><a-select v-model="current.positioning.style" :style="{ width: '200px' }" /></div>
            <div class="mw-form-row"><div class="mw-form-label">内容方向</div><a-select v-model="current.positioning.content" :style="{ width: '200px' }" /></div>
            <div class="mw-form-row items-start">
              <div class="mw-form-label pt-1">内容配比</div>
              <div>
                <div class="mw-subtle mb-1.5">示例方向，可编辑：具体配比待确认。</div>
                <div class="flex gap-2 flex-wrap">
                  <span v-for="m in current.positioning.mix" :key="m.text" class="mw-tag cursor-pointer" :class="m.cls">
                    {{ m.text }} <icon-edit :size="11" />
                  </span>
                </div>
              </div>
            </div>
          </div>
          <a-button type="primary" long class="mt-3" @click="$message.success('IP 定位已保存（演示）')">保存定位</a-button>

          <div class="mt-4 pt-3 border-t border-[var(--mw-border)] flex flex-col gap-2.5 text-[13px]">
            <div class="flex"><span class="w-[76px] text-[var(--mw-text3)]">归属主体</span><span>{{ current.owner }}</span></div>
            <div class="flex"><span class="w-[76px] text-[var(--mw-text3)]">可用范围</span><span>{{ current.positioning.scope }}</span></div>
            <div class="flex items-center">
              <span class="w-[76px] text-[var(--mw-text3)]">授权材料</span>
              <span class="mw-tag" :class="current.positioning.auth.startsWith('待') ? 'mw-tag-yellow' : 'mw-tag-green'">{{ current.positioning.auth }}</span>
              <div class="flex-1"></div>
              <icon-right :size="13" class="text-[var(--mw-text3)]" />
            </div>
          </div>
        </div>

        <!-- 形象照片 -->
        <div v-else-if="detailTab === 'photo'" class="grid grid-cols-3 gap-2">
          <ThumbBox v-for="i in 6" :key="i" :seed="current.id + i" :width="100" :height="100" />
        </div>

        <!-- 口播分身 -->
        <div v-else-if="detailTab === 'avatar'" class="flex flex-col gap-2.5">
          <div v-for="i in current.avatar" :key="i" class="p-3 rounded-[10px] border border-[var(--mw-border)] flex items-center gap-3">
            <ThumbBox :seed="current.id + 'av' + i" :width="52" :height="36" />
            <div class="text-[13px]">分身 {{ i }} · 1080P</div>
            <div class="flex-1"></div>
            <a-button size="mini">预览</a-button>
          </div>
          <div v-if="!current.avatar" class="mw-subtle text-center py-6">暂无口播分身</div>
        </div>

        <!-- 声音档案 -->
        <div v-else-if="detailTab === 'voice'" class="flex flex-col gap-2.5">
          <div class="p-3 rounded-[10px] border border-[var(--mw-border)] flex items-center gap-3">
            <icon-sound :size="18" class="text-[color:var(--mw-primary)]" />
            <div>
              <div class="text-[13px] font-medium">{{ current.name }} · 自录声音</div>
              <div class="mw-subtle">WAV · 48kHz · 已绑定</div>
            </div>
            <div class="flex-1"></div>
            <a-button size="mini" @click="$message.info('试听播放中（演示）')">试听</a-button>
          </div>
          <div class="mw-subtle">声音共享须单独核验授权。</div>
        </div>

        <!-- 背景与空镜 -->
        <div v-else class="flex flex-col gap-2.5">
          <div v-for="b in ['背景图', '背景视频', '空镜视频']" :key="b" class="p-3 rounded-[10px] border border-[var(--mw-border)] flex items-center gap-3">
            <ThumbBox :seed="current.id + b" :width="52" :height="36" />
            <div class="text-[13px]">{{ b }}</div>
            <div class="flex-1"></div>
            <span class="mw-tag mw-tag-gray">已配置</span>
          </div>
        </div>

        <div class="mt-4 pt-3 border-t border-[var(--mw-border)] cursor-pointer" @click="detailTab = 'bg'">
          <div class="flex items-center gap-2">
            <icon-play-circle :size="17" class="text-[color:var(--mw-primary)]" />
            <div class="text-[13.5px] font-medium">人物专属背景与空镜</div>
            <div class="flex-1"></div>
            <span class="mw-link flex items-center whitespace-nowrap">管理资源 <icon-right :size="12" /></span>
          </div>
          <div class="mw-subtle mt-1 pl-6">背景图、背景视频、空镜视频</div>
        </div>
      </div>
    </div>

    <div class="mt-4 mw-subtle flex items-center gap-1"><icon-info-circle :size="13" />素人矩阵不使用数字人口播。声音共享须单独核验授权。</div>
    <div class="mw-corner-note">原型预览 · 演示数据</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, toRaw } from 'vue'
import PageHead from '@/components/PageHead.vue'
import LineTag from '@/components/LineTag.vue'
import ThumbBox from '@/components/ThumbBox.vue'
import { people } from '@/mocks/data'

const tab = ref('all')
const detailTab = ref('ip')
const currentId = ref('p1')

const filtered = computed(() => (tab.value === 'all' ? people : people.filter((p) => p.line === tab.value)))
const current = computed(() => {
  const p = people.find((x) => x.id === currentId.value)
  return p ? toRaw(p) : undefined
})
</script>
