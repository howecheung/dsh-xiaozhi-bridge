/**
 * 小智 MCP 接入点桥接核心
 *
 * 协议要点（实测小智 MCP 接入点）：
 *   - 一条 WS text 帧 = 一条 JSON-RPC 2.0 消息（无 Content-Length 头，NDJSON 风格）。
 *   - 小智侧的 broker（serverInfo: xz-mcp-broker）**以 MCP 客户端身份**发起握手：
 *     broker → 我们：`initialize` 请求（capabilities: sampling / roots）
 *     我们 → broker：`initialize` 结果（capabilities: tools）
 *     broker → 我们：`notifications/initialized`
 *     broker → 我们：`tools/list` 请求 → 我们回工具清单
 *     broker → 我们：`ping` → 我们回 `{}`
 *     broker → 我们：`tools/call` 请求（{name, arguments}）→ 我们回
 *               `{content:[{type:'text',text}], isError}`
 *
 * 因此本地这端扮演 **MCP 服务端**（不是客户端），也不主动发 initialize。
 */
import { setTimeout as delay } from 'node:timers/promises'

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]

export class XiaozhiBridge {
  /**
   * @param {object} options
   * @param {string} options.url            接入点地址（wss://...）
   * @param {Array}  options.tools          MCP 工具定义数组 [{name, description, inputSchema}]
   * @param {(name: string, args: object, meta: object) => Promise<{text: string, isError?: boolean}>} options.callTool
   * @param {(level: string, message: string) => void} [options.log]
   * @param {(state: object) => void} [options.onState]
   */
  constructor(options) {
    this.url = options.url
    this.tools = options.tools ?? []
    this.callTool = options.callTool
    this.log = options.log ?? (() => {})
    this.onState = options.onState ?? (() => {})
    this.reconnect = options.reconnect !== false
    this.maxReconnectDelay = options.maxReconnectDelay ?? 60000

    this.ws = null
    this.closed = false
    this.reconnectAttempt = 0
    this.reconnectTimer = null
    this.pending = new Map()
    this.nextId = 1

    this.state = {
      connected: false,
      initialized: false,
      url: this.url,
      lastError: null,
      lastConnectAt: null,
      lastToolsAt: null,
      toolCalls: 0,
      toolErrors: 0,
      reconnects: 0,
      serverInfo: null,
    }
  }

  setUrl(url) {
    if (url === this.url) return
    this.url = url
    // stop() 会把 closed 置为 true，所以必须先 stop 再 restart，
    // 否则随后的 start() 会因 closed 为真直接返回，连接根本建立不起来。
    this.stop()
    this.restart()
  }

  start() {
    if (this.closed || !this.url) return
    this.#connect()
  }

  stop() {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const [, p] of this.pending) p.reject(new Error('bridge stopped'))
    this.pending.clear()
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this.#setState({ connected: false, initialized: false })
  }

  /** 重新连接（保存配置后调用） */
  restart() {
    this.closed = false
    this.reconnectAttempt = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this.#setState({ connected: false, initialized: false })
    this.#connect()
  }

  #connect() {
    if (this.closed) return
    let ws
    try {
      ws = new WebSocket(this.url)
    } catch (error) {
      this.#fail(`连接失败：${error.message}`)
      this.#scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0
      this.#setState({ connected: true, lastError: null, lastConnectAt: new Date().toISOString() })
      this.log('info', `已连接接入点 ${this.url}`)
    }

    ws.onmessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data)
      this.#handle(raw)
    }

    ws.onerror = () => {
      this.#setState({ lastError: 'WebSocket 错误' })
    }

    ws.onclose = (event) => {
      const wasConnected = this.state.connected
      this.ws = null
      this.#setState({ connected: false, initialized: false })
      if (this.closed) return
      if (wasConnected) this.log('warn', `接入点连接断开（code=${event?.code ?? '?'}）`)
      this.#scheduleReconnect()
    }
  }

  #scheduleReconnect() {
    if (!this.reconnect || this.closed) return
    const base = DEFAULT_RECONNECT_DELAYS[
      Math.min(this.reconnectAttempt, DEFAULT_RECONNECT_DELAYS.length - 1)
    ]
    const wait = Math.min(base, this.maxReconnectDelay)
    this.reconnectAttempt += 1
    this.#setState({ reconnects: this.state.reconnects + 1 })
    this.log('info', `${wait / 1000}s 后重连接入点（第 ${this.reconnectAttempt} 次）`)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.#connect()
    }, wait)
  }

  #fail(message) {
    this.#setState({ lastError: message })
    this.log('warn', message)
  }

  #setState(patch) {
    this.state = { ...this.state, ...patch }
    try { this.onState(this.state) } catch { /* ignore */ }
  }

  #handle(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      this.log('warn', `收到非 JSON 帧：${raw.slice(0, 120)}`)
      return
    }
    if (Array.isArray(msg)) {
      for (const item of msg) this.#handle(JSON.stringify(item))
      return
    }

    // 响应（对我们主动发出的请求的回应）：目前我们不主动发请求，忽略即可。
    if (msg.method === undefined) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        this.pending.delete(msg.id)
        if (msg.error) pending.reject(new Error(msg.error.message ?? 'remote error'))
        else pending.resolve(msg.result)
      }
      return
    }

    const respond = (result) => {
      if (msg.id === undefined) return
      this.#send({ jsonrpc: '2.0', id: msg.id, result })
    }

    switch (msg.method) {
      case 'initialize': {
        // 对端是 MCP 客户端（小智 broker），它的 clientInfo 才是我们想展示的「服务端」
        const client = msg.params?.clientInfo
        if (client?.name) {
          this.#setState({
            serverInfo: client.version ? `${client.name} ${client.version}` : String(client.name),
          })
        }
        respond({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'dsh-xiaozhi-bridge', version: '0.1.0' },
        })
        break
      }

      case 'notifications/initialized':
        this.#setState({ initialized: true })
        this.log('info', '接入点握手完成，工具已发布')
        break

      case 'ping':
        respond({})
        break

      case 'tools/list':
        this.#setState({ lastToolsAt: new Date().toISOString() })
        respond({ tools: this.tools })
        break

      case 'resources/list':
        respond({ resources: [] })
        break

      case 'prompts/list':
        respond({ prompts: [] })
        break

      case 'tools/call':
        this.#handleToolCall(msg)
        break

      case 'notifications/tools/list_changed':
        this.log('info', '接入点请求刷新工具清单')
        break

      default:
        if (msg.id !== undefined) {
          this.#send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `method not found: ${msg.method}` },
          })
        }
    }
  }

  async #handleToolCall(msg) {
    const name = msg.params?.name
    const args = msg.params?.arguments ?? {}
    const started = Date.now()
    this.#setState({ toolCalls: this.state.toolCalls + 1 })
    this.log('info', `工具调用 ${name} ${JSON.stringify(args).slice(0, 200)}`)
    try {
      const result = await this.callTool(name, args, { startedAt: started })
      const text = typeof result === 'string' ? result : (result?.text ?? JSON.stringify(result))
      this.#send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text }], isError: false },
      })
    } catch (error) {
      this.#setState({ toolErrors: this.state.toolErrors + 1 })
      this.log('warn', `工具 ${name} 执行失败：${error.message}`)
      this.#send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `执行失败：${error.message}` }],
          isError: true,
        },
      })
    }
  }

  #send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return
    try {
      this.ws.send(JSON.stringify(obj))
    } catch (error) {
      this.log('warn', `发送失败：${error.message}`)
    }
  }

  /** 主动发一个 JSON-RPC 请求（目前备用，用于未来需要服务端确认的场景） */
  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, timeoutMs)
    })
    this.#send({ jsonrpc: '2.0', id, method, params })
    return promise
  }
}

export { delay }
