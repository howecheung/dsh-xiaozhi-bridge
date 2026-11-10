# dsh-xiaozhi-bridge

把本机 **DeepSeek Harness（DSH）** 以 MCP 工具的形式发布到 **小智 MCP 接入点**，
让使用小智接入点的机器人（如 [StackChan](https://github.com/howecheung/stackchan)）用语音驱动桌面 AI。

- 插件包名 / 仓库名：`dsh-xiaozhi-bridge`
- 设置页入口：**设置 → 插件 → 小智桥接**
- 配置落盘：`~/.dsh/dsh-xiaozhi-bridge/config.json`（token 只存本地，不上传）

[English](README.en.md)

## 功能

| 能力 | 说明 |
| --- | --- |
| 语音驱动 | 机器人说一句「帮我总结这个文档」，工具调用本机 DSH 执行后把回复读回去 |
| 服务总开关 | 设置页页头一键启停；关闭后不再连接接入点，机器人调不到本机 DSH |
| 启动自启 | 可选。开启后 DSH 每次启动自动连接接入点；关闭时每次重启后需手动打开 |
| 断线重连 | 接入点断开后按退避策略自动重连（可关闭） |
| 工作目录 / 超时 | 指定 DSH Agent 的工作目录与单次调用最长等待秒数 |
| 自检 | 设置页一键发一句话给本机 DSH，验证回路是否打通 |

## 角色与协议

小智接入点（形如 `wss://<your-endpoint>/mcp/?token=…`）会**主动以 MCP 客户端身份**连过来
（实测 serverInfo = `xz-mcp-broker`），所以本地这端扮演 **MCP 服务端**：

```
broker → 我们 : initialize(id=0, capabilities:{sampling,roots})
我们 → broker : {protocolVersion:'2024-11-05', capabilities:{tools:{listChanged:true}}, serverInfo:{name:'dsh-xiaozhi-bridge'}}
broker → 我们 : notifications/initialized
broker → 我们 : tools/list(id=1)        → 我们回 { tools:[dsh_chat, dsh_status] }
broker → 我们 : tools/call(id,n)          → 我们回 {content:[{type:'text',text}], isError}
broker → 我们 : ping(id)                  → 我们回 {}
```

一条 WS text 帧 = 一条 JSON-RPC 2.0 消息（NDJSON 风格，无 Content-Length 头）。

## 发布给小智的工具

| 工具 | 作用 | 参数 |
| --- | --- | --- |
| `dsh_chat` | 把一句话交给本机 DSH 执行，返回最终回复（可直接朗读） | `message`（必填）、`timeoutSeconds`、`newSession` |
| `dsh_status` | 报告桥接连接状态、已发布工具、工作目录 | 无 |

## 注册到 DSH 的工具

| 工具 | 作用 |
| --- | --- |
| `xiaozhi_bridge_status` | 查看桥接状态（连接、工具、DSH 会话、模型） |
| `xiaozhi_bridge_reconnect` | 重新连接接入点（服务开关关闭时会先打开开关） |
| `xiaozhi_bridge_set_service` | 开启/关闭服务总开关（参数 `enabled: boolean`） |
| `xiaozhi_bridge_set_autostart` | 开启/关闭「启动自启」（参数 `autoStart: boolean`） |

## 设置页

插件在 DSH **设置 → 插件 → 小智桥接** 页签里（UI 与其它插件一致，走 `settings.plugins.tab` 槽位）：

- **服务开关**（页头右上角）：一键启动/关闭服务。关闭后不再连接小智接入点，机器人调不到本机 DSH
- **启动自启**（配置卡片内）：默认**关闭**。开启后 DSH 每次启动会自动连接接入点；关闭时每次重启 DSH 服务都是关的，需要在页头手动打开
- 填写小智 MCP 接入点地址（`wss://…`，可含 `?token=…`）与独立 token
- 设置 DSH Agent 的工作目录、单次调用超时、是否断线自动重连
- **保存并重连**：写入 `~/.dsh/dsh-xiaozhi-bridge/config.json` 后立即重启桥接
- 页面实时展示连接状态、握手结果、工具调用次数、DSH 会话与模型
- **自检**：发一句话给本机 DSH，验证回路是否打通
- 已发布给机器人的工具清单

设置页通过 `connection` RPC 通道（`/dsh-xiaozhi`）与 Host 插件通信，token 不外泄到客户端。

## 获取接入点地址

小智控制台 → **智能体管理 → 配置角色 → 意图识别 → 编辑功能 → MCP 接入点**，
复制那里的 `wss://…` 地址（通常自带 `?token=…`）。把它填进设置页的「接入点地址」即可。

> 接入点地址与 token 属于你自己的服务凭据，**不会**写进本仓库；插件只把它存在本机
> `~/.dsh/dsh-xiaozhi-bridge/config.json`。

## 配置文件

`~/.dsh/dsh-xiaozhi-bridge/config.json`：

```json
{
  "endpoint": "wss://<your-endpoint>/mcp/",
  "token": "<your-token>",
  "enabled": false,
  "autoStart": false,
  "autoReconnect": true,
  "cwd": "",
  "timeoutSeconds": 180
}
```

- `endpoint`：小智 MCP 接入点地址（可含 `?token=…`）
- `token`：单独填写的 token；地址里已带 token 时以地址为准
- `enabled`：服务当前开关（运行时状态），DSH 启动时按 `autoStart` 重置
- `autoStart`：启动自启，默认 false（重启后需手动打开服务）
- `autoReconnect`：断线自动重连
- `cwd`：DSH Agent 工作目录，空 = 当前会话工作区
- `timeoutSeconds`：单次工具调用最长等待秒数

## DSH 回合驱动方式

按官方 one-shot 驱动器 `dsh-headless/lib/index.js` 的同款流程：

```
ctx.agents.create(...) → agent.followup(createUserMessage(...))
  → await agent.whenIdle() → sessions.flush(agent.session)
  → 从 session 事件里取最后一条 assistant/message 的文本
```

插件不 import 任何 `@deepseek-ai/*` 包（本地目录安装是 link，裸包名解析不可靠），
`createUserMessage` / `installModelSelection` 按上游实现等价内联。

## 安装

### 插件管理面板（推荐）

桌面版左侧栏「**插件**」→ 添加组合包，填入下列任一来源：

- GitHub 源：`github:howecheung/dsh-xiaozhi-bridge`
- npm 源（发布后）：`dsh-xiaozhi-bridge`

> 桌面版的 profile 由桌面应用自身独占管理，命令行 `dsh plugin --profile desktop ...` 会被拒绝，
> 请用「插件」面板安装。

### 命令行（CLI 管理的 profile，例如 `dsh web`）

```powershell
dsh plugin --profile web add github:howecheung/dsh-xiaozhi-bridge
```

```powershell
dsh plugin --profile web add dsh-xiaozhi-bridge   # npm 发布后可用
```

安装后需**完全退出桌面版**（托盘图标右键退出）再启动，插件才会加载。

## 环境要求

- DeepSeek Harness ≥ 0.1.0-rc.6
- Node.js ≥ 22
- 一个可用的**小智 MCP 接入点**（免费机器人/自建角色均可）

## 隐私

- 接入点地址与 token 只保存在本机 `~/.dsh/dsh-xiaozhi-bridge/config.json`
- 机器人发来的内容会进入本机 DSH 会话（与你其它 DSH 对话同一套模型与工作区权限）

## License

[MIT](LICENSE)
