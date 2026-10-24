<template>
  <a-drawer :visible="visible" :width="760" title="选题方法论" :footer="false" @cancel="$emit('close')">
    <div class="methodology-intro">
      <span>从事实出发，让每个选题都有理由</span>
      <h2>素材 × 人物 × 角度 × 钩子</h2>
      <p>
        热点资讯回答「现在为什么讲」，对标视频回答「怎样的表达被验证过」。两类资料都需要经过人物适配和人工筛选，才进入文案工坊。
      </p>
    </div>
    <h3 class="research-section-title">01 / 现有方法与实际提示词</h3>
    <div class="methodology-options">
      <button v-for="t in templates" :key="t.id" :class="{ active: current?.id === t.id }" @click="selected = t.id">
        <strong>{{ t.name }}</strong
        ><span>{{ methodNotes[t.builtin || ''] || '自定义选题方法' }}</span>
      </button>
    </div>
    <section v-if="current" class="methodology-template">
      <div>
        <strong>{{ current.name }}</strong
        ><a-tag v-if="current.isDefault" size="small">默认方法</a-tag
        ><a-button size="small" type="primary" @click="$emit('use', current.id)">使用此方法生成选题</a-button>
      </div>
      <pre>{{ current.content }}</pre>
      <p>上方内容读取自服务端模板。人物档案与禁用表达会由后端固定追加，修改模板不会绕过这些约束。</p>
    </section>
    <h3 class="research-section-title">02 / 一条可执行选题需要什么</h3>
    <div class="methodology-fields">
      <div>
        <b>标题 title</b>
        <p>讲什么问题；限定对象和边界。</p>
      </div>
      <div>
        <b>方向 direction</b>
        <p>选事实、误区、人群或机制中的一个角度。</p>
      </div>
      <div>
        <b>开场 hook</b>
        <p>一句可以直接口播的话，让观众知道与自己有什么关系。</p>
      </div>
      <div>
        <b>理由 rationale</b>
        <p>给出时效、事实或受众需求依据，便于人工筛选。</p>
      </div>
    </div>
    <h3 class="research-section-title">03 / 对标视频如何判定爆款</h3>
    <section class="methodology-rule">
      <strong>{{ overview?.methodology.formula || '正在读取服务端规则…' }}</strong>
      <ul v-if="overview">
        <li>基线至少 {{ overview.methodology.minSample }} 条样本；不足样本或均值为 0 时不判定。</li>
        <li>
          回填整页后统一判断，避免入库顺序影响结果；近
          {{ overview.methodology.refreshDays }} 天作品在监控时更新互动并重新判断。
        </li>
        <li>爆款标记保留，判定时的均值、样本量、阈值和时间保存为快照；每条作品只发一次爆款告警。</li>
      </ul>
      <p>
        这是同账号内的互动异常识别。大账号的绝对点赞量不能直接作为小账号的爆款标准；播放量未提供时，不计算互动率、完播率或转粉率。
      </p>
    </section>
    <h3 class="research-section-title">04 / 从对标到原创</h3>
    <p class="methodology-conclusion">
      先看真实视频与判定依据 → 提取口播全文 → 拆解开场、论证和收束 → 选择人物与新的事实材料 →
      在文案工坊重写并审核。标题是内容线索，不能代替视频全文；高互动也不等于高转化，发布后的效果需要回看数据验证。
    </p>
  </a-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TopicTemplate } from '@/api/topics'
import type { ResearchOverview } from '@/api/benchmark'
const props = defineProps<{ visible: boolean; templates: TopicTemplate[]; overview: ResearchOverview | null }>()
defineEmits<{ close: []; use: [id: string] }>()
const selected = ref('')
const current = computed(
  () =>
    props.templates.find((t) => t.id === selected.value) ||
    props.templates.find((t) => t.isDefault) ||
    props.templates[0],
)
const methodNotes: Record<string, string> = {
  market: '结论 → 事实 → 影响',
  education: '误解 → 规则 → 边界',
  comment: '事件 → 观点 → 理由',
  product: '人群 → 风险 → 选择维度',
}
</script>
