import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ArcoResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [
    vue(),
    // P3-2：Arco 组件与图标按模板用到的按需引入，不再全量注册（样式仍由 main.ts 全量引入 arco.css，外观不变）
    Components({
      resolvers: [ArcoResolver({ resolveIcons: true, sideEffect: false })],
      dts: false,
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Vue 运行时单独成包：业务代码更新时浏览器仍可复用缓存；Arco 组件随用到它的页面按需分包
        manualChunks(id) {
          if (/node_modules\/(@vue|vue|vue-router|pinia)\//.test(id)) return 'vue'
        },
      },
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // 爆款选题模块后端（Fastify，默认 127.0.0.1:8787）
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
