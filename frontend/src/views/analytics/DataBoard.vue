<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="数据看板">
      <template #sub>从内容表现，找到下一轮选题线索</template>
      <template #actions>
        <a-button type="primary">查看选题建议</a-button>
      </template>
    </PageHead>

    <a-tabs v-model:active-key="tab" type="line" class="mw-tabs">
      <a-tab-pane key="effect" title="效果看板" />
      <a-tab-pane key="feature" title="特征沉淀" />
      <a-tab-pane key="topic" title="选题反馈" />
    </a-tabs>

    <!-- ============ 效果看板 ============ -->
    <div v-if="tab === 'effect'">
      <!-- 筛选行 -->
      <div class="flex items-center gap-2.5 mb-4 -mt-1">
        <a-select :style="{ width: '100px' }" default-value="近7天" />
        <a-select :style="{ width: '120px' }" default-value="全部生产线" />
        <a-select :style="{ width: '110px' }" default-value="全部平台" />
        <div class="flex-1"></div>
        <span class="mw-subtle whitespace-nowrap">2026.10.06 – 10.12 · 北京时间</span>
        <span class="mw-subtle whitespace-nowrap">最近回步：10月12日 09:30（演示）</span>
        <span class="mw-subtle whitespace-nowrap flex items-center gap-1"><icon-info-circle :size="13" />平台回采能力待验证</span>
      </div>

      <!-- 指标卡 -->
      <div class="grid grid-cols-3 gap-5 mb-5">
        <div v-for="m in metrics" :key="m.name" class="mw-card p-5 flex items-center justify-between transition-shadow hover:shadow-[var(--mw-shadow-md)]">
          <div>
            <div class="mw-subtle">{{ m.name }}<span class="ml-0.5">（演示）</span></div>
            <div class="text-[32px] font-bold leading-[1.2] mt-1.5 tracking-tight">{{ m.value }}</div>
          </div>
          <div class="w-11 h-11 rounded-full flex items-center justify-center" :style="{ background: m.bg, color: m.color }">
            <component :is="m.icon" :size="19" />
          </div>
        </div>
      </div>
      <div class="mw-subtle -mt-3 mb-4">统计来自示例发布记录；生产任务量不等于成功发布量。</div>

      <!-- 趋势 + 生产线表现 -->
      <div class="grid grid-cols-[1.9fr_1fr] gap-5 mb-5">
        <div class="mw-card p-5">
          <div class="flex items-center gap-4">
            <div class="text-[15px] font-semibold">播放趋势指数 <span class="mw-subtle font-normal">（演示）</span></div>
            <div class="flex items-center gap-3 ml-auto">
              <span v-for="s in trend.series" :key="s.name" class="flex items-center gap-1.5 text-[12px] text-[var(--mw-text2)]">
                <span class="mw-dot" :style="{ background: s.color }"></span>{{ s.name }}
              </span>
            </div>
          </div>
          <div class="mw-subtle mt-0.5">各线分别标准化，展示变化趋势</div>
          <svg viewBox="0 0 620 190" class="w-full mt-2">
            <defs>
              <linearGradient id="mwAreaMain" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#1d4ed8" stop-opacity="0.13" />
                <stop offset="100%" stop-color="#1d4ed8" stop-opacity="0" />
              </linearGradient>
            </defs>
            <g v-for="(y, i) in [0, 33, 66, 100]" :key="i">
              <text x="18" :y="164 - y * 1.5 + 4" font-size="10" fill="#a5aebc">{{ y }}</text>
              <line x1="34" :y1="164 - y * 1.5" x2="600" :y2="164 - y * 1.5" stroke="#eef1f5" stroke-dasharray="3 4" />
            </g>
            <path :d="areaPath(trend.series[0])" fill="url(#mwAreaMain)" />
            <template v-for="s in trend.series" :key="s.name">
              <path :d="linePath(s.values)" fill="none" :stroke="s.color" stroke-width="2" stroke-linecap="round" />
              <circle
                v-for="(v, i) in s.values" :key="i"
                :cx="64 + i * 86" :cy="164 - v * 1.5" r="3" fill="#fff" :stroke="s.color" stroke-width="2"
              />
            </template>
            <text v-for="(d, i) in trend.days" :key="d" :x="64 + i * 86" y="184" font-size="10" fill="#a5aebc" text-anchor="middle">{{ d }}</text>
          </svg>
        </div>
        <div class="mw-card p-5">
          <div class="text-[15px] font-semibold">各生产线表现 <span class="mw-subtle font-normal">（演示）</span></div>
          <div class="mt-4 flex flex-col gap-4">
            <div v-for="s in linePerf" :key="s.name" class="flex items-center gap-3">
              <span class="w-9 h-9 rounded-full flex items-center justify-center" :style="{ background: s.bg }">
                <span class="w-4 h-4 rounded-full" :style="{ background: s.color }"></span>
              </span>
              <span class="text-[14px] font-medium w-16">{{ s.name }}</span>
              <span class="text-[15px] font-bold">{{ s.count }} 条</span>
              <div class="flex-1"></div>
              <span class="mw-subtle">单条均播</span>
              <span class="text-[17px] font-bold ml-1">{{ s.avg }}</span>
            </div>
          </div>
          <div class="mt-4 pt-3 border-t border-[#f2f4f7] mw-subtle">跨线对比需考虑账号基数与平台差异。</div>
        </div>
      </div>

      <!-- 内容表现 + 选题建议 -->
      <div class="grid grid-cols-[1.9fr_1fr] gap-5">
        <div class="mw-card p-5">
          <div class="flex items-center justify-between mb-3">
            <div class="text-[15px] font-semibold">内容表现</div>
            <span class="mw-tag mw-tag-blue">T+1 / T+7 独立快照</span>
          </div>
          <div class="grid grid-cols-[3fr_1fr_1.2fr_1fr_1fr_1fr] text-[12px] text-[var(--mw-text3)] pb-2 border-b border-[var(--mw-border)]">
            <span>内容</span><span>平台</span><span>回采节点</span><span>播放</span><span>互动</span><span>完播率</span>
          </div>
          <div v-for="r in contentPerf" :key="r.id" class="grid grid-cols-[3fr_1fr_1.2fr_1fr_1fr_1fr] items-center py-2.5 border-b border-[#f2f4f7] last:border-none">
            <div class="flex items-center gap-2.5 min-w-0">
              <ThumbBox :seed="r.id" :width="44" :height="32" />
              <div class="min-w-0">
                <div class="text-[13px] font-medium truncate flex items-center gap-1.5">
                  {{ r.title }} <span v-if="r.hot" class="mw-tag mw-tag-yellow !text-[10px] !px-1.5">爆款</span>
                </div>
                <div class="mw-subtle truncate">{{ r.subject }}</div>
              </div>
            </div>
            <span class="text-[13px]">{{ r.platform }}</span>
            <span class="text-[13px]">{{ r.node }}</span>
            <span class="text-[13.5px] font-semibold">{{ r.play }}</span>
            <span class="text-[13px]">{{ r.interact }}</span>
            <span class="text-[13px] text-[var(--mw-text3)]">{{ r.finish }}</span>
          </div>
          <div class="mt-3 flex items-center justify-between">
            <span class="mw-subtle">— 表示尚未取得或待验证，不按 0 计入。</span>
            <span class="mw-subtle">样例爆款口径：播放高于账号历史均值 3 倍。</span>
          </div>
        </div>

        <div class="mw-card p-5">
          <div class="text-[15px] font-semibold mb-3">待确认的选题建议 <span class="text-[color:var(--mw-primary)]">2</span></div>
          <div class="p-4 rounded-[10px] border border-[color:var(--mw-primary-soft)] bg-[color:var(--mw-primary-faint)]">
            <div class="flex items-center gap-2 text-[12.5px] font-medium text-[color:var(--mw-primary)]">
              <icon-bar-chart :size="14" />问题式开场在本组样例中互动较高
            </div>
            <div class="mt-2 flex items-center gap-2">
              <span class="text-[14px] font-semibold flex-1 leading-5">定期回顾投资目标时，应关注什么?</span>
              <span class="mw-tag mw-tag-yellow flex-shrink-0">待运营确认</span>
            </div>
            <div class="mw-link mt-2 flex items-center">查看依据 <icon-right :size="12" /></div>
          </div>
          <div class="mt-4 flex items-center justify-center gap-2 text-[12px] text-[var(--mw-text2)]">
            <span class="px-2.5 py-1 rounded-full bg-[#f2f3f5]">数据观察</span>
            <icon-right :size="12" class="text-[var(--mw-text3)]" />
            <span class="px-2.5 py-1 rounded-full bg-[#f2f3f5]">人工确认</span>
            <icon-right :size="12" class="text-[var(--mw-text3)]" />
            <span class="px-2.5 py-1 rounded-full bg-[#f2f3f5]">选题候选</span>
          </div>
          <div class="mt-4 pt-3 border-t border-[#f2f4f7] mw-subtle flex items-center gap-1"><icon-info-circle :size="12" />相关性观察，不代表因果结论。</div>
        </div>
      </div>
    </div>

    <!-- ============ 特征沉淀 ============ -->
    <div v-else-if="tab === 'feature'" class="mw-card p-5">
      <div class="text-[15px] font-semibold mb-3">爆款特征沉淀 <span class="mw-subtle font-normal">（演示）· 系统自动归因，待运营确认后作为生成偏好</span></div>
      <div class="grid grid-cols-[3fr_1.2fr_1.2fr_1fr] text-[12px] text-[var(--mw-text3)] pb-2 border-b border-[var(--mw-border)]">
        <span>特征维度</span><span>高表现取值</span><span>爆款占比</span><span>状态</span>
      </div>
      <div v-for="f in features" :key="f.dim" class="grid grid-cols-[3fr_1.2fr_1.2fr_1fr] items-center py-3 border-b border-[#f2f4f7] last:border-none text-[13px]">
        <span>{{ f.dim }}</span>
        <span class="font-medium">{{ f.value }}</span>
        <span>{{ f.ratio }}</span>
        <span><span class="mw-tag" :class="f.cls">{{ f.status }}</span></span>
      </div>
      <div class="mw-subtle mt-3 flex items-center gap-1"><icon-info-circle :size="12" />特征结论将作为文案生成引擎的默认偏好参数（T+1 / T+7 分别留存）。</div>
    </div>

    <!-- ============ 选题反馈 ============ -->
    <div v-else class="mw-card p-5">
      <div class="text-[15px] font-semibold mb-3">反哺选题库 <span class="mw-subtle font-normal">（演示）· 运营确认后进入资讯候选池</span></div>
      <div v-for="s in feedbacks" :key="s.id" class="flex items-center gap-4 py-3 border-b border-[#f2f4f7] last:border-none">
        <ThumbBox :seed="s.id" :width="52" :height="38" />
        <div class="flex-1 min-w-0">
          <div class="text-[14px] font-medium">{{ s.title }}</div>
          <div class="mw-subtle mt-0.5">依据：{{ s.basis }}</div>
        </div>
        <span class="mw-tag" :class="s.cls">{{ s.status }}</span>
        <div class="flex gap-2">
          <a-button size="small" type="outline">加入选题库</a-button>
          <a-button size="small">忽略</a-button>
        </div>
      </div>
    </div>
    <div class="mw-corner-note">原型预览 · 演示数据</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { IconFile, IconPlayCircleFill, IconHeartFill } from '@arco-design/web-vue/es/icon'
import PageHead from '@/components/PageHead.vue'
import ThumbBox from '@/components/ThumbBox.vue'
import { contentPerf, trendData } from '@/mocks/data'

const tab = ref('effect')
const trend = trendData
const metrics = [
  { name: '发布作品', value: '24', icon: IconFile, bg: '#eef4ff', color: '#1d4ed8' },
  { name: '播放量', value: '12.8万', icon: IconPlayCircleFill, bg: '#e9f3ff', color: '#1c7bd8' },
  { name: '互动量', value: '4,260', icon: IconHeartFill, bg: '#fdeef2', color: '#d8497b' },
]

/** Catmull-Rom 转贝塞尔平滑曲线 */
function ptsOf(values: number[]) {
  return values.map((v, i) => ({ x: 64 + i * 86, y: 164 - v * 1.5 }))
}
function linePath(values: number[]) {
  const pts = ptsOf(values)
  let d = `M ${pts[0].x},${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x},${p2.y}`
  }
  return d
}
function areaPath(series: { values: number[] }) {
  const pts = ptsOf(series.values)
  return `${linePath(series.values)} L ${pts[pts.length - 1].x},164 L ${pts[0].x},164 Z`
}

const linePerf = [
  { name: '经理 IP', color: '#1d4ed8', bg: '#eef4ff', count: 8, avg: '6,000' },
  { name: '员工 KOS', color: '#4f83f1', bg: '#eef4ff', count: 10, avg: '5,000' },
  { name: '素人矩阵', color: '#a9c4f7', bg: '#eef4ff', count: 6, avg: '5,000' },
]
const features = [
  { dim: '开场钩子类型', value: '问题式开场', ratio: '41%', status: '待确认', cls: 'mw-tag-yellow' },
  { dim: '时长区间', value: '45-60 秒', ratio: '63%', status: '已沉淀', cls: 'mw-tag-green' },
  { dim: '封面样式', value: '大字标题 + 人物', ratio: '55%', status: '已沉淀', cls: 'mw-tag-green' },
  { dim: '发布时间', value: '工作日 12:00-13:00', ratio: '38%', status: '观察中', cls: 'mw-tag-gray' },
  { dim: '选题方向', value: '风险认知类', ratio: '47%', status: '待确认', cls: 'mw-tag-yellow' },
]
const feedbacks = [
  { id: 'f1', title: '问题式开场在本组样例中互动较高', basis: '近 7 天 32 条爆款的钩子归因（示例）', status: '待确认', cls: 'mw-tag-yellow' },
  { id: 'f2', title: '45-60 秒时长区间的完播率最优', basis: 'T+7 完播率对比（示例）', status: '已加入选题库', cls: 'mw-tag-green' },
  { id: 'f3', title: '素人矩阵：概念澄清类选题跑量更稳', basis: '素人线 T+1 播放对比（示例）', status: '待确认', cls: 'mw-tag-yellow' },
]
</script>
