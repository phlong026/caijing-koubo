import 'fastify'
import type { AppUser } from './modules/auth/repo.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** 操作人：登录账号名（P0-1 起取自令牌，不再信任请求头 X-Operator）；未登录为 anonymous */
    operator: string
    /** 当前登录账号；公开接口未登录时为 null */
    user: AppUser | null
  }
}
