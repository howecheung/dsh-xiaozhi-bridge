/**
 * 设置页 ↔ Host 的 RPC 通道。
 *
 * 客户端（设置 → 插件 → 小智桥接 页签）通过 connection.rpc.call 调这里，
 * Host 通过 connection.rpc.handle 注册。通道名与端点名必须两端一致。
 */

export const RPC_CHANNEL = '/dsh-xiaozhi'

export const RPC_ENDPOINTS = {
  /** 读配置 + 桥接状态 */
  status: 'xiaozhi.status',
  /** 保存配置（保存后自动重连） */
  saveConfig: 'xiaozhi.config.save',
  /** 手动重连接入点 */
  reconnect: 'xiaozhi.reconnect',
  /** 服务开关：启停接入点桥接（payload: {enabled: boolean}） */
  setEnabled: 'xiaozhi.service.setEnabled',
  /** 启动自启开关（payload: {autoStart: boolean}） */
  setAutoStart: 'xiaozhi.service.setAutoStart',
  /** 自检：把一句话交给本机 DSH 跑一遍 */
  testChat: 'xiaozhi.testChat',
}

/**
 * 给客户端看的配置：token 不外泄，只告诉它「有没有」。
 * @param {object} config
 */
export function publicConfig(config) {
  return {
    endpoint: String(config?.endpoint ?? '').trim(),
    hasToken: Boolean(String(config?.token ?? '').trim()),
    enabled: config?.enabled === true,
    autoStart: config?.autoStart === true,
    autoReconnect: config?.autoReconnect !== false,
    cwd: String(config?.cwd ?? '').trim(),
    timeoutSeconds: Number(config?.timeoutSeconds) || 180,
  }
}

/** 把 URL 里的 token 抹掉，避免经 RPC 泄到浏览器 */
export function maskUrl(url) {
  return String(url ?? '').replace(/([?&]token=)[^&]*/i, '$1***')
}

/**
 * 从用户粘贴的地址里拆出 token（用户可能把整条带 token 的 URL 贴进来）。
 * @param {string} endpoint
 */
export function splitToken(endpoint) {
  const text = String(endpoint ?? '')
  const match = /([?&])token=([^&]*)/i.exec(text)
  if (!match) return { endpoint: text.trim(), token: '' }
  let token = match[2]
  try {
    token = decodeURIComponent(token)
  } catch {
    /* 保留原样 */
  }
  const cleaned = text
    .replace(/([?&])token=[^&]*/i, '$1')
    .replace(/[?&]+\s*$/, '')
    .replace(/\?&/g, '?')
    .trim()
  return { endpoint: cleaned, token }
}

/**
 * 失败信封：客户端 parseConnectionResponse 会校验 error.details 是对象，
 * 少了 details 整个响应会被判为非法信封（TypeError），故这里固定带上。
 */
function fail(code, message) {
  return { ok: false, error: { code, message, details: { issues: [{ message }] } } }
}

/**
 * 生成 Host 侧 handler。
 * @param {{
 *   status: () => Promise<object>,
 *   saveConfig: (patch: object) => Promise<object>,
 *   reconnect: () => Promise<object>,
 *   setEnabled: (enabled: boolean) => Promise<object>,
 *   setAutoStart: (autoStart: boolean) => Promise<object>,
 *   testChat: (message: string) => Promise<string>,
 * }} api
 */
export function createRpcHandler(api) {
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case RPC_ENDPOINTS.status:
          return { ok: true, value: await api.status() }
        case RPC_ENDPOINTS.saveConfig:
          return { ok: true, value: await api.saveConfig(payload ?? {}) }
        case RPC_ENDPOINTS.reconnect:
          return { ok: true, value: await api.reconnect() }
        case RPC_ENDPOINTS.setEnabled: {
          const enabled = payload?.enabled === undefined ? true : Boolean(payload.enabled)
          return { ok: true, value: await api.setEnabled(enabled) }
        }
        case RPC_ENDPOINTS.setAutoStart: {
          const autoStart = payload?.autoStart === undefined ? true : Boolean(payload.autoStart)
          return { ok: true, value: await api.setAutoStart(autoStart) }
        }
        case RPC_ENDPOINTS.testChat: {
          const message = String(payload?.message ?? '').trim()
          if (!message) return fail('bad-request', '自检内容不能为空 | message is required')
          const text = await api.testChat(message)
          return { ok: true, value: { text: String(text ?? '') } }
        }
        default:
          return fail('bad-request', `Unknown endpoint: ${endpoint}`)
      }
    } catch (error) {
      return fail('bad-request', error?.message ?? String(error))
    }
  }
}
