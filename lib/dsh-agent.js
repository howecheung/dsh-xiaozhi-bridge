/**
 * 在 Host 插件内驱动一个 DSH Agent 跑完一轮对话。
 *
 * 依据官方 one-shot 驱动器 `dsh-headless/lib/index.js`（run() 第 127-168 行）：
 *   create → followup → whenIdle → sessions.flush → 从 session 事件里取最后一条 assistant 文本
 *
 * 说明：这里**不 import** 任何 @deepseek-ai/* 包 —— 插件以本地目录方式安装（link），
 * 裸包名解析不可靠；用到的 createUserMessage / installModelSelection 都是纯函数，
 * 按上游实现等价内联（见各函数注释）。
 */
import { randomUUID } from 'node:crypto'

/** 深冻结（对齐 dsh-llm 的 deepFreeze 语义） */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 构造一条用户消息（等价 dsh-llm 的 createUserMessage）：
 * `{...input, id: randomUUID(), role: 'user'}` 后深冻结。
 */
function createUserMessage(input) {
  return deepFreeze({
    ...structuredClone(input),
    id: randomUUID(),
    role: 'user',
  })
}

/**
 * 把模型选择绑到 Agent 的 prompt 组装与请求路由。
 * 等价 dsh-agent 的 installModelSelection —— 这里只保留路由必需的两个 waterfall：
 *   - system-prompt/assemble：把 provider/model 写进 prompt 变量
 *   - agent/request：把 provider/model/effort 写进请求配置
 * 上游还有一个「模型切换提示」waterfall（agent/pre-step），它只在同一 Agent
 * 中途换模型时追加一条提示；本插件的机器人会话是一次性创建、模型固定，
 * 该分支不会命中，故省略。
 */
function installModelSelection(agentCtx, selection) {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inherited, ...rest } = resolved
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}

/** 把 turn/end 的 reason 归一化成字符串 */
function reasonKind(reason) {
  if (reason === undefined || reason === null) return undefined
  if (typeof reason === 'string') return reason
  return reason.kind
}

/**
 * 创建机器人会话驱动器。
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {(level: string, message: string) => void} [options.log]
 * @param {() => object} [options.getConfig]
 */
export function createDshRunner({ ctx, log = () => {}, getConfig = () => ({}) }) {
  /** @type {{ agent: any, dispose: () => Promise<void> } | null} */
  let handle = null
  let lastError = null
  let lastUsedAt = null
  /** 当前 Agent 建立时使用的工作目录，用于判断配置变更后是否需要重建 */
  let lastCwd = null
  /** 串行化：同一条机器人会话不能被并发回合交叉写入 */
  let chain = Promise.resolve()

  const services = () => ({
    agents: ctx.get('agents'),
    sessions: ctx.get('sessions'),
    defaultModel: ctx.get('agentDefaultModel'),
  })

  function serialize(task) {
    const run = chain.then(task)
    // 无论成功失败都推进队列，避免一次失败卡死后续调用
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function disposeAgent() {
    if (!handle) return
    const current = handle
    handle = null
    try {
      await current.dispose()
    } catch (error) {
      log('warn', `释放 Agent 失败：${error?.message ?? error}`)
    }
  }

  async function ensureAgent({ cwd, newSession }) {
    const cwdChanged = handle !== null && lastCwd !== cwd
    if (handle && !newSession && !cwdChanged) return handle
    await disposeAgent()

    const { agents, defaultModel } = services()
    if (agents?.create === undefined) throw new Error('DSH 的 agents 服务不可用')
    if (defaultModel?.currentSelection === undefined) throw new Error('DSH 的 agentDefaultModel 服务不可用')
    const selection = defaultModel.currentSelection()
    if (!selection?.provider || !selection?.model) {
      throw new Error('DSH 未设置默认模型（provider/model 为空），请先在 DSH 里选好模型')
    }

    const created = await agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: cwd ? { cwd } : {},
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
      },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      },
    })
    handle = created
    lastCwd = cwd
    await created.agent.whenIdle()
    log('info', `已创建机器人会话 ${created.agent.session.id}（${selection.provider}/${selection.model}）`)
    return created
  }

  /** 用超时包装一个 promise；超时后取消 Agent */
  async function withTimeout(promise, seconds, agent) {
    let timer = null
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            try {
              agent.cancel({ kind: 'user' })
            } catch {
              /* ignore */
            }
            reject(new Error(`任务超时（${seconds}s）`))
          }, seconds * 1000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 让 DSH 执行一句话，返回最终助手文本。
   * @param {string} message
   * @param {{ timeoutSeconds?: number, newSession?: boolean }} [options]
   * @returns {Promise<string>}
   */
  async function chatOnce(message, options = {}) {
    const config = getConfig() ?? {}
    const timeoutSeconds = Number(options.timeoutSeconds) > 0
      ? Number(options.timeoutSeconds)
      : Number(config.timeoutSeconds) > 0
        ? Number(config.timeoutSeconds)
        : 180
    const cwd = (options.cwd || config.cwd || '').trim()

    const created = await ensureAgent({ cwd, newSession: options.newSession === true })
    const agent = created.agent
    const firstSeq = agent.session.seq

    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: message }],
        source: { kind: 'user' },
      }),
    )

    await withTimeout(agent.whenIdle(), timeoutSeconds, agent)

    const { sessions } = services()
    if (sessions?.flush !== undefined) {
      try {
        await sessions.flush(agent.session)
      } catch {
        /* ignore */
      }
    }

    let text = ''
    let reason
    const events = agent.session.snapshotEvents?.(firstSeq) ?? []
    for (const event of events) {
      if (event.type === 'assistant/message') {
        const joined = (event.data?.message?.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        if (joined !== '') text = joined
      }
      if (event.type === 'turn/end') reason = event.data?.reason
    }

    lastUsedAt = new Date().toISOString()
    const kind = reasonKind(reason)
    if (kind && kind !== 'completed') {
      const detail = typeof reason === 'object' && reason?.error?.message ? `：${reason.error.message}` : ''
      lastError = `回合结束状态 ${kind}${detail}`
      if (text === '') text = `（本轮未能完成，原因：${kind}${detail}）`
    } else {
      lastError = null
    }
    if (text === '') text = '（DSH 没有产出文本回复）'
    return text
  }

  /** 对外入口：串行执行，避免并发回合互相打断 */
  function chat(message, options = {}) {
    return serialize(() => chatOnce(message, options))
  }

  /** Agent 侧状态（供配置页/DSH 工具展示） */
  function agentStatus() {
    const { defaultModel } = services()
    let selection = null
    try {
      selection = defaultModel?.currentSelection?.() ?? null
    } catch {
      selection = null
    }
    return {
      sessionId: handle?.agent?.session?.id ?? null,
      model: selection ? `${selection.provider}/${selection.model}` : null,
      lastUsedAt,
      lastError,
    }
  }

  return {
    chat,
    agentStatus,
    dispose: disposeAgent,
  }
}
