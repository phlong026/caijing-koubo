import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { config } from './config.js'
import { logger } from './log.js'
import { ApiError, isApiError } from './errors.js'
import { getDb } from './db/index.js'
import { getRedis, queueStats, getQueueBackend } from './queue/index.js'
import { registerRoutes } from './routes.js'
import { toDb, utcNow } from './lib/time.js'
import { UPLOAD_LIMITS } from './modules/personas/types.js'
import { registerAuthGuard } from './modules/auth/guard.js'

/** 统一成功响应结构：{ ok: true, data } */
export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true as const, data }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
}

export async function buildApp(opts: { staticDir?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    // P2-12：没有 x-request-id 时必须生成新 id，返回空串会让所有请求共用同一个 id
    genReqId: (req) => {
      const raw = req.headers['x-request-id']
      const v = Array.isArray(raw) ? raw[0] : raw
      return (v && String(v).trim()) || randomUUID()
    },
  })

  // P0-1：跨域只放行白名单来源（生产缺省为空 = 只允许同源访问）
  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
  })

  // P0-3：文章上传走 multipart；单文件 + 大小上限由各路由用 limits 覆盖
  // 注意：@fastify/multipart 的插件级 limits 会覆盖每次调用的 limits（deepmergeAll 后者胜），
  // 且 req.parts() 与 req.file() 各自新建 busboy 挂同一 raw 流、不能混用——
  // 因此这里按「全模块最大上传上限」设置全局 fileSize（分身素材 200MB），
  // 各素材类型的细分上限由路由在读流过程中自行判定（见 personas/routes.ts readMultipart）。
  // files 上限放宽到 20：素材库素材包导入支持一次投多个片段（ML2），单文件路由仍只取 files[0]。
  const multipartMaxBytes = Math.max(
    config.copy.articleMaxBytes,
    ...Object.values(UPLOAD_LIMITS).map((l) => l.maxBytes),
  )
  await app.register(multipart, {
    limits: { fileSize: multipartMaxBytes, files: 20, fields: 20 },
    throwFileSizeLimit: false,
  })

  // P0-1：登录与角色守卫（操作人取自令牌，不再信任请求头 X-Operator）
  registerAuthGuard(app)

  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/health' || req.url === '/api/health') return
    logger.info(
      { method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime), op: req.operator },
      'http',
    )
  })

  app.setErrorHandler(async (error, req, reply: FastifyReply) => {
    // P1-1：上传超限等在请求体读完之前就报错时，服务端会关闭该连接；
    // 显式告知客户端不要复用，否则下一个请求会在同一连接上遇到 ECONNRESET
    if (!req.raw.complete) reply.header('Connection', 'close')
    if (isApiError(error)) {
      return reply.status(error.status).send({
        ok: false,
        error: { code: error.code, message: error.message, details: error.details ?? null },
      })
    }
    const err = error as { statusCode?: number; validation?: unknown; message?: string; code?: string }
    if (err.validation) {
      return reply.status(400).send({
        ok: false,
        error: { code: 'bad_request', message: `参数校验失败：${err.message}`, details: err.validation },
      })
    }
    // P1-16：框架层的 4xx（400 JSON 解析失败 / 413 请求体过大 / 415 媒体类型不支持 /
    // 429 限流等）必须原样透传，否则会被改写成 500 并污染错误日志。
    const status = Number(err.statusCode ?? 0)
    if (status >= 400 && status < 500) {
      return reply.status(status).send({
        ok: false,
        error: { code: err.code ?? 'bad_request', message: err.message ?? '请求不合法' },
      })
    }
    logger.error({ err: (error as Error).message, stack: (error as Error).stack }, 'http.error')
    return reply.status(500).send({
      ok: false,
      error: { code: 'internal', message: (error as Error).message || '服务内部错误' },
    })
  })

  // 前端静态托管（桌面/单端口部署）：GET 非 /api 未命中时回 index.html（SPA history 路由）。
  // 手写而非 @fastify/static：Electron 内置 Node 20 不支持 require() ESM-only 依赖
  // （该插件链上的 content-disposition 等），自己读文件 + mime 最可控。
  const staticRoot = opts.staticDir ? path.resolve(opts.staticDir) : null
  app.setNotFoundHandler(async (req, reply) => {
    if (staticRoot && req.method === 'GET' && !req.url.startsWith('/api')) {
      const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0])
      // 路径穿越防护：normalize 后必须仍在 staticRoot 内
      let file = path.join(staticRoot, path.normalize(rel).replace(/^([.]{2}[\\/])+/, ''))
      if (!file.startsWith(staticRoot)) file = path.join(staticRoot, 'index.html')
      try {
        const st = await fsp.stat(file)
        if (!st.isFile()) throw new Error('not a file')
      } catch {
        file = path.join(staticRoot, 'index.html') // SPA history 路由回退
      }
      reply.header('content-type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
      // 带 hash 的构建产物可长缓存；index.html 必须每次校验
      if (file.startsWith(path.join(staticRoot, 'assets'))) reply.header('cache-control', 'public, max-age=31536000, immutable')
      else reply.header('cache-control', 'no-cache')
      return reply.send(fs.createReadStream(file))
    }
    return reply.status(404).send({
      ok: false,
      error: { code: 'not_found', message: `接口不存在：${req.method} ${req.url}` },
    })
  })

  /** 健康检查：DB / Redis / 队列可观测（§2.4） */
  const healthHandler = async (_req: FastifyRequest, reply: FastifyReply) => {
    // ⚠️ redis.ping() 在连接断开时**不会 reject**，而是挂在 ioredis 的无限重连上，
    // 导致 /health 永远不返回（表现为 http=000）。必须自己加超时。
    let redisUp = false
    // memory 后端（桌面模式）不建 Redis 连接，直接视为不可用
    if (getQueueBackend() === 'redis') {
      try {
        redisUp =
          (await Promise.race([
            getRedis().ping(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('redis ping timeout')), 1500)),
          ])) === 'PONG'
      } catch {
        redisUp = false
      }
    }
    let dbUp = false
    let dialect = 'unknown'
    try {
      const db = getDb()
      dialect = db.kind
      await db.get('SELECT 1 AS ok')
      dbUp = true
    } catch {
      dbUp = false
    }
    // 队列统计不再依赖 redisUp：内存后端下 queues 依然有意义（waiting/active/completed/failed）
    const queues = await queueStats().catch(() => ({}))
    const queueBackend = getQueueBackend()
    // AC-0.5：视频创作段的 ffmpeg/ffprobe 与飞影 / ASR 配置状态（脱敏，失败不阻断健康判定）
    const video = await import('./modules/video/routes.js')
      .then((m) => m.videoHealth())
      .catch(() => null)
    // 判定口径：**DB 可用即视为服务可用**（200）。
    // Redis 只影响「队列后端选型」：Redis 可用走 BullMQ（持久、跨进程），
    // 不可用则切进程内队列（memory）——异步链路仍可跑，但不持久化、仅单实例消费。
    // 因此 degraded 只表示「队列降级」，不代表功能缺失，不要让监控据此判死。
    const healthy = dbUp
    const degraded = dbUp && queueBackend === 'memory'
    return reply.status(healthy ? 200 : 503).send(
      ok({
        status: healthy ? (degraded ? 'degraded' : 'ok') : 'down',
        env: config.env,
        time: toDb(utcNow()),
        db: { up: dbUp, dialect },
        redis: { up: redisUp, host: config.redis.host, port: config.redis.port },
        queue: { backend: queueBackend, stats: queues },
        queues,
        video,
        ...(degraded
          ? {
              hint:
                '队列已降级为进程内队列（memory）：选题生成/视频提取/文案生成可用，' +
                '但任务不持久化、仅本实例消费。启动 Redis 后重启可恢复 BullMQ。',
            }
          : {}),
      }),
    )
  }
  app.get('/health', healthHandler)
  app.get('/api/health', healthHandler)

  await app.register(registerRoutes, { prefix: '/api' })

  return app
}

export { ApiError }
