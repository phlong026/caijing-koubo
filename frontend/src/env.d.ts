/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API 前缀，缺省 /api（由 vite dev proxy 转发到本地 8787） */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
