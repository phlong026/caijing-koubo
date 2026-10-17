<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="视频创作">
      <template #sub>将审核通过的文案，制作基础视频（数字人口播 / 素材混剪）。</template>
    </PageHead>

    <!-- 文案卡 -->
    <div class="mw-card p-4 mb-5 flex items-center gap-4">
      <div class="w-11 h-11 rounded-[10px] bg-[var(--mw-primary-bg)] flex items-center justify-center">
        <icon-file :size="22" class="text-[color:var(--mw-primary)]" />
      </div>
      <div>
        <div class="text-[16px] font-semibold">基金定投入门</div>
        <div class="mw-subtle mt-0.5">小林科普 · 员工 KOS · 文案 v3 · 约 200 字 · 预计口播 60 秒</div>
      </div>
      <span class="mw-tag mw-tag-green ml-4"><icon-check-circle :size="12" />人工复核通过（示例）</span>
      <div class="flex-1"></div>
      <span class="mw-link">查看文案 <icon-right :size="12" /></span>
    </div>

    <div class="grid grid-cols-[54fr_46fr] gap-5 items-start">
      <!-- ============ 左列配置 ============ -->
      <div class="flex flex-col gap-5">
        <!-- 视频模式 -->
        <div class="mw-card p-5">
          <div class="text-[15px] font-semibold mb-3">视频模式</div>
          <div class="grid grid-cols-2 gap-3">
            <div
              v-for="m in modes"
              :key="m.key"
              class="p-4 rounded-[10px] border-2 cursor-pointer transition-colors"
              :class="mode === m.key ? 'border-[color:var(--mw-primary)] bg-[color:var(--mw-primary-faint)]' : 'border-[var(--mw-border)] hover:border-[color:var(--mw-primary-soft)]'"
              @click="mode = m.key"
            >
              <div class="flex items-center gap-2">
                <a-radio :model-value="mode === m.key" />
                <span class="text-[15px] font-semibold">{{ m.name }}</span>
                <component :is="m.icon" :size="18" class="ml-auto text-[var(--mw-text3)]" />
              </div>
              <div class="text-[12.5px] text-[var(--mw-text3)] mt-2 leading-5">{{ m.desc }}</div>
            </div>
          </div>
        </div>

        <!-- 口播：人物绑定形象 -->
        <template v-if="mode === 'avatar'">
          <div class="mw-card p-5">
            <div class="text-[15px] font-semibold mb-3">人物绑定形象</div>
            <div class="grid grid-cols-2 gap-3">
              <div
                v-for="av in avatars"
                :key="av.name"
                class="p-3.5 rounded-[10px] border-2 cursor-pointer flex gap-3"
                :class="avatar === av.name ? 'border-[color:var(--mw-primary)] bg-[color:var(--mw-primary-faint)]' : 'border-[var(--mw-border)] hover:border-[color:var(--mw-primary-soft)]'"
                @click="avatar = av.name"
              >
                <ThumbBox :seed="av.name" :width="64" :height="64" />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-1.5">
                    <a-radio :model-value="avatar === av.name" />
                    <span class="text-[14px] font-medium">{{ av.name }}</span>
                  </div>
                  <div class="text-[12px] text-[var(--mw-text3)] mt-1 leading-4">{{ av.desc }}</div>
                  <span class="mw-tag mw-tag-gray mt-1.5">来自人物库</span>
                </div>
              </div>
            </div>

            <div class="mt-4 flex flex-col">
              <div class="mw-form-row">
                <div class="mw-form-label">声音</div>
                <div class="flex items-center gap-2.5 flex-1 p-2.5 rounded-[8px] border border-[var(--mw-border)]">
                  <icon-sound :size="16" class="text-[color:var(--mw-primary)]" />
                  <span class="text-[13.5px]">小林 · 自录声音</span>
                  <div class="flex-1"></div>
                  <a-button size="small" @click="$message.info('试听播放中（演示）')"><template #icon><icon-play-arrow /></template>试听</a-button>
                </div>
                <span class="mw-tag mw-tag-green"><icon-check-circle :size="12" />试听已确认</span>
              </div>
              <div class="mw-form-row">
                <div class="mw-form-label">背景</div>
                <a-select v-model="background" :style="{ width: '220px' }" />
                <span class="mw-subtle">已绑定人物资源</span>
              </div>
            </div>
          </div>
        </template>

        <!-- 混剪：素材配置 -->
        <template v-else>
          <div class="mw-card p-5">
            <div class="text-[15px] font-semibold mb-2">混剪配置</div>
            <div class="mw-subtle mb-2">系统根据文案语义自动匹配素材包中的画面，按段落切分合成，无需数字人出镜。</div>
            <div class="flex flex-col">
              <div class="mw-form-row">
                <div class="mw-form-label">素材包</div>
                <a-select v-model="mixPack" :style="{ width: '220px' }" />
                <span class="mw-tag mw-tag-gray">24 项素材 · 已打标</span>
              </div>
              <div class="mw-form-row">
                <div class="mw-form-label">声音</div>
                <a-select v-model="mixVoice" :style="{ width: '220px' }" />
                <a-button size="small" @click="$message.info('试听播放中（演示）')"><template #icon><icon-play-arrow /></template>试听</a-button>
              </div>
              <div class="mw-form-row">
                <div class="mw-form-label">字幕字体</div>
                <a-select v-model="mixFont" :style="{ width: '220px' }" />
                <span class="mw-subtle">字幕、BGM 与风险尾页可在剪辑中调整</span>
              </div>
            </div>
          </div>
        </template>

        <!-- 配置检查 -->
        <div class="mw-card p-5">
          <div class="text-[15px] font-semibold mb-3">配置检查</div>
          <div class="flex items-center gap-6 flex-wrap">
            <span v-for="c in checks" :key="c" class="flex items-center gap-1.5 text-[13px] text-[var(--mw-text2)]">
              <icon-check-circle :size="15" class="text-[#0f7b3e]" />{{ c }}
            </span>
          </div>
        </div>
      </div>

      <!-- ============ 右列：预览 ============ -->
      <div class="mw-card p-5">
        <div class="flex items-center justify-between mb-3">
          <div class="text-[16px] font-semibold">基础视频已生成 <span class="mw-subtle font-normal">（示例）</span></div>
          <span class="mw-tag mw-tag-gray">模板示意</span>
        </div>
        <!-- 9:16 视频占位 -->
        <div class="mx-auto relative rounded-[12px] overflow-hidden" style="width: 300px; aspect-ratio: 9/16; background: linear-gradient(160deg,#3c4a5d 0%,#5a6b80 55%,#8a97a8 100%)">
          <div class="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/35 text-white text-[12px]">
            <span class="w-4 h-4 rounded-full bg-[#1d4ed8] inline-flex items-center justify-center text-[9px]">林</span>小林科普
          </div>
          <div class="absolute inset-0 flex items-center justify-center">
            <div class="w-14 h-14 rounded-full bg-white/25 backdrop-blur flex items-center justify-center cursor-pointer hover:bg-white/35 transition-colors" @click="$message.info('预览播放（演示）')">
              <icon-play-arrow-fill :size="30" style="color:#fff" />
            </div>
          </div>
          <div class="absolute bottom-10 inset-x-0 text-center">
            <div class="inline-block px-2.5 py-1 rounded-[6px] bg-black/45 text-white text-[13px]">{{ previewSubtitle }}</div>
            <div class="mt-1.5 inline-block px-2 py-0.5 rounded-[4px] bg-black/55 text-white/90 text-[10px]">基金有风险，投资需谨慎</div>
          </div>
          <div class="absolute bottom-0 inset-x-0 px-3 pb-2.5">
            <div class="h-1 rounded bg-white/25 overflow-hidden"><div class="h-full w-1/5 bg-white"></div></div>
            <div class="flex items-center gap-2 text-white/85 text-[11px] mt-1.5">
              <icon-play-arrow-fill :size="12" /><span>00:12 / 01:00</span><div class="flex-1"></div><icon-sound :size="12" /><icon-fullscreen :size="12" />
            </div>
          </div>
        </div>
        <div class="text-center mw-subtle mt-3">1080P · 9:16 · 约60秒</div>
        <div class="text-center mw-subtle mt-1">基础视频预览：字幕、BGM 与风险尾页在剪辑中添加。</div>
      </div>
    </div>

    <!-- 底部操作条 -->
    <div class="mw-card mt-5 p-4 flex items-center gap-4">
      <span class="mw-tag mw-tag-green"><icon-check-circle :size="12" />基础视频已生成</span>
      <span class="text-[var(--mw-border)]">|</span>
      <div class="flex items-center gap-2 text-[13px] text-[var(--mw-text2)]">
        <span class="w-5 h-5 rounded-full border border-[var(--mw-border)] inline-flex items-center justify-center text-[11px]">1</span>{{ steps[0] }}
        <icon-right :size="13" class="text-[var(--mw-text3)]" />
        <span class="w-5 h-5 rounded-full border border-[var(--mw-border)] inline-flex items-center justify-center text-[11px]">2</span>{{ steps[1] }}
        <icon-right :size="13" class="text-[var(--mw-text3)]" />
        <span class="w-5 h-5 rounded-full border border-[var(--mw-border)] inline-flex items-center justify-center text-[11px]">3</span>{{ steps[2] }}
      </div>
      <div class="flex-1"></div>
      <a-button @click="$message.success('配置已保存（演示）')">保存配置</a-button>
      <a-button type="primary" @click="$router.push('/video/edit')"><template #icon><icon-play-arrow /></template>进入视频剪辑</a-button>
    </div>
    <div class="mw-corner-note">生成结果为设计示例，接口状态待确认 · 设计预览</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import PageHead from '@/components/PageHead.vue'
import ThumbBox from '@/components/ThumbBox.vue'
import { IconUser, IconVideoCamera } from '@arco-design/web-vue/es/icon'

const mode = ref<'avatar' | 'mix'>('avatar')
const modes = [
  { key: 'avatar', name: '数字人口播', icon: IconUser, desc: '由数字人根据文案进行口播，快速生成品牌一致的视频。' },
  { key: 'mix', name: '素材混剪', icon: IconVideoCamera, desc: '语音合成 + 按文案语义匹配素材包画面，合成无出镜视频。' },
] as const

const avatar = ref('小林 · 亲和科普')
const avatars = [
  { name: '小林 · 亲和科普', desc: '自然亲切，适合科普与知识类内容。' },
  { name: '人物专属背景', desc: '白色简洁，绑定人物资源。' },
]
const background = ref('小林 · 白色简洁')
const mixPack = ref('品牌标准 · 蓝色背景')
const mixVoice = ref('KOS 通用女声')
const mixFont = ref('富国思源黑体')

const previewSubtitle = computed(() =>
  mode.value === 'avatar' ? '定投是一种定期投入的方式' : '素材匹配画面 · 按段落切换（示意）',
)

const steps = computed(() =>
  mode.value === 'avatar' ? ['语音合成', '口播画面', '基础视频'] : ['语音合成', '素材匹配', '合成视频'],
)
const checks = computed(() =>
  mode.value === 'avatar'
    ? ['文案 v3 已通过人工复核', '形象与声音已绑定', '人物背景已配置']
    : ['文案 v3 已通过人工复核', '素材包已选择并打标', '声音已确认试听'],
)
</script>
