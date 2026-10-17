import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: config.logLevel,
  transport:
    config.env === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        },
  // 凭据不落日志：统一脱敏常见 key 字段
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.apiKey',
      '*.accessKeyId',
      '*.accessKeySecret',
      '*.password',
      '*.fileUrl',
    ],
    censor: '***',
  },
  base: { service: 'viral-topics-server' },
} as pino.LoggerOptions)

export function child(name: string) {
  return logger.child({ mod: name })
}
