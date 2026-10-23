import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export function readWorkspacePreference(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`matrix.workspace.${key}`) ?? fallback
  } catch {
    return fallback
  }
}
export function saveWorkspacePreference(key: string, value: string): void {
  try {
    localStorage.setItem(`matrix.workspace.${key}`, value)
  } catch {
    /* 浏览器禁用存储时仍可使用当前布局 */
  }
}

export const useWorkspaceStore = defineStore('workspace-layout', () => {
  const sidebarCollapsed = ref(
    readWorkspacePreference(
      'navigation-collapsed',
      window.matchMedia('(max-width: 900px)').matches ? 'true' : 'false',
    ) === 'true',
  )
  const focusWriting = ref(false)
  const navigationCollapsed = computed(() => sidebarCollapsed.value || focusWriting.value)
  function toggleNavigation() {
    if (focusWriting.value) {
      focusWriting.value = false
      sidebarCollapsed.value = false
    } else sidebarCollapsed.value = !sidebarCollapsed.value
    saveWorkspacePreference('navigation-collapsed', String(sidebarCollapsed.value))
  }
  return { sidebarCollapsed, navigationCollapsed, focusWriting, toggleNavigation }
})
