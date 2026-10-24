import path from 'node:path'

/**
 * 任务临时目录（FR-P9；♻ R3 平移 AI-Studio video-generation-media.mjs#resolveQueueDir）。
 * jobId 必须是安全字符，拒绝任何路径越界（AC-N3）；终态由调用方负责清理。
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export function resolveJobTempDir(tempRoot: string, jobId: string): string {
  if (!SAFE_ID.test(jobId)) {
    throw new Error(`非法的任务号：${jobId.slice(0, 32)}`)
  }
  const dir = path.resolve(tempRoot, 'video-jobs', jobId)
  const root = path.resolve(tempRoot)
  if (!dir.startsWith(root + path.sep)) {
    throw new Error('任务临时目录越界')
  }
  return dir
}
