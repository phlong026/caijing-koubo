<template>
  <div class="p-7 pb-10 max-w-[1500px] mx-auto">
    <PageHead title="发布管理">
      <template #sub>按运营主体与平台范围安排发布</template>
      <template #actions>
        <span class="mw-alert-banner"><icon-exclamation-circle :size="14" />方案模拟 · 平台授权与接口能力待验证</span>
      </template>
    </PageHead>

    <a-tabs v-model:active-key="tab" type="line" class="mw-tabs mb-4">
      <a-tab-pane key="todo"><template #title>待安排 <span class="mw-subtle">{{ contents.length }}</span></template></a-tab-pane>
      <a-tab-pane key="plan" title="发布计划" />
      <a-tab-pane key="log" title="发布记录" />
    </a-tabs>

    <!-- ============ 待安排 ============ -->
    <div v-if="tab === 'todo'" class="grid grid-cols-[1fr_430px] gap-5 items-start">
      <!-- 左：内容与分平台记录 -->
      <div class="flex flex-col gap-4">
        <div class="mw-card p-5">
          <div class="text-[15px] font-semibold mb-3">选择待发布内容（{{ contents.length }}）</div>
          <div class="flex flex-col gap-3">
            <div
              v-for="c in contents"
              :key="c.id"
              class="p-3.5 rounded-[10px] border-2 cursor-pointer transition-colors"
              :class="selected === c.id ? 'border-[color:var(--mw-primary)] bg-[color:var(--mw-primary-faint)]' : 'border-[var(--mw-border)] hover:border-[color:var(--mw-primary-soft)]'"
              @click="selected = c.id"
            >
              <div class="flex gap-4">
                <a-checkbox :model-value="selected === c.id" @click.prevent />
                <ThumbBox :seed="c.id" :width="110" :height="66" />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-[15px] font-semibold">{{ c.title }}</span>
                    <LineTag :line="c.line" />
                  </div>
                  <div class="mw-subtle mt-1">{{ c.subject }} · {{ c.form }}</div>
                  <div class="mt-2 flex items-center gap-2">
                    <span v-for="v in c.versions" :key="v" class="mw-tag mw-tag-gray">{{ v }}</span>
                    <span class="mw-tag" :class="c.status.cls">{{ c.status.text }}</span>
                  </div>
                </div>
              </div>
              <div v-if="selected === c.id && c.note" class="mt-3 pt-2.5 border-t border-[#eef1f5] mw-subtle">发布绑定{{ c.note }}</div>
            </div>
          </div>
        </div>

        <div class="mw-card p-5">
          <div class="text-[15px] font-semibold mb-3">分平台记录 <span class="mw-subtle font-normal">（演示）</span></div>
          <div v-for="(r, i) in platformRecords" :key="i" class="flex items-center gap-3 py-2.5 border-b border-[#f2f4f7] last:border-none">
            <span class="w-7 h-7 rounded-full text-white text-[12px] flex items-center justify-center flex-shrink-0" :style="{ background: r.color }">{{ r.icon }}</span>
            <span class="text-[13.5px] font-medium w-14">{{ r.platform }}</span>
            <span class="mw-tag" :class="r.cls">{{ r.status }}</span>
            <span class="mw-subtle flex-1">{{ r.desc }}</span>
            <span class="mw-link flex items-center">{{ r.action }} <icon-right :size="12" /></span>
          </div>
          <div class="mw-subtle mt-2 flex items-center gap-1"><icon-info-circle :size="12" />保存计划不等于平台已接收：调度与回执能力待验证。</div>
        </div>
      </div>

      <!-- 右：发布设置 -->
      <div class="mw-card p-5">
        <div class="text-[16px] font-semibold mb-3">发布设置</div>
        <!-- 平台卡 -->
        <div class="grid grid-cols-3 gap-2.5 mb-4">
          <div
            v-for="p in platforms"
            :key="p.name"
            class="p-3 rounded-[10px] border-2 cursor-pointer text-center transition-colors"
            :class="p.disabled ? 'border-[var(--mw-border)] opacity-45 cursor-not-allowed' : platform === p.name ? 'border-[color:var(--mw-primary)] bg-[color:var(--mw-primary-faint)]' : 'border-[var(--mw-border)] hover:border-[color:var(--mw-primary-soft)]'"
            @click="!p.disabled && (platform = p.name)"
          >
            <span class="w-7 h-7 rounded-full text-white text-[12px] inline-flex items-center justify-center" :style="{ background: p.color }">{{ p.icon }}</span>
            <div class="text-[13.5px] font-medium mt-1.5">{{ p.name }}</div>
            <div class="text-[10.5px] mt-0.5" :class="p.disabled ? 'text-[#c0392b]' : 'text-[var(--mw-text3)]'">{{ p.note }}</div>
          </div>
        </div>

        <div class="flex flex-col">
          <div class="mw-form-row">
            <div class="mw-form-label">发布账号</div>
            <div class="flex-1">
              <a-select v-model="account" :style="{ width: '100%' }" />
              <div class="mw-subtle mt-1 flex items-center gap-1"><icon-info-circle :size="12" />授权状态待核验</div>
            </div>
          </div>
          <div class="mw-form-row">
            <div class="mw-form-label">标题</div>
            <div class="flex-1">
              <a-input v-model="title" :max-length="50" />
              <div class="mw-subtle mt-1 text-right">{{ title.length }}/50</div>
            </div>
          </div>
          <div class="mw-form-row items-start">
            <div class="mw-form-label pt-1">封面</div>
            <ThumbBox :seed="'cover'" :width="64" :height="84" />
            <div class="text-[12.5px]">
              <div class="mw-link flex items-center">封面 v2 · 查看 <icon-right :size="12" /></div>
              <div class="mw-subtle mt-1 leading-4">建议使用 9:16 的竖版封面，文字清晰、主题突出。</div>
            </div>
          </div>
          <div class="mw-form-row items-start">
            <div class="mw-form-label pt-1">话题标签</div>
            <div class="flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span v-for="t in tags" :key="t" class="mw-tag mw-tag-blue">#{{ t }} <icon-close :size="11" class="cursor-pointer" @click="tags = tags.filter((x) => x !== t)" /></span>
                <a-button size="mini" type="text" class="!text-[color:var(--mw-primary)]"><template #icon><icon-plus /></template>添加标签</a-button>
              </div>
              <div class="mt-1.5 mw-tag mw-tag-yellow !bg-[#fdf3e0]"><icon-exclamation-circle :size="12" />标题、封面实质修改后需重新复审</div>
            </div>
          </div>
          <div class="mw-form-row">
            <div class="mw-form-label">发布时间</div>
            <a-radio-group v-model="when">
              <a-radio value="now">立即发布</a-radio>
              <a-radio value="timer">定时发布</a-radio>
            </a-radio-group>
          </div>
          <div v-if="when === 'timer'" class="mw-form-row">
            <div class="mw-form-label"></div>
            <a-date-picker v-model="date" :style="{ width: '150px' }" />
            <a-select v-model="time" :style="{ width: '100px' }">
              <a-option v-for="t in ['09:00', '10:00', '12:00', '18:00', '20:00']" :key="t" :value="t">{{ t }}</a-option>
            </a-select>
            <span class="mw-subtle">北京时间</span>
          </div>
        </div>

        <div class="mt-3 p-3 rounded-[8px] bg-[color:var(--mw-primary-faint)] border border-[color:var(--mw-primary-soft)] text-[12.5px] text-[var(--mw-text2)]">
          计划发布：{{ platform }} · {{ account }} · {{ when === 'timer' ? '10月13日 10:00' : '立即' }}
        </div>
        <div class="mt-4 flex items-center gap-3">
          <a-button @click="$message.success('草稿已保存（演示）')">保存草稿</a-button>
          <a-button type="primary" class="flex-1" @click="savePlan">保存发布计划</a-button>
        </div>
      </div>
    </div>

    <!-- ============ 发布计划 ============ -->
    <div v-else-if="tab === 'plan'" class="mw-card p-8 text-center mw-subtle">
      <div v-if="plans.length">
        <div v-for="(p, i) in plans" :key="i" class="text-[13.5px] text-[var(--mw-text2)] py-2 border-b border-[#f2f4f7] last:border-none text-left">
          <b>{{ p.title }}</b> → {{ p.platform }} · {{ p.account }} · {{ p.when }}
        </div>
      </div>
      <div v-else class="py-6">暂无发布计划。在「待安排」中保存发布计划后显示于此。</div>
    </div>

    <!-- ============ 发布记录 ============ -->
    <div v-else class="mw-card">
      <div class="grid grid-cols-[2fr_1fr_1.4fr_1fr_1fr] text-[12px] mw-thead px-5 py-2.5 border-b border-[var(--mw-border)]">
        <span>内容</span><span>平台</span><span>状态</span><span>回执</span><span>时间</span>
      </div>
      <div v-for="(r, i) in platformRecords" :key="i" class="grid grid-cols-[2fr_1fr_1.4fr_1fr_1fr] items-center px-5 py-3 border-b border-[#f2f4f7] text-[13px]">
        <span>基金定投入门</span>
        <span>{{ r.platform }}</span>
        <span><span class="mw-tag" :class="r.cls">{{ r.status }}</span></span>
        <span class="mw-subtle">{{ r.desc }}</span>
        <span class="mw-subtle">10-12 09:30（演示）</span>
      </div>
    </div>
    <div class="mw-corner-note">原型预览 · 演示数据</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import LineTag from '@/components/LineTag.vue'
import ThumbBox from '@/components/ThumbBox.vue'
import { platformRecords, publishContents } from '@/mocks/data'

const tab = ref('todo')
const contents = publishContents
const selected = ref('V-501')
const platform = ref('抖音')
const platforms = [
  { name: '抖音', icon: '▶', color: '#111827', note: '全部三条线' },
  { name: '小红书', icon: '书', color: '#FF2442', note: '员工 / 素人' },
  { name: '快手', icon: 'K', color: '#FF6900', note: '员工KOS 不适用', disabled: true },
]
const account = ref('小林科普 · 抖音（示例账号）')
const accountsByPlatform = computed(() => ({
  '抖音': ['小林科普 · 抖音（示例账号）', '张三说基金 · 抖音（示例账号）'],
  '小红书': ['小林科普 · 小红书（示例账号）'],
}))
const title = ref('基金定投入门：先了解目标与风险')
const tags = ref(['基金定投', '投资者教育'])
const when = ref('timer')
const date = ref('2026-10-13')
const time = ref('10:00')
const plans = ref<{ title: string; platform: string; account: string; when: string }[]>([])

function savePlan() {
  const c = contents.find((x) => x.id === selected.value)
  if (!c) return Message.warning('请先选择待发布内容')
  plans.value.push({ title: c.title, platform: platform.value, account: account.value, when: when.value === 'timer' ? '10月13日 10:00' : '立即' })
  Message.success('发布计划已保存（演示：调度与回执能力待验证）')
  tab.value = 'plan'
}
</script>
