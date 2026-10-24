import { apiGet, apiPatch, apiPost } from './client'

export type Role = 'ops' | 'reviewer' | 'admin'

export interface AuthUser {
  id: string
  username: string
  displayName: string
  role: Role
  roleLabel: string
  enabled: boolean
  createdAt: string | null
  lastLoginAt: string | null
}

export interface LoginResult {
  token: string
  expiresAt: string
  user: AuthUser
}

export const ROLE_LABELS: Record<Role, string> = { ops: '运营', reviewer: '审核', admin: '管理员' }

export function login(username: string, password: string) {
  return apiPost<LoginResult>('/auth/login', { username, password })
}

export function logout() {
  return apiPost<{ ok: boolean }>('/auth/logout')
}

export function getMe() {
  return apiGet<AuthUser>('/auth/me')
}

export function changePassword(oldPassword: string, newPassword: string) {
  return apiPost<LoginResult>('/auth/password', { oldPassword, newPassword })
}

/* ── 账号管理（管理员）──────────────────────────────────────── */

export function listUsers() {
  return apiGet<{ items: AuthUser[]; roleLabels: Record<Role, string> }>('/users')
}

export function createUser(input: { username: string; displayName?: string; role: Role; password: string }) {
  return apiPost<AuthUser>('/users', input)
}

export function updateUser(
  id: string,
  patch: { displayName?: string; role?: Role; enabled?: boolean; password?: string },
) {
  return apiPatch<AuthUser>(`/users/${id}`, patch)
}
