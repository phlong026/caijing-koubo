import { createRouter, createWebHistory } from 'vue-router'
import MainLayout from '@/layouts/MainLayout.vue'
import { brand } from '@/config/brand'
import { useAuthStore } from '@/stores/auth'
import type { Role } from '@/api/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/views/auth/Login.vue'), meta: { title: '登录', public: true } },
    {
      path: '/',
      component: MainLayout,
      redirect: '/workbench',
      children: [
        { path: 'workbench', name: 'workbench', component: () => import('@/views/Workbench.vue'), meta: { title: '工作台' } },
        { path: 'topics', name: 'topics', component: () => import('@/views/topics/ViralTopics.vue'), meta: { title: '爆款选题' } },
        { path: 'copy', name: 'copy', component: () => import('@/views/copy/CopyStudio.vue'), meta: { title: '文案工坊' } },
        { path: 'video/create', name: 'videoCreate', component: () => import('@/views/video/VideoCreate.vue'), meta: { title: '视频创作' } },
        { path: 'video/edit', name: 'videoEdit', component: () => import('@/views/video/VideoEdit.vue'), meta: { title: '视频剪辑' } },
        { path: 'people', name: 'people', component: () => import('@/views/assets/PeopleLibrary.vue'), meta: { title: '人物库' } },
        { path: 'materials', name: 'materials', component: () => import('@/views/assets/MaterialLibrary.vue'), meta: { title: '素材库' } },
        { path: 'tasks', name: 'tasks', component: () => import('@/views/tasks/TaskCenter.vue'), meta: { title: '任务中心' } },
        { path: 'review', name: 'review', component: () => import('@/views/review/ReviewWorkbench.vue'), meta: { title: '审核工作台', roles: ['reviewer', 'admin'] } },
        { path: 'publish', name: 'publish', component: () => import('@/views/publish/PublishManage.vue'), meta: { title: '发布管理' } },
        { path: 'analytics', name: 'analytics', component: () => import('@/views/analytics/DataBoard.vue'), meta: { title: '数据看板' } },
        { path: 'users', name: 'users', component: () => import('@/views/admin/UserManage.vue'), meta: { title: '账号管理', roles: ['admin'] } },
      ],
    },
  ],
})

// P0-1：除登录页外都要求登录；带 roles 的页面再按角色放行
router.beforeEach(async (to) => {
  if (to.meta.public) return true
  const auth = useAuthStore()
  if (!(await auth.ensureLoaded())) {
    return { name: 'login', query: to.fullPath && to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
  }
  const roles = to.meta.roles as Role[] | undefined
  if (roles && !auth.hasRole(...roles)) return { path: '/workbench' }
  return true
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · ${brand.appName}` : brand.appName
})

export default router
