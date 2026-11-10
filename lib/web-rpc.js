/**
 * 设置页 ⇄ Host 的 HTTP RPC 通道（自建，不走 connection.rpc.handle）。
 *
 * 为什么不用 ctx.connection.rpc.handle()：
 *   该方法内部会访问 owner.webServer，而 owner（读到该服务的上下文）没有 inject
 *   'webServer' 时会抛 "cannot get property without inject"，于是通道压根没注册上；
 *   客户端的 POST 落到 SPA 兜底路由 → 405 Method Not Allowed
 *   （dsh-pocket 的 lib/web-rpc.js 头部注释记录了同样的坑，它改成自挂 webServer 路由）。
 *
 * 这里在插件自己 inject 的 webServer 上挂一条 prefix 路由，并逐字节复刻
 * dsh-client-connection 的 /api 传输语义：
 *   请求：POST {channel}/{endpoint}，body = {type:'client-request', rpcId, method, payload}
 *   响应：200 {type:'server-response', rpcId, result:{ok:true,value} | {ok:false,error}}
 *   错误信封必须带 details（客户端 parseConnectionResponse 会校验 error.details 是对象）。
 */

/** endpoint 段字符（与 dsh-client-connection 的 ENDPOINT_SEGMENT_PATTERN 对齐）。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** 单次请求体上限：8 MB（本插件只有 status/save/reconnect/testChat 等小控制 JSON）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * 从 `{channel}/{endpoint}` 路径里取出 endpoint，段非法时返回 undefined。
 */
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (
    endpoint
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))
  ) {
    return undefined
  }
  return endpoint
}

/**
 * 最小本机信任判定：Host 是回环地址、非跨站 fetch、Origin 与 Host 一致。
 * 桌面版 GUI 走 127.0.0.1，即使浏览器会话 cookie 不可用也能通过。
 */
function isLoopbackRequest(req) {
  const host = req.headers?.host
  if (!host) return false
  const hostName = host.split(':')[0]
  if (!LOOPBACK_HOSTNAMES.has(hostName)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

function errorResult(code, message) {
  return { ok: false, error: { code, message, details: { issues: [] } } }
}

/**
 * 在 ctx.webServer 上挂载 RPC 通道。
 *
 * 优先自建 webServer 路由（新版 dsh 的正常路径）；
 * 没有 webServer 服务时（headless 等）退回 ctx.connection.rpc.handle。
 *
 * @param {object} ctx Host 插件上下文（需 inject 'webServer' 与 'connection'）
 * @param {{
 *   channel: string,
 *   handler: (endpoint: string, payload: any) => Promise<{ok:boolean, value?:any, error?:object}>,
 *   log?: (level: string, message: string) => void,
 * }} options
 * @returns {(() => void)|null} 清理函数；两条路都不可用时返回 null
 */
export function installWebRpc(ctx, { channel, handler, log = () => {} }) {
  const webServer = ctx?.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    // 旧版 dsh / headless：退回官方 rpc.handle
    const rpc = ctx?.connection?.rpc
    if (rpc && typeof rpc.handle === 'function') {
      const dispose = rpc.handle(channel, handler)
      return typeof dispose === 'function' ? dispose : () => {}
    }
    return null
  }
  const connection = ctx?.connection

  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      // 1) 访问栅栏：优先用官方 requestRejection（401 未认证 / 403 不可信来源）。
      //    桌面版 GUI 与 Host 同机，若浏览器会话 cookie 未被识别，
      //    允许「本机回环 + 同源」请求通过；403（来源不可信）一律拒绝。
      let rejection
      try {
        // 必须以**方法形式**调用：HostConnectionService.requestRejection 是类方法，
        // 内部读 this.trustedHosts / this.browserAuth（dsh-pocket issue #117）。
        rejection = connection?.requestRejection?.(req)
      } catch {
        // 判定不了时退回本机回环判定（旧版 dsh 行为）。
        rejection = isLoopbackRequest(req) ? undefined : 403
      }
      const trusted = rejection === undefined || (rejection === 401 && isLoopbackRequest(req))
      if (!trusted) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }

      // 2) 读请求体
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413, { connection: 'close' })
          res.end()
          req.destroy()
          return
        }
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString('utf8')

      // 3) 路由与信封校验
      const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
      const endpoint = endpointFromPath(channel, pathname)
      if (req.method !== 'POST' || endpoint === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }

      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('body is not JSON')
        return
      }

      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
      const method = typeof body?.method === 'string' ? body.method : null
      if (rpcId === 'invalid-request' || method === null) {
        writeJson(res, 200, {
          type: 'server-response',
          rpcId: 'invalid-request',
          result: errorResult('bad-request', 'invalid client-request message'),
        })
        return
      }
      if (method !== endpoint) {
        writeJson(res, 200, {
          type: 'server-response',
          rpcId,
          result: errorResult(
            'bad-request',
            `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          ),
        })
        return
      }

      // 4) 交给业务 handler
      try {
        const result = await handler(endpoint, body.payload)
        writeJson(res, 200, { type: 'server-response', rpcId, result })
      } catch (error) {
        log('error', `RPC ${endpoint} 处理失败：${error?.message ?? error}`)
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('handler failure')
      }
    },
  }

  const registered = webServer.register(route)
  const cleanup = typeof registered === 'function' ? registered : () => {}
  return cleanup
}
