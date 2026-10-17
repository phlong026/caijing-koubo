import { registerWorker, QUEUE_NAMES } from '../../queue/index.js'
import { config } from '../../config.js'
import { logger } from '../../log.js'
import { runGeneration, runVariant } from './generation.js'

/**
 * `copy-generate` 队列 worker（FR-G2 / §7 可观测）。
 * 单个 job 的 data：{ generationId }；kind 由 generation 记录区分（generate | variant）。
 */
export function registerCopyWorker(): void {
  registerWorker(
    QUEUE_NAMES.copyGenerate,
    async (job) => {
      const { generationId } = job.data as { generationId: string }
      if (!generationId) return
      if (job.name === 'variant') {
        await runVariant(generationId)
      } else {
        await runGeneration(generationId)
      }
      logger.debug({ generationId, name: job.name }, 'copy.generate.job_done')
    },
    { concurrency: Math.max(1, config.copy.generateConcurrency) },
  )
}
