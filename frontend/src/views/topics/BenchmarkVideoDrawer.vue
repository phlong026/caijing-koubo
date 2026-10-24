<template>
  <a-drawer :visible="!!video" :width="740" title="视频详情与选题依据" :footer="false" @cancel="$emit('close')">
    <template v-if="video">
      <div class="research-player" :class="{ 'is-portrait': isPortrait }" :style="{ '--player-ratio': playerRatio }">
        <video
          v-if="playUrl"
          :key="video.id"
          :src="playUrl"
          controls
          autoplay
          playsinline
          @loadedmetadata="onMetadata"
          @error="playError = '播放地址暂不可用，请打开原视频查看。'"
        /><template v-else
          ><img
            v-if="video.coverUrl"
            :src="video.coverUrl"
            alt="视频封面"
            referrerpolicy="no-referrer"
            @load="onCoverLoad"
          /><a-button type="primary" :loading="playing" @click="play"
            ><template #icon><icon-play-arrow /></template>播放原视频</a-button
          ></template
        >
      </div>
      <p v-if="playError" role="alert" class="research-error">{{ playError }}</p>
      <div class="research-video-heading">
        <h2>{{ video.title }}</h2>
        <a :href="originalUrl" target="_blank" rel="noreferrer">抖音原视频 ↗</a>
      </div>
      <p class="mw-subtle">
        {{ video.authorNickname || video.accountNickname }} · {{ date(video.publishedAt) }} · 时长 {{ duration }}
      </p>
      <div class="research-detail-metrics">
        <div>
          <span>点赞</span><strong>{{ number(video.diggCount) }}</strong>
        </div>
        <div>
          <span>评论</span><strong>{{ number(video.commentCount) }}</strong>
        </div>
        <div>
          <span>分享</span><strong>{{ number(video.shareCount) }}</strong>
        </div>
        <div>
          <span>互动合计</span><strong>{{ number(video.interactTotal) }}</strong>
        </div>
      </div>
      <h3 class="research-section-title">
        爆款判定依据 <a-tag v-if="video.isHot" color="red" size="small">已判为爆款</a-tag>
      </h3>
      <div v-if="baseline" class="research-baseline">
        <div>
          <span>基线样本</span><b>{{ baseline.sample }} 条</b>
        </div>
        <div>
          <span>同账号互动均值</span><b>{{ number(Number(baseline.baselineAvg)) }}</b>
        </div>
        <div>
          <span>判定阈值 · ×{{ baseline.multiplier }}</span
          ><b>{{ number(Number(baseline.threshold)) }}</b>
        </div>
        <div>
          <span>判定时本条互动</span><b>{{ number(Number(baseline.interact)) }}</b>
        </div>
        <p>
          判定时间：{{ date(String(baseline.judgedAt)) }}。{{
            video.isHot ? '爆款标记保留，以上为首次命中快照。' : '未超过阈值，保留在普通作品中。'
          }}
        </p>
      </div>
      <p v-else class="research-notice">
        暂无有效判定快照。直接提取的视频不参与判定；监控视频至少需要
        {{ overview?.methodology.minSample || 5 }} 条其他作品作为基线。
      </p>
      <h3 class="research-section-title">选题拆解起点 <small>基于标题的线索</small></h3>
      <div class="research-angle">
        <strong>{{ angle }}</strong>
        <p>
          先确认原视频的核心问题、开场承诺、事实依据和结尾行动，再用目标人物的经验与当前材料重新组织。保留表达结构，为自己的选题补充新的事实和观点。
        </p>
      </div>
      <div class="research-next-actions">
        <a-button
          :disabled="overview?.extractionReady === false && video.extractStatus !== 'done'"
          @click="$emit('extract', video)"
          >{{ video.extractStatus === 'done' ? '查看已提取文案' : '提取口播全文' }}</a-button
        ><a-button type="primary" :disabled="video.extractStatus !== 'done'" @click="$emit('send', video)"
          >送入文案工坊<icon-right
        /></a-button>
      </div>
      <p v-if="overview?.extractionReady === false && video.extractStatus !== 'done'" class="mw-subtle mt-3">
        真实转写还需要服务端 ASR 与音频中转配置；视频标题不会被当作已提取文案。
      </p>
      <p class="research-source-note">
        数据来源 TikHub / 抖音 · 视频 ID {{ video.videoId }}<br />最近同步
        {{ date(video.statsUpdatedAt || video.fetchedAt || null) }} · 播放量未提供时不展示推算值。
      </p>
    </template>
  </a-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getVideoPlayback, type BenchVideo, type ResearchOverview } from '@/api/benchmark'
const props = defineProps<{ video: BenchVideo | null; overview: ResearchOverview | null }>()
defineEmits<{ close: []; extract: [video: BenchVideo]; send: [video: BenchVideo] }>()
const playUrl = ref(''),
  playError = ref(''),
  playing = ref(false)
const nativeRatio = ref(0),
  coverRatio = ref(0)
const videoRatio = computed(
  () =>
    nativeRatio.value || (props.video?.width && props.video?.height ? props.video.width / props.video.height : 16 / 9),
)
const playerRatio = computed(() => (playUrl.value ? videoRatio.value : coverRatio.value || videoRatio.value))
const isPortrait = computed(() => playerRatio.value < 1)
function onCoverLoad(e: Event) {
  const image = e.target as HTMLImageElement
  if (image.naturalWidth && image.naturalHeight) coverRatio.value = image.naturalWidth / image.naturalHeight
}
function onMetadata(e: Event) {
  const v = e.target as HTMLVideoElement
  if (v.videoWidth && v.videoHeight) nativeRatio.value = v.videoWidth / v.videoHeight
}
let request = 0
watch(
  () => props.video?.id,
  () => {
    request++
    playUrl.value = ''
    playError.value = ''
    playing.value = false
    coverRatio.value = 0
    nativeRatio.value = 0
  },
)
const baseline = computed(() => props.video?.hotBaseline as Record<string, number | string> | null)
const originalUrl = computed(() => `https://www.douyin.com/video/${encodeURIComponent(props.video?.videoId || '')}`)
const duration = computed(() => {
  const s = props.video?.duration || 0
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
const angle = computed(() =>
  /[？?]|为什么|如何|怎么/.test(props.video?.title || '')
    ? '提问切入：这个问题为什么值得观众继续看？'
    : /风险|危机|陷阱|误区/.test(props.video?.title || '')
      ? '认知纠偏：哪些常见判断需要补充前提？'
      : '机制解读：从一个具体事件解释背后的运行逻辑。',
)
const number = (n: number) => new Intl.NumberFormat('zh-CN').format(n || 0)
const date = (s: string | null) =>
  s
    ? new Date(/[zZ]|[+]\d\d:/.test(s) ? s : s.replace(' ', 'T') + 'Z').toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '—'
async function play() {
  if (!props.video || playing.value) return
  const token = ++request,
    id = props.video.id
  playing.value = true
  playError.value = ''
  try {
    const result = await getVideoPlayback(id)
    if (token === request) playUrl.value = result.playUrl
  } catch (e) {
    if (token === request) playError.value = e instanceof Error ? e.message : '获取视频失败'
  } finally {
    if (token === request) playing.value = false
  }
}
</script>
