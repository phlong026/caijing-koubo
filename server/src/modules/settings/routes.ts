/**
 * 系统设置路由（用户中心 → 系统设置，仅管理员）。
 */
import type { FastifyInstance } from 'fastify'
import { ok } from '../../app.js'
import { getDb } from '../../db/index.js'
import { listSettings, saveSettings } from './service.js'

export function registerSettingRoutes(app: FastifyInstance): void {
  app.get('/settings', async () => ok(await listSettings(getDb())))

  app.put('/settings', async (req) => {
    const body = (req.body ?? {}) as { settings?: Array<{ key: string; value: string }> }
    return ok(await saveSettings(getDb(), body.settings ?? [], req.operator))
  })
}
