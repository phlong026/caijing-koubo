import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config, paths } from '../../config.js'
import { logger } from '../../log.js'

/**
 * 令牌与口令（P0-1）。
 * - 令牌：HS256 JWT（node:crypto 实现，不引入新依赖）；
 * - 口令：scrypt + 随机盐，格式 `scrypt$<salt hex>$<hash hex>`，比较用 timingSafeEqual。
 */

export type Role = 'ops' | 'reviewer' | 'admin'

export interface TokenClaims {
  sub: string
  u: string
  r: Role
  /** token_version：改密 / 停用后 +1，旧令牌即失效 */
  tv: number
  iat: number
  exp: number
}

let secretCache: Buffer | null = null

/**
 * 生产必须显式配置 AUTH_JWT_SECRET；开发环境缺省时在 .data 下生成并持久化，
 * 避免每次重启都让所有人重新登录。
 */
export function jwtSecret(): Buffer {
  if (secretCache) return secretCache
  const configured = config.auth.jwtSecret
  if (configured) {
    if (configured.length < 32) throw new Error('AUTH_JWT_SECRET 至少 32 个字符')
    secretCache = Buffer.from(configured, 'utf8')
    return secretCache
  }
  if (config.env === 'production') {
    throw new Error('生产环境必须配置 AUTH_JWT_SECRET（至少 32 个字符），已拒绝启动')
  }
  const file = path.join(paths.dataDir, 'jwt-secret')
  try {
    secretCache = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'utf8')
    if (secretCache.length >= 32) return secretCache
  } catch {
    /* 首次启动：生成 */
  }
  fs.mkdirSync(paths.dataDir, { recursive: true })
  const generated = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, generated, { mode: 0o600 })
  logger.warn({ file }, 'auth.jwt_secret_generated：开发环境自动生成令牌密钥，生产请配置 AUTH_JWT_SECRET')
  secretCache = Buffer.from(generated, 'utf8')
  return secretCache
}

const b64url = (buf: Buffer) => buf.toString('base64url')

export function signToken(claims: Omit<TokenClaims, 'iat' | 'exp'>): { token: string; expiresAt: number } {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + Math.max(1, config.auth.tokenTtlHours) * 3600
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = b64url(Buffer.from(JSON.stringify({ ...claims, iat, exp })))
  const sig = b64url(crypto.createHmac('sha256', jwtSecret()).update(`${header}.${payload}`).digest())
  return { token: `${header}.${payload}.${sig}`, expiresAt: exp * 1000 }
}

/** 校验签名与有效期；任何异常都返回 null（调用方统一按未登录处理） */
export function verifyToken(token: string): TokenClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts as [string, string, string]
  const expected = crypto.createHmac('sha256', jwtSecret()).update(`${header}.${payload}`).digest()
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string }
    if (h.alg !== 'HS256') return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims
    if (!claims.sub || !claims.exp || claims.exp * 1000 <= Date.now()) return null
    return claims
  } catch {
    return null
  }
}

const SCRYPT_KEYLEN = 64

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = String(stored ?? '').split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return crypto.timingSafeEqual(actual, expected)
}

/** 口令强度：至少 8 位，且同时包含字母与数字 */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return '密码至少 8 位'
  if (password.length > 128) return '密码不能超过 128 位'
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码需同时包含字母和数字'
  return null
}
