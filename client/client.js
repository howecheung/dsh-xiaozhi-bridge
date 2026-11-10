/**
 * 小智 MCP × DSH 桥接 —— 设置页 UI。
 *
 * 注册在「设置 → 插件」分区下的一个页签（settings.plugins.tab），
 * 宿主数据通过 connection RPC 向 Host 插件取，本文件不直接碰文件系统。
 */
window.__ModuleLoader__.load({
  id: 'dsh-xiaozhi-bridge',
  factory: (require) => {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var NS = 'xiaozhi-bridge'
    var CHANNEL = '/dsh-xiaozhi'
    var ENDPOINTS = {
      status: 'xiaozhi.status',
      saveConfig: 'xiaozhi.config.save',
      reconnect: 'xiaozhi.reconnect',
      setEnabled: 'xiaozhi.service.setEnabled',
      setAutoStart: 'xiaozhi.service.setAutoStart',
      testChat: 'xiaozhi.testChat',
    }

    var zh = {
      tabLabel: '小智桥接',
      nav: '小智桥接',
      title: '小智 MCP 桥接',
      subtitle: '把本机 DSH 发布成小智 MCP 接入点的工具，让机器人用语音驱动桌面 AI。',
      connected: '已连接',
      disconnected: '未连接',
      endpoint: '接入点地址',
      endpointHint: '小智控制台「智能体管理 → 配置角色 → 意图识别 → 编辑功能 → MCP 接入点」中的地址。',
      token: '接入 Token',
      tokenHint: '留空表示不修改已保存的 Token。',
      tokenSaved: '已保存',
      tokenMissing: '未设置',
      cwd: '工作目录',
      cwdHint: 'DSH 执行指令时使用的工作目录，留空则用当前会话工作区。',
      timeout: '单次最长等待（秒）',
      autoReconnect: '断线自动重连',
      service: '服务开关',
      serviceOn: '已开启',
      serviceOff: '已关闭',
      serviceStarted: '服务已开启，正在连接接入点…',
      serviceStopped: '服务已关闭，机器人暂时无法调用本机 DSH。',
      autoStart: '启动自启',
      autoStartHint: '开启后 DeepSeek Harness 每次启动会自动连接接入点；关闭则每次重启后需手动打开服务开关。',
      autoStartOn: '已开启启动自启',
      autoStartOff: '已关闭启动自启',
      serviceOffHint: '服务已关闭：重启 DSH 后需手动打开（或勾选「启动自启」）。',
      save: '保存并重连',
      saving: '保存中…',
      reconnect: '重新连接',
      saved: '已保存，正在重连接入点。',
      stateTitle: '连接状态',
      rowConnected: '连接',
      rowHandshake: '握手',
      rowLastConnect: '最近连接',
      rowLastTools: '最近拉取工具',
      rowToolCalls: '工具调用',
      rowReconnects: '重连次数',
      rowServer: '服务端',
      rowSession: 'DSH 会话',
      rowModel: 'DSH 模型',
      yes: '是',
      no: '否',
      dash: '—',
      toolsTitle: '已发布给机器人的工具',
      probeTitle: '自检',
      probeHint: '发一句话给本机 DSH，验证回路是否打通。',
      probePlaceholder: '例如：用一句话回答：桥接自检通过',
      probeSend: '发送',
      probing: '执行中…',
      never: '暂无',
      notConfigured: '尚未配置接入点地址，保存后即可连接。',
      error: '出错了：{err}',
    }

    var en = {
      tabLabel: 'Xiaozhi Bridge',
      nav: 'Xiaozhi Bridge',
      title: 'Xiaozhi MCP bridge',
      subtitle: 'Publishes the local DSH agent as tools on a Xiaozhi MCP endpoint so the robot can drive the desktop AI by voice.',
      connected: 'Connected',
      disconnected: 'Not connected',
      endpoint: 'Endpoint',
      endpointHint: 'The address shown in the Xiaozhi console under Agent management → Role → Intent recognition → Edit feature → MCP endpoint.',
      token: 'Access token',
      tokenHint: 'Leave empty to keep the saved token.',
      tokenSaved: 'saved',
      tokenMissing: 'not set',
      cwd: 'Working directory',
      cwdHint: 'Working directory the DSH agent uses. Empty means the current session workspace.',
      timeout: 'Timeout per call (seconds)',
      autoReconnect: 'Auto reconnect',
      service: 'Service',
      serviceOn: 'On',
      serviceOff: 'Off',
      serviceStarted: 'Service started. Connecting to the endpoint…',
      serviceStopped: 'Service stopped. The robot cannot call the local DSH for now.',
      autoStart: 'Auto start',
      autoStartHint: 'When on, DeepSeek Harness connects to the endpoint automatically on every launch. When off, the service stays off after each restart until you turn it on manually.',
      autoStartOn: 'Auto start enabled',
      autoStartOff: 'Auto start disabled',
      serviceOffHint: 'Service is off: after restarting DSH you must turn it on manually (or enable Auto start).',
      save: 'Save and reconnect',
      saving: 'Saving…',
      reconnect: 'Reconnect',
      saved: 'Saved. Reconnecting to the endpoint…',
      stateTitle: 'Connection state',
      rowConnected: 'Connection',
      rowHandshake: 'Handshake',
      rowLastConnect: 'Last connect',
      rowLastTools: 'Last tools/list',
      rowToolCalls: 'Tool calls',
      rowReconnects: 'Reconnects',
      rowServer: 'Server',
      rowSession: 'DSH session',
      rowModel: 'DSH model',
      yes: 'Yes',
      no: 'No',
      dash: '—',
      toolsTitle: 'Tools published to the robot',
      probeTitle: 'Self-test',
      probeHint: 'Send one sentence to the local DSH to check the whole loop.',
      probePlaceholder: 'e.g. Answer in one sentence: bridge self-test passed',
      probeSend: 'Send',
      probing: 'Running…',
      never: 'none yet',
      notConfigured: 'No endpoint configured yet. Fill it in and save to connect.',
      error: 'Error: {err}',
    }

    var styles = {
      card: {
        background: 'var(--dsw-alias-bg-layer-1,#fff)',
        border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
        borderRadius: 12,
        padding: '16px 20px',
      },
      title: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary,inherit)' },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#8b93a1)' },
      muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
      input: {
        font: 'inherit',
        height: 32,
        padding: '0 10px',
        width: '100%',
        maxWidth: 520,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2,#d1d5db)',
        background: 'var(--dsw-alias-bg-layer-1,#fff)',
        color: 'var(--dsw-alias-label-primary,inherit)',
        outline: 'none',
      },
      mono: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12 },
      primary: {
        font: 'inherit',
        cursor: 'pointer',
        border: 'none',
        background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        height: 34,
        padding: '0 18px',
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 500,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      btn: {
        font: 'inherit',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))',
        background: 'var(--dsw-alias-bg-layer-1,#fff)',
        color: 'var(--dsw-alias-label-primary,inherit)',
        height: 34,
        padding: '0 18px',
        borderRadius: 999,
        fontSize: 13,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        padding: '2px 10px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2,#d1d5db)',
        color: 'var(--dsw-alias-label-secondary,#6b7280)',
      },
      badgeOk: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        padding: '2px 10px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-state-success-border,#86efac)',
        color: 'var(--dsw-alias-state-success-primary,#15803d)',
      },
    }

    function fmt(t, key, vars) {
      var s = t(key)
      if (vars) {
        for (var kv of Object.entries(vars)) {
          s = String(s).split('{' + kv[0] + '}').join(String(kv[1]))
        }
      }
      return s
    }

    function errText(error) {
      if (!error) return ''
      if (typeof error === 'string') return error
      return error.message || String(error)
    }

    function timeText(value) {
      if (!value) return ''
      try {
        var d = new Date(value)
        if (Number.isNaN(d.getTime())) return String(value)
        return d.toLocaleString()
      } catch {
        return String(value)
      }
    }

    function XiaozhiBridgeTab(props) {
      var t = props.t
      var rpcCall = props.rpcCall
      var [status, setStatus] = useState(null)
      var [form, setForm] = useState(null)
      var [busy, setBusy] = useState(false)
      var [error, setError] = useState(null)
      var [notice, setNotice] = useState(null)
      var [probe, setProbe] = useState('')
      var [probeBusy, setProbeBusy] = useState(false)
      var [probeText, setProbeText] = useState(null)

      var call = useCallback(
        async function (endpoint, payload) {
          if (!rpcCall) throw new Error('Connection RPC unavailable')
          var res = await rpcCall(endpoint, payload)
          if (!res || !res.ok) {
            throw new Error((res && res.error && res.error.message) || 'RPC failed')
          }
          return res.value
        },
        [rpcCall],
      )

      var load = useCallback(
        async function () {
          try {
            var s = await call(ENDPOINTS.status, {})
            setStatus(s)
            setForm(function (prev) {
              if (prev) return prev
              var c = (s && s.config) || {}
              return {
                endpoint: c.endpoint || '',
                token: '',
                autoReconnect: c.autoReconnect !== false,
                autoStart: c.autoStart === true,
                cwd: c.cwd || '',
                timeoutSeconds: c.timeoutSeconds || 180,
              }
            })
          } catch (err) {
            setError(errText(err))
          }
        },
        [call],
      )

      useEffect(
        function () {
          load()
          var timer = setInterval(load, 3000)
          return function () {
            clearInterval(timer)
          }
        },
        [load],
      )

      var save = async function () {
        if (!form) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          var s = await call(ENDPOINTS.saveConfig, {
            endpoint: form.endpoint,
            token: form.token,
            autoReconnect: form.autoReconnect,
            cwd: form.cwd,
            timeoutSeconds: Number(form.timeoutSeconds) || 180,
          })
          setStatus(s)
          setForm(function (prev) {
            return prev ? { ...prev, token: '' } : prev
          })
          setNotice(t('saved'))
        } catch (err) {
          setError(errText(err))
        } finally {
          setBusy(false)
        }
      }

      var reconnect = async function () {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          var s = await call(ENDPOINTS.reconnect, {})
          setStatus(s)
        } catch (err) {
          setError(errText(err))
        } finally {
          setBusy(false)
        }
      }

      // 服务总开关：点了立即生效，状态存在 Host 侧，重启桌面版后保持
      var toggleService = async function () {
        var next = !(status && status.enabled !== false)
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          var s = await call(ENDPOINTS.setEnabled, { enabled: next })
          setStatus(s)
          setNotice(next ? t('serviceStarted') : t('serviceStopped'))
        } catch (err) {
          setError(errText(err))
        } finally {
          setBusy(false)
        }
      }

      // 启动自启：勾选后 DSH 启动即自动连接接入点；取消后下次重启需手动打开
      var toggleAutoStart = async function (value) {
        var next = Boolean(value)
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          var s = await call(ENDPOINTS.setAutoStart, { autoStart: next })
          setStatus(s)
          setForm(function (prev) {
            return prev ? { ...prev, autoStart: next } : prev
          })
          setNotice(next ? t('autoStartOn') : t('autoStartOff'))
        } catch (err) {
          setError(errText(err))
        } finally {
          setBusy(false)
        }
      }

      var runProbe = async function () {
        var text = String(probe || '').trim()
        if (!text) return
        setProbeBusy(true)
        setError(null)
        try {
          var res = await call(ENDPOINTS.testChat, { message: text })
          setProbeText((res && res.text) || '')
        } catch (err) {
          setError(errText(err))
          setProbeText(null)
        } finally {
          setProbeBusy(false)
        }
      }

      var state = (status && status.state) || null
      var cfg = (status && status.config) || null
      var agent = (status && status.agent) || null
      var tools = (status && status.tools) || []
      var connected = !!(state && state.connected)
      var serviceOn = !(status && status.enabled === false)
      var autoStartOn = !!(status ? status.autoStart === true : form && form.autoStart === true)

      function row(label, value) {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              padding: '5px 0',
              fontSize: 12,
            },
          },
          h(
            'span',
            { style: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', minWidth: 92 } },
            label,
          ),
          h(
            'span',
            { style: { color: 'var(--dsw-alias-label-primary,inherit)', wordBreak: 'break-all' } },
            value,
          ),
        )
      }

      function input(value, onChange, extra) {
        return h('input', {
          style: styles.input,
          value: value == null ? '' : String(value),
          onChange: function (event) {
            onChange(event.target.value)
          },
          ...(extra || {}),
        })
      }

      function field(label, hint, control) {
        return h(
          'div',
          { style: { marginTop: 14 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, label),
            hint ? h('span', { style: styles.hint }, hint) : null,
          ),
          h('div', { style: { marginTop: 6 } }, control),
        )
      }

      function switchControl(checked, onChange) {
        return h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            onClick: function () {
              onChange(!checked)
            },
            style: {
              font: 'inherit',
              cursor: 'pointer',
              width: 40,
              height: 22,
              borderRadius: 999,
              border: '1px solid var(--dsw-alias-border-l2,#d1d5db)',
              background: checked
                ? 'var(--dsw-alias-brand-primary,#4f6ef7)'
                : 'var(--dsw-alias-bg-layer-2,#f3f4f6)',
              position: 'relative',
              padding: 0,
            },
          },
          h('span', {
            style: {
              position: 'absolute',
              top: 2,
              left: checked ? 20 : 2,
              width: 16,
              height: 16,
              borderRadius: 999,
              background: '#fff',
              transition: 'left .15s ease',
            },
          }),
        )
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 } },
        // 头部
        h(
          'div',
          null,
          h('div', { style: styles.title }, t('title')),
          h('div', { style: { ...styles.muted, marginTop: 4 } }, t('subtitle')),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' } },
            h(
              'span',
              { style: connected ? styles.badgeOk : styles.badge },
              connected ? '● ' + t('connected') : '○ ' + t('disconnected'),
            ),
            h(
              'button',
              {
                style: styles.btn,
                height: 28,
                padding: '0 12px',
                fontSize: 12,
                disabled: busy,
                onClick: reconnect,
              },
              t('reconnect'),
            ),
            h(
              'span',
              {
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  marginLeft: 'auto',
                },
              },
              h('span', { style: styles.hint }, t('service')),
              switchControl(serviceOn, toggleService),
              h('span', { style: styles.hint }, serviceOn ? t('serviceOn') : t('serviceOff')),
            ),
          ),
        ),
        error
          ? h(
              'div',
              { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 12 } },
              fmt(t, 'error', { err: error }),
            )
          : null,
        notice
          ? h(
              'div',
              { style: { color: 'var(--dsw-alias-state-success-primary,#15803d)', fontSize: 12 } },
              notice,
            )
          : null,
        serviceOn
          ? null
          : h(
              'div',
              { style: { color: 'var(--dsw-alias-state-warning-primary,#b45309)', fontSize: 12 } },
              t('serviceOffHint'),
            ),
        // 配置
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, t('endpoint')),
          h(
            'div',
            { style: { ...styles.muted, marginTop: 4 } },
            cfg && cfg.endpoint ? t('endpointHint') : t('notConfigured'),
          ),
          form
            ? h(
                'div',
                null,
                field(
                  t('endpoint'),
                  null,
                  input(form.endpoint, function (value) {
                    setForm(function (prev) {
                      return { ...prev, endpoint: value }
                    })
                  }, { placeholder: 'wss://<your-endpoint>/mcp/' }),
                ),
                field(
                  t('token'),
                  cfg && cfg.hasToken ? t('tokenHint') + ' · ' + t('tokenSaved') : t('tokenHint'),
                  input(form.token, function (value) {
                    setForm(function (prev) {
                      return { ...prev, token: value }
                    })
                  }, {
                    type: 'password',
                    placeholder: cfg && cfg.hasToken ? '••••••' : '',
                    style: { ...styles.input, maxWidth: 520, fontFamily: 'ui-monospace,Menlo,monospace' },
                  }),
                ),
                field(
                  t('cwd'),
                  t('cwdHint'),
                  input(form.cwd, function (value) {
                    setForm(function (prev) {
                      return { ...prev, cwd: value }
                    })
                  }, { placeholder: 'D:\\AI Agent\\DeepSeek workplace' }),
                ),
                field(
                  t('timeout'),
                  null,
                  input(form.timeoutSeconds, function (value) {
                    setForm(function (prev) {
                      return { ...prev, timeoutSeconds: value }
                    })
                  }, { type: 'number', min: '30', max: '1800', style: { ...styles.input, maxWidth: 160 } }),
                ),
                field(
                  t('autoReconnect'),
                  null,
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                    switchControl(form.autoReconnect, function (value) {
                      setForm(function (prev) {
                        return { ...prev, autoReconnect: value }
                      })
                    }),
                    h(
                      'span',
                      { style: styles.hint },
                      form.autoReconnect ? t('yes') : t('no'),
                    ),
                  ),
                ),
                field(
                  t('autoStart'),
                  t('autoStartHint'),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                    switchControl(autoStartOn, toggleAutoStart),
                    h(
                      'span',
                      { style: styles.hint },
                      autoStartOn ? t('yes') : t('no'),
                    ),
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 16 } },
                  h(
                    'button',
                    { style: styles.primary, disabled: busy, onClick: save },
                    busy ? t('saving') : t('save'),
                  ),
                ),
              )
            : null,
        ),
        // 连接状态
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, t('stateTitle')),
          h(
            'div',
            { style: { marginTop: 8 } },
            row(t('rowConnected'), connected ? t('yes') : t('no')),
            row(t('service'), serviceOn ? t('yes') : t('no')),
            row(t('autoStart'), autoStartOn ? t('yes') : t('no')),
            row(t('rowHandshake'), state && state.initialized ? t('yes') : t('no')),
            row(t('rowLastConnect'), state && state.lastConnectAt ? timeText(state.lastConnectAt) : t('dash')),
            row(t('rowLastTools'), state && state.lastToolsAt ? timeText(state.lastToolsAt) : t('dash')),
            row(
              t('rowToolCalls'),
              state ? String(state.toolCalls ?? 0) + '（失败 ' + String(state.toolErrors ?? 0) + '）' : t('dash'),
            ),
            row(t('rowReconnects'), state ? String(state.reconnects ?? 0) : t('dash')),
            row(t('rowServer'), state && state.serverInfo ? String(state.serverInfo) : t('dash')),
            row(t('rowSession'), agent && agent.sessionId ? String(agent.sessionId) : t('never')),
            row(t('rowModel'), agent && agent.model ? String(agent.model) : t('dash')),
          ),
        ),
        // 已发布工具
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, t('toolsTitle')),
          h(
            'div',
            { style: { marginTop: 8 } },
            tools.length
              ? tools.map(function (tool) {
                  return h(
                    'div',
                    { key: tool.name, style: { padding: '6px 0' } },
                    h(
                      'div',
                      { style: { ...styles.mono, fontWeight: 600 } },
                      tool.name,
                    ),
                    h('div', { style: { ...styles.muted, marginTop: 2 } }, tool.description),
                  )
                })
              : h('div', { style: styles.muted }, t('never')),
          ),
        ),
        // 自检
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, t('probeTitle')),
          h('div', { style: { ...styles.muted, marginTop: 4 } }, t('probeHint')),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
            h('input', {
              style: { ...styles.input, flex: 1 },
              value: probe,
              placeholder: t('probePlaceholder'),
              onChange: function (event) {
                setProbe(event.target.value)
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') runProbe()
              },
            }),
            h(
              'button',
              { style: styles.btn, disabled: probeBusy, onClick: runProbe },
              probeBusy ? t('probing') : t('probeSend'),
            ),
          ),
          probeText
            ? h(
                'div',
                {
                  style: {
                    marginTop: 10,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
                    background: 'var(--dsw-alias-bg-layer-2,#f9fafb)',
                    fontSize: 12,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                  },
                },
                probeText,
              )
            : null,
        ),
      )
    }

    var inject = ['slots', 'connection', 'locale']

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh: zh, en: en }),
        'dsh-xiaozhi: dictionaries',
      )
      var t = ctx.locale.bind(NS)
      var rpcCall = function (endpoint, payload, signal) {
        return ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal)
      }
      ctx.slots.inject('settings.plugins.tab', () =>
        ctx.slots.register(
          {
            name: 'settings.plugins.tab',
            id: 'xiaozhi-bridge',
            order: 70,
            label: () => t('tabLabel'),
            locale: NS,
            inject: () => ({ rpcCall: rpcCall, t: t }),
          },
          XiaozhiBridgeTab,
        ),
      )
      // 同时在「设置」导航里挂一个独立分区（与 dsh-pocket 同款做法），
      // 保证任何设置版本下都能看到入口。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'xiaozhi-bridge',
            order: 70,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ rpcCall: rpcCall, t: t }),
          },
          XiaozhiBridgeTab,
        ),
      )
    }

    return { name: 'xiaozhi-bridge', inject: inject, apply: apply }
  },
})
