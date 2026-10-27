<template>
  <div class="p-7 pb-10 max-w-[1100px] mx-auto">
    <PageHead title="账号管理">
      <template #sub>管理登录账号与角色，以及各数据源、模型服务的密钥与环境配置（系统设置）。</template>
    </PageHead>

    <a-tabs v-model:active-key="activeTab">
      <a-tab-pane key="users" title="账号管理">
        <div class="mb-4 flex justify-end">
          <a-button type="primary" @click="openCreate"
            ><template #icon><icon-plus /></template>新建账号</a-button
          >
        </div>

        <a-table :data="users" :loading="loading" row-key="id" :pagination="false" :bordered="{ cell: false }">
          <template #columns>
            <a-table-column title="账号" data-index="username" />
            <a-table-column title="显示名" data-index="displayName" />
            <a-table-column title="角色">
              <template #cell="{ record }">
                <a-select
                  :model-value="record.role"
                  size="small"
                  :style="{ width: '110px' }"
                  :disabled="record.id === auth.user?.id"
                  @change="(v) => changeRole(record, v as Role)"
                >
                  <a-option v-for="(label, key) in ROLE_LABELS" :key="key" :value="key" :label="label" />
                </a-select>
              </template>
            </a-table-column>
            <a-table-column title="状态">
              <template #cell="{ record }">
                <span class="mw-tag" :class="record.enabled ? 'mw-tag-green' : 'mw-tag-gray'">{{
                  record.enabled ? '启用' : '停用'
                }}</span>
              </template>
            </a-table-column>
            <a-table-column title="最近登录">
              <template #cell="{ record }">{{ fmt(record.lastLoginAt) }}</template>
            </a-table-column>
            <a-table-column title="操作" :width="200">
              <template #cell="{ record }">
                <a-space>
                  <a-button size="mini" @click="openReset(record)">重置密码</a-button>
                  <a-button size="mini" :disabled="record.id === auth.user?.id" @click="toggle(record)">{{
                    record.enabled ? '停用' : '启用'
                  }}</a-button>
                </a-space>
              </template>
            </a-table-column>
          </template>
        </a-table>

        <a-modal
          v-model:visible="createVisible"
          title="新建账号"
          :ok-loading="saving"
          @ok="submitCreate"
          @cancel="createVisible = false"
        >
          <div class="flex flex-col gap-3">
            <a-input v-model="form.username" placeholder="账号（3–32 位字母、数字、下划线）" />
            <a-input v-model="form.displayName" placeholder="显示名（可选）" />
            <a-select v-model="form.role">
              <a-option v-for="(label, key) in ROLE_LABELS" :key="key" :value="key" :label="label" />
            </a-select>
            <a-input-password v-model="form.password" placeholder="初始密码（至少 8 位，含字母和数字）" />
          </div>
        </a-modal>

        <a-modal
          v-model:visible="resetVisible"
          :title="`重置密码：${resetTarget?.username ?? ''}`"
          :ok-loading="saving"
          @ok="submitReset"
          @cancel="resetVisible = false"
        >
          <a-input-password v-model="resetPassword" placeholder="新密码（至少 8 位，含字母和数字）" />
          <p class="mw-subtle mt-2">重置后该账号已登录的会话会立即失效。</p>
        </a-modal>
      </a-tab-pane>
      <a-tab-pane key="settings" title="系统设置">
        <SystemSettings v-if="activeTab === 'settings'" />
      </a-tab-pane>
    </a-tabs>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import SystemSettings from './SystemSettings.vue'
import { createUser, listUsers, updateUser, ROLE_LABELS, type AuthUser, type Role } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const activeTab = ref('users')
const users = ref<AuthUser[]>([])
const loading = ref(false)
const saving = ref(false)
const createVisible = ref(false)
const resetVisible = ref(false)
const resetTarget = ref<AuthUser | null>(null)
const resetPassword = ref('')
const form = reactive({ username: '', displayName: '', role: 'ops' as Role, password: '' })

function fmt(v: string | null): string {
  return v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—'
}

async function load(): Promise<void> {
  loading.value = true
  try {
    users.value = (await listUsers()).items
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  Object.assign(form, { username: '', displayName: '', role: 'ops', password: '' })
  createVisible.value = true
}

async function submitCreate(): Promise<void> {
  saving.value = true
  try {
    await createUser({ ...form, displayName: form.displayName || undefined })
    Message.success('账号已创建')
    createVisible.value = false
    await load()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

function openReset(u: AuthUser): void {
  resetTarget.value = u
  resetPassword.value = ''
  resetVisible.value = true
}

async function submitReset(): Promise<void> {
  if (!resetTarget.value) return
  saving.value = true
  try {
    await updateUser(resetTarget.value.id, { password: resetPassword.value })
    Message.success('密码已重置')
    resetVisible.value = false
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

async function changeRole(u: AuthUser, role: Role): Promise<void> {
  try {
    await updateUser(u.id, { role })
    Message.success('角色已更新')
  } catch (e) {
    Message.error((e as Error).message)
  }
  await load()
}

async function toggle(u: AuthUser): Promise<void> {
  try {
    await updateUser(u.id, { enabled: !u.enabled })
    Message.success(u.enabled ? '已停用' : '已启用')
  } catch (e) {
    Message.error((e as Error).message)
  }
  await load()
}

onMounted(load)
</script>
