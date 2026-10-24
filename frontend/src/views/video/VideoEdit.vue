<template>
  <div class="p-7 pb-10 max-w-[1500px] mx-auto">
    <a-spin :loading="store.loading" style="width: 100%">
      <!-- 头部 -->
      <div class="flex items-start justify-between mb-4">
        <div>
          <h1 class="mw-page-title">视频剪辑</h1>
          <div class="mw-page-sub">
            {{ pageSub }}
          </div>
        </div>
        <div class="flex items-center gap-3 pt-1.5">
          <a-select
            v-if="store.versions.length"
            :model-value="currentCutId"
            :style="{ width: '190px' }"
            placeholder="历史版本"
            @change="onVersionSwitch"
          >
            <a-option v-for="v in store.versions" :key="v.id" :value="v.id">
              成片 v{{ v.versionNo }} · {{ cutStatusText(v) }}
            </a-option>
          </a-select>
          <a-button :loading="saving" @click="saveDraft">保存草稿</a-button>
          <a-button type="primary" :loading="creating" :disabled="!store.draft" @click="createVersion">
            渲染成片版本
          </a-button>
        </div>
      </div>

      <!-- 提示横幅（§7 复审联动） -->
      <div v-if="store.isMockEngine" class="mw-alert-banner mb-3">
        <icon-info-circle :size="15" />
        <span
          >当前环境无字幕渲染能力（ffmpeg 缺 libass / 未配置字体），成片不含字幕烧录与尾页文字，仅用于流程联调。</span
        >
      </div>
      <div v-if="reviewBanner" class="mw-alert-banner mb-3 !bg-[#fdf0e0] !border-[#f2cfa0] !text-[#9a5b12]">
        <icon-exclamation-circle :size="15" />
        <span class="font-medium">{{ reviewBanner.text }}</span>
        <div class="flex-1"></div>
        <span>{{ reviewBanner.detail }}</span>
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
            v-for="(seg, i) in editableSegments"
            :key="seg.index"
            class="grid grid-cols-[92px_1fr] gap-x-3 py-2.5 border-b border-[#f2f4f7] cursor-pointer rounded-[8px] px-1 -mx-1"
            :class="current === i ? 'bg-[color:var(--mw-primary-faint)]' : ''"
            @click="current = i"
          >
            <span class="text-[13px] text-[var(--mw-text2)] leading-8">
              {{ fmtMs(seg.startMs) }} – {{ fmtMs(seg.endMs) }}
            </span>
            <div>
              <a-textarea
                v-if="seg.kind === 'normal'"
                v-model="seg.text"
                :auto-size="{ minRows: 1 }"
                class="!border-none !bg-transparent !px-0 !text-[13.5px] !leading-5"
                @change="onSegmentEdit(seg)"
              />
              <div v-else class="text-[13.5px] leading-5 py-1">{{ seg.text }}</div>
              <div v-if="current === i && seg.kind === 'normal'" class="mw-subtle flex items-center gap-1 mt-1">
                <icon-info-circle :size="12" />编辑字幕后需重新合成，内容变更需复审。
              </div>
              <div v-if="seg.kind === 'risk'" class="mt-1">
                <span class="mw-tag mw-tag-blue"><icon-safe :size="12" />风险提示 · 锁定</span>
              </div>
              <div v-else-if="seg.edited" class="mt-1">
                <span class="mw-tag mw-tag-yellow">已修改</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ============ 视频预览 ============ -->
        <div class="mw-card p-5">
          <div class="flex items-center justify-between mb-3">
            <div class="text-[15px] font-semibold">视频预览</div>
            <span class="mw-tag mw-tag-gray">{{ previewSourceLabel }}</span>
          </div>
          <div
            class="relative rounded-[12px] overflow-hidden bg-black"
            style="aspect-ratio: 9 / 16; max-height: 430px; margin: 0 auto"
          >
            <video
              v-if="previewUrl"
              ref="videoEl"
              :src="previewUrl"
              class="w-full h-full object-contain"
              @timeupdate="onTimeUpdate"
              @loadedmetadata="onLoaded"
            ></video>
            <div v-else class="absolute inset-0 flex items-center justify-center text-white/50 text-[13px]">
              加载基础视频中…
            </div>
            <!-- CSS 字幕叠加（渲染前低仿预览） -->
            <div
              v-if="previewMode === 'base' && currentSegment"
              class="absolute inset-x-0 pointer-events-none"
              :style="subtitleOverlayStyle"
            >
              <div
                class="mx-auto w-fit max-w-[85%] px-2.5 py-1 rounded-[6px] text-center text-white text-[14px] font-medium leading-5"
                :style="{
                  background: draft?.subtitleStyle.backgroundEnabled
                    ? hexToRgba(draft!.subtitleStyle.backgroundColor, draft!.subtitleStyle.backgroundOpacity)
                    : 'transparent',
                  textShadow: `0 0 ${draft!.subtitleStyle.outlineWidth}px ${draft!.subtitleStyle.outlineColor}, 0 0 ${draft!.subtitleStyle.outlineWidth}px ${draft!.subtitleStyle.outlineColor}`,
                }"
              >
                {{ currentSegment.text }}
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2.5 mt-3">
            <a-button type="text" size="mini" @click="togglePlay">
              <template #icon><icon-play-arrow-fill v-if="!playing" /><icon-pause v-else /></template>
            </a-button>
            <span class="text-[12px] text-[var(--mw-text2)]">{{ fmtMs(currentTimeMs) }} / {{ fmtMs(durationMs) }}</span>
            <a-slider
              v-model="seekSec"
              :max="Math.max(1, Math.floor(durationMs / 1000))"
              :style="{ flex: 1 }"
              :tooltip-visible="false"
              @change="onSeek"
            />
          </div>
          <div class="flex items-center gap-2 mt-4 flex-wrap">
            <span class="mw-tag mw-tag-gray">基础视频 {{ fmtMs(durationMs) }}</span>
            <icon-right v-if="draft?.riskTailEnabled" :size="13" class="text-[var(--mw-text3)]" />
            <span v-if="draft?.riskTailEnabled" class="mw-tag mw-tag-yellow"
              >风险尾页 {{ draft.riskTailSeconds }}s</span
            >
            <span v-if="draft?.breatheEnabled" class="mw-tag mw-tag-blue">剪气口</span>
            <span v-if="draft?.bgmEnabled" class="mw-tag mw-tag-green">BGM</span>
          </div>
        </div>

        <!-- ============ 配置面板 ============ -->
        <div class="mw-card p-5">
          <a-tabs v-model:active-key="tab" type="line">
            <a-tab-pane key="sub" title="字幕" />
            <a-tab-pane key="bgm" title="BGM" />
            <a-tab-pane key="post" title="后期" />
            <a-tab-pane key="risk" title="风险尾页" />
          </a-tabs>

          <!-- 字幕样式 -->
          <div v-if="tab === 'sub' && draft" class="mt-2">
            <div class="text-[14px] font-semibold mb-1">字幕样式</div>
            <div class="mw-form-row">
              <div class="mw-form-label">启用字幕</div>
              <a-switch v-model="draft.subtitleEnabled" />
            </div>
            <div class="mw-form-row">
              <div class="mw-form-label">字号</div>
              <a-slider
                v-model="draft!.subtitleStyle.fontSize"
                :min="24"
                :max="96"
                :step="2"
                :style="{ width: '200px' }"
              />
              <span class="text-[13px] text-[var(--mw-text2)]">{{ draft!.subtitleStyle.fontSize }}</span>
            </div>
            <div class="mw-form-row">
              <div class="mw-form-label">位置</div>
              <a-radio-group v-model="draft!.subtitleStyle.position" type="button" size="small">
                <a-radio value="top">顶部</a-radio>
                <a-radio value="center">居中</a-radio>
                <a-radio value="bottom">底部</a-radio>
              </a-radio-group>
            </div>
            <div class="mw-form-row">
              <div class="mw-form-label">对齐</div>
              <a-radio-group v-model="draft!.subtitleStyle.alignment" type="button" size="small">
                <a-radio value="left">左</a-radio>
                <a-radio value="center">中</a-radio>
                <a-radio value="right">右</a-radio>
              </a-radio-group>
            </div>
            <div class="mw-form-row">
              <div class="mw-form-label">文字颜色</div>
              <input
                v-model="draft!.subtitleStyle.fontColor"
                type="color"
                class="w-7 h-7 rounded-[6px] border border-[var(--mw-border)] bg-transparent"
              />
              <span class="text-[13px] text-[var(--mw-text2)]">{{ draft.subtitleStyle.fontColor }}</span>
            </div>
            <div class="mw-form-row">
              <div class="mw-form-label">描边</div>
              <input
                v-model="draft!.subtitleStyle.outlineColor"
                type="color"
                class="w-7 h-7 rounded-[6px] border border-[var(--mw-border)] bg-transparent"
              />
              <a-slider
                v-model="draft!.subtitleStyle.outlineWidth"
                :min="0"
                :max="8"
                :step="1"
                :style="{ width: '160px' }"
              />
              <span class="text-[13px] text-[var(--mw-text2)]">{{ draft!.subtitleStyle.outlineWidth }}px</span>
            </div>
            <div class="mw-form-row">
              <div class="mw-form-label">背景框</div>
              <a-switch v-model="draft!.subtitleStyle.backgroundEnabled" />
              <template v-if="draft.subtitleStyle.backgroundEnabled">
                <input
                  v-model="draft!.subtitleStyle.backgroundColor"
                  type="color"
                  class="w-7 h-7 rounded-[6px] border border-[var(--mw-border)] bg-transparent"
                />
                <a-slider v-model="bgmOpacityProxy" :min="0" :max="100" :style="{ width: '140px' }" />
                <span class="text-[13px] text-[var(--mw-text2)]">{{ draft!.subtitleStyle.backgroundOpacity }}</span>
              </template>
            </div>
            <div class="mw-subtle mt-2">一期内置开源字体（思源黑体）；多字体与上传列素材库范围。</div>
          </div>

          <!-- BGM -->
          <div v-if="tab === 'bgm' && draft" class="mt-2">
            <div class="mw-form-row">
              <div class="mw-form-label">启用</div>
              <a-switch v-model="draft.bgmEnabled" />
            </div>
            <div class="mw-form-row">
              <div class="mw-form-label">音乐选择</div>
              <a-select
                v-model="bgmIdProxy"
                :style="{ width: '200px' }"
                :disabled="!draft!.bgmEnabled"
                placeholder="选择 BGM"
                allow-clear
              >
                <a-option v-for="b in bgmList" :key="b.id" :value="b.id">{{ b.name }}</a-option>
              </a-select>
              <a-button size="small" :disabled="!previewBgmUrl" @click="previewBgm">
                <template #icon><icon-play-arrow /></template>试听
              </a-button>
            </div>
            <div class="mw-form-row">
              <div class="mw-form-label">音量</div>
              <a-slider
                v-model="bgmVolumePercent"
                :min="0"
                :max="100"
                :style="{ width: '200px' }"
                :format-tooltip="(v: number) => v + '%'"
              />
              <span class="text-[13px] text-[var(--mw-text2)]">{{ bgmVolumePercent }}%</span>
            </div>
            <div class="mw-form-row">
              <div class="mw-form-label">淡入 / 淡出</div>
              <a-input-number
                v-model="draft.bgmFadeIn"
                :min="0"
                :max="10000"
                :step="500"
                :style="{ width: '110px' }"
                :disabled="!draft.bgmEnabled"
              >
                <template #suffix>ms</template>
              </a-input-number>
              <a-input-number
                v-model="draft.bgmFadeOut"
                :min="0"
                :max="10000"
                :step="500"
                :style="{ width: '110px' }"
                :disabled="!draft.bgmEnabled"
              >
                <template #suffix>ms</template>
              </a-input-number>
            </div>
            <div class="mw-subtle flex items-center gap-1 mt-2">
              <icon-upload :size="12" />BGM 由管理员上传维护（<b>{{ bgmList.length }}</b> 首可选用）。
            </div>
          </div>

          <!-- 后期 -->
          <div v-if="tab === 'post' && draft" class="mt-2">
            <div class="text-[14px] font-semibold mb-2">后期处理</div>
            <div class="p-3.5 rounded-[10px] border border-[var(--mw-border)] mb-3">
              <div class="flex items-center">
                <div>
                  <div class="text-[13.5px] font-medium flex items-center gap-1">
                    自动剪气口 <icon-info-circle :size="13" class="text-[var(--mw-text3)]" />
                  </div>
                  <div class="mw-subtle mt-0.5">检测语音停顿并收紧节奏，字幕时间轴同步重映射</div>
                </div>
                <div class="flex-1"></div>
                <a-switch v-model="draft.breatheEnabled" />
              </div>
              <div v-if="draft.breatheEnabled" class="mt-3 grid grid-cols-3 gap-3">
                <div>
                  <div class="mw-subtle mb-1">静音阈值(dB)</div>
                  <a-input-number v-model="breatheProxy.noiseDb" size="small" :min="-60" :max="-20" />
                </div>
                <div>
                  <div class="mw-subtle mb-1">最短静音(ms)</div>
                  <a-input-number v-model="breatheProxy.minSilenceMs" size="small" :min="200" :max="2000" :step="100" />
                </div>
                <div>
                  <div class="mw-subtle mb-1">保留间隙(ms)</div>
                  <a-input-number v-model="breatheProxy.keepGapMs" size="small" :min="0" :max="500" :step="20" />
                </div>
              </div>
            </div>
            <div class="p-3.5 rounded-[10px] border border-[var(--mw-border)] flex items-center opacity-60">
              <div>
                <div class="text-[13.5px] font-medium flex items-center gap-1">
                  画中画 <icon-info-circle :size="13" class="text-[var(--mw-text3)]" />
                </div>
                <div class="mw-subtle mt-0.5">叠加展示画面（二期开放）</div>
              </div>
              <div class="flex-1"></div>
              <span class="mw-subtle mr-2">二期</span>
            </div>
          </div>

          <!-- 风险尾页 -->
          <div v-if="tab === 'risk' && draft" class="mt-2">
            <div class="flex items-center gap-2 mb-2">
              <div class="text-[14px] font-semibold">风险尾页</div>
              <span class="mw-tag mw-tag-deep">合规话术锁定</span>
            </div>
            <div class="mw-form-row">
              <div class="mw-form-label">启用</div>
              <a-switch v-model="draft.riskTailEnabled" />
            </div>
            <div
              class="p-3.5 rounded-[10px] border border-[color:var(--mw-primary-mid)] bg-[color:var(--mw-primary-faint)]"
            >
              <div class="flex gap-3">
                <div
                  class="w-[72px] h-[54px] rounded-[8px] bg-black text-white/90 text-[9px] flex items-center justify-center text-center px-1 flex-shrink-0"
                >
                  风险提示<br />（黑底白字）
                </div>
                <div class="flex-1">
                  <span class="mw-tag mw-tag-deep">风险提示</span>
                  <div class="text-[12.5px] text-[var(--mw-text2)] mt-1.5 leading-5">
                    {{ draft.riskTailText || '（该文案无风险提示内容，无法开启尾页）' }}
                  </div>
                </div>
              </div>
            </div>
            <div class="mw-form-row mt-2">
              <div class="mw-form-label">时长</div>
              <a-slider
                v-model="draft.riskTailSeconds"
                :min="1"
                :max="15"
                :step="1"
                :style="{ width: '200px' }"
                :disabled="!draft.riskTailEnabled"
              />
              <span class="text-[13px] text-[var(--mw-text2)]">{{ draft.riskTailSeconds }}s</span>
            </div>
            <div class="mw-subtle flex items-center gap-1 mt-1">
              <icon-info-circle :size="12" />文案取自文案工坊过审风险提示段，不可编辑；适用范围以 Q4 拍板为准。
            </div>
          </div>
        </div>
      </div>

      <!-- 渲染进度 -->
      <div
        v-if="store.activeCut && ['queued', 'rendering', 'cancelling'].includes(store.activeCut.cut.status)"
        class="mw-card mt-5 p-4"
      >
        <div class="flex items-center gap-3">
          <span class="mw-tag mw-tag-blue"
            >成片 v{{ store.activeCut.cut.versionNo }} · {{ cutStatusText(store.activeCut.cut) }}</span
          >
          <a-progress :percent="store.activeCut.cut.progress / 100" :style="{ flex: 1 }" size="small" />
          <a-button size="mini" status="warning" @click="cancelCut">取消渲染</a-button>
        </div>
        <div class="mw-subtle mt-1.5">阶段：{{ store.activeCut.cut.renderStage }}</div>
      </div>

      <!-- 底部状态 -->
      <div class="mw-card mt-5 p-4 flex items-center gap-3">
        <span class="mw-tag mw-tag-gray">{{ specText }}</span>
        <span class="text-[var(--mw-border)]">|</span>
        <span class="mw-subtle">{{ bottomHint }}</span>
        <div class="flex-1"></div>
        <a-button v-if="activeCompleted" size="mini" :disabled="activeReviewing" type="primary" @click="submitReview">
          {{ store.activeCut?.cut.reviewStatus === 'approved' ? '已通过复审' : '提交成片复审' }}
        </a-button>
        <a-button v-if="activeFailed" size="mini" status="danger" @click="retryRender">重试渲染</a-button>
      </div>
    </a-spin>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watchEffect } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useRoute } from 'vue-router'
import { cutApi, fmtMs, CUT_STATUS_LABELS, CUT_REVIEW_LABELS, type CutSegment, type BgmItem } from '@/api/cut'
import { useCutStore } from '@/stores/cut'

/**
 * 视频剪辑页（任务书 §7 / CE7）：整页重写，替换静态演示原型。
 * 左列字幕分段（normal 可编辑 / risk 锁定），中列低仿预览（base + CSS 字幕叠加），
 * 右列配置四面板，底部渲染进度与复审动作。
 */

const route = useRoute()
const store = useCutStore()
defineOptions({ name: 'VideoEdit' })
const tab = ref('sub')
const current = ref(0)
const saving = ref(false)
const creating = ref(false)
const playing = ref(false)
const currentTimeMs = ref(0)
const durationMs = ref(0)
const seekSec = ref(0)
const bgmList = ref<BgmItem[]>([])
const videoEl = ref<HTMLVideoElement | null>(null)

const videoJobId = computed(() => String(route.query.videoJobId ?? ''))
const currentCutId = computed(() => store.activeCut?.cut.id ?? undefined)
function onVersionSwitch(
  v:
    | string
    | number
    | boolean
    | Record<string, unknown>
    | Array<string | number | boolean | Record<string, unknown>>
    | undefined,
): void {
  if (typeof v === 'string') void switchVersion(v)
}
const draft = computed(() => store.draft)

const editableSegments = computed<CutSegment[]>(() => draft.value?.segments ?? [])
const currentSegment = computed(() => editableSegments.value[current.value] ?? null)

const previewMode = computed(() =>
  store.activeCut?.cut.status === 'completed' && store.activeCut.url ? 'final' : 'base',
)
const previewUrl = computed(() => (previewMode.value === 'final' ? store.activeCut?.url : store.base?.url) ?? '')
const previewSourceLabel = computed(() =>
  previewMode.value === 'final' ? `成片 v${store.activeCut?.cut.versionNo}` : '基础视频（预览）',
)
const activeCompleted = computed(() => store.activeCut?.cut.status === 'completed')
const activeFailed = computed(() => store.activeCut?.cut.status === 'failed')
const activeReviewing = computed(
  () => store.activeCut?.cut.reviewStatus === 'in_review' || store.activeCut?.cut.reviewStatus === 'approved',
)

const pageSub = computed(() => {
  if (!store.base) return ''
  return `基础视频 v${store.base.versionNo} · ${fmtMs(store.base.durationMs)} · 时间轴 ${store.base.timelineSource === 'aligned' ? '已对齐' : '估算'}`
})

const specText = computed(() => {
  const d = draft.value
  if (!d) return '—'
  const total = (store.base?.durationMs ?? 0) + (d.riskTailEnabled ? d.riskTailSeconds * 1000 : 0)
  return `1080P · 9:16 · 约 ${fmtMs(total)}`
})

const bottomHint = computed(() => {
  const edited = editableSegments.value.some((s) => s.edited)
  if (edited) return '字幕已修改：渲染新版本后需重新提交成片复审。'
  if (store.approvedDrifted) return '内容已修改，需重新渲染并复审后发布。'
  return '风险提示话术不可修改；修改其他字幕不改变文案过审版本。'
})

const reviewBanner = computed(() => {
  const v = store.versions.find((x) => x.approvedContentHash)
  if (store.approvedDrifted) {
    return { text: '内容已修改，需重新审核后发布。', detail: `成片 v${v?.versionNo} · 曾复审通过（现为待复审）` }
  }
  if (store.activeCut?.cut.reviewStatus === 'in_review') {
    return {
      text: '成片已提交复审，等待人工复核。',
      detail: `成片 v${store.activeCut.cut.versionNo} · ${CUT_REVIEW_LABELS.in_review}`,
    }
  }
  if (store.activeCut?.cut.reviewStatus === 'rejected') {
    return {
      text: `复审退回：${store.activeCut.submission?.decisionReason ?? '原因未填写'}`,
      detail: `成片 v${store.activeCut.cut.versionNo}`,
    }
  }
  return null
})

const breatheProxy = reactive({ noiseDb: -30, minSilenceMs: 500, keepGapMs: 120 })
watchEffect(() => {
  const p = draft.value?.breatheParams
  if (p) {
    breatheProxy.noiseDb = p.noiseDb
    breatheProxy.minSilenceMs = p.minSilenceMs
    breatheProxy.keepGapMs = p.keepGapMs
  }
})

const bgmVolumePercent = computed({
  get: () => Math.round((draft.value?.bgmVolume ?? 0.2) * 100),
  set: (v: number) => {
    if (draft.value) draft.value.bgmVolume = Math.round(v) / 100
  },
})
const bgmIdProxy = computed({
  get: () => draft.value?.bgmId ?? undefined,
  set: (v: string | number | boolean | Record<string, unknown> | undefined) => {
    if (draft.value) draft.value.bgmId = v ? String(v) : null
  },
})
const bgmOpacityProxy = computed({
  get: () => Math.round((draft.value?.subtitleStyle.backgroundOpacity ?? 0.5) * 100),
  set: (v: number) => {
    if (draft.value) draft.value.subtitleStyle.backgroundOpacity = Math.round(v) / 100
  },
})

const subtitleOverlayStyle = computed(() => {
  const pos = draft.value?.subtitleStyle.position ?? 'bottom'
  return pos === 'top'
    ? { top: '8%' }
    : pos === 'center'
      ? { top: '50%', transform: 'translateY(-50%)' }
      : { bottom: '12%' }
})

function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16) || 0
  const g = parseInt(hex.slice(3, 5), 16) || 0
  const b = parseInt(hex.slice(5, 7), 16) || 0
  return `rgba(${r},${g},${b},${opacity})`
}

function onSegmentEdit(seg: CutSegment): void {
  if (draft.value) {
    seg.edited = true
    draft.value.segments = [...draft.value.segments]
  }
}

async function loadAll(): Promise<void> {
  if (!videoJobId.value) {
    Message.error('缺少 videoJobId 参数')
    return
  }
  await store.loadConfig(videoJobId.value)
  const bgm = await cutApi.listBgm().catch(() => ({ items: [] as BgmItem[] }))
  bgmList.value = bgm.items
}

async function saveDraft(): Promise<void> {
  if (!draft.value) return
  saving.value = true
  try {
    const payload = {
      subtitleEnabled: draft.value.subtitleEnabled,
      subtitleStyle: draft.value.subtitleStyle,
      segments: draft.value.segments.map((s) => ({ index: s.index, text: s.text })),
      riskTailEnabled: draft.value.riskTailEnabled,
      riskTailSeconds: draft.value.riskTailSeconds,
      bgmEnabled: draft.value.bgmEnabled,
      bgmId: draft.value.bgmId,
      bgmVolume: draft.value.bgmVolume,
      bgmFadeIn: draft.value.bgmFadeIn,
      bgmFadeOut: draft.value.bgmFadeOut,
      breatheEnabled: draft.value.breatheEnabled,
      breatheParams: draft.value.breatheEnabled ? { ...breatheProxy } : undefined,
    }
    await cutApi.saveConfig(videoJobId.value, payload)
    Message.success('草稿已保存')
    await store.loadConfig(videoJobId.value, true)
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

async function createVersion(): Promise<void> {
  creating.value = true
  try {
    await saveDraft()
    const r = await cutApi.createVersion(videoJobId.value, `cut-${Date.now()}`)
    Message.success(r.idempotent ? '已有渲染中的版本，已为你定位' : `成片 v${r.cut.versionNo} 已加入渲染队列`)
    await store.loadConfig(videoJobId.value, true)
    await store.trackCut(r.cut.id)
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

async function cancelCut(): Promise<void> {
  if (!store.activeCut) return
  try {
    await cutApi.cancel(store.activeCut.cut.id)
    Message.info('已请求取消')
    await store.loadConfig(videoJobId.value, true)
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function retryRender(): Promise<void> {
  if (!store.activeCut) return
  try {
    const v = await cutApi.retryRender(store.activeCut.cut.id)
    Message.success(`已创建重试版本 v${v.versionNo}`)
    await store.loadConfig(videoJobId.value, true)
    await store.trackCut(v.id)
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function submitReview(): Promise<void> {
  if (!store.activeCut || store.activeCut.cut.reviewStatus !== 'none') return
  try {
    const r = await cutApi.submitReview(store.activeCut.cut.id)
    const pts = r.submission.riskPoints?.length ?? 0
    Message.success(pts ? `已提交复审（${pts} 项风险点供人工重点核）` : '已提交复审，三关自动检查通过')
    await store.loadConfig(videoJobId.value, true)
    await store.trackCut(store.activeCut.cut.id, true)
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function switchVersion(cutId: string): Promise<void> {
  await store.trackCut(cutId)
}

/* ── 预览播放 ── */
function onTimeUpdate(): void {
  currentTimeMs.value = (videoEl.value?.currentTime ?? 0) * 1000
  seekSec.value = Math.floor(videoEl.value?.currentTime ?? 0)
}
function onLoaded(): void {
  durationMs.value = (videoEl.value?.duration ?? 0) * 1000
}
function togglePlay(): void {
  const el = videoEl.value
  if (!el) return
  if (el.paused) {
    void el.play()
    playing.value = true
  } else {
    el.pause()
    playing.value = false
  }
}
function onSeek(v: number | string | number[] | string[] | undefined): void {
  if (typeof v === 'number' && videoEl.value) videoEl.value.currentTime = v
}
const previewBgmUrl = computed(() => bgmList.value.find((b) => b.id === draft.value?.bgmId)?.storageKey ?? null)
let bgmAudio: HTMLAudioElement | null = null
function previewBgm(): void {
  const key = previewBgmUrl.value
  if (!key) return
  bgmAudio?.pause()
  bgmAudio = new Audio(`/api/media/${key}`)
  void bgmAudio.play().catch(() => Message.warning('试听播放失败'))
}

function cutStatusText(v: { status: keyof typeof CUT_STATUS_LABELS; reviewStatus: string }): string {
  const s = CUT_STATUS_LABELS[v.status] ?? v.status
  return v.reviewStatus !== 'none' ? `${s} · ${CUT_REVIEW_LABELS[v.reviewStatus as keyof typeof CUT_REVIEW_LABELS]}` : s
}

onMounted(loadAll)
onUnmounted(() => {
  store.stopPolling()
  bgmAudio?.pause()
})
</script>
