<template>
  <div class="h-full flex overflow-hidden">
    <!-- 侧边导航 -->
    <aside class="w-[232px] bg-white border-r border-[var(--mw-border-light)] flex flex-col flex-shrink-0">
      <div class="px-5 pt-5 pb-4 flex items-center gap-2.5">
        <div
          class="w-9 h-9 rounded-[11px] flex items-center justify-center flex-shrink-0 text-white font-bold"
          :style="{
            background: `linear-gradient(135deg, ${brand.logoGradient[0]}, ${brand.logoGradient[1]})`,
            boxShadow: `0 2px 6px ${brand.logoGradient[1]}59, inset 0 1px 0 rgba(255, 255, 255, 0.25)`,
            fontSize: brand.logoText ? '17px' : undefined,
            letterSpacing: brand.logoText ? '0' : undefined,
          }"
        >
          <template v-if="brand.logoText">{{ brand.logoText }}</template>
          <icon-sun-fill v-else :size="19" />
        </div>
        <div class="leading-tight min-w-0">
          <div class="text-[17px] font-bold text-[#131f38] truncate" style="letter-spacing: 1px">{{ brand.appName }}</div>
          <div class="text-[11px] text-[var(--mw-text3)] mt-0.5 truncate" style="letter-spacing: 1.5px">{{ brand.appTagline }}</div>
        </div>
      </div>
      <nav class="flex-1 overflow-y-auto px-3 pb-3">
        <template v-for="group in navGroups" :key="group.label">
          <div v-if="group.label" class="px-3 pt-4 pb-1.5 text-[11px] text-[var(--mw-text3)]" style="letter-spacing: 2px">{{ group.label }}</div>
          <RouterLink
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            custom
            v-slot="{ isActive, navigate }"
          >
            <div
              class="mw-nav-item"
              :class="{ active: isActive }"
              @click="navigate()"
            >
              <component :is="item.icon" :size="17" />
              <span>{{ item.label }}</span>
            </div>
          </RouterLink>
        </template>
      </nav>
      <div class="border-t border-[var(--mw-border-light)] p-3">
        <div class="flex items-center gap-2.5 px-2 py-1.5 rounded-[10px] cursor-pointer hover:bg-gray-50 transition-colors">
          <div
            class="w-8 h-8 rounded-full text-white flex items-center justify-center text-[13px] font-semibold"
            style="background: linear-gradient(135deg, #2e63e7, #16339e); box-shadow: 0 1px 3px rgba(29, 78, 216, 0.3)"
          >陈</div>
          <div class="flex-1 leading-tight">
            <div class="text-[13px] font-medium">陈</div>
            <div class="text-[11px] text-[var(--mw-text3)]">管理员</div>
          </div>
          <icon-right :size="14" class="text-[var(--mw-text3)]" />
        </div>
      </div>
    </aside>

    <!-- 右侧区域 -->
    <div class="flex-1 flex flex-col min-w-0">
      <header class="h-16 bg-white border-b border-[var(--mw-border-light)] flex items-center px-6 gap-4 flex-shrink-0">
        <div class="flex-1"></div>
        <a-input-search :style="{ width: '420px' }" placeholder="搜索任务、素材...">
          <template #suffix>
            <span class="mw-subtle" style="border: 1px solid var(--mw-border); border-radius: 4px; padding: 0 5px">⌘ K</span>
          </template>
        </a-input-search>
        <a-badge dot :count="1">
          <a-button type="text" shape="circle">
            <template #icon><icon-notification :size="18" /></template>
          </a-button>
        </a-badge>
      </header>
      <main class="flex-1 overflow-auto">
        <router-view />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { h, onMounted } from 'vue'
import { brand, applyBrand } from '@/config/brand'
import {
  IconHome,
  IconFire,
  IconFile,
  IconPlayCircle,
  IconScissor,
  IconUser,
  IconFolder,
  IconCheckSquare,
  IconSafe,
  IconSend,
  IconBarChart,
} from '@arco-design/web-vue/es/icon'

const icon = (comp: any) => () => h(comp)
const navGroups = [
  { label: '', items: [{ label: '工作台', path: '/workbench', icon: icon(IconHome) }] },
  {
    label: '创作',
    items: [
      { label: '爆款选题', path: '/topics', icon: icon(IconFire) },
      { label: '文案工坊', path: '/copy', icon: icon(IconFile) },
      { label: '视频创作', path: '/video/create', icon: icon(IconPlayCircle) },
      { label: '视频剪辑', path: '/video/edit', icon: icon(IconScissor) },
    ],
  },
  {
    label: '资产',
    items: [
      { label: '人物库', path: '/people', icon: icon(IconUser) },
      { label: '素材库', path: '/materials', icon: icon(IconFolder) },
    ],
  },
  {
    label: '运营',
    items: [
      { label: '任务中心', path: '/tasks', icon: icon(IconCheckSquare) },
      { label: '审核工作台', path: '/review', icon: icon(IconSafe) },
      { label: '发布管理', path: '/publish', icon: icon(IconSend) },
      { label: '数据看板', path: '/analytics', icon: icon(IconBarChart) },
    ],
  },
]

onMounted(applyBrand)
</script>
