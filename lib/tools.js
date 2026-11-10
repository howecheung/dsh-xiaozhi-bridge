/**
 * 工具面：
 *   1) 发布给小智（MCP 接入点侧）的工具 —— 机器人用语音调用
 *   2) 注册到 DSH（Host 侧）的工具 —— 用户在 DSH 里查看/操作桥接
 */

/** 发布给小智的工具定义（MCP tools/list 用的形状） */
export const ROBOT_TOOLS = [
  {
    name: 'dsh_chat',
    description:
      '把一句话交给本机的 DeepSeek Harness（DSH）执行，并把最终回复文本返回。' +
      '适合让机器人调用本机的 AI 能力：读写文件、跑脚本、查资料、写文档、执行多步骤任务。' +
      '参数 message 为完整的中文/英文指令；reply 为 DSH 的回答，可直接朗读给用户。' +
      '(Send a request to the local DeepSeek Harness agent and return its final reply text.)',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '要交给 DSH 执行的完整指令（自然语言，可多步）。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '最长等待秒数（默认 180，最大 1800）。任务较久时适当调大。',
        },
        newSession: {
          type: 'boolean',
          description: 'true = 开启全新会话（不保留上文上下文）；默认 false 延续上一次对话。',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_status',
    description:
      '返回本机 DSH 桥接状态：接入点是否已连接、已发布哪些工具、工作目录、工具调用次数。' +
      '当机器人不确定 DSH 是否可用时调用。' +
      '(Report the local DSH bridge status: connection state, published tools, working directory.)',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
]

/** 语音场景的字数上限：太长机器人读不完，也会把上下文撑爆 */
const VOICE_LIMIT = 1200

/**
 * 把 DSH 的长回复压成适合朗读的一段话：
 * 折叠连续空行 → 按句末标点截到 limit 以内 → 追加省略提示。
 */
function forVoice(text, limit = VOICE_LIMIT) {
  const flat = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (flat.length <= limit) return flat
  const cut = flat.slice(0, limit)
  const lastStop = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('；'),
    cut.lastIndexOf('. '),
  )
  const head = lastStop > limit * 0.6 ? cut.slice(0, lastStop + 1) : cut
  return `${head}\n\n（内容较长，以上为前 ${head.length} 字的摘要；完整结果已留在本机 DSH 会话里。）`
}

/**
 * MCP 工具调用分发
 * @param {{ chat: (message: string, options: object) => Promise<string>, status: () => Promise<string> }} runner
 */
export function createRobotToolHandlers(runner) {
  return {
    async dsh_chat(args) {
      const message = String(args?.message ?? '').trim()
      if (!message) throw new Error('参数 message 不能为空')
      const reply = await runner.chat(message, {
        timeoutSeconds: args?.timeoutSeconds,
        newSession: args?.newSession === true,
      })
      return forVoice(reply)
    },
    async dsh_status() {
      return runner.status()
    },
  }
}

/** 注册到 DSH 侧的 Host 工具（给用户在 DSH 里用） */
export function registerHostTools(ctx, api) {
  const output = {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        message: { type: 'string' },
        detail: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'message'],
      additionalProperties: true,
    },
    render(args, value) {
      const lines = [value.message]
      for (const [key, val] of Object.entries(value.detail ?? {})) {
        lines.push(`- ${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }

  ctx.tools.register({
    name: 'xiaozhi_bridge_status',
    description:
      '查看小智 MCP × DSH 桥接状态：小智接入点连接情况、已发布的 MCP 工具、最近工具调用与错误。' +
      '用户问「机器人连上了吗」「桥接状态」「小智能体能不能用」时使用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    async execute() {
      const detail = await api.status()
      return {
        ok: true,
        message:
          detail?.enabled === false
            ? '服务开关处于关闭状态，机器人无法调用本机 DSH'
            : detail?.state?.connected
              ? '桥接已连接小智接入点'
              : '桥接未连接小智接入点',
        detail,
      }
    },
  })

  ctx.tools.register({
    name: 'xiaozhi_bridge_reconnect',
    description:
      '重新连接小智 MCP 接入点（用于接入点地址变更或连接异常后手动重连）。' +
      '若服务开关处于关闭状态，会先把服务打开再重连。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    async execute() {
      const detail = await api.reconnect()
      return { ok: true, message: '已触发重新连接', detail }
    },
  })

  ctx.tools.register({
    name: 'xiaozhi_bridge_set_service',
    description:
      '启动或关闭小智 MCP × DSH 桥接服务。关闭后机器人无法调用本机 DSH（设置页的开关状态会被记住）。' +
      '用户说「关掉机器人桥接」「打开小智桥接服务」时使用。',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true = 启动服务，false = 关闭服务' },
      },
      required: ['enabled'],
      additionalProperties: false,
    },
    output,
    async execute(args) {
      const enabled = args?.enabled !== false
      const detail = await api.setEnabled(enabled)
      return { ok: true, message: enabled ? '服务已开启' : '服务已关闭', detail }
    },
  })

  ctx.tools.register({
    name: 'xiaozhi_bridge_set_autostart',
    description:
      '设置小智 MCP × DSH 桥接的「启动自启」。开启后 DeepSeek Harness 每次启动会自动连接小智接入点；' +
      '关闭后每次重启 DSH 服务都处于关闭状态，需要手动打开。',
    parameters: {
      type: 'object',
      properties: {
        autoStart: { type: 'boolean', description: 'true = 随 DSH 启动自动连接，false = 关闭自启' },
      },
      required: ['autoStart'],
      additionalProperties: false,
    },
    output,
    async execute(args) {
      const autoStart = args?.autoStart !== false
      const detail = await api.setAutoStart(autoStart)
      return {
        ok: true,
        message: autoStart ? '已开启启动自启：DSH 启动后将自动连接接入点' : '已关闭启动自启：重启 DSH 后需手动打开服务',
        detail,
      }
    },
  })
}
