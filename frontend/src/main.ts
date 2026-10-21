import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { Message } from '@arco-design/web-vue'
import App from './App.vue'
import router from './router'
import { UNAUTHORIZED_EVENT } from './api/client'
import { useAuthStore } from './stores/auth'
import '@arco-design/web-vue/dist/arco.css'
import './style.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
// 组件与图标由 unplugin-vue-components 按需引入（P3-2）；模板里的 $message 需要注册 Message
app.use(Message)
app.mount('#app')

// P0-1：任意接口返回 401（令牌过期 / 账号停用）时回到登录页
window.addEventListener(UNAUTHORIZED_EVENT, () => {
  useAuthStore().clear()
  const current = router.currentRoute.value
  if (current.name !== 'login') void router.replace({ name: 'login', query: { redirect: current.fullPath } })
})
