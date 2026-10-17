import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import { config } from './config.js'
import { logger } from './log.js'
import { ApiError, isApiError } from './errors.js'
import { getDb } from './db/index.js'
import { redis, queueStats } from './queue/index.js'
import { registerRoutes } from './routes.js'
import { toDb, utcNow } from './lib/time.js'

/** 统一成功响应结构：{ ok: true, data } */
export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true as const, data }
}

/** D14：操作人取值 —— 请求头 X-Operator，缺省 ops */
export function operatorOf(req: FastifyRequest): string {
  const raw = req.headers['x-operator']
  const v = Array.isArray(raw) ? raw[0] : raw
  return (v && String(v).trim()) || config.defaultOperator
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    genReqId: (req) => String(req.headers['x-request-id'] ?? ''),
  })

  await app.register(cors, { origin: true, credentials: false })

  app.addHook('onRequest', async (req) => {
    req.operator = operatorOf(req)
  })

  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/health' || req.url === '/api/health') return
    logger.info(
      { method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime), op: req.operator },
      'http',
    )
  })

  app.setErrorHandler(async (error, _req, reply: FastifyReply) => {
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
    logger.error({ err: (error as Error).message, stack: (error as Error).stack }, 'http.error')
    return reply.status(500).send({
      ok: false,
      error: { code: 'internal', message: (error as Error).message || '服务内部错误' },
    })
  })

  app.setNotFoundHandler(async (req, reply) => {
    return reply.status(404).send({
      ok: false,
      error: { code: 'not_found', message: `接口不存在：${req.method} ${req.url}` },
    })
  })

  /** 健康检查：DB / Redis / 队列可观测（§2.4） */
  const healthHandler = async (_req: FastifyRequest, reply: FastifyReply) => {
    let redisUp = false
    try {
      redisUp = (await redis.ping()) === 'PONG'
    } catch {
      redisUp = false
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
    const queues = redisUp ? await queueStats().catch(() => ({})) : {}
    const healthy = dbUp && redisUp
    return reply.status(healthy ? 200 : 503).send(
      ok({
        status: healthy ? 'ok' : 'degraded',
        env: config.env,
        time: toDb(utcNow()),
        db: { up: dbUp, dialect },
        redis: { up: redisUp, host: config.redis.host, port: config.redis.port },
        queues,
      }),
    )
  }
  app.get('/health', healthHandler)
  app.get('/api/health', healthHandler)

  await app.register(registerRoutes, { prefix: '/api' })

  return app
}

export { ApiError }
