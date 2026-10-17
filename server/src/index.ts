import { buildApp } from './app.js'
import { closeAll, initDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { config } from './config.js'
import { logger } from './log.js'
import { closeQueues, warnIfQueuePrefixShared } from './queue/index.js'
import { registerNewsJobs, triggerFetch } from './modules/news/jobs.js'
import { registerTopicJobs } from './modules/topics/jobs.js'
import { registerBenchmarkJobs } from './modules/benchmark/sweep.js'
import { registerExtractWorker } from './modules/benchmark/extract.js'
import { registerCopyWorker } from './modules/copy/worker.js'
import { checkFfmpeg } from './media/pipeline.js'
import { ossStatus } from './integrations/aliyun-oss/client.js'
import { describeUpstream } from './integrations/tikhub/client.js'

/**
 * 全局异常兜底。
 *
 * 教训：接入 FinStep 后进程曾因一次 TLS 握手失败（网络抖动）直接退出（http=000）。
 * Node 默认行为是「未捕获异常 = 进程终止」，对一个长驻采集服务来说这是错的：
 * 一次外部网络抖动不该让整个后端消失。这里改成「记录 + 存活」，
 * 只有显式触发 shutdown 才退出。
 *
 * 注意：这不代表可以吞掉错误——未捕获异常通常意味着状态可能不一致，
 * 所以一律以 error 级别记录堆栈，便于事后排查。
 */
function installGlobalHandlers(): void {
  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack, kind: 'uncaughtException' }, 'server.uncaught_exception')
    // 进程已处于不确定状态，但仍继续服务；由外部监控按日志频次告警
  })
  process.on('unhandledRejection', (reason) => {
    const e = reason instanceof Error ? reason : new Error(String(reason))
    logger.error({ err: e.message, stack: e.stack, kind: 'unhandledRejection' }, 'server.unhandled_rejection')
  })
}

async function main(): Promise<void> {
  installGlobalHandlers()
  const db = await initDb()
  await runMigrations(db)

  // D9：server 进程须具备 ffmpeg 与可写临时目录
  const ffmpeg = await checkFfmpeg()
  const oss = await ossStatus()
  logger.info(
    {
      db: db.kind,
      ffmpeg: ffmpeg.ok ? `ok ${ffmpeg.version ?? ''}` : ffmpeg.error,
      oss: oss.enabled ? `bucket=${oss.bucket}` : 'mock 本地目录',
      tikhub: describeUpstream(),
      extractMode: config.extract.mode,
    },
    'env.check',
  )

  // 任务统一由 server 内 BullMQ 承载（D9）
  // 先做队列前缀冲突自检：两个实例连不同库却共用同一 Redis 前缀时，
  // job 会被「错误的那个实例」消费，表现为任务永远 pending（数据写入另一份库）。
  await warnIfQueuePrefixShared()
  await registerNewsJobs()
  await registerTopicJobs()
  await registerBenchmarkJobs()
  await registerExtractWorker()
  // 文案工坊生成队列（W2）
  registerCopyWorker()

  const app = await buildApp()
  await app.listen({ port: config.port, host: config.host })
  logger.info({ url: `http://${config.host}:${config.port}/api`, health: `http://${config.host}:${config.port}/health` }, 'server.ready')

  // 启动即采集一次，便于本地验证（定时任务随后按 15min 周期运行）
  await triggerFetch('boot').catch((e) => logger.error({ err: (e as Error).message }, 'boot.fetch_failed'))

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'server.shutdown')
    try {
      await app.close()
    } catch {}
    await closeQueues()
    await closeAll()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((e) => {
  logger.error({ err: (e as Error).message, stack: (e as Error).stack }, 'server.failed')
  process.exit(1)
})
