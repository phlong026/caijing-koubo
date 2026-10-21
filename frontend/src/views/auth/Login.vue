<template>
  <div class="login-page">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-brand">
        <div class="login-mark" :style="{ background: brand.themePrimary }">{{ brand.logoText || '矩' }}</div>
        <div>
          <h1>{{ brand.appName }}</h1>
          <p>{{ brand.appTagline }}</p>
        </div>
      </div>
      <label for="login-username">账号</label>
      <a-input :input-attrs="{ id: 'login-username' }" v-model="username" autocomplete="username" placeholder="请输入账号" :disabled="loading" allow-clear />
      <label for="login-password">密码</label>
      <a-input-password :input-attrs="{ id: 'login-password' }" v-model="password" autocomplete="current-password" placeholder="请输入密码" :disabled="loading" @press-enter="submit" />
      <p v-if="error" class="login-error" role="alert">{{ error }}</p>
      <a-button type="primary" html-type="submit" long :loading="loading" :disabled="!username.trim() || !password">登录</a-button>
      <p class="login-hint">账号由管理员分配；忘记密码请联系管理员重置。</p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { brand } from '@/config/brand'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

async function submit(): Promise<void> {
  if (loading.value || !username.value.trim() || !password.value) return
  loading.value = true
  error.value = ''
  try {
    await auth.login(username.value.trim(), password.value)
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/'
    await router.replace(redirect)
  } catch (e) {
    error.value = (e as Error).message || '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--mw-bg);
  padding: 16px;
}
.login-card {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 28px;
  border: 1px solid var(--mw-border);
  border-radius: var(--mw-radius);
  background: #fff;
}
.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.login-mark {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  color: #fff;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-brand h1 {
  font-size: 18px;
  margin: 0;
  color: var(--mw-text);
}
.login-brand p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--mw-text3);
}
.login-card label {
  font-size: 13px;
  color: var(--mw-text2);
  margin-top: 4px;
}
.login-error {
  margin: 4px 0 0;
  font-size: 13px;
  color: #b42318;
}
.login-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--mw-text3);
}
.login-card :deep(.arco-btn) {
  margin-top: 12px;
}
</style>
