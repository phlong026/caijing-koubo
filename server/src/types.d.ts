import 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    /** D14：操作人，取自请求头 X-Operator，缺省 ops */
    operator: string
  }
}
