<template>
  <section class="source-workbench" aria-label="来源材料">
    <SourceIntake @created="(ids) => emit('created', ids)" @source-mode="(mode) => emit('source-mode', mode)">
      <a-spin :loading="loading" class="w-full">
        <div class="source-overview" :class="{ 'has-cover': material?.videoId }">
          <button
            v-if="material?.videoId"
            class="source-cover"
            aria-label="回看原视频并核对素材"
            @click="openReview(true)"
          >
            <img v-if="material.coverUrl" :src="material.coverUrl" alt="原视频封面" /><span>▶ 回看原视频</span>
          </button>
          <div class="source-description">
            <div class="source-title">
              <span class="mw-tag mw-tag-gray">{{ store.copy?.sourceLabel }}</span>
            </div>
            <h3>{{ material?.title || store.copy?.title }}</h3>
            <div v-if="material?.author" class="mw-subtle mb-3">
              {{ material.author }}<template v-if="material.duration"> · {{ material.duration }} 秒</template>
            </div>
            <div class="source-note">请核对名称、数字和引用，生成时将使用校对稿。</div>
            <a-button :disabled="!material" @click="openReview(false)">回看与校对</a-button>
          </div>
        </div>
        <div v-if="error" role="alert" class="source-error">
          {{ error }} <a-link @click="loadMaterial">重试</a-link>
        </div>
        <div v-if="savedReview?.note" class="source-note">校对备注：{{ savedReview.note }}</div>
        <details class="source-text">
          <summary>{{ savedReview ? '查看校对稿' : '查看原始文案' }}</summary>
          <p>
            {{ savedReview?.correctedText || material?.text || store.detail?.sourceSummary?.text || '暂无来源正文' }}
          </p>
        </details>
        <a v-if="sourceLink" :href="sourceLink" target="_blank" rel="noopener noreferrer" class="source-origin"
          >查看来源网页 ↗</a
        >
        <p v-if="store.copy?.status === 'in_review'" class="source-note">审核中素材已锁定；撤回后可继续校对。</p>
      </a-spin>
    </SourceIntake>
    <a-modal
      :visible="reviewOpen"
      title="素材回看与校对"
      :width="1060"
      class="source-review-modal"
      @cancel="closeReview"
    >
      <template #footer
        ><span class="review-save-hint" role="status">{{
          savedReview ? '已保存校对记录，生成将使用校对文本' : '校对不会覆盖原始提取文本'
        }}</span
        ><a-button @click="closeReview">返回编辑</a-button
        ><a-button
          type="primary"
          :loading="saving"
          :disabled="!store.canEdit || !correctedText.trim()"
          @click="saveReview"
          >保存校对稿</a-button
        ></template
      >
      <div class="source-review-grid">
        <div class="source-reference">
          <video
            v-if="playUrl"
            ref="player"
            :src="playUrl"
            controls
            playsinline
            preload="metadata"
            @loadedmetadata="applySeek"
            @error="playError = '视频暂时无法播放，请重试或查看来源网页'"
          />
          <a-button v-if="material?.videoId" long :loading="playLoading" @click="playAt(0)">{{
            playUrl ? '从头回看' : '加载并播放原视频'
          }}</a-button>
          <p v-if="playError" class="source-error" role="alert">{{ playError }}</p>
          <div class="source-reference-title">
            原始文案 <span v-if="material?.sentences?.length" class="mw-subtle">点击时间回看片段</span>
          </div>
          <div class="transcript-list">
            <template v-if="material?.sentences?.length"
              ><div v-for="(s, i) in material.sentences" :key="i" class="transcript-row">
                <button
                  :disabled="!material.videoId"
                  :aria-label="`播放 ${time(s.startTime)} 的片段`"
                  @click="playAt(s.startTime / 1000)"
                >
                  {{ time(s.startTime) }}
                </button>
                <p>{{ s.text }}</p>
              </div></template
            >
            <p v-else class="raw-transcript">{{ material?.text }}</p>
          </div>
        </div>
        <div class="source-correction">
          <label for="corrected-source"
            ><strong>校对稿</strong><span class="mw-subtle">修正专名、数字和听写错误</span></label
          ><a-textarea
            id="corrected-source"
            v-model="correctedText"
            aria-label="素材校对稿"
            :max-length="30000"
            :disabled="!store.canEdit"
            :auto-size="{ minRows: 12, maxRows: 20 }"
          /><label for="source-review-note">校对备注 / 事实出处</label
          ><a-textarea
            id="source-review-note"
            v-model="note"
            aria-label="校对备注"
            :max-length="1000"
            placeholder="记录修改了什么；需要保留的事实或引用来源"
            :disabled="!store.canEdit"
            :auto-size="{ minRows: 2, maxRows: 4 }"
          /><a-checkbox v-model="confirmed" :disabled="!store.canEdit">我已人工核对素材中的专名、数字和引用</a-checkbox>
          <p class="source-note">此确认仅针对素材，不代表新生成稿已经通过人工审核。</p>
        </div>
      </div>
    </a-modal>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { useCopyStore } from '@/stores/copy'
import { copyApi, type SourceMaterial, type SourceReview } from '@/api/copy'
import { getVideoPlayback } from '@/api/benchmark'
import SourceIntake from './SourceIntake.vue'
const emit = defineEmits<{ (e: 'created', ids: string[]): void; (e: 'source-mode', mode: string): void }>()
const store = useCopyStore()
const material = ref<SourceMaterial | null>(null),
  loading = ref(false),
  error = ref(''),
  reviewOpen = ref(false),
  saving = ref(false)
const correctedText = ref(''),
  note = ref(''),
  confirmed = ref(false),
  playUrl = ref(''),
  playLoading = ref(false),
  playError = ref(''),
  player = ref<HTMLVideoElement | null>(null)
let seekTo = 0,
  loadSeq = 0,
  reviewBaseline = ''
function reviewFingerprint() {
  return JSON.stringify([correctedText.value, note.value, confirmed.value])
}
function closeReview() {
  if (reviewFingerprint() !== reviewBaseline && store.canEdit) {
    Modal.confirm({
      title: '校对改动尚未保存',
      content: '保存后可用于后续生成，也可以留在这里继续校对。',
      okText: '保存并返回',
      cancelText: '继续校对',
      onOk: async () => {
        if (await saveReview()) reviewOpen.value = false
      },
    })
  } else reviewOpen.value = false
}
const savedReview = computed(() => store.copy?.settings?.sourceReview as SourceReview | undefined)
const sourceLink = computed(() => {
  const value = material.value?.shareUrl || material.value?.contentUrl
  return value && /^https?:\/\//i.test(value) ? value : ''
})
async function loadMaterial() {
  const id = store.copy?.id
  if (!id) return
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const r = await copyApi.source(id)
    if (seq === loadSeq) material.value = r
  } catch (e) {
    if (seq === loadSeq) error.value = (e as Error).message
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}
watch(
  () => store.copy?.id,
  () => {
    material.value = null
    playUrl.value = ''
    reviewOpen.value = false
    void loadMaterial()
  },
  { immediate: true },
)
watch(correctedText, () => {
  confirmed.value = false
})
function time(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
async function openReview(play: boolean) {
  correctedText.value = savedReview.value?.correctedText || material.value?.text || ''
  note.value = savedReview.value?.note || ''
  await nextTick()
  confirmed.value = savedReview.value?.confirmed ?? false
  reviewBaseline = reviewFingerprint()
  reviewOpen.value = true
  if (play) await playAt(0)
}
async function applySeek() {
  if (!player.value || !reviewOpen.value) return
  player.value.currentTime = seekTo
  try {
    await player.value.play()
  } catch {
    if (reviewOpen.value && player.value?.paused) playError.value = '请点击视频上的播放按钮继续'
  }
}
async function playAt(seconds: number) {
  if (!material.value?.videoId) return
  seekTo = seconds
  playError.value = ''
  if (!playUrl.value) {
    playLoading.value = true
    try {
      const r = await getVideoPlayback(material.value.videoId)
      playUrl.value = r.playUrl
      await nextTick()
    } catch (e) {
      playError.value = (e as Error).message
    } finally {
      playLoading.value = false
    }
  } else await applySeek()
}
watch(reviewOpen, (v) => {
  if (!v) player.value?.pause()
})
async function saveReview() {
  if (!store.copy) return false
  saving.value = true
  try {
    const r = await copyApi.saveSourceReview(store.copy.id, {
      correctedText: correctedText.value,
      note: note.value,
      confirmed: confirmed.value,
    })
    if (store.copy) store.copy.settings = { ...store.copy.settings, sourceReview: r.sourceReview }
    reviewBaseline = reviewFingerprint()
    Message.success('校对稿已保存；后续生成使用此文本')
    return true
  } catch (e) {
    Message.error((e as Error).message)
    return false
  } finally {
    saving.value = false
  }
}
</script>
<style scoped>
.source-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.review-state {
  font-size: 11px;
  color: #9a6b1f;
}
.review-state.confirmed {
  color: #247354;
}
.source-workbench h3 {
  font-size: 14px;
  line-height: 1.8;
  margin: 12px 0 6px;
}
.source-cover {
  position: relative;
  width: 100%;
  border: 0;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  background: #edf2ef;
  display: flex;
  justify-content: center;
  max-height: 230px;
}
.source-cover img {
  width: 100%;
  height: auto;
  object-fit: cover;
  display: block;
}
.source-cover span {
  position: absolute;
  inset: auto 0 0;
  background: linear-gradient(transparent, #000b);
  padding: 25px 12px 14px;
  color: white;
  font-size: 13px;
}
.source-note {
  font-size: 12px;
  line-height: 1.8;
  color: #738078;
  margin: 12px 0;
}
.source-text {
  margin-top: 20px;
}
.source-text summary {
  font-size: 12px;
  color: #52645a;
  font-weight: 600;
  cursor: pointer;
}
.source-text p,
.raw-transcript {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.95;
  color: #4a5c51;
}
.source-origin {
  font-size: 12px;
  color: var(--mw-primary);
}
.source-error {
  font-size: 12px;
  color: #b45427;
  line-height: 1.8;
  margin: 10px 0;
}
.source-review-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  gap: 24px;
}
.source-reference video {
  display: block;
  width: 100%;
  max-height: 250px;
  border-radius: 8px;
  object-fit: contain;
  background: #f3f5f3;
  margin-bottom: 10px;
}
.source-reference-title {
  margin-top: 18px;
  font-size: 13px;
  font-weight: 600;
}
.source-reference-title span {
  font-weight: 400;
  margin-left: 6px;
}
.transcript-list {
  max-height: 370px;
  overflow: auto;
  margin-top: 12px;
  overscroll-behavior: contain;
}
.transcript-row {
  display: flex;
  gap: 12px;
  border-top: 1px solid #eef1ee;
  padding: 12px 4px;
  align-items: baseline;
}
.transcript-row button {
  border: 0;
  border-radius: 4px;
  background: #edf3ef;
  color: #37715a;
  padding: 3px 7px;
  cursor: pointer;
  font-size: 12px;
  flex-shrink: 0;
}
.transcript-row p {
  font-size: 13px;
  line-height: 1.9;
  margin: 0;
}
.source-correction > label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 13px;
}
.source-correction > label:not(:first-child) {
  margin-top: 16px;
}
.source-correction :deep(.arco-checkbox) {
  margin-top: 16px;
  align-items: flex-start;
}
.review-save-hint {
  margin-right: auto;
  font-size: 12px;
  color: #7b8780;
}
@media (max-width: 750px) {
  .source-review-grid {
    grid-template-columns: 1fr;
  }
  .review-save-hint {
    display: none;
  }
}
</style>
<style scoped>
.source-overview.has-cover {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
.source-description {
  min-width: 0;
}
.source-overview .source-cover {
  max-height: none;
}
.source-overview .source-cover img {
  width: 100%;
  height: auto;
}
.source-text {
  padding-top: 16px;
  border-top: 1px solid var(--mw-border-light);
  margin-bottom: 12px;
}
@media (max-width: 600px) {
  .source-overview.has-cover {
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }
  .source-overview .source-cover {
    max-width: 140px;
  }
}
.source-reference {
  position: sticky;
  top: 0;
  align-self: start;
}
.source-reference video {
  width: auto;
  max-width: 100%;
  height: auto;
  max-height: 220px;
  margin: 0 auto 10px;
}
.transcript-list {
  max-height: clamp(180px, calc(100dvh - 480px), 340px);
}
.source-correction {
  max-height: calc(100dvh - 220px);
  overflow: auto;
  padding-right: 6px;
}
@media (max-width: 750px) {
  .source-reference {
    position: static;
  }
  .source-correction {
    max-height: none;
    overflow: visible;
  }
}
</style>
