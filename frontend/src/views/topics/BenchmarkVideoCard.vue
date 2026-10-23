<template>
  <article ref="cardElement" class="benchmark-card" :class="{ 'is-hot': video.isHot }" :data-format="format" :style="{ '--cover-aspect': previewRatio, gridRowEnd: `span ${rowSpan}` }" data-testid="benchmark-video-card">
    <div v-if="playUrl" class="benchmark-inline-player">
      <video ref="videoElement" :src="playUrl" controls autoplay playsinline :aria-label="title" @loadedmetadata="onMetadata" @error="onPlayError" />
      <button class="benchmark-close-player" :aria-label="`收起播放：${title}`" @click="stopPlayback">收起 ×</button>
    </div>
    <button v-else class="benchmark-preview" :class="`is-${format}`" :aria-label="`播放视频：${title}`" :disabled="playing" @click="startPlayback">
      <img v-if="video.coverUrl && !coverFailed" class="benchmark-preview-image" :src="video.coverUrl" :alt="title" loading="lazy" referrerpolicy="no-referrer" @load="onLoad" @error="coverFailed = true" />
      <span v-else class="benchmark-no-cover"><icon-video-camera :size="26" />{{ coverFailed ? '封面暂不可用' : '暂无封面' }}</span>
      <span class="benchmark-preview-label"><icon-mobile v-if="format === 'portrait'" :size="12" /><icon-desktop v-else :size="12" />{{ formatLabel }}</span>
      <span v-if="video.isHot" class="benchmark-hot-label"><icon-fire :size="12" />爆款</span>
      <span class="benchmark-play" :class="{ 'is-loading': playing }"><span v-if="playing">加载中…</span><icon-play-arrow-fill v-else :size="20" /></span>
      <span v-if="video.duration" class="benchmark-duration">{{ duration }}</span>
    </button>
    <div class="benchmark-card-body">
      <p v-if="playError" role="alert" class="benchmark-extract-error">{{ playError }} 点击封面重试。</p>
      <div class="benchmark-card-byline"><span class="benchmark-platform">抖音</span><span class="benchmark-author" :title="video.authorNickname || video.accountNickname || ''">{{ video.authorNickname || video.accountNickname || '—' }}</span><span v-if="video.authorNickname && video.accountNickname && video.authorNickname !== video.accountNickname" class="benchmark-pinned" :title="`来自${video.accountNickname}的共创作品集`">共创</span><span v-if="video.isTop" class="benchmark-pinned">置顶</span><time>{{ published }}</time></div>
      <button class="benchmark-card-title" :title="video.title || title" @click="$emit('detail', video)">{{ title }}</button>
      <div class="benchmark-topic-tags"><span v-for="tag in tags" :key="tag">{{ tag }}</span><span v-if="!tags.length" class="benchmark-category">{{ video.origin === 'adhoc' ? '直接提取' : '账号作品' }}</span></div>
      <div class="benchmark-card-metrics"><div><span><icon-heart :size="12" />点赞</span><strong>{{ compact(video.diggCount) }}</strong></div><div><span><icon-message :size="12" />评论</span><strong>{{ compact(video.commentCount) }}</strong></div><div><span><icon-send :size="12" />分享</span><strong>{{ compact(video.shareCount) }}</strong></div><div class="benchmark-interaction"><span>互动合计</span><strong>{{ compact(video.interactTotal) }}</strong></div></div>
      <div class="benchmark-performance"><span v-if="lift !== null" :class="{ 'is-highlight': video.isHot }"><icon-arrow-rise v-if="video.isHot" :size="13" />{{ lift.toFixed(1) }}× <small>判定时账号基线</small></span><span v-else>基线待建立</span><span :class="EXTRACT_TAG[video.extractStatus]">{{ EXTRACT_LABEL[video.extractStatus] }}</span></div>
      <p v-if="video.extractError && video.extractStatus === 'failed'" class="benchmark-extract-error">{{ video.extractError }}</p>
      <div class="benchmark-card-actions"><button class="benchmark-analysis" @click="$emit('detail', video)">视频分析<icon-arrow-right :size="13" /></button><a-tooltip :content="extractionReady === false && video.extractStatus !== 'done' ? '配置语音识别服务后可提取口播全文' : '提取视频中的口播全文'"><a-button v-if="video.extractStatus !== 'done'" size="mini" type="text" :loading="EXTRACTING.includes(video.extractStatus)" :disabled="extractionReady === false" @click="$emit('extract', video)"><icon-file :size="13" />{{ EXTRACTING.includes(video.extractStatus) ? '提取中' : '提取文案' }}</a-button><a-button v-else size="mini" type="text" @click="$emit('extract', video)">查看文案</a-button></a-tooltip><a-button v-if="video.extractStatus === 'done'" size="mini" type="primary" @click="$emit('send', video)">送文案工坊</a-button></div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { getVideoPlayback, type BenchVideo } from '@/api/benchmark'
import { EXTRACTING, EXTRACT_LABEL, EXTRACT_TAG } from '@/stores/benchmark'
const props = defineProps<{ video: BenchVideo; extractionReady?: boolean; active?: boolean }>()
const emit = defineEmits<{ detail: [video: BenchVideo]; extract: [video: BenchVideo]; send: [video: BenchVideo]; play: [id: string] }>()
const coverFailed = ref(false), imageWidth = ref(0), imageHeight = ref(0)
const playUrl = ref(''), playError = ref(''), playing = ref(false), nativeRatio = ref(0)
const videoElement = ref<HTMLVideoElement | null>(null)
let playbackRequest = 0
const cardElement = ref<HTMLElement | null>(null)
const rowSpan = ref(120)
let resizeObserver: ResizeObserver | undefined
function measureCard() {
  if (!cardElement.value) return
  // 每格 6px；额外 18px 是卡片的纵向间距。卡片本身仍按内容自然高度显示。
  const next = Math.ceil((cardElement.value.getBoundingClientRect().height + 18) / 6)
  if (next !== rowSpan.value) rowSpan.value = next
}
onMounted(() => { measureCard(); resizeObserver = new ResizeObserver(measureCard); if (cardElement.value) resizeObserver.observe(cardElement.value) })
onBeforeUnmount(() => { stopPlayback(); resizeObserver?.disconnect() })
watch(() => props.active, active => { if (active === false) stopPlayback() })
watch(() => props.video.id, stopPlayback)
watch(() => props.video.coverUrl, () => { coverFailed.value = false; imageWidth.value = 0; imageHeight.value = 0 })
const dimensions = computed(() => props.video.width && props.video.height ? { width: props.video.width, height: props.video.height } : { width: imageWidth.value, height: imageHeight.value })
// 封面比例与视频比例可能不同。卡片完整展示封面，播放时才按视频尺寸调整。
const coverDimensions = computed(() => imageWidth.value && imageHeight.value ? { width: imageWidth.value, height: imageHeight.value } : dimensions.value)
const previewRatio = computed(() => playUrl.value ? nativeRatio.value || (dimensions.value.width && dimensions.value.height ? dimensions.value.width / dimensions.value.height : 16 / 9) : (coverDimensions.value.width || 3) / (coverDimensions.value.height || 4))
async function startPlayback() {
  if (playing.value) return
  emit('play', props.video.id)
  const token = ++playbackRequest
  playing.value = true; playError.value = ''
  try { const result = await getVideoPlayback(props.video.id); if (token === playbackRequest) playUrl.value = result.playUrl }
  catch (e) { if (token === playbackRequest) playError.value = e instanceof Error ? e.message : '获取视频失败。' }
  finally { if (token === playbackRequest) playing.value = false }
}
function stopPlayback() { playbackRequest++; videoElement.value?.pause(); playUrl.value = ''; playing.value = false; nativeRatio.value = 0 }
function onMetadata(e: Event) { const v = e.target as HTMLVideoElement; if (v.videoWidth && v.videoHeight) nativeRatio.value = v.videoWidth / v.videoHeight }
function onPlayError() { stopPlayback(); playError.value = '播放暂不可用。' }
const format = computed(() => { const { width, height } = dimensions.value; return !width || !height ? 'unknown' : width > height * 1.05 ? 'landscape' : height > width * 1.05 ? 'portrait' : 'square' })
const formatLabel = computed(() => ({ landscape: '横屏', portrait: '竖屏', square: '方屏', unknown: '自适应' }[format.value]))
const title = computed(() => (props.video.title || '').split('#')[0].trim() || '无标题视频')
const tags = computed(() => Array.from(new Set((props.video.title || '').match(/#[^\s#]+/g) || [])).filter(t => t.length < 22).slice(0, 2))
const duration = computed(() => { const s = props.video.duration || 0; return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` })
const published = computed(() => props.video.publishedAt ? new Date(props.video.publishedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }) : '日期未知')
const lift = computed(() => { const b = props.video.hotBaseline as { baselineAvg?: number; interact?: number } | null; return b?.baselineAvg ? Number(b.interact || 0) / b.baselineAvg : null })
function compact(n: number) { return n >= 10000 ? `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}万` : new Intl.NumberFormat('zh-CN').format(n || 0) }
function onLoad(e: Event) { const image = e.target as HTMLImageElement; imageWidth.value = image.naturalWidth; imageHeight.value = image.naturalHeight }
</script>

<style scoped>
.benchmark-card { min-width: 0; align-self: start; background: #fff; border: 1px solid #e2e7e3; border-radius: 10px; overflow: hidden; transition: border-color .2s, box-shadow .2s; }
.benchmark-card:hover { border-color: #b7c7bc; box-shadow: 0 6px 22px #233d2e0d; }
.benchmark-card.is-hot { border-color: #e5d4c5; }
.benchmark-card button { font: inherit; cursor: pointer; }
.benchmark-card button:focus-visible { outline: 2px solid #7f9d8b; outline-offset: -3px; }
.benchmark-preview { position: relative; display: grid; place-items: center; aspect-ratio: var(--cover-aspect, 3 / 4); width: 100%; overflow: hidden; border: 0; padding: 0; background: #edf0ed; }
.benchmark-inline-player { position: relative; width: 100%; aspect-ratio: var(--cover-aspect, 16 / 9); background: #132019; }
.benchmark-inline-player video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.benchmark-close-player { position: absolute; top: 9px; right: 9px; z-index: 2; border: 1px solid #ffffff80; border-radius: 4px; background: #13271d99; color: #fff; padding: 3px 7px; font-size: 11px !important; }
.benchmark-preview-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 1; }
.benchmark-preview::after { content: ''; position: absolute; inset: 0; background: linear-gradient(#0002, transparent 30%, transparent 65%, #0004); z-index: 2; pointer-events: none; }
.benchmark-preview-label, .benchmark-hot-label, .benchmark-duration { position: absolute; z-index: 3; display: flex; align-items: center; gap: 4px; font-size: 10px; line-height: 1.5; color: #fff; background: #13271d80; padding: 3px 7px; border-radius: 4px; backdrop-filter: blur(6px); }
.benchmark-preview-label { top: 11px; left: 11px; }
.benchmark-hot-label { top: 11px; right: 11px; background: #fff0e6; color: #a95338; }
.benchmark-duration { right: 10px; bottom: 10px; font-variant-numeric: tabular-nums; }
.benchmark-play { z-index: 4; display: grid; place-items: center; width: 42px; height: 42px; padding-left: 2px; background: #16241d50; border: 1px solid #ffffffb0; border-radius: 50%; color: white; opacity: .8; transition: transform .2s, background .2s; }
.benchmark-play.is-loading { width: auto; min-width: 66px; padding-inline: 10px; border-radius: 20px; font-size: 11px; }
.benchmark-preview:hover .benchmark-play { background: #294e3bdb; transform: scale(1.07); opacity: 1; }
.benchmark-no-cover { display: grid; justify-items: center; gap: 9px; color: #8c9a90; font-size: 11px; }
.benchmark-card-body { padding: 15px 16px 0; }
.benchmark-card-byline { display: flex; align-items: center; gap: 7px; font-size: 11px; color: #8b958e; }
.benchmark-platform { color: #5e6b62; background: #f0f3f0; padding: 1px 5px; border-radius: 3px; font-size: 10px; }
.benchmark-author { max-width: 47%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #687a6c; }
.benchmark-card-byline time { margin-left: auto; }
.benchmark-pinned { color: #9a8c69; font-size: 10px; }
.benchmark-card-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; height: 46px; margin-top: 10px; padding: 0; width: 100%; border: 0; background: transparent; text-align: left; color: #2a352e; font-size: 14px !important; font-weight: 600 !important; line-height: 23px !important; }
.benchmark-card-title:hover { color: #416d52; }
.benchmark-topic-tags { height: 27px; display: flex; gap: 7px; align-items: center; overflow: hidden; margin-top: 3px; font-size: 10px; color: #7d8c80; }
.benchmark-topic-tags > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.benchmark-category { color: #a3aaa5; }
.benchmark-card-metrics { display: grid; grid-template-columns: 1fr 1fr 1fr 1.15fr; gap: 8px; padding: 12px 0 14px; border-bottom: 1px solid #edf0ec; }
.benchmark-card-metrics > div > span { display: flex; align-items: center; gap: 3px; font-size: 10px; color: #929d95; margin-bottom: 6px; }
.benchmark-card-metrics strong { color: #47594c; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.benchmark-interaction { padding-left: 12px; border-left: 1px solid #e7ede7; }
.benchmark-interaction strong { color: #355d43; }
.benchmark-performance { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 0; font-size: 11px; color: #829285; }
.benchmark-performance > span:first-child { display: flex; align-items: center; gap: 4px; }
.benchmark-performance small { font-size: 10px; color: #a0aaa2; }
.benchmark-performance .is-highlight { color: #ad6644; font-weight: 500; }
.benchmark-performance :deep(.mw-tag) { font-size: 9px; padding: 1px 5px; line-height: 1.7; }
.benchmark-card-actions { display: flex; align-items: center; gap: 7px; border-top: 1px solid #edf0ec; padding: 9px 0 10px; }
.benchmark-analysis { border: 0; background: transparent; color: #456d52; padding: 0; margin-right: auto; display: flex; align-items: center; gap: 5px; font-size: 12px !important; font-weight: 500 !important; }
.benchmark-card-actions :deep(.arco-btn-text) { font-size: 11px; padding-inline: 3px; }
.benchmark-card-actions :deep(.arco-btn-disabled) { opacity: .65; }
.benchmark-extract-error { color: #b45d4b; font-size: 11px; line-height: 1.6; }
@media (prefers-reduced-motion: reduce) { .benchmark-card, .benchmark-play { transition: none; } }
</style>
