import { buildApp } from './app.js'
import { closeAll, initDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { ensureBootstrapAdmin } from './modules/auth/repo.js'
import { jwtSecret } from './modules/auth/tokens.js'
import { config, hasOss, ossConfigIssues } from './config.js'
import { logger } from './log.js'
import { closeQueues, setQueueBackend, warnIfQueuePrefixShared } from './queue/index.js'
import { loadStartupSettings } from './modules/settings/service.js'
import { registerNewsJobs, triggerFetch } from './modules/news/jobs.js'
import { registerTopicJobs } from './modules/topics/jobs.js'
import { registerBenchmarkJobs } from './modules/benchmark/sweep.js'
import { registerExtractWorker } from './modules/benchmark/extract.js'
import { registerCopyWorker } from './modules/copy/worker.js'
import { resumeStubSubmissions } from './modules/copy/review.js'
import { registerPersonaModule } from './modules/personas/index.js'
import { bootstrapFonts } from './modules/material/fonts.js'
import { registerPublishModule } from './modules/publish/index.js'
import { checkFfmpeg } from './media/pipeline.js'
import { ossStatus } from './integrations/aliyun-oss/client.js'
import { describeUpstream } from './integrations/tikhub/client.js'
import { createBurstCounter } from './lib/burst.js'

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
 *
 * P3-5：偶发一次照旧「记录 + 存活」；但同一分钟内反复出现（默认 3 次，UNCAUGHT_EXIT_THRESHOLD），
 * 说明进程大概率已带着不一致的状态在跑，此时走优雅停机并以非 0 退出，交给守护进程重启。
 */
const uncaughtBurst = createBurstCounter(60_000)
let requestFatalShutdown: ((reason: string) => void) | null = null

function installGlobalHandlers(): void {
  const threshold = Math.max(0, Number(process.env.UNCAUGHT_EXIT_THRESHOLD ?? 3) || 0)
  // 日志 worker 线程已退出时 logger 本身会抛错；在异常处理器里再抛会形成新的未捕获异常，退回直接写 stderr
  const safeLog = (write: () => void, fallback: string) => {
    try {
      write()
    } catch {
      process.stderr.write(`${fallback}\n`)
    }
  }
  process.on('uncaughtException', (err) => {
    const recent = uncaughtBurst.hit()
    safeLog(
      () =>
        logger.error(
          { err: err.message, stack: err.stack, kind: 'uncaughtException', recentPerMinute: recent, exitThreshold: threshold || null },
          'server.uncaught_exception',
        ),
      `server.uncaught_exception (${recent}/min): ${err.stack ?? err.message}`,
    )
    if (!threshold || recent < threshold) return
    safeLog(
      () => logger.fatal({ recentPerMinute: recent, threshold }, 'server.uncaught_burst：一分钟内多次未捕获异常，主动退出交给守护进程重启'),
      `server.uncaught_burst: ${recent} uncaught exceptions within a minute, exiting`,
    )
    if (requestFatalShutdown) requestFatalShutdown('uncaughtException')
    else process.exit(1)
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
  // 用户中心保存的系统设置覆盖 .env：在一切消费方（OSS 自检 / 队列注册 / 服务注册）之前应用
  await loadStartupSettings(db)
  // 素材库 ML1/FR-F5：扫描 CUT_FONTS_DIR，手工放置的字体同步为未启用记录（幂等，失败不阻断启动）
  await bootstrapFonts().catch((e) => logger.warn({ err: (e as Error).message }, 'material.font.bootstrap_failed'))
  // P0-1：令牌密钥自检（生产缺失直接拒绝启动）+ 首个管理员
  jwtSecret()
  await ensureBootstrapAdmin()

  // OSS：半配置 / 内网签名等问题在启动时就暴露，而不是等到飞影拉取失败
  for (const issue of ossConfigIssues()) logger.warn({ issue }, 'oss.config_issue')
  logger.info(
    hasOss()
      ? { bucket: config.oss.bucket, region: config.oss.region, internal: config.oss.internal, endpoint: config.oss.endpoint || null }
      : { mode: 'local-fallback' },
    hasOss() ? 'oss.enabled' : 'oss.disabled_using_local_storage',
  )

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
  // 视频创作模块：video-generate worker + video-poll-sweep + 启动 reconcile（FR-P6）
  const { registerVideoModule } = await import('./modules/video/index.js')
  await registerVideoModule().catch((e) => logger.error({ err: (e as Error).message }, 'video.module.register_failed'))
  // 发布管理模块：publish-login worker + login/main 双 sweep（PU1；PU4 扩展 execute）
  await registerPublishModule().catch((e) => logger.error({ err: (e as Error).message }, 'publish.module.register_failed'))
  // 视频剪辑模块：video-cut worker + video-cut-sweep + 启动 reconcile（FR-J3）+ 媒体环境探测（AC-0.2）
  const { registerCutModule } = await import('./modules/cut/index.js')
  await registerCutModule().catch((e) => logger.error({ err: (e as Error).message }, 'cut.module.register_failed'))
  // 审核桩在进程内推进，重启后续推未走完三关的桩审核单（P2-19）
  await resumeStubSubmissions().catch((e) => logger.error({ err: (e as Error).message }, 'review.stub.resume_scan_failed'))
  // 校对台审核：补送未送出的审核单并轮询在审进度（未配置 JIAODUITAI_BASE_URL 时不启动）
  const { startJiaoduitaiSync } = await import('./modules/copy/jiaoduitai-sync.js')
  startJiaoduitaiSync()

  // P2-13c：临时文件每日清理（启动时先跑一次）
  const { cleanupTempFiles } = await import('./modules/copy/article.js')
  await cleanupTempFiles().catch((e) => logger.warn({ err: (e as Error).message }, 'temp.clean_failed'))
  setInterval(() => void cleanupTempFiles().catch(() => undefined), 24 * 3600 * 1000).unref()

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

  let shuttingDown = false
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal, exitCode }, 'server.shutdown')
    // P2-10：worker.close() 会等进行中的任务结束（提取轮询最长 15 分钟），停机必须有上限。
    // 被打断的任务由既有续跑逻辑接住：提取按 running + task_id 续轮询、审核桩续推、克隆由 poll_sweep 续上
    const forceMs = Math.max(1000, Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000) || 10_000)
    setTimeout(() => {
      logger.warn({ forceMs }, 'server.shutdown_forced：优雅停机超时，强制退出')
      process.exit(1)
    }, forceMs).unref()
    try {
      await app.close()
    } catch {}
    await closeQueues()
    await closeAll()
    process.exit(exitCode)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  requestFatalShutdown = (reason) => void shutdown(reason, 1)
}

main().catch((e) => {
  logger.error({ err: (e as Error).message, stack: (e as Error).stack }, 'server.failed')
  process.exit(1)
})
