import { QUEUE_NAMES, enqueue, registerWorker } from '../../queue/index.js'
import { logger } from '../../log.js'
import { runGeneration } from './service.js'

export async function registerTopicJobs(): Promise<void> {
  registerWorker(
    QUEUE_NAMES.topicGenerate,
    async (job) => {
      const { batchId } = job.data as { batchId: string }
      await runGeneration(batchId)
      return { batchId }
    },
    { concurrency: 2 },
  )
}

export async function enqueueGeneration(batchId: string): Promise<void> {
  await enqueue(
    QUEUE_NAMES.topicGenerate,
    'generate',
    { batchId },
    { jobId: `gen-${batchId}`, attempts: 2, backoff: { type: 'exponential', delay: 3000 } },
  )
  logger.info({ batchId }, 'topic.queued')
}
