<template>
  <div class="mw-page workbench-page">
    <PageHead title="工作台">
      <template #sub>{{ todayText }} · 三条生产线并行运转中</template>
    </PageHead>

    <!-- 今日概览 -->
    <div class="workbench-metrics">
      <div
        v-for="m in metrics"
        :key="m.name"
        class="mw-card p-5 cursor-pointer transition-shadow hover:shadow-sm"
        @click="$router.push(m.to)"
      >
        <div class="flex items-center justify-between">
          <span class="mw-subtle">{{ m.name }}</span>
          <span class="mw-tag" :class="m.cls">{{ m.tag }}</span>
        </div>
        <div class="text-[30px] font-bold mt-2">{{ m.value }}</div>
        <div class="mw-subtle mt-1">{{ m.hint }}</div>
      </div>
    </div>

    <!-- 三线运转 -->
    <div class="text-[16px] font-semibold mb-3">三条生产线</div>
    <div class="grid grid-cols-3 gap-5 mb-5">
      <div v-for="l in lines" :key="l.name" class="mw-card p-5">
        <div class="flex items-center gap-2">
          <span class="mw-tag" :class="l.cls">{{ l.name }}</span>
          <span class="mw-subtle">{{ l.scope }}</span>
        </div>
        <div class="mt-3 flex flex-col gap-2 text-[13px]">
          <div v-for="s in l.steps" :key="s.label" class="flex items-center gap-2">
            <span class="mw-dot" :style="{ background: s.dot }"></span>
            <span class="text-[var(--mw-text2)] w-[72px] whitespace-nowrap flex-shrink-0">{{ s.label }}</span>
            <span class="text-[var(--mw-text3)]">{{ s.desc }}</span>
          </div>
        </div>
        <div class="mt-3 pt-3 border-t border-[#f2f4f7] flex items-center justify-between">
          <span class="mw-subtle">今日 {{ l.today }}</span>
          <span class="mw-link" @click="$router.push(l.to)">进入{{ l.name }}线 <icon-right :size="12" /></span>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-[1.6fr_1fr] gap-5">
      <!-- 待处理 -->
      <div class="mw-card p-5">
        <div class="flex items-center justify-between mb-2">
          <div class="text-[15px] font-semibold">待处理</div>
          <span class="mw-link" @click="$router.push('/tasks')">前往任务中心 <icon-right :size="12" /></span>
        </div>
        <div
          v-for="t in todos"
          :key="t.title"
          class="flex items-center gap-3 py-2.5 border-b border-[#f2f4f7] last:border-none cursor-pointer"
          @click="$router.push(t.to)"
        >
          <ThumbBox :seed="t.title" :width="46" :height="34" />
          <div class="flex-1 min-w-0">
            <div class="text-[13.5px] font-medium truncate">{{ t.title }}</div>
            <div class="mw-subtle">{{ t.desc }}</div>
          </div>
          <span class="mw-tag" :class="t.cls">{{ t.action }}</span>
        </div>
      </div>
      <!-- 快捷入口 -->
      <div class="mw-card p-5">
        <div class="text-[15px] font-semibold mb-3">快捷入口</div>
        <div class="grid grid-cols-2 gap-3">
          <div
            v-for="q in quicks"
            :key="q.label"
            class="p-4 rounded-[10px] border border-[var(--mw-border)] cursor-pointer hover:border-[color:var(--mw-primary-soft)] hover:bg-[color:var(--mw-primary-faint)] transition-colors"
            @click="$router.push(q.to)"
          >
            <component :is="q.icon" :size="20" class="text-primary-c" />
            <div class="text-[13.5px] font-medium mt-2">{{ q.label }}</div>
            <div class="mw-subtle mt-0.5">{{ q.desc }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import PageHead from '@/components/PageHead.vue'
import ThumbBox from '@/components/ThumbBox.vue'
import { features } from '@/config/features'
import { IconFire, IconFile, IconPlayCircle, IconBarChart } from '@arco-design/web-vue/es/icon'

// 审核工作台下线期间，审核相关入口统一落到任务中心（features.reviewWorkbench 打开后恢复原跳转）
const reviewEntry = features.reviewWorkbench ? '/review' : '/tasks'

const todayText = new Date().toLocaleDateString('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
})

const metrics = [
  {
    name: '今日新增任务',
    value: '6',
    tag: '全部阶段',
    cls: 'mw-tag-blue',
    hint: '经理 IP 3 · 员工 KOS 3',
    to: '/tasks',
  },
  {
    name: '待人工审核',
    value: '2',
    tag: '审核链第3关后',
    cls: 'mw-tag-yellow',
    hint: '日均审核 20-30 条',
    to: reviewEntry,
  },
  { name: '待发布', value: '3', tag: '成片复审通过', cls: 'mw-tag-green', hint: '抖音 2 · 小红书 1', to: '/publish' },
  {
    name: '数据待回采',
    value: '5',
    tag: 'T+1 到期',
    cls: 'mw-tag-gray',
    hint: '每日 06:00 自动回采',
    to: '/analytics',
  },
]
const lines = [
  {
    name: '经理 IP',
    cls: 'mw-tag-deep',
    scope: '仅抖音 · 日均 1 条',
    to: '/copy',
    steps: [
      { label: '内容输入', desc: 'Word 文章 / 当日热点', dot: '#1d4ed8' },
      { label: '审核链', desc: '三关已过 1 条 · 待复核 1 条', dot: '#e69b3c' },
      { label: '视频与发布', desc: '张经理数字人口播 → 抖音', dot: '#9ca3af' },
    ],
    today: '已产出 2 条',
  },
  {
    name: '员工 KOS',
    cls: 'mw-tag-blue',
    scope: '抖音 + 小红书 · 日均 1-2 条',
    to: '/topics',
    steps: [
      { label: '内容输入', desc: '热点资讯 / 产品素材', dot: '#1d4ed8' },
      { label: '审核链', desc: '队列 5 条 · 已通过 12 条', dot: '#0f7b3e' },
      { label: '视频与发布', desc: '口播 / 混剪 → 矩阵分发', dot: '#9ca3af' },
    ],
    today: '已产出 10 条',
  },
  {
    name: '素人矩阵',
    cls: 'mw-tag-purple',
    scope: '三平台 · 日均 2-3 条',
    to: '/topics',
    steps: [
      { label: '对标采集', desc: '新发现候选 2 个 · 爆款 3 条', dot: '#7c5cd6' },
      { label: '审核链', desc: '查重 < 30% 已卡控', dot: '#0f7b3e' },
      { label: '视频与发布', desc: '仅混剪/产品替代，不用数字人', dot: '#9ca3af' },
    ],
    today: '已产出 6 条',
  },
]
const todos = [
  {
    title: '市场波动与长期配置',
    desc: '文案生成 · 待人工审核 · 张经理 · 经理 IP',
    action: '去审核',
    cls: 'mw-tag-yellow',
    to: reviewEntry,
  },
  {
    title: '基金定投入门',
    desc: '剪辑合成 · 草稿 v2 · 小林科普 · 员工 KOS',
    action: '继续剪辑',
    cls: 'mw-tag-blue',
    to: '/video/edit',
  },
  {
    title: '基金定投入门（发布）',
    desc: '成片复审通过 · 待安排 · 定时 10月13日 10:00',
    action: '去发布',
    cls: 'mw-tag-green',
    to: '/publish',
  },
]
const quicks = [
  { icon: IconFire, label: '爆款选题', desc: '热点资讯 / 对标账号 → 候选选题', to: '/topics' },
  { icon: IconFile, label: '文案工坊', desc: '多稿创作 · 送审三关审核链', to: '/copy' },
  { icon: IconPlayCircle, label: '视频创作', desc: '数字人口播 / 素材混剪', to: '/video/create' },
  { icon: IconBarChart, label: '数据看板', desc: 'T+1 / T+7 回采与选题反馈', to: '/analytics' },
]
</script>
