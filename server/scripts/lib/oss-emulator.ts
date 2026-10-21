import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 本地 OSS 协议仿真（仅测试用）。
 *
 * 目的：沙箱 / CI 访问不到 aliyuncs.com，也没有真实 AccessKey，但要验证 ali-oss 这条代码路径
 * （put / 分片上传 / getStream + Range / 签名 URL / delete）。仿真按 OSS 签名 V1 真实校验
 * 请求头签名与 URL 签名（含过期），签名不对一律 403，因此「调用没抛错」不会掩盖配置或签名问题。
 *
 * 覆盖：PUT/GET/HEAD/DELETE 对象、Range(206/416)、Initiate/UploadPart/Complete/Abort 分片上传。
 * 不覆盖：ACL、版本控制、生命周期等。使用 CNAME 风格（路径即 key）：ali-oss 的 signatureUrl 拒绝 IP 端点，
 * 所以测试里端点用 http://localhost:<port> + cname=true。
 */

export interface StoredObject {
  body: Buffer
  contentType: string
  etag: string
}

export interface OssEmulator {
  endpoint: string
  bucket: string
  accessKeyId: string
  accessKeySecret: string
  objects: Map<string, StoredObject>
  /** 全部请求日志：用于断言「走了分片 / 带了 Range / 签名通过」 */
  requests: Array<{ method: string; key: string; query: string; range: string | null; auth: 'header' | 'query' | 'none'; status: number }>
  close(): Promise<void>
}

const SUB_RESOURCES = new Set([
  'acl', 'uploads', 'location', 'cors', 'logging', 'website', 'referer', 'lifecycle', 'delete', 'append',
  'tagging', 'objectMeta', 'uploadId', 'partNumber', 'security-token', 'position', 'img', 'style', 'styleName',
  'replication', 'replicationProgress', 'replicationLocation', 'cname', 'bucketInfo', 'comp', 'qos', 'live',
  'status', 'vod', 'startTime', 'endTime', 'symlink', 'x-oss-process', 'response-content-type',
  'response-content-language', 'response-expires', 'response-cache-control', 'response-content-disposition',
  'response-content-encoding', 'udf', 'udfName', 'udfImage', 'udfId', 'udfImageDesc', 'udfApplication',
  'comp', 'udfApplicationLog', 'restore', 'callback', 'callback-var', 'policy', 'encryption', 'versions',
  'versioning', 'versionId',
])

function canonicalResource(bucket: string, key: string, params: URLSearchParams): string {
  const subs: string[] = []
  for (const [k, v] of params) {
    if (SUB_RESOURCES.has(k)) subs.push(v === '' ? k : `${k}=${v}`)
  }
  subs.sort()
  return `/${bucket}/${key}${subs.length ? `?${subs.join('&')}` : ''}`
}

function canonicalOssHeaders(headers: http.IncomingHttpHeaders): string {
  return Object.keys(headers)
    .filter((k) => k.toLowerCase().startsWith('x-oss-'))
    .sort()
    .map((k) => `${k.toLowerCase()}:${String(headers[k]).trim()}\n`)
    .join('')
}

function hmacSha1(secret: string, data: string): string {
  return crypto.createHmac('sha1', secret).update(data).digest('base64')
}

function xmlError(res: http.ServerResponse, status: number, code: string, message: string): void {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><RequestId>EMU</RequestId><HostId>emulator</HostId></Error>`
  res.writeHead(status, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

export async function startOssEmulator(opts: { bucket?: string; accessKeyId?: string; accessKeySecret?: string } = {}): Promise<OssEmulator> {
  const bucket = opts.bucket ?? 'koubo-test'
  const accessKeyId = opts.accessKeyId ?? 'TESTAKID'
  const accessKeySecret = opts.accessKeySecret ?? 'testsecret'
  const objects = new Map<string, StoredObject>()
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer>; contentType: string }>()
  const requests: OssEmulator['requests'] = []

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://emulator')
    const method = req.method ?? 'GET'
    // CNAME / 虚拟主机风格：Bucket 由域名决定，路径即对象 key（单 Bucket 仿真，不看 Host）
    const key = decodeURIComponent(url.pathname).replace(/^\//, '')
    const log = (status: number, auth: 'header' | 'query' | 'none', key: string): void => {
      requests.push({ method, key, query: url.search, range: (req.headers.range as string) ?? null, auth, status })
    }
    const resource = canonicalResource(bucket, key, url.searchParams)

    // ── 鉴权：URL 签名或请求头签名，二选一，签名错 403，过期 403 ──
    let auth: 'header' | 'query' | 'none' = 'none'
    if (url.searchParams.has('Signature')) {
      auth = 'query'
      const expires = url.searchParams.get('Expires') ?? ''
      const stringToSign = `${method}\n\n\n${expires}\n${resource}`
      const expected = hmacSha1(accessKeySecret, stringToSign)
      if (url.searchParams.get('OSSAccessKeyId') !== accessKeyId || url.searchParams.get('Signature') !== expected) {
        log(403, auth, key)
        return xmlError(res, 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.')
      }
      if (Number(expires) * 1000 < Date.now()) {
        log(403, auth, key)
        return xmlError(res, 403, 'AccessDenied', 'Request has expired.')
      }
    } else if (typeof req.headers.authorization === 'string') {
      auth = 'header'
      const mm = /^OSS (.+?):(.+)$/.exec(req.headers.authorization)
      const date = (req.headers['x-oss-date'] as string) || (req.headers.date as string) || ''
      const stringToSign = [
        method,
        (req.headers['content-md5'] as string) ?? '',
        (req.headers['content-type'] as string) ?? '',
        date,
      ].join('\n') + '\n' + canonicalOssHeaders(req.headers) + resource
      const expected = hmacSha1(accessKeySecret, stringToSign)
      if (!mm || mm[1] !== accessKeyId || mm[2] !== expected) {
        log(403, auth, key)
        return xmlError(res, 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.')
      }
    } else {
      log(403, auth, key)
      return xmlError(res, 403, 'AccessDenied', 'Anonymous access is forbidden.')
    }

    const q = url.searchParams
    try {
      // ── 分片上传 ──
      if (method === 'POST' && q.has('uploads')) {
        const uploadId = crypto.randomBytes(8).toString('hex')
        uploads.set(uploadId, { key, parts: new Map(), contentType: (req.headers['content-type'] as string) ?? 'application/octet-stream' })
        const body = `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
        log(200, auth, key)
        res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) })
        return void res.end(body)
      }
      if (method === 'PUT' && q.has('partNumber') && q.has('uploadId')) {
        const up = uploads.get(q.get('uploadId')!)
        if (!up) {
          log(404, auth, key)
          return xmlError(res, 404, 'NoSuchUpload', 'The specified upload does not exist.')
        }
        const buf = await readBody(req)
        up.parts.set(Number(q.get('partNumber')), buf)
        log(200, auth, key)
        res.writeHead(200, { etag: `"${crypto.createHash('md5').update(buf).digest('hex').toUpperCase()}"`, 'content-length': 0 })
        return void res.end()
      }
      if (method === 'POST' && q.has('uploadId')) {
        const up = uploads.get(q.get('uploadId')!)
        if (!up) {
          log(404, auth, key)
          return xmlError(res, 404, 'NoSuchUpload', 'The specified upload does not exist.')
        }
        await readBody(req)
        const body = Buffer.concat([...up.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b))
        const etag = `"${crypto.createHash('md5').update(body).digest('hex').toUpperCase()}"`
        objects.set(up.key, { body, contentType: up.contentType, etag })
        uploads.delete(q.get('uploadId')!)
        const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`
        log(200, auth, key)
        res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(xml), etag })
        return void res.end(xml)
      }
      if (method === 'DELETE' && q.has('uploadId')) {
        uploads.delete(q.get('uploadId')!)
        log(204, auth, key)
        res.writeHead(204)
        return void res.end()
      }

      // ── 普通对象 ──
      if (method === 'PUT') {
        const buf = await readBody(req)
        const etag = `"${crypto.createHash('md5').update(buf).digest('hex').toUpperCase()}"`
        objects.set(key, { body: buf, contentType: (req.headers['content-type'] as string) ?? 'application/octet-stream', etag })
        log(200, auth, key)
        res.writeHead(200, { etag, 'content-length': 0 })
        return void res.end()
      }
      if (method === 'DELETE') {
        objects.delete(key)
        log(204, auth, key)
        res.writeHead(204)
        return void res.end()
      }
      if (method === 'GET' || method === 'HEAD') {
        const obj = objects.get(key)
        if (!obj) {
          log(404, auth, key)
          return xmlError(res, 404, 'NoSuchKey', 'The specified key does not exist.')
        }
        const total = obj.body.length
        const rg = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range as string) ?? '')
        if (rg) {
          let start = rg[1] === '' ? Math.max(0, total - Number(rg[2])) : Number(rg[1])
          let end = rg[1] === '' ? total - 1 : rg[2] === '' ? total - 1 : Math.min(Number(rg[2]), total - 1)
          if (start >= total || start > end) {
            log(416, auth, key)
            return xmlError(res, 416, 'InvalidRange', 'The requested range is not satisfiable.')
          }
          start = Math.max(0, start)
          end = Math.min(end, total - 1)
          const slice = obj.body.subarray(start, end + 1)
          log(206, auth, key)
          res.writeHead(206, {
            'content-type': obj.contentType,
            'content-length': slice.length,
            'content-range': `bytes ${start}-${end}/${total}`,
            etag: obj.etag,
            'accept-ranges': 'bytes',
          })
          return void res.end(method === 'HEAD' ? undefined : slice)
        }
        log(200, auth, key)
        res.writeHead(200, { 'content-type': obj.contentType, 'content-length': total, etag: obj.etag, 'accept-ranges': 'bytes' })
        return void res.end(method === 'HEAD' ? undefined : obj.body)
      }
      log(405, auth, key)
      return xmlError(res, 405, 'MethodNotAllowed', 'unsupported')
    } catch (e) {
      log(500, auth, key)
      return xmlError(res, 500, 'InternalError', (e as Error).message)
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    endpoint: `http://localhost:${port}`,
    bucket,
    accessKeyId,
    accessKeySecret,
    objects,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}
