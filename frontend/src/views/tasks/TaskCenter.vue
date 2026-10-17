<template>
  <div class="p-7 pb-10 max-w-[1500px] mx-auto">
    <PageHead title="任务中心">
      <template #sub>
        <div>
          <div>跟进内容进度，找到下一步</div>
          <div>2026年10月12日 · 星期一 · 北京时间</div>
        </div>
      </template>
      <template #actions>
        <div class="text-right">
          <a-button type="primary"><template #icon><icon-plus /></template>新建任务</a-button>
          <div class="mw-subtle mt-1">创建时选择运营主体</div>
        </div>
      </template>
    </PageHead>

    <div class="flex items-center gap-4 mb-4">
      <a-tabs v-model:active-key="tab" type="line" class="mw-tabs flex-1">
        <a-tab-pane key="all"><template #title>全部任务 <span class="mw-subtle">{{ tasks.length }}</span></template></a-tab-pane>
        <a-tab-pane key="mine"><template #title>我负责的 <span class="mw-subtle">3</span></template></a-tab-pane>
        <a-tab-pane key="todo"><template #title>需处理 <span class="mw-subtle">2</span></template></a-tab-pane>
      </a-tabs>
    </div>
    <div class="flex items-center gap-2.5 mb-4 -mt-2">
      <a-select :style="{ width: '130px' }" default-value="全部阶段" />
      <a-select :style="{ width: '130px' }" default-value="全部状态" />
      <a-select :style="{ width: '150px' }" default-value="全部运营主体" />
      <a-input-search :style="{ width: '260px' }" placeholder="搜索任务标题、任务号、负责人..." allow-clear />
    </div>

    <div class="grid grid-cols-[1fr_380px] gap-5 items-start">
      <!-- ============ 任务列表 ============ -->
      <div class="mw-card overflow-hidden">
        <div class="grid grid-cols-[30fr_16fr_10fr_22fr_12fr] text-[12px] mw-thead px-5 py-2.5 border-b border-[var(--mw-border)]">
          <span>内容</span><span>运营主体</span><span>负责人</span><span>阶段与状态</span><span>下一步</span>
        </div>
        <div
          v-for="t in filteredTasks"
          :key="t.id"
          class="grid grid-cols-[30fr_16fr_10fr_22fr_12fr] items-center px-5 py-3 border-b border-[#f2f4f7] cursor-pointer transition-colors"
          :class="currentId === t.id ? 'bg-[color:var(--mw-primary-faint)]' : 'hover:bg-[#fafbfc]'"
          @click="currentId = t.id"
        >
          <div class="flex items-center gap-3 min-w-0">
            <ThumbBox :seed="t.id" :width="52" :height="40" />
            <div class="min-w-0">
              <div class="text-[14px] font-medium truncate">{{ t.title }}</div>
              <div class="mw-subtle">任务 {{ t.no }} · {{ t.target }}</div>
            </div>
          </div>
          <div>
            <div class="text-[13px]">{{ t.subject }}</div>
            <LineTag :line="t.line" class="mt-0.5" />
          </div>
          <div class="text-[13px]">{{ t.owner }}</div>
          <div>
            <div class="flex items-center gap-2 text-[13px] font-medium">
              <span class="mw-dot" :style="{ background: t.dot }"></span>{{ t.stage }}
            </div>
            <div class="text-[12px] mt-0.5" :style="t.statusCls || 'color:var(--mw-text3)'">{{ t.status }}</div>
            <a-progress v-if="t.progress" :percent="t.progress / 100" size="mini" :show-text="false" class="mt-1 !w-32" />
          </div>
          <span class="mw-link flex items-center" @click.stop="doNext(t)">{{ t.next }} <icon-right :size="12" class="ml-0.5" /></span>
        </div>
      </div>

      <!-- ============ 任务详情 ============ -->
      <div class="mw-card p-5" v-if="current">
        <div class="flex items-start justify-between">
          <div class="text-[16px] font-semibold">任务详情</div>
          <span class="mw-subtle">{{ current.id }}</span>
        </div>
        <div class="flex gap-3 mt-3">
          <ThumbBox :seed="current.id" :width="56" :height="56" />
          <div>
            <div class="text-[15px] font-semibold">{{ current.title }}</div>
            <div class="mw-subtle mt-0.5">{{ current.subject }} · {{ lineName(current.line) }}</div>
            <div class="mw-subtle">任务 {{ current.no }} · {{ current.target }}</div>
          </div>
        </div>
        <div class="mt-3 p-3 rounded-[10px] border border-[var(--mw-border)] flex items-center gap-2 cursor-pointer hover:border-[color:var(--mw-primary-soft)]">
          <icon-file :size="16" class="text-[color:var(--mw-primary)]" />
          <span class="text-[13px]">关联作品</span>
          <span class="mw-tag mw-tag-gray">W-1024</span>
          <div class="flex-1"></div>
          <icon-right :size="13" class="text-[var(--mw-text3)]" />
        </div>

        <div class="mt-4 text-[14px] font-semibold mb-3">进度流程</div>
        <div class="mw-timeline-item" v-for="(s, i) in flow" :key="i">
          <div class="mw-timeline-dot" :style="{ background: s.done ? '#1d4ed8' : '#7c5cd6' }">
            <icon-check :size="10" style="color: #fff" v-if="s.done" />
            <icon-edit :size="9" style="color: #fff" v-else />
          </div>
          <div class="text-[13.5px] font-medium" :style="s.done ? '' : 'color:#7c5cd6'">{{ s.title }}</div>
          <div class="text-[12px] text-[var(--mw-text3)] mt-0.5">{{ s.desc }}</div>
          <div class="text-[11.5px] text-[var(--mw-text3)] mt-0.5">{{ s.time }}</div>
        </div>

        <div class="mt-2 text-[14px] font-semibold mb-2">关联内容</div>
        <div class="flex items-center gap-1.5 flex-wrap">
          <template v-for="(c, i) in chips" :key="c.t">
            <span v-if="i > 0"><icon-right :size="12" class="text-[var(--mw-text3)]" /></span>
            <span class="p-2 rounded-[8px] border text-center" :class="c.cur ? 'border-[#7c5cd6] bg-[#f6f2fd]' : 'border-[var(--mw-border)]'">
              <div class="text-[12px] font-medium" :style="c.cur ? 'color:#7c5cd6' : ''">{{ c.t }}</div>
              <div class="text-[10.5px] text-[var(--mw-text3)]">{{ c.s }}</div>
            </span>
          </template>
        </div>

        <a-button type="primary" long class="mt-4" @click="doNext(current)">继续剪辑</a-button>
        <div class="mw-subtle flex items-center gap-1 mt-2"><icon-info-circle :size="12" />继续剪辑沿用基础视频，不重复渲染。</div>
      </div>
    </div>

    <div class="mt-4 flex items-center gap-6">
      <span class="mw-subtle flex items-center gap-1"><icon-info-circle :size="13" />保存失败仅重试下载，避免重复生成计费。</span>
      <span class="mw-subtle flex items-center gap-1"><icon-info-circle :size="13" />状态不明先查询原任务，不直接重新提交。</span>
      <span class="mw-subtle flex items-center gap-1"><icon-info-circle :size="13" />素材混剪已一期启用，与口播共用任务流程。</span>
    </div>
    <div class="mw-corner-note">原型预览 · 演示数据</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import LineTag from '@/components/LineTag.vue'
import ThumbBox from '@/components/ThumbBox.vue'
import { lineNames, tasks } from '@/mocks/data'

const router = useRouter()
const tab = ref('all')
const currentId = ref('T-1024')

const filteredTasks = computed(() => {
  if (tab.value === 'mine') return tasks.filter((t) => ['陈悦'].includes(t.owner))
  if (tab.value === 'todo') return tasks.filter((t) => ['待人工审核', '保存失败'].some((s) => t.status.includes(s)))
  return tasks
})
const current = computed(() => tasks.find((t) => t.id === currentId.value))
const lineName = (l: string) => lineNames[l as keyof typeof lineNames] ?? l

const flow = [
  { title: '选题生成', desc: '已完成', time: '10月12日 09:12', done: true },
  { title: '稿件 v3', desc: '人工审核通过', time: '10月12日 10:03', done: true },
  { title: '基础视频 v1', desc: '已生成', time: '10月12日 11:26', done: true },
  { title: '剪辑 v2', desc: '草稿，待继续剪辑', time: '10月12日 14:20', done: false },
]
const chips = [
  { t: '稿件 v3', s: '已通过', cur: false },
  { t: '基础视频 v1', s: '已生成', cur: false },
  { t: '剪辑 v2', s: '草稿中', cur: true },
]

function doNext(t: { next: string; stage: string }) {
  if (t.stage === '剪辑合成') router.push('/video/edit')
  else if (t.stage === '文案生成') router.push('/review')
  else if (t.stage === '选题生成') router.push('/topics')
  else Message.info(`${t.next}（演示）`)
}
</script>
