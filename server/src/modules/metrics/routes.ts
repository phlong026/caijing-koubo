import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { listCalls, summarizeCalls } from './call-log.js'

/** FR-C4 成本记录与汇总 */
export function registerCostRoutes(app: FastifyInstance): void {
  app.get('/api-calls/summary', async (req) => ok(await summarizeCalls((req.query ?? {}) as Record<string, unknown>)))
  app.get('/api-calls', async (req) => ok(await listCalls((req.query ?? {}) as Record<string, unknown>)))
}
