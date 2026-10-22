<template>
  <div class="p-7 pb-10 max-w-[1500px] mx-auto">
    <!-- 头部 -->
    <div class="flex items-start justify-between mb-4">
      <div>
        <h1 class="mw-page-title">视频剪辑</h1>
        <div class="mw-page-sub">基金定投入门 · 小林科普 · 员工 KOS</div>
      </div>
      <div class="flex items-center gap-3 pt-1.5">
        <span class="mw-subtle flex items-center gap-1">成片复审规则待确认 <icon-info-circle :size="13" /></span>
        <a-button @click="saveVersion">保存版本</a-button>
        <a-button type="primary" @click="$message.success('成片 v3 已提交复审（演示）')">提交成片复审</a-button>
      </div>
    </div>

    <!-- 警示条 -->
    <div class="mw-alert-banner mb-5 !bg-[#fdf0e0] !border-[#f2cfa0] !text-[#9a5b12]">
      <icon-exclamation-circle :size="15" />
      <span class="font-medium">内容已修改，需重新审核后发布。</span>
      <div class="flex-1"></div>
      <span>源文案 v3 · 人工复核通过（示例）&nbsp;&nbsp;/&nbsp;&nbsp;<b>成片 v2 · 待复审</b></span>
    </div>

    <div class="grid grid-cols-[28fr_30fr_42fr] gap-5 items-start">
      <!-- ============ 字幕片段 ============ -->
      <div class="mw-card p-5">
        <div class="flex items-center justify-between mb-3">
          <div class="text-[15px] font-semibold">字幕片段</div>
          <span class="mw-subtle">文字可编辑 · 时间只读</span>
        </div>
        <div
          class="grid grid-cols-[92px_1fr] text-[12px] text-[var(--mw-text3)] pb-2 border-b border-[var(--mw-border)]"
        >
          <span>时间</span><span>字幕内容</span>
        </div>
        <div
          v-for="(seg, i) in segments"
          :key="i"
          class="grid grid-cols-[92px_1fr] gap-x-3 py-2.5 border-b border-[#f2f4f7] cursor-pointer rounded-[8px] px-1 -mx-1"
          :class="current === i ? 'bg-[color:var(--mw-primary-faint)]' : ''"
          @click="current = i"
        >
          <span class="text-[13px] text-[var(--mw-text2)] leading-8">{{ seg.start }} – {{ seg.end }}</span>
          <div>
            <a-textarea
              v-model="seg.text"
              :auto-size="{ minRows: 1 }"
              class="!border-none !bg-transparent !px-0 !text-[13.5px] !leading-5"
              @input="modified = true"
            />
            <div v-if="current === i" class="mw-subtle flex items-center gap-1 mt-1">
              <icon-info-circle :size="12" />编辑字幕后需重新合成，内容变更需复审。
            </div>
            <div v-if="seg.risk" class="mt-1">
              <span class="mw-tag mw-tag-blue"><icon-safe :size="12" />风险提示</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ============ 视频预览 ============ -->
      <div class="mw-card p-5">
        <div class="flex items-center justify-between mb-3">
          <div class="text-[15px] font-semibold">视频预览</div>
          <span class="mw-tag mw-tag-gray">预览示例</span>
        </div>
        <div
          class="relative rounded-[12px] overflow-hidden"
          style="
            aspect-ratio: 9/16;
            max-height: 430px;
            margin: 0 auto;
            width: auto;
            height: 430px;
            background: linear-gradient(160deg, #3c4a5d 0%, #5a6b80 55%, #8a97a8 100%);
          "
        >
          <div
            class="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/35 text-white text-[12px]"
          >
            <span class="w-4 h-4 rounded-full bg-[#1d4ed8] inline-flex items-center justify-center text-[9px]">林</span
            >小林科普
          </div>
          <div class="absolute bottom-14 inset-x-0 text-center px-4">
            <div
              class="inline-block px-2.5 py-1 rounded-[6px] text-white text-[14px] font-medium"
              style="background: rgba(0, 0, 0, 0.45); text-shadow: 0 0 4px rgba(0, 0, 0, 0.5)"
            >
              {{ segments[current].text }}
            </div>
            <div class="mt-1.5 inline-block px-2 py-0.5 rounded-[4px] bg-black/55 text-white/90 text-[10px]">
              基金有风险，投资需谨慎
            </div>
          </div>
        </div>
        <!-- 播放器 -->
        <div class="flex items-center gap-2.5 mt-3">
          <a-button type="text" size="mini" @click="$message.info('预览播放（演示）')"
            ><template #icon><icon-play-arrow-fill /></template
          ></a-button>
          <span class="text-[12px] text-[var(--mw-text2)]">00:12 / 01:00</span>
          <a-slider v-model="progress" :max="60" :style="{ flex: 1 }" :tooltip-visible="false" />
          <icon-fullscreen :size="15" class="text-[var(--mw-text3)]" />
        </div>
        <!-- 预览定位 -->
        <div class="mt-2">
          <div class="mw-subtle mb-1">预览定位</div>
          <div class="relative h-6 rounded-[6px] border border-[var(--mw-border)] bg-[#fafbfc]">
            <div
              class="absolute inset-y-0"
              :style="{ left: '0%', width: (progress / 60) * 100 + '%', background: 'rgba(29,78,216,.12)' }"
            ></div>
            <div
              class="absolute top-0 bottom-0 w-[2px] bg-[#1d4ed8]"
              :style="{ left: (progress / 60) * 100 + '%' }"
            ></div>
            <div class="absolute inset-0 flex items-center justify-between px-2 text-[10px] text-[var(--mw-text3)]">
              <span>00:00</span><span>00:15</span><span>00:30</span><span>00:45</span><span>01:00</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 mt-4">
          <span class="mw-tag mw-tag-gray">基础视频 01:00</span>
          <icon-right :size="13" class="text-[var(--mw-text3)]" />
          <span class="mw-tag mw-tag-yellow">风险尾页 时长待配置</span>
        </div>
      </div>

      <!-- ============ 样式配置 ============ -->
      <div class="mw-card p-5">
        <a-tabs v-model:active-key="tab" type="line">
          <a-tab-pane key="sub" title="字幕" />
          <a-tab-pane key="bgm" title="BGM" />
          <a-tab-pane key="post" title="后期" />
          <a-tab-pane key="risk" title="风险尾页" />
        </a-tabs>

        <!-- 字幕 -->
        <div v-if="tab === 'sub'" class="mt-2">
          <div class="text-[14px] font-semibold mb-1">字幕样式</div>
          <div class="mw-form-row">
            <div class="mw-form-label">字体</div>
            <a-select v-model="subFont" :style="{ width: '200px' }" />
          </div>
          <div class="mw-form-row">
            <div class="mw-form-label">字号</div>
            <a-select v-model="subSize" :style="{ width: '120px' }" />
          </div>
          <div class="mw-form-row">
            <div class="mw-form-label">位置</div>
            <a-select v-model="subPos" :style="{ width: '120px' }" />
          </div>
          <div class="mw-form-row">
            <div class="mw-form-label">文字颜色</div>
            <span
              class="w-7 h-7 rounded-[6px] border border-[var(--mw-border)] inline-block"
              style="background: #fff"
            ></span>
            <span class="text-[13px] text-[var(--mw-text2)]">#FFFFFF</span>
          </div>
          <div class="mw-form-row">
            <div class="mw-form-label">描边</div>
            <span
              class="w-7 h-7 rounded-[6px] border border-[var(--mw-border)] inline-block"
              style="background: #0f2d5c"
            ></span>
            <span class="text-[13px] text-[var(--mw-text2)]">深蓝</span>
          </div>
          <div class="text-[14px] font-semibold mt-5 mb-1">背景音乐</div>
          <div class="mw-form-row">
            <div class="mw-form-label">启用</div>
            <a-switch v-model="bgmOn" />
          </div>
          <div class="mw-form-row">
            <div class="mw-form-label">音乐选择</div>
            <a-select v-model="bgm" :style="{ width: '200px' }" :disabled="!bgmOn" />
            <a-button size="small" :disabled="!bgmOn" @click="$message.info('试听播放中（演示）')"
              ><template #icon><icon-play-arrow /></template>试听</a-button
            >
          </div>
          <div class="mw-form-row">
            <div class="mw-form-label">音量</div>
            <a-slider
              v-model="volume"
              :max="100"
              :style="{ width: '200px' }"
              :format-tooltip="(v: number) => v + '%'"
            />
            <span class="text-[13px] text-[var(--mw-text2)]">{{ volume }}%</span>
          </div>
        </div>

        <!-- 后期 -->
        <div v-if="tab === 'post'" class="mt-2">
          <div class="text-[14px] font-semibold mb-2">后期处理</div>
          <div
            class="p-3.5 rounded-[10px] border border-[var(--mw-border)] flex items-center mb-3 cursor-pointer hover:border-[color:var(--mw-primary-soft)]"
          >
            <div>
              <div class="text-[13.5px] font-medium flex items-center gap-1">
                自动剪气口 <icon-info-circle :size="13" class="text-[var(--mw-text3)]" />
              </div>
              <div class="mw-subtle mt-0.5">检测语音停顿并收紧节奏（生成后可预览）</div>
            </div>
            <div class="flex-1"></div>
            <span class="mw-subtle mr-2">未启用</span><icon-right :size="14" class="text-[var(--mw-text3)]" />
          </div>
          <div
            class="p-3.5 rounded-[10px] border border-[var(--mw-border)] flex items-center cursor-pointer hover:border-[color:var(--mw-primary-soft)]"
          >
            <div>
              <div class="text-[13.5px] font-medium flex items-center gap-1">
                画中画 <icon-info-circle :size="13" class="text-[var(--mw-text3)]" />
              </div>
              <div class="mw-subtle mt-0.5">叠加展示画面（素材库画中画模板）</div>
            </div>
            <div class="flex-1"></div>
            <span class="mw-subtle mr-2">未启用</span><icon-right :size="14" class="text-[var(--mw-text3)]" />
          </div>
        </div>

        <!-- 风险尾页 -->
        <div v-if="tab === 'risk'" class="mt-2">
          <div class="flex items-center gap-2 mb-2">
            <div class="text-[14px] font-semibold">风险尾页</div>
            <span class="mw-tag mw-tag-yellow">待配置</span>
          </div>
          <div
            class="p-3.5 rounded-[10px] border border-[color:var(--mw-primary-mid)] bg-[color:var(--mw-primary-faint)]"
          >
            <div class="flex gap-3">
              <ThumbBox seed="risk" :width="72" :height="54" />
              <div class="flex-1">
                <span class="mw-tag mw-tag-deep">风险提示</span>
                <div class="text-[12.5px] text-[var(--mw-text2)] mt-1.5 leading-5">
                  本内容仅供投资者教育参考，不构成投资建议。基金投资有风险，过往业绩不代表未来表现。请认真阅读基金合同，了解产品的风险收益特征，并结合自身风险承受能力审慎决策。
                </div>
              </div>
            </div>
          </div>
          <div class="mw-form-row mt-2">
            <div class="mw-form-label">来源</div>
            <a-select v-model="riskSrc" :style="{ width: '220px' }" />
          </div>
          <div class="mw-form-row">
            <div class="mw-form-label">插入</div>
            <a-checkbox v-model="riskAppend">插入视频末尾</a-checkbox>
            <span class="mw-subtle">播放时长 待配置</span>
          </div>
          <div class="mw-subtle flex items-center gap-1 mt-1">
            <icon-info-circle :size="12" />适用范围、文案及最长时长待确认。
          </div>
        </div>
      </div>
    </div>

    <!-- 底部状态 -->
    <div class="mw-card mt-5 p-4 flex items-center gap-3">
      <span class="mw-tag mw-tag-green"><icon-check-circle :size="12" />已保存 10:28</span>
      <span class="mw-subtle">1080P · 9:16 · 01:00</span>
      <span class="text-[var(--mw-border)]">|</span>
      <span class="mw-subtle">{{
        modified ? '字幕已修改：保存版本后将重新合成，并需重新送审。' : '修改文案含义或风险提示，须重新送审。'
      }}</span>
      <div class="flex-1"></div>
      <span class="mw-subtle">设计预览 · 规则待确认</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import ThumbBox from '@/components/ThumbBox.vue'
import { subtitleSegments } from '@/mocks/data'

const segments = reactive(subtitleSegments.map((s) => ({ ...s })))
const current = ref(1)
const modified = ref(false)
const tab = ref('sub')
const progress = ref(12)

const subFont = ref('品牌思源黑体')
const subSize = ref('36')
const subPos = ref('下方')
const bgmOn = ref(true)
const bgm = ref('轻柔钢琴（示例）')
const volume = ref(20)
const riskSrc = ref('产品风险提示（示例）')
const riskAppend = ref(false)

function saveVersion() {
  modified.value = false
  Message.success('已保存版本：成片 v3（草稿）· 需提交成片复审（演示）')
}
</script>
