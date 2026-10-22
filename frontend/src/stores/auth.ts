import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { readToken, writeToken } from '@/api/client'
import * as authApi from '@/api/auth'
import type { AuthUser, Role } from '@/api/auth'

/** 登录状态（P0-1）：令牌存 localStorage，当前账号在首次进入受保护页面时向服务端确认 */
export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(readToken())
  const user = ref<AuthUser | null>(null)
  const loaded = ref(false)

  const isLoggedIn = computed(() => !!token.value && !!user.value)
  const role = computed<Role | null>(() => user.value?.role ?? null)

  function hasRole(...roles: Role[]): boolean {
    return !!user.value && roles.includes(user.value.role)
  }

  async function login(username: string, password: string): Promise<AuthUser> {
    const r = await authApi.login(username, password)
    writeToken(r.token)
    token.value = r.token
    user.value = r.user
    loaded.value = true
    return r.user
  }

  /** 进入受保护页面前调用：有令牌但未取过账号信息时向服务端确认一次 */
  async function ensureLoaded(): Promise<boolean> {
    if (!token.value) return false
    if (loaded.value && user.value) return true
    try {
      user.value = await authApi.getMe()
      loaded.value = true
      return true
    } catch {
      clear()
      return false
    }
  }

  async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const r = await authApi.changePassword(oldPassword, newPassword)
    writeToken(r.token)
    token.value = r.token
    user.value = r.user
  }

  function clear(): void {
    writeToken(null)
    token.value = null
    user.value = null
    loaded.value = false
  }

  async function logout(): Promise<void> {
    await authApi.logout().catch(() => undefined)
    clear()
  }

  return { token, user, loaded, isLoggedIn, role, hasRole, login, ensureLoaded, changePassword, clear, logout }
})
