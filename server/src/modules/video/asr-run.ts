import { hasDashScope } from '../../config.js'
import { logger } from '../../log.js'
import * as asr from '../../integrations/dashscope/asr.js'

/**
 * ASR 调用封装（FR-P5）：submitTask → waitForResult，统一超时与错误信息。
 * 真实 / mock 由 dashscope 模块按密钥与 MOCK_FALLBACK 决定（V13）。
 */

export async function asrSubmitAndWait(
  fileUrl: string,
  ref: { type: string; id: string },
): Promise<asr.AsrResult> {
  const taskId = await asr.submitTask(fileUrl, ref)
  try {
    return await asr.waitForResult(taskId, {
      intervalMs: 2000,
      timeoutMs: hasDashScope() ? undefined : 10_000,
    })
  } catch (e) {
    logger.warn({ err: (e as Error).message, jobId: ref.id }, 'video.asr_failed')
    throw e
  }
}
