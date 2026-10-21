import { buildApp } from './app.js'
import { closeAll, initDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { ensureBootstrapAdmin } from './modules/auth/repo.js'
import { jwtSecret } from './modules/auth/tokens.js'
import { config } from './config.js'
import { logger } from './log.js'
import { closeQueues, setQueueBackend, warnIfQueuePrefixShared } from './queue/index.js'
import { registerNewsJobs, triggerFetch } from './modules/news/jobs.js'
import { registerTopicJobs } from './modules/topics/jobs.js'
import { registerBenchmarkJobs } from './modules/benchmark/sweep.js'
import { registerExtractWorker } from './modules/benchmark/extract.js'
import { registerCopyWorker } from './modules/copy/worker.js'
import { resumeStubSubmissions } from './modules/copy/review.js'
import { registerPersonaModule } from './modules/personas/index.js'
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

/**
 * 探测 Redis 是否可用（3 秒超时）。
 * 只用一次 PING，不做重连，避免把启动流程拖住。
 */
async function probeRedis(): Promise<boolean> {
  const { redis } = await import('./queue/index.js')
  try {
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ])
    return pong === 'PONG'
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'redis.probe_failed')
    return false
  }
}

async function main(): Promise<void> {
  installGlobalHandlers()
  const db = await initDb()
  await runMigrations(db)
  // P0-1：令牌密钥自检（生产缺失直接拒绝启动）+ 首个管理员
  jwtSecret()
  await ensureBootstrapAdmin()

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
      reviewStub: config.copy.reviewStubEnabled ? 'on（联调用，提交后自动模拟三关）' : 'off（等待真实审核模块回写）',
    },
    'env.check',
  )
  if (config.copyLlm.baseUrl && config.copyLlm.apiKey && !config.copyLlm.complianceApproved) {
    logger.warn(
      'copy_llm.not_approved：已配置 COPY_LLM_*（第三方模型中转），但未设置 COPY_LLM_COMPLIANCE_APPROVED=true，' +
        '文案生成已回退百炼。获得产品与合规书面批准后再开启。',
    )
  }
  if (config.copy.reviewStubEnabled && config.env === 'production') {
    logger.warn(
      'review.stub_enabled_in_production：生产环境开启了审核桩（REVIEW_STUB_ENABLED=true），' +
        '审核员可通过 /review/submissions/:id/decision 跳过真实三关直接裁决，请确认这是有意为之。',
    )
  }

  // 任务统一由 server 内 BullMQ 承载（D9）
  // 先做队列前缀冲突自检：两个实例连不同库却共用同一 Redis 前缀时，
  // job 会被「错误的那个实例」消费，表现为任务永远 pending（数据写入另一份库）。
  //
  // ⚠️ Redis 不可用时的降级策略（两级）：
  //
  //  ① 后端切到进程内队列（memory）：选题生成、视频提取、文案生成这些**核心异步链路
  //     照常可用**，日志与 /health 会标注 queue=memory（不持久化、单实例）。
  //     早期实现是「连不上就整块跳过队列注册」，结果是选题生成永久停在 pending、
  //     视频提取无法触发——恰好是本模块的主功能，降级等于不可用。
  //
  //  ② BullMQ 的 worker 在连不上时会无限重连并把事件循环占满，导致 listen() 永远等不到
  //     （表现为端口 502、日志刷 ECONNREFUSED），所以切到 memory 后必须确保不再创建
  //     任何 BullMQ 实例——下面的 register* 函数内部会走到 memEnqueue/memRegisterWorker。
  const redisOk = await probeRedis()
  setQueueBackend(redisOk ? 'redis' : 'memory')
  if (redisOk) {
    await warnIfQueuePrefixShared()
  } else {
    logger.error(
      { host: config.redis.host, port: config.redis.port },
      'queue.degraded：Redis 不可用，已切换到进程内队列（memory）。' +
        '异步链路（选题生成/视频提取/文案生成）仍可用，但任务不持久化——进程重启后未完成任务会丢失，' +
        '且仅本实例消费。请启动 Redis 后重启服务以恢复 BullMQ。',
    )
  }
  await registerNewsJobs()
  await registerTopicJobs()
  await registerBenchmarkJobs()
  await registerExtractWorker()
  // 文案工坊生成队列（W2）
  registerCopyWorker()
  // 人物库模块（PL4/PL5）：素材处理 / 克隆执行 / 授权到期扫描三类 worker + 每日排期
  // + 重启时 submitting→uncertain 扫描（R9）
  await registerPersonaModule().catch((e) =>
    logger.error({ err: (e as Error).message }, 'persona.module.register_failed'),
  )
  // 审核桩在进程内推进，重启后续推未走完三关的桩审核单（P2-19）
  await resumeStubSubmissions().catch((e) => logger.error({ err: (e as Error).message }, 'review.stub.resume_scan_failed'))

  const app = await buildApp()
  await app.listen({ port: config.port, host: config.host })
  logger.info({ url: `http://${config.host}:${config.port}/api`, health: `http://${config.host}:${config.port}/health` }, 'server.ready')

  // 启动即采集一次，便于本地验证（定时任务随后按 15min 周期运行）
  // Redis 不可用时直接跑 fetchAndStore（同步），不经过队列，保证 boot 仍有数据
  if (redisOk) {
    await triggerFetch('boot').catch((e) => logger.error({ err: (e as Error).message }, 'boot.fetch_failed'))
  } else {
    const { fetchAndStore } = await import('./modules/news/service.js')
    fetchAndStore()
      .then((o) => logger.info({ fetched: o.fetched, inserted: o.inserted, mode: 'sync-degraded' }, 'boot.fetch_done'))
      .catch((e) => logger.error({ err: (e as Error).message }, 'boot.fetch_failed'))
  }

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
