import pino from 'pino'
import { config } from './config.js'

const prettyTarget = {
  target: 'pino-pretty',
  options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
}

export const logger = pino({
  level: config.logLevel,
  // LOG_FILE（桌面模式指向 userData/logs）：JSON 落文件；控制台保持原口径
  // （生产 = stdout JSON，开发 = pretty；桌面壳从 stdout 转发到自己的日志）
  transport: config.logFile
    ? {
        targets: [
          { target: 'pino/file', options: { destination: config.logFile, mkdir: true } },
          config.env === 'production'
            ? { target: 'pino/file', options: { destination: 1 } }
            : prettyTarget,
        ],
      }
    : config.env === 'production'
      ? undefined
      : prettyTarget,
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
