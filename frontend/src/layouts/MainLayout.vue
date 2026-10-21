<template>
  <div class="mw-shell" :class="{ 'is-nav-collapsed': workspace.navigationCollapsed }">
    <!-- 侧边导航 -->
    <aside class="mw-sidebar" aria-label="主导航">
      <div class="mw-brand">
        <div
          class="mw-brand-mark"
          :style="{
            background: brand.themePrimary,
            fontSize: brand.logoText ? '17px' : undefined,
            letterSpacing: brand.logoText ? '0' : undefined,
          }"
        >
          <template v-if="brand.logoText">{{ brand.logoText }}</template>
          <icon-sun-fill v-else :size="19" />
        </div>
        <div class="mw-brand-copy leading-tight min-w-0">
          <div class="mw-brand-name">{{ brand.appName }}</div>
          <div class="mw-brand-tagline">{{ brand.appTagline }}</div>
        </div>
      </div>
      <div class="mw-sidebar-tools"><a-button type="text" :aria-label="workspace.navigationCollapsed ? '展开导航' : '收起导航'" :aria-expanded="!workspace.navigationCollapsed" aria-controls="workspace-navigation" :title="workspace.navigationCollapsed ? '展开导航' : '收起导航'" @click="workspace.toggleNavigation()"><template #icon><icon-menu-unfold v-if="workspace.navigationCollapsed" /><icon-menu-fold v-else /></template><span v-if="!workspace.navigationCollapsed">收起导航</span></a-button></div>
      <nav id="workspace-navigation" class="mw-sidebar-nav">
        <template v-for="group in navGroups" :key="group.label">
          <div v-if="group.label" class="mw-nav-group">{{ group.label }}</div>
          <RouterLink
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            custom
            v-slot="{ isActive, navigate, href }"
          >
            <a
              :href="href"
              :aria-current="isActive ? 'page' : undefined"
              :aria-label="item.label"
              :title="workspace.navigationCollapsed ? item.label : undefined"
              class="mw-nav-item"
              :class="{ active: isActive }"
              @click="navigate"
            >
              <component :is="item.icon" :size="17" />
              <span class="mw-nav-label">{{ item.label }}</span>
            </a>
          </RouterLink>
        </template>
      </nav>
      <div class="mw-sidebar-footer">
        <div class="mw-profile">
          <div class="mw-profile-avatar">陈</div>
          <div class="mw-profile-meta flex-1"><div class="font-medium">陈</div><div class="mw-subtle">管理员</div></div>
          <a-badge dot :count="bench.unread">
            <a-button type="text" shape="circle" title="对标告警" aria-label="查看对标告警" @click="router.push('/topics')">
              <template #icon><icon-notification :size="17" /></template>
            </a-button>
          </a-badge>
        </div>
      </div>
    </aside>
    <div class="mw-main-column">
      <main class="mw-main">
        <router-view />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { h, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { brand, applyBrand } from '@/config/brand'
import { useBenchmarkStore } from '@/stores/benchmark'
import { useWorkspaceStore } from '@/stores/workspace'
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

const router = useRouter()
const workspace = useWorkspaceStore()
// 导航铃铛：对标告警未读数（FR-B9），60s 刷新一次
const bench = useBenchmarkStore()
let unreadTimer: number | undefined
onMounted(() => {
  applyBrand()
  void bench.loadUnread()
  unreadTimer = window.setInterval(() => void bench.loadUnread(), 60_000)
})
onBeforeUnmount(() => window.clearInterval(unreadTimer))
</script>
