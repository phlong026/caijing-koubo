import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { listPersonas } from './repo.js'

/** D13：M1 未就绪时为只读桩；接口与字段在 M1 落地后保持不变 */
export function registerPersonaRoutes(app: FastifyInstance): void {
  app.get('/personas', async (req) => {
    const q = (req.query ?? {}) as { includeDisabled?: string }
    const includeDisabled = q.includeDisabled === '1' || q.includeDisabled === 'true'
    return ok(await listPersonas(!includeDisabled))
  })
}
