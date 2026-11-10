/**
 * dsh-xiaozhi-bridge
 *
 * 把本机 DSH（DeepSeek Harness）以 MCP 工具的形式发布到小智 MCP 接入点，
 * 让使用小智 MCP 接入点的机器人（如 StackChan）用语音驱动桌面 AI。
 *
 * 角色：小智接入点会主动以 MCP 客户端身份连过来（实测 serverInfo=xz-mcp-broker），
 * 所以本地这端扮演 **MCP 服务端**：响应 initialize / tools/list / tools/call。
 *
 * 界面：设置 → 插件 → 小智桥接 页签（客户端面板通过 connection RPC 读写本插件）。
 */
import { XiaozhiBridge } from './lib/mcp-bridge.js'
import { loadConfig, saveConfig, composeUrl } from './lib/config-store.js'
import { ROBOT_TOOLS, createRobotToolHandlers, registerHostTools } from './lib/tools.js'
import { createDshRunner } from './lib/dsh-agent.js'
import {
  RPC_CHANNEL,
  createRpcHandler,
  publicConfig,
  maskUrl,
  splitToken,
} from './lib/rpc.js'
import { installWebRpc } from './lib/web-rpc.js'

export const name = 'xiaozhi-bridge'

/**
 * 依赖的 Host 服务：Agent 注册表、会话存储、默认模型、工具注册表、连接、HTTP 载体。
 * 'webServer' 必须显式 inject——设置页的 RPC 通道要自己挂在它上面。
 */
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'tools', 'connection', 'webServer']

export function apply(ctx) {
  const logger = ctx.logger('xiaozhi-bridge')
  const log = (level, message) => {
    try {
      const fn = typeof logger?.[level] === 'function' ? logger[level] : logger?.info
      fn?.call(logger, message)
    } catch {
      /* ignore */
    }
  }

  /** @type {object|null} */
  let config = null
  /** @type {XiaozhiBridge|null} */
  let bridge = null
  /** @type {ReturnType<typeof createDshRunner>|null} */
  let runner = null

  ctx.effect(() => async () => {
    try {
      bridge?.stop()
    } catch {
      /* ignore */
    }
    try {
      runner?.dispose()
    } catch {
      /* ignore */
    }
  })

  const getConfig = () => config ?? {}

  const composeStatus = () => ({
    /** 服务总开关（运行时状态；重启后按 autoStart 决定初始值） */
    enabled: config?.enabled === true,
    /** 启动自启：DSH 启动时自动连接接入点 */
    autoStart: config?.autoStart === true,
    config: publicConfig(config ?? {}),
    state: bridge
      ? {
          connected: bridge.state.connected,
          initialized: bridge.state.initialized,
          url: maskUrl(bridge.state.url),
          lastError: bridge.state.lastError,
          lastConnectAt: bridge.state.lastConnectAt,
          lastToolsAt: bridge.state.lastToolsAt,
          toolCalls: bridge.state.toolCalls,
          toolErrors: bridge.state.toolErrors,
          reconnects: bridge.state.reconnects,
          serverInfo: bridge.state.serverInfo,
        }
      : null,
    tools: ROBOT_TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
    agent: runner?.agentStatus?.() ?? null,
  })

  const statusText = () => {
    const status = composeStatus()
    const lines = [
      `服务开关：${status.enabled ? '已开启' : '已关闭'}`,
      `启动自启：${status.autoStart ? '已开启' : '已关闭'}`,
      `桥接连接：${status.state?.connected ? '已连接' : '未连接'}`,
      `握手完成：${status.state?.initialized ? '是' : '否'}`,
      `接入点：${status.config?.endpoint ?? '(未配置)'}`,
      `工作目录：${status.config?.cwd || '(默认)'}`,
      `已发布工具：${status.tools.map((tool) => tool.name).join(', ')}`,
      `工具调用：${status.state?.toolCalls ?? 0} 次（失败 ${status.state?.toolErrors ?? 0} 次）`,
      `DSH 会话：${status.agent?.sessionId ?? '(尚未创建)'}`,
      `DSH 模型：${status.agent?.model ?? '(未知)'}`,
    ]
    return lines.join('\n')
  }

  /**
   * 保存配置 → 重连桥接
   * token 语义：留空 = 不修改已保存的 token；地址里自带 token 时以地址为准。
   */
  const applyConfig = async (patch) => {
    const rawEndpoint = String(patch?.endpoint ?? config?.endpoint ?? '').trim()
    const parsed = splitToken(rawEndpoint)
    const patch2 = {
      endpoint: parsed.endpoint,
      autoReconnect: patch?.autoReconnect !== false,
      cwd: String(patch?.cwd ?? '').trim(),
      timeoutSeconds: Number(patch?.timeoutSeconds) || 180,
    }
    const incomingToken = String(patch?.token ?? '').trim() || parsed.token
    if (incomingToken) patch2.token = incomingToken

    config = await saveConfig(patch2)
    const url = composeUrl(config)
    if (bridge) {
      bridge.reconnect = config.autoReconnect !== false
      if (config.enabled === false) {
        // 服务开关关着：只保存配置，不重连
        bridge.stop()
        log('info', '配置已更新；服务开关为关闭状态，未重连接入点')
      } else {
        if (url !== bridge.url) bridge.setUrl(url)
        else bridge.restart()
        log('info', url ? '配置已更新，正在重连接入点' : '配置已更新（尚未填写接入点地址）')
      }
    }
    return config
  }

  /**
   * 服务总开关：启停接入点桥接。
   * 仅影响本次运行；重启桌面版后的初始状态由「启动自启」决定。
   */
  const setServiceEnabled = async (enabled) => {
    const next = Boolean(enabled)
    config = await saveConfig({ enabled: next })
    if (bridge) {
      bridge.reconnect = next && config.autoReconnect !== false
      const url = composeUrl(config)
      if (!next) {
        bridge.stop()
        log('info', '服务已关闭，机器人暂时无法调用本机 DSH')
      } else if (url) {
        bridge.restart()
        log('info', '服务已开启，正在连接小智接入点')
      } else {
        bridge.stop()
        log('warn', '服务已开启，但尚未配置接入点地址，请先填写地址')
      }
    }
    return composeStatus()
  }

  /**
   * 启动自启开关：
   * - 开启：DSH 启动时自动连接接入点（等同启动即开启服务）
   * - 关闭：每次重启 DSH 后服务保持关闭，需要在设置页手动打开
   */
  const setAutoStart = async (autoStart) => {
    const next = Boolean(autoStart)
    config = await saveConfig({ autoStart: next })
    if (next) {
      // 勾选自启即刻生效：把服务打开并连接
      await setServiceEnabled(true)
      log('info', '已开启启动自启：DSH 启动后将自动连接小智接入点')
    } else {
      log('info', '已关闭启动自启：下次重启 DSH 后服务将保持关闭，需手动打开')
    }
    return composeStatus()
  }

  // DSH 侧工具：查看/重连桥接（在 apply 同步注册，随插件生命周期注销）
  registerHostTools(ctx, {
    status: async () => composeStatus(),
    reconnect: async () => {
      // 服务处于关闭状态时，「重新连接」顺带把服务打开
      if (config?.enabled === false) {
        await setServiceEnabled(true)
      } else {
        bridge?.restart()
      }
      return composeStatus()
    },
    setEnabled: async (enabled) => setServiceEnabled(enabled),
    setAutoStart: async (autoStart) => setAutoStart(autoStart),
  })

  // ---- 机器人侧工具（小智 → DSH） --------------------------------------
  const handlers = createRobotToolHandlers({
    chat: async (message, options) => {
      if (!runner) throw new Error('DSH 驱动器尚未就绪')
      return runner.chat(message, options)
    },
    status: async () => statusText(),
  })

  const callTool = async (toolName, args) => {
    const handler = handlers[toolName]
    if (!handler) throw new Error(`未知工具：${toolName}`)
    const text = await handler(args ?? {})
    return { text: typeof text === 'string' ? text : JSON.stringify(text) }
  }

  // ---- 设置页 ↔ Host 的 RPC 通道 ---------------------------------------
  const rpcHandler = createRpcHandler({
    status: async () => composeStatus(),
    saveConfig: async (patch) => {
      await applyConfig(patch)
      return composeStatus()
    },
    reconnect: async () => {
      // 服务处于关闭状态时，「重新连接」顺带把服务打开
      if (config?.enabled === false) {
        return setServiceEnabled(true)
      }
      bridge?.restart()
      return composeStatus()
    },
    setEnabled: async (enabled) => setServiceEnabled(enabled),
    setAutoStart: async (autoStart) => setAutoStart(autoStart),
    testChat: async (message) => {
      if (!runner) throw new Error('DSH 驱动器尚未就绪')
      return runner.chat(message, { timeoutSeconds: 120 })
    },
  })

  ctx.effect(() => {
    let dispose = null
    try {
      dispose = installWebRpc(ctx, {
        channel: RPC_CHANNEL,
        handler: rpcHandler,
        log: (level, message) => log(level, message),
      })
    } catch (error) {
      log('warn', `设置页 RPC 通道注册失败：${error?.message ?? error}`)
    }
    if (!dispose) {
      log('warn', 'Host Web 服务不可用，设置页将无法使用 | webServer unavailable')
      return () => {}
    }
    return async () => {
      try {
        await dispose()
      } catch {
        /* ignore */
      }
    }
  }, 'dsh-xiaozhi: settings RPC channel')

  // ---- 初始化 -----------------------------------------------------------
  const boot = async () => {
    config = await loadConfig()

    // 启动态由「启动自启」决定：未开启自启时，重启 DSH 后服务保持关闭，需手动打开
    const autoStart = config.autoStart === true
    config = await saveConfig({ autoStart, enabled: autoStart })

    runner = createDshRunner({ ctx, log, getConfig })

    bridge = new XiaozhiBridge({
      url: composeUrl(config),
      tools: ROBOT_TOOLS,
      callTool,
      log,
      reconnect: config.autoReconnect !== false,
      onState: (state) => {
        if (state.connected && !state.initialized) log('info', '接入点已连接，等待握手')
      },
    })

    if (composeUrl(config)) {
      if (config.enabled === false) {
        bridge.stop()
        log('info', '服务开关为关闭状态，未连接接入点（可在「设置 → 插件 → 小智桥接」中开启，或勾选「启动自启」）')
      } else {
        bridge.start()
      }
    } else {
      log('warn', '尚未配置小智 MCP 接入点地址，请在「设置 → 插件 → 小智桥接」中填写')
    }
  }

  boot().catch((error) => {
    log('error', `初始化失败：${error?.message ?? error}`)
  })
}
