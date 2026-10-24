import { defineConfig } from 'vitest/config'

/**
 * P3-3：纯函数快速单测（不起服务、不连库）。
 * 需要数据库 / 队列 / HTTP 的回归仍走 scripts/test-*.ts 与 smoke。
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // config.ts 在首次 import 时读环境变量：固定为开发口径，避免本机 .env 影响断言
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
})
