import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import type { OssEmulator } from './oss-emulator.js'

/**
 * 隔离的进程内测试环境（test-integration / test-personas-acceptance 共用）。
 *
 *  - 默认：临时 SQLite + 内存队列；
 *  - real：真实 MySQL（临时库，结束即删）+ 真实 Redis/BullMQ（独立前缀，结束即清），连接参数取
 *    DB_HOST / DB_PORT / DB_USER / DB_PASSWORD 与 REDIS_HOST / REDIS_PORT；
 *  - oss：启动本地 OSS 协议仿真并让服务端按「已配置 OSS」运行。
 *
 * 必须在 import 任何 src 模块之前调用（config 在首次 import 时读取环境变量）。
 */

export interface IsolatedEnvOptions {
  real?: boolean
  oss?: boolean
  /** 追加或覆盖的环境变量（在 config 加载前生效） */
  env?: Record<string, string>
  /** 监听端口，0 = 随机 */
  port?: number
}

export interface IsolatedEnv {
  app: FastifyInstance
  base: string
  real: boolean
  emu: OssEmulator | null
  dbName: string | null
  redisPrefix: string | null
  shutdown(): Promise<void>
}

async function mysqlAdmin(): Promise<import('mysql2/promise').Connection> {
  const mysql = (await import('mysql2/promise')).default
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  })
}

export async function bootIsolated(opts: IsolatedEnvOptions = {}): Promise<IsolatedEnv> {
  const real = !!opts.real
  const tempRoot = resolve(tmpdir())
  const temp = mkdtempSync(join(tempRoot, 'koubo-integration-'))
  const runTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const dbName = real ? `${process.env.DB_NAME || 'viral_topics'}_it_${runTag}` : null
  const redisPrefix = real ? `it_${runTag}` : null

  Object.assign(
    process.env,
    real
      ? { DB_DRIVER: 'mysql', DB_NAME: dbName!, QUEUE_PREFIX: redisPrefix! }
      : { DB_DRIVER: 'sqlite', DB_SQLITE_PATH: join(temp, 'test.db') },
    {
      NODE_ENV: 'test',
      TEMP_DIR: join(temp, 'media'),
      MOCK_FALLBACK: 'true',
      NEWS_MOCK_SOURCE: 'true',
      REVIEW_STUB_ENABLED: 'true',
      REVIEW_STUB_STEP_MS: '300',
      LOG_LEVEL: 'silent',
      DASHSCOPE_API_KEY: '',
      COPY_LLM_API_KEY: '',
      TIKHUB_API_KEY: '',
      FINSTEP_API_KEY: '',
      SATURN_NEWS_MCP_KEY: '',
      OSS_ACCESS_KEY_ID: '',
      OSS_ACCESS_KEY_SECRET: '',
      OSS_BUCKET: '',
      HIFLY_API_KEY: '',
    },
  )

  if (real) {
    const conn = await mysqlAdmin()
    await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await conn.end()
    console.log(`Real backend: MySQL database ${dbName}, Redis prefix ${redisPrefix}`)
  }

  let emu: OssEmulator | null = null
  if (opts.oss) {
    const { startOssEmulator } = await import('./oss-emulator.js')
    emu = await startOssEmulator()
    Object.assign(process.env, {
      OSS_BUCKET: emu.bucket,
      OSS_ACCESS_KEY_ID: emu.accessKeyId,
      OSS_ACCESS_KEY_SECRET: emu.accessKeySecret,
      OSS_ENDPOINT: emu.endpoint,
      OSS_CNAME: 'true',
    })
    console.log(`OSS emulator: ${emu.endpoint} (bucket ${emu.bucket})`)
  }
  Object.assign(process.env, opts.env ?? {})

  const { initDb, closeAll } = await import('../../src/db/index.js')
  const { runMigrations } = await import('../../src/db/migrate.js')
  const { redis, setQueueBackend, closeQueues, queueStats } = await import('../../src/queue/index.js')
  const { providers } = await import('../../src/modules/news/providers.js')
  const { fetchAndStore } = await import('../../src/modules/news/service.js')
  const { registerNewsJobs } = await import('../../src/modules/news/jobs.js')
  const { registerTopicJobs } = await import('../../src/modules/topics/jobs.js')
  const { registerBenchmarkJobs } = await import('../../src/modules/benchmark/sweep.js')
  const { registerExtractWorker } = await import('../../src/modules/benchmark/extract.js')
  const { registerCopyWorker } = await import('../../src/modules/copy/worker.js')
  const { registerPersonaModule } = await import('../../src/modules/personas/index.js')
  const { createTopic } = await import('../../src/modules/topics/repo.js')
  const { buildApp } = await import('../../src/app.js')

  if (!real) {
    redis.disconnect()
    setQueueBackend('memory')
  } else {
    setQueueBackend('redis')
  }
  providers.splice(0, providers.length, ...providers.filter((p) => p.name === 'mock'))
  const app = await buildApp()

  const db = await initDb()
  await runMigrations(db)
  await registerNewsJobs()
  await registerTopicJobs()
  await registerBenchmarkJobs()
  await registerExtractWorker()
  registerCopyWorker()
  await registerPersonaModule()
  await fetchAndStore()
  await createTopic({ source: 'manual', title: '尚未分配人物的集成测试选题' })
  const address = await app.listen({ host: '127.0.0.1', port: opts.port ?? 0 })

  async function shutdown(): Promise<void> {
    await app.close()
    // HTTP 响应可能先于异步 worker 结束
    for (let n = 0; n < 100; n++) {
      const stats = await queueStats()
      if (Object.values(stats).every((s) => !s.active && !s.waiting)) break
      await delay(50)
    }
    await closeQueues()
    if (real) {
      let cursor = '0'
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${redisPrefix}:*`, 'COUNT', 500)
        cursor = next
        if (keys.length) await redis.del(...keys)
      } while (cursor !== '0')
    }
    redis.disconnect()
    await closeAll()
    await emu?.close()
    if (real) {
      const conn = await mysqlAdmin()
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``)
      await conn.end()
    }
    if (dirname(temp) !== tempRoot || !basename(temp).startsWith('koubo-integration-')) {
      throw new Error('Unexpected integration cleanup path')
    }
    rmSync(temp, { recursive: true, force: true })
  }

  return { app, base: `${address}/api`, real, emu, dbName, redisPrefix, shutdown }
}
