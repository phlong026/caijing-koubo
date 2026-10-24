import { fromDb } from '../../lib/time.js'
import type { PublishLog } from './types.js'

/** publish_log 行映射（plans.ts / records.ts 共用） */

export function safeTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v) {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return []
}

export function mapLog(r: Record<string, any>): PublishLog {
  return {
    id: r.id,
    planId: r.plan_id ?? null,
    platform: r.platform,
    accountId: r.account_id,
    source: r.source ?? 'auto',
    status: r.status,
    attempt: r.attempt,
    title: r.title ?? null,
    description: r.description ?? null,
    tags: safeTags(r.tags),
    coverObjectKey: r.cover_object_key ?? null,
    scheduledAt: fromDb(r.scheduled_at),
    retryAt: fromDb(r.retry_at),
    startedAt: fromDb(r.started_at),
    finishedAt: fromDb(r.finished_at),
    windowExpiresAt: fromDb(r.window_expires_at),
    videoUrl: r.video_url ?? null,
    externalVideoId: r.external_video_id ?? null,
    errorCode: r.error_code ?? null,
    errorMessage: r.error_message ?? null,
    createdAt: fromDb(r.created_at),
    updatedAt: fromDb(r.updated_at),
  }
}
