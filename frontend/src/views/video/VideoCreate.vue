<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="视频创作">
      <template #sub>将审核通过的文案，制作基础视频（数字人口播 / 素材混剪）。</template>
      <template #extra>
        <a-button @click="pickerVisible = true"
          ><template #icon><icon-file /></template>选择文案</a-button
        >
      </template>
    </PageHead>

    <a-spin :loading="store.contextLoading" class="block">
      <!-- 文案卡（FR-C2）-->
      <div v-if="ctx" class="mw-card p-4 mb-5 flex items-center gap-4">
        <div class="w-11 h-11 rounded-[10px] bg-[var(--mw-primary-bg)] flex items-center justify-center">
          <icon-file :size="22" class="text-[color:var(--mw-primary)]" />
        </div>
        <div class="min-w-0">
          <div class="text-[16px] font-semibold truncate">{{ ctx.copy.title || '（无标题）' }}</div>
          <div class="mw-subtle mt-0.5">
            {{ ctx.copy.persona?.name ?? '—' }} · {{ lineLabel(ctx.copy.line) }} · 文案 v{{ ctx.copy.versionNo }} · 约
            {{ ctx.copy.wordCount }} 字 · 预计口播 {{ Math.round(ctx.copy.estSeconds) }} 秒
          </div>
        </div>
        <span class="mw-tag mw-tag-green ml-4"><icon-check-circle :size="12" />人工复核通过</span>
        <div class="flex-1"></div>
        <span class="mw-link cursor-pointer" @click="copyDrawerVisible = true">查看文案 <icon-right :size="12" /></span>
      </div>
      <div v-else class="mw-card p-10 mb-5 text-center mw-subtle">
        尚未选择文案：点击右上角「选择文案」，或从文案工坊「去视频创作」进入。
      </div>

      <a-alert v-if="ctx?.copy.revising" type="warning" class="mb-5">
        文案修订中，当前使用已通过的 v{{ ctx.copy.versionNo }}；修订重提通过后再生成将使用新版本。
      </a-alert>

      <template v-if="ctx">
        <div class="grid grid-cols-[54fr_46fr] gap-5 items-start">
          <!-- ============ 左列配置 ============ -->
          <div class="flex flex-col gap-5">
            <!-- ① 视频模式（FR-A1）-->
            <div class="mw-card p-5">
              <div class="text-[15px] font-semibold mb-3">视频模式</div>
              <div class="grid grid-cols-2 gap-3">
                <div
                  v-for="m in store.options?.modes ?? []"
                  :key="m.key"
                  class="p-4 rounded-[10px] border-2 transition-colors"
                  :class="[
                    mode === m.key
                      ? 'border-[color:var(--mw-primary)] bg-[color:var(--mw-primary-faint)]'
                      : 'border-[var(--mw-border)] hover:border-[color:var(--mw-primary-soft)]',
                    modeBlocked(m.key) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                  ]"
                  @click="!modeBlocked(m.key) && (mode = m.key)"
                >
                  <div class="flex items-center gap-2">
                    <a-radio :model-value="mode === m.key" />
                    <span class="text-[15px] font-semibold">{{ m.label }}</span>
                  </div>
                  <div class="text-[12.5px] text-[var(--mw-text3)] mt-2 leading-5">
                    {{ modeBlocked(m.key) ? m.personaLineBlocked : m.desc }}
                  </div>
                </div>
              </div>
            </div>

            <!-- ② 口播：人物绑定形象 / 声音 / 引擎（FR-A2~A4）-->
            <div v-if="mode === 'avatar'" class="mw-card p-5">
              <div class="text-[15px] font-semibold mb-3">人物绑定形象</div>
              <div class="grid grid-cols-2 gap-3">
                <div
                  v-for="av in ctx.avatars"
                  :key="av.avatarId"
                  class="p-3.5 rounded-[10px] border-2 flex gap-3"
                  :class="[
                    avatarId === av.avatarId
                      ? 'border-[color:var(--mw-primary)] bg-[color:var(--mw-primary-faint)]'
                      : 'border-[var(--mw-border)]',
                    av.selectable
                      ? 'cursor-pointer hover:border-[color:var(--mw-primary-soft)]'
                      : 'opacity-60 cursor-not-allowed',
                  ]"
                  @click="av.selectable && (avatarId = av.avatarId)"
                >
                  <ThumbBox :seed="av.name" :width="64" :height="64" />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5">
                      <a-radio :model-value="avatarId === av.avatarId" />
                      <span class="text-[14px] font-medium truncate">{{ av.name }}</span>
                      <span v-if="av.isDefault" class="mw-tag mw-tag-gray">默认</span>
                    </div>
                    <div class="text-[12px] text-[var(--mw-text3)] mt-1 leading-4">
                      {{ av.backgroundLabel ? `背景：${av.backgroundLabel}` : av.statusLabel }}
                    </div>
                    <span v-if="!av.selectable" class="mw-tag mw-tag-gray mt-1.5">{{ av.blockedReason }}</span>
                    <span v-else class="mw-tag mw-tag-gray mt-1.5">来自人物库</span>
                  </div>
                </div>
                <div v-if="!ctx.avatars.length" class="col-span-2 mw-subtle text-[13px] py-3">
                  该人物还没有可用分身，请先到人物库制作口播分身。
                </div>
              </div>

              <div class="mt-4 flex flex-col">
                <div class="mw-form-row">
                  <div class="mw-form-label">声音</div>
                  <div class="flex items-center gap-2.5 flex-1 p-2.5 rounded-[8px] border border-[var(--mw-border)]">
                    <icon-sound :size="16" class="text-[color:var(--mw-primary)]" />
                    <span class="text-[13.5px]">{{ voiceSummary }}</span>
                    <div class="flex-1"></div>
                    <a-button size="small" :loading="previewBusy" @click="previewVoice"
                      ><template #icon><icon-play-arrow /></template>试听</a-button
                    >
                  </div>
                </div>
                <div class="mw-form-row">
                  <div class="mw-form-label">引擎</div>
                  <div class="flex items-center gap-2 flex-1">
                    <span class="text-[13.5px]">{{ engineLabel }}</span>
                    <span v-if="store.options?.engine.mock" class="mw-tag mw-tag-gray">模拟</span>
                    <span v-else-if="credit != null" class="mw-subtle"
                      >余额 {{ credit }} 积分 · 本次预估 {{ estCredits }}</span
                    >
                  </div>
                </div>
              </div>
            </div>

            <!-- ② 混剪配置（FR-M1）-->
            <div v-else class="mw-card p-5">
              <div class="text-[15px] font-semibold mb-2">混剪配置</div>
              <div class="mw-subtle mb-2">
                按关键词匹配素材包画面并按时间轴叠加；风险段保持底板画面。字幕、BGM 与风险尾页在剪辑中添加。
              </div>
              <div class="flex flex-col">
                <div class="mw-form-row">
                  <div class="mw-form-label">素材包</div>
                  <a-select v-model:model-value="mixPackIds" multiple placeholder="选择素材包" :style="{ flex: 1 }">
                    <a-option v-for="p in packs" :key="p.id" :value="p.id"
                      >{{ p.name }}（{{ p.itemCount }} 项）</a-option
                    >
                  </a-select>
                </div>
                <div class="mw-form-row">
                  <div class="mw-form-label">关键词组</div>
                  <a-select v-model:model-value="mixGroupIds" multiple placeholder="默认全部启用" :style="{ flex: 1 }">
                    <a-option v-for="g in groups" :key="g.id" :value="g.id"
                      >{{ g.name }}（{{ g.keywords.length }} 词）</a-option
                    >
                  </a-select>
                  <a-button size="small" @click="doPreview">预览匹配</a-button>
                </div>
                <div class="mw-form-row">
                  <div class="mw-form-label">配音声音</div>
                  <div class="flex items-center gap-2 flex-1">
                    <span class="text-[13.5px]">{{ mixVoiceLabel }}</span>
                    <span class="mw-subtle">{{
                      ctx.copy.line === 'persona' ? '素人线使用公共音色（非本人声音）' : '使用人物默认克隆声音'
                    }}</span>
                  </div>
                </div>
                <div class="mw-form-row">
                  <div class="mw-form-label">显示方式</div>
                  <a-radio-group v-model:model-value="mixDisplay">
                    <a-radio value="fullscreen">全屏覆盖</a-radio>
                    <a-radio value="pip">画中画</a-radio>
                  </a-radio-group>
                </div>
              </div>
              <div
                v-if="previewMatches.length"
                class="mt-3 p-3 rounded-[8px] bg-[var(--mw-primary-bg)] max-h-[220px] overflow-auto"
              >
                <div class="text-[12.5px] font-medium mb-1.5">匹配预览（估算时间轴，生成时以对齐结果为准）</div>
                <div
                  v-for="m in previewMatches"
                  :key="`${m.index}-${m.itemId}`"
                  class="text-[12.5px] mw-subtle leading-5"
                >
                  第 {{ m.index + 1 }} 句 ·「{{ m.keyword }}」→ {{ m.groupName }} · {{ (m.startMs / 1000).toFixed(1) }}s
                  ~ {{ (m.endMs / 1000).toFixed(1) }}s
                </div>
              </div>
            </div>

            <!-- ③ 配置检查（FR-A5）-->
            <div class="mw-card p-5">
              <div class="text-[15px] font-semibold mb-3">配置检查</div>
              <a-spin v-if="!store.precheck" :loading="true" class="block" />
              <div v-else class="flex flex-col gap-1.5">
                <div v-for="c in store.precheck.checks" :key="c.key" class="flex items-center gap-1.5 text-[13px]">
                  <icon-check-circle v-if="c.pass" :size="15" class="text-[#0f7b3e]" />
                  <icon-close-circle
                    v-else
                    :size="15"
                    :class="c.level === 'hard' ? 'text-[#c02c2c]' : 'text-[#b45309]'"
                  />
                  <span
                    :class="
                      c.pass ? 'text-[var(--mw-text2)]' : c.level === 'hard' ? 'text-[#c02c2c]' : 'text-[#b45309]'
                    "
                    >{{ c.message }}</span
                  >
                  <a-link
                    v-if="c.action?.startsWith('persona:')"
                    class="text-[12px]"
                    @click="$router.push({ path: '/people' })"
                    >去人物库</a-link
                  >
                </div>
              </div>
            </div>
          </div>

          <!-- ============ 右列：预览与版本 ============ -->
          <div class="flex flex-col gap-5">
            <div class="mw-card p-5">
              <!-- 生成中 -->
              <template v-if="active && phaseRunning(active.phase)">
                <div
                  class="mx-auto relative rounded-[12px] overflow-hidden"
                  style="width: 300px; aspect-ratio: 9/16; background: var(--mw-primary-bg)"
                >
                  <div class="absolute inset-0 flex flex-col items-center justify-center gap-3">
                    <a-progress type="circle" size="large" :percent="Math.min(99, active.progress) / 100" />
                    <div class="text-[13.5px]">{{ active.message }}</div>
                    <div class="mw-subtle text-[12px]">可离开页面，回来后进度自动续显</div>
                  </div>
                </div>
              </template>
              <!-- 完成：播放（FR-A8）-->
              <template v-else-if="selectedJob?.phase === 'completed'">
                <video
                  :src="playUrl"
                  :poster="playCover ?? undefined"
                  controls
                  playsinline
                  class="mx-auto rounded-[12px] block"
                  style="width: 300px; aspect-ratio: 9/16; background: #000"
                />
                <div class="text-center mw-subtle mt-3">
                  {{ selectedJob.width }}P · 9:16 · 约 {{ Math.round((selectedJob.durationMs || 0) / 1000) }} 秒
                  <span v-if="selectedJob.isMock" class="mw-tag mw-tag-gray ml-1">模拟</span>
                </div>
                <div class="text-center mw-subtle mt-1">基础视频预览：字幕、BGM 与风险尾页在剪辑中添加。</div>
                <div v-if="selectedJob.timelineSource === 'estimated'" class="mt-3">
                  <a-alert type="warning">时间轴为估算，请在剪辑中校对。</a-alert>
                  <div class="mt-2 text-center">
                    <a-button size="small" :loading="acting" @click="act('realign')">重新对齐</a-button>
                  </div>
                </div>
              </template>
              <!-- 异常态（FR-A9）-->
              <template v-else-if="active && abnormalPhase">
                <div
                  class="mx-auto rounded-[12px] p-6"
                  style="width: 300px; aspect-ratio: 9/16; background: var(--mw-primary-bg)"
                >
                  <div class="flex flex-col items-center justify-center h-full gap-2 text-center px-3">
                    <icon-exclamation-circle :size="34" class="text-[#b45309]" />
                    <div class="text-[13.5px]">{{ active.message }}</div>
                    <div v-if="active.errorCode === 'VIDEO_SAVE_FAILED'" class="mw-subtle text-[12px]">
                      视频已生成，无需重新生成，只重试下载（不重复计费）。
                    </div>
                    <div
                      v-else-if="active.errorCode === 'VIDEO_SUBMISSION_UNKNOWN'"
                      class="mw-subtle text-[12px] break-all"
                    >
                      请在飞影后台按标题「{{ active.vendorTitle ?? '—' }}」检索后再操作。
                    </div>
                  </div>
                </div>
              </template>
              <!-- 占位 -->
              <template v-else>
                <div
                  class="mx-auto rounded-[12px] p-6"
                  style="width: 300px; aspect-ratio: 9/16; background: var(--mw-primary-bg)"
                >
                  <div
                    class="flex flex-col items-center justify-center h-full gap-2 mw-subtle text-[13px] text-center px-3"
                  >
                    <icon-video-camera :size="34" />
                    <span>配置完成点击下方「生成基础视频」</span>
                    <span>产出 1080P · 9:16 竖屏基础视频</span>
                  </div>
                </div>
              </template>
            </div>

            <!-- 版本列表（FR-C3）-->
            <div v-if="ctx.jobs.length" class="mw-card p-5">
              <div class="text-[15px] font-semibold mb-3">本文案的基础视频</div>
              <div class="flex flex-col gap-2">
                <div
                  v-for="j in ctx.jobs"
                  :key="j.id"
                  class="p-3 rounded-[10px] border cursor-pointer flex items-center gap-3"
                  :class="
                    selectedJobId === j.id
                      ? 'border-[color:var(--mw-primary)] bg-[color:var(--mw-primary-faint)]'
                      : 'border-[var(--mw-border)] hover:border-[color:var(--mw-primary-soft)]'
                  "
                  @click="selectJob(j)"
                >
                  <div
                    class="w-9 h-9 rounded-[8px] bg-[var(--mw-primary-bg)] flex items-center justify-center text-[12px] font-semibold"
                  >
                    v{{ j.versionNo }}
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-[13.5px]">
                      {{ modeLabel(j.mode) }} · {{ phaseLabel(j.phase) }}
                      <span v-if="j.durationMs">· 约 {{ Math.round(j.durationMs / 1000) }} 秒</span>
                    </div>
                    <div class="mw-subtle text-[12px] mt-0.5">
                      基于文案 v{{ j.copyVersionNo }}
                      <span v-if="j.copyVersionNo < ctx.copy.versionNo" class="text-[#b45309]">· 文案已更新</span>
                      <span v-if="j.timelineSource === 'estimated'">· 时间轴待校对</span>
                      <span v-if="j.isMock">· 模拟</span>
                    </div>
                  </div>
                  <div v-if="phaseRunning(j.phase)" class="text-[12px] text-[color:var(--mw-primary)]">
                    {{ j.progress }}%
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部操作条（FR-A7/A9）-->
        <div class="mw-card mt-5 p-4 flex items-center gap-4">
          <span class="mw-tag" :class="statusTagClass">{{ statusLabel }}</span>
          <span class="text-[var(--mw-border)]">|</span>
          <div class="flex items-center gap-2 text-[13px] text-[var(--mw-text2)]">
            <span v-for="(s, i) in steps" :key="s" class="flex items-center gap-2">
              <span
                class="w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px]"
                :class="stepIndex >= i ? 'bg-[color:var(--mw-primary)] text-white' : 'border border-[var(--mw-border)]'"
                >{{ i + 1 }}</span
              >{{ s }}
              <icon-right v-if="i < steps.length - 1" :size="13" class="text-[var(--mw-text3)]" />
            </span>
          </div>
          <div class="flex-1"></div>
          <!-- 异常态动作（FR-A9：重试下载不重复生成）-->
          <template v-if="active && abnormalPhase">
            <a-button
              v-if="active.nextActions.includes('retry_download')"
              type="primary"
              status="warning"
              :loading="acting"
              @click="act('retry-download')"
              >重试下载</a-button
            >
            <a-button
              v-if="active.nextActions.includes('query_original')"
              :loading="acting"
              @click="act('query-original')"
              >查询原任务</a-button
            >
            <a-button v-if="active.nextActions.includes('bind_remote')" @click="bindVisible = true"
              >补录任务号</a-button
            >
            <a-button v-if="active.phase === 'paused'" :loading="acting" @click="act('resume')">继续查询</a-button>
          </template>
          <a-button
            v-else-if="active && ['generating', 'recovering'].includes(active.phase)"
            status="danger"
            :loading="acting"
            @click="act('cancel')"
            >停止等待</a-button
          >
          <a-button :disabled="creating" @click="onSaveConfig">保存配置</a-button>
          <a-button
            v-if="!active || ['completed', 'failed', 'cancelled'].includes(active.phase)"
            type="primary"
            :disabled="!store.hardChecksPass || creating"
            :loading="creating"
            @click="onGenerate"
          >
            <template #icon><icon-play-arrow /></template>
            {{ ctx.jobs.length ? '重新生成' : '生成基础视频' }}
          </a-button>
          <a-button
            v-if="active?.nextActions.includes('continue_edit')"
            type="primary"
            @click="$router.push({ path: '/video/edit', query: { videoJobId: active.id } })"
          >
            <template #icon><icon-play-arrow /></template>进入视频剪辑
          </a-button>
          <a-button
            v-if="selectedJob?.phase === 'completed' && selectedJob.copyId"
            @click="$router.push({ path: '/publish', query: { copyId: selectedJob.copyId } })"
          >
            <template #icon><icon-send /></template>去发布
          </a-button>
        </div>
      </template>
    </a-spin>

    <CopyPickerDrawer :visible="pickerVisible" @close="pickerVisible = false" @pick="onPickCopy" />

    <!-- 查看文案抽屉 -->
    <a-drawer
      :visible="copyDrawerVisible"
      title="查看文案"
      :width="520"
      unmount-on-close
      @cancel="copyDrawerVisible = false"
      @close="copyDrawerVisible = false"
    >
      <template v-if="ctx">
        <div class="text-[15px] font-semibold mb-3">{{ ctx.copy.title }}（v{{ ctx.copy.versionNo }}）</div>
        <div class="flex flex-col gap-3">
          <div v-for="(s, i) in ctx.copy.sections" :key="i" class="p-3 rounded-[8px] border border-[var(--mw-border)]">
            <div class="text-[12.5px] mw-subtle mb-1">{{ s.label || `段落 ${i + 1}` }}</div>
            <div class="text-[13.5px] leading-6 whitespace-pre-wrap">{{ s.text }}</div>
          </div>
          <div v-if="ctx.copy.riskHint" class="p-3 rounded-[8px] border border-[#e8b339] bg-[#fdf6e7]">
            <div class="text-[12.5px] text-[#b45309] mb-1">风险话术（随口播最后一段）</div>
            <div class="text-[13.5px] leading-6">{{ ctx.copy.riskHint }}</div>
          </div>
        </div>
      </template>
    </a-drawer>

    <BindRemoteDialog
      :visible="bindVisible"
      :job-id="active?.id ?? ''"
      :vendor-title="active?.vendorTitle ?? null"
      :short-ref="active?.shortRef ?? null"
      :remote-task-id="active?.remoteTaskId ?? null"
      @close="bindVisible = false"
      @done="onActionDone"
    />

    <div v-if="store.options?.engine.mock" class="mw-corner-note">
      当前为模拟引擎（MOCK），产物带「模拟」标记，仅用于联调。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import {
  IconCheckCircle,
  IconCloseCircle,
  IconExclamationCircle,
  IconFile,
  IconPlayArrow,
  IconRight,
  IconSound,
  IconVideoCamera,
} from '@arco-design/web-vue/es/icon'
import PageHead from '@/components/PageHead.vue'
import ThumbBox from '@/components/ThumbBox.vue'
import CopyPickerDrawer from './components/CopyPickerDrawer.vue'
import BindRemoteDialog from './components/BindRemoteDialog.vue'
import { useVideoStore } from '@/stores/video'
import {
  createVideoJob,
  getVideoJob,
  getVideoJobBase,
  listKeywordGroups,
  listMaterialPacks,
  postJobAction,
  postMixcutPreview,
  putVideoCopyConfig,
  type JobSummary,
  type KeywordGroup,
  type MaterialPack,
  type VideoMode,
} from '@/api/video'
import { createVoicePreview, getVoicePreview, voicePreviewUrl } from '@/api/personas'

const route = useRoute()
const store = useVideoStore()

const ctx = computed(() => store.context)
const mode = ref<VideoMode>('avatar')
const avatarId = ref<string | null>(null)
const mixPackIds = ref<string[]>([])
const mixGroupIds = ref<string[]>([])
const mixDisplay = ref<'fullscreen' | 'pip'>('fullscreen')
const packs = ref<MaterialPack[]>([])
const groups = ref<KeywordGroup[]>([])
const previewMatches = ref<
  Array<{ index: number; keyword: string; groupName: string; itemId: string; startMs: number; endMs: number }>
>([])

const selectedJobId = ref<string | null>(null)
const selectedJob = ref<JobSummary | null>(null)
const playUrl = ref('')
const playCover = ref('')
const pickerVisible = ref(false)
const copyDrawerVisible = ref(false)
const bindVisible = ref(false)
const creating = ref(false)
const acting = ref(false)
const previewBusy = ref(false)
const credit = computed(() => store.options?.engine.credit ?? null)

const active = computed(() => store.activeJob)
const abnormalPhase = computed(
  () => !!active.value && ['failed', 'save_failed', 'submission_unknown', 'paused'].includes(active.value.phase),
)
const estCredits = computed(() => store.precheck?.estCredits ?? '—')
const voiceSummary = computed(() => {
  const v = ctx.value?.productionProfile?.voice
  if (!v) return '人物未绑定克隆声音（到人物库制作并确认）'
  return `${v.name} · ${v.language} · 语速 ${v.speechRate} / 音量 ${v.volume} / 音调 ${v.pitch}`
})
const mixVoiceLabel = computed(() => {
  const v = ctx.value?.productionProfile?.voice
  return v ? `${v.name}（人物默认）` : '公共音色（非本人声音）'
})
const engineLabel = computed(() => (store.options?.engine.mock ? '模拟引擎 · 文本直出' : '飞影数字人 · 文本直出'))

const steps = computed(() =>
  mode.value === 'avatar' ? ['提交', '口播画面生成', '基础视频'] : ['提交', '配音与素材合成', '基础视频'],
)
const stepIndex = computed(() => {
  const p = active.value?.phase ?? selectedJob.value?.phase
  if (!p) return -1
  if (p === 'completed') return 2
  if (['downloading', 'verifying', 'aligning', 'composing'].includes(p)) return 1
  return 0
})
const statusLabel = computed(() => active.value?.message ?? selectedJob.value?.message ?? '待配置')
const statusTagClass = computed(() => (selectedJob.value?.phase === 'completed' ? 'mw-tag-green' : 'mw-tag-gray'))

function lineLabel(line?: string | null): string {
  return line === 'manager' ? '经理' : line === 'kos' ? '员工 KOS' : line === 'persona' ? '素人矩阵' : '—'
}
function modeLabel(m: string): string {
  return m === 'avatar' ? '数字人口播' : '素材混剪'
}
function modeBlocked(m: VideoMode): boolean {
  return m === 'avatar' && ctx.value?.copy.line === 'persona'
}
function phaseLabel(p: string): string {
  const map: Record<string, string> = {
    waiting: '排队中',
    preparing: '准备中',
    submitting: '提交中',
    generating: '生成中',
    recovering: '恢复查询',
    downloading: '下载中',
    verifying: '校验中',
    aligning: '对齐中',
    composing: '合成中',
    tts: '配音合成中',
    completed: '已完成',
    failed: '失败',
    save_failed: '保存失败',
    submission_unknown: '提交结果待确认',
    paused: '已停止等待',
    cancelled: '已取消',
  }
  return map[p] ?? p
}
function phaseRunning(p: string): boolean {
  return [
    'waiting',
    'preparing',
    'submitting',
    'generating',
    'recovering',
    'downloading',
    'verifying',
    'aligning',
    'composing',
    'tts',
  ].includes(p)
}

async function onPickCopy(copyId: string): Promise<void> {
  pickerVisible.value = false
  await store.loadContext(copyId)
  selectedJobId.value = null
  selectedJob.value = null
  playUrl.value = ''
  restoreConfig()
  void rerunPrecheck()
}

/** 回填保存的配置（FR-C4）*/
function restoreConfig(): void {
  const saved = ctx.value?.savedConfig
  if (!saved) return
  if (saved.mode) mode.value = saved.mode
  if (saved.avatarId && ctx.value?.avatars.some((a) => a.avatarId === saved.avatarId && a.selectable)) {
    avatarId.value = saved.avatarId
  }
  if (saved.mixcut?.packIds?.length) mixPackIds.value = saved.mixcut.packIds
  if (saved.mixcut?.keywordGroupIds?.length) mixGroupIds.value = saved.mixcut.keywordGroupIds
  if (saved.mixcut?.display) mixDisplay.value = saved.mixcut.display
}

async function rerunPrecheck(): Promise<void> {
  try {
    await store.refreshPrecheck({ mode: mode.value, avatarId: avatarId.value, mixcutPackIds: mixPackIds.value })
  } catch (e) {
    Message.error((e as Error).message)
  }
}

let precheckTimer: ReturnType<typeof setTimeout> | null = null
watch([mode, avatarId, mixPackIds], () => {
  previewMatches.value = []
  if (precheckTimer) clearTimeout(precheckTimer)
  precheckTimer = setTimeout(() => void rerunPrecheck(), 400)
})

async function loadStatic(): Promise<void> {
  try {
    const [p, g] = await Promise.all([listMaterialPacks(), listKeywordGroups()])
    packs.value = p.filter((x) => x.enabled)
    groups.value = g.filter((x) => x.enabled)
  } catch {
    // 素材桩加载失败不阻塞口播
  }
}

async function previewVoice(): Promise<void> {
  const voice = ctx.value?.productionProfile?.voice
  if (!voice) {
    Message.warning('人物未绑定克隆声音')
    return
  }
  previewBusy.value = true
  try {
    const first = ctx.value?.copy.sections[0]?.text?.slice(0, 80) || '大家好。'
    const p = await createVoicePreview(voice.voiceId, first)
    for (let i = 0; i < 20; i++) {
      const r = await getVoicePreview(p.previewId)
      if (r.status === 'ready') {
        void new Audio(voicePreviewUrl(p.previewId)).play()
        return
      }
      if (r.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
    Message.warning('试听生成超时')
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    previewBusy.value = false
  }
}

async function doPreview(): Promise<void> {
  if (!ctx.value) return
  try {
    const r = await postMixcutPreview({ copyId: ctx.value.copy.id, keywordGroupIds: mixGroupIds.value })
    previewMatches.value = r.matches
    if (!r.matches.length) Message.info('没有命中关键词，请调整关键词组或素材包')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

function newIdempotencyKey(): string {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function onGenerate(): Promise<void> {
  if (!ctx.value) return
  creating.value = true
  try {
    const input = {
      copyId: ctx.value.copy.id,
      mode: mode.value,
      ...(mode.value === 'avatar'
        ? { avatarId: avatarId.value }
        : { mixcutPackIds: mixPackIds.value, mixcutKeywordGroupIds: mixGroupIds.value, display: mixDisplay.value }),
    }
    const r = await createVideoJob(input, newIdempotencyKey())
    Message.success(`已创建基础视频 v${r.versionNo}${r.replayed ? '（重复请求已合并）' : ''}`)
    await store.trackJob(r.jobId)
    selectedJobId.value = r.jobId
    selectedJob.value = null
    playUrl.value = ''
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

async function onSaveConfig(): Promise<void> {
  if (!ctx.value) return
  try {
    await putVideoCopyConfig(ctx.value.copy.id, {
      mode: mode.value,
      avatarId: avatarId.value,
      mixcutPackIds: mixPackIds.value,
      mixcutKeywordGroupIds: mixGroupIds.value,
      display: mixDisplay.value,
    })
    Message.success('配置已保存')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function selectJob(j: JobSummary): Promise<void> {
  selectedJobId.value = j.id
  playUrl.value = ''
  playCover.value = ''
  if (phaseRunning(j.phase)) {
    await store.trackJob(j.id)
    return
  }
  store.stopPolling()
  selectedJob.value = j
  if (j.phase === 'completed') {
    try {
      const base = await getVideoJobBase(j.id)
      playUrl.value = base.url
      playCover.value = base.coverUrl ?? ''
    } catch (e) {
      Message.error((e as Error).message)
    }
  }
}

// 停留在页面上等到生成完成：自动切到该版本并播放（FR-A8），不必再去版本列表里点一次
watch(
  () => active.value?.phase,
  (phase, prev) => {
    const job = active.value
    if (phase === 'completed' && prev && prev !== 'completed' && job && selectedJobId.value === job.id) {
      void selectJob(job)
    }
  },
)

async function act(action: string): Promise<void> {
  if (!active.value) return
  acting.value = true
  try {
    await postJobAction(active.value.id, action)
    Message.success('操作已提交')
    await store.trackJob(active.value.id)
    await store.refreshContext()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    acting.value = false
  }
}

async function onActionDone(): Promise<void> {
  if (!active.value) return
  await store.trackJob(active.value.id)
  await store.refreshContext()
}

onMounted(async () => {
  await store.loadOptions()
  void loadStatic()
  const q = route.query as { copyId?: string; jobId?: string }
  if (q.jobId) {
    try {
      const detail = await getVideoJob(q.jobId)
      await store.loadContext(detail.copyId)
      restoreConfig()
      selectedJobId.value = detail.id
      await store.trackJob(detail.id)
      void rerunPrecheck()
    } catch (e) {
      Message.error((e as Error).message)
    }
  } else if (q.copyId) {
    await store.loadContext(q.copyId)
    restoreConfig()
    void rerunPrecheck()
  } else {
    pickerVisible.value = true
  }
})

onBeforeUnmount(() => {
  store.stopPolling()
  if (precheckTimer) clearTimeout(precheckTimer)
})
</script>
