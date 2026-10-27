import { bootServer } from './boot.js'
import { logger } from './log.js'

bootServer().catch((e) => {
  logger.error({ err: (e as Error).message, stack: (e as Error).stack }, 'server.failed')
  process.exit(1)
})
