# dsh-xiaozhi-bridge

Expose the local **DeepSeek Harness (DSH)** agent as MCP tools on a **Xiaozhi MCP endpoint**,
so robots using that endpoint (e.g. [StackChan](https://github.com/howecheung/stackchan))
can drive the desktop AI by voice.

- Package / repository name: `dsh-xiaozhi-bridge`
- Settings entry: **Settings → Plugins → 小智桥接 (Xiaozhi Bridge)**
- Config file: `~/.dsh/dsh-xiaozhi-bridge/config.json` (the token never leaves your machine)

[中文](README.md)

## Features

| Feature | Description |
| --- | --- |
| Voice control | The robot says "summarize this document"; the tool call runs on the local DSH and the reply is read back |
| Service switch | One click in the settings header to start/stop the service. While off, the endpoint is not connected and the robot cannot reach the local DSH |
| Auto start | Optional. When on, DSH connects to the endpoint on every launch; when off the service stays off after each restart until you enable it manually |
| Auto reconnect | Reconnects with backoff after the endpoint drops (can be disabled) |
| Working directory / timeout | Choose the DSH agent working directory and the per-call timeout |
| Self check | Send one test message from the settings page to verify the round trip |

## Roles and protocol

The Xiaozhi endpoint (e.g. `wss://<your-endpoint>/mcp/?token=…`) connects **to us** as an
MCP **client** (observed `serverInfo = xz-mcp-broker`), so the local side acts as an
**MCP server**:

```
broker → us : initialize(id=0, capabilities:{sampling,roots})
us → broker : {protocolVersion:'2024-11-05', capabilities:{tools:{listChanged:true}}, serverInfo:{name:'dsh-xiaozhi-bridge'}}
broker → us : notifications/initialized
broker → us : tools/list(id=1)        → us reply { tools:[dsh_chat, dsh_status] }
broker → us : tools/call(id,n)         → us reply {content:[{type:'text',text}], isError}
broker → us : ping(id)                 → us reply {}
```

One WS text frame = one JSON-RPC 2.0 message (NDJSON style, no Content-Length header).

## Tools published to the robot

| Tool | Purpose | Arguments |
| --- | --- | --- |
| `dsh_chat` | Hand one sentence to the local DSH and return the final reply (readable as-is) | `message` (required), `timeoutSeconds`, `newSession` |
| `dsh_status` | Report bridge status, published tools and working directory | none |

## Tools registered into DSH

| Tool | Purpose |
| --- | --- |
| `xiaozhi_bridge_status` | Show bridge status (connection, tools, DSH session, model) |
| `xiaozhi_bridge_reconnect` | Reconnect to the endpoint (opens the service switch first when it is off) |
| `xiaozhi_bridge_set_service` | Start/stop the service (argument `enabled: boolean`) |
| `xiaozhi_bridge_set_autostart` | Enable/disable auto start (argument `autoStart: boolean`) |

## Settings page

The plugin lives in **Settings → Plugins → 小智桥接** (uses the standard `settings.plugins.tab` slot):

- **Service switch** (top right of the header): start/stop the service in one click. While off, the endpoint is not connected and the robot cannot reach the local DSH
- **Auto start** (inside the config card): **off** by default. When on, DSH connects to the endpoint on every launch; when off, the service stays off after each restart and has to be enabled manually
- Xiaozhi MCP endpoint address (`wss://…`, may contain `?token=…`) and a separate token
- DSH agent working directory, per-call timeout, auto reconnect
- **Save & reconnect**: writes `~/.dsh/dsh-xiaozhi-bridge/config.json` and restarts the bridge
- Live view of connection state, handshake result, tool call counters, DSH session and model
- **Self check**: sends one message to the local DSH to verify the round trip
- The list of tools published to the robot

The settings page talks to the Host plugin over the `connection` RPC channel (`/dsh-xiaozhi`);
the token is never sent to the client.

## Where to get the endpoint

Xiaozhi console → **Agent management → Role → Intent recognition → Edit feature → MCP endpoint**,
copy the `wss://…` address (it normally carries `?token=…`) and paste it into the settings page.

> The endpoint address and token are your own service credentials. They are **not** part of this
> repository; the plugin stores them locally in `~/.dsh/dsh-xiaozhi-bridge/config.json`.

## Config file

`~/.dsh/dsh-xiaozhi-bridge/config.json`:

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

- `endpoint`: Xiaozhi MCP endpoint address (may contain `?token=…`)
- `token`: standalone token; the address wins when it already carries one
- `enabled`: current service switch (runtime state); DSH resets it from `autoStart` on launch
- `autoStart`: auto start, default false (enable the service manually after each restart)
- `autoReconnect`: reconnect automatically after a drop
- `cwd`: DSH agent working directory, empty = current session workspace
- `timeoutSeconds`: maximum seconds to wait for one tool call

## How a DSH turn is driven

Same flow as the official one-shot driver `dsh-headless/lib/index.js`:

```
ctx.agents.create(...) → agent.followup(createUserMessage(...))
  → await agent.whenIdle() → sessions.flush(agent.session)
  → take the last assistant/message text from the session events
```

The plugin does not import any `@deepseek-ai/*` package (a local directory install is a link and
bare package names resolve unreliably); `createUserMessage` / `installModelSelection` are
inlined equivalents of the upstream implementation.

## Install

### From GitHub

```powershell
dsh plugin --profile desktop add github:howecheung/dsh-xiaozhi-bridge
```

### From npm (once published)

```powershell
dsh plugin --profile desktop add dsh-xiaozhi-bridge
```

Fully quit the desktop app (right-click the tray icon → quit) and start it again for the plugin
to load. Use `dsh plugin --profile desktop list` to check the installation.

## Requirements

- DeepSeek Harness ≥ 0.1.0-rc.6
- Node.js ≥ 22
- A working **Xiaozhi MCP endpoint**

## Privacy

- The endpoint address and token only live in the local `~/.dsh/dsh-xiaozhi-bridge/config.json`
- What the robot sends becomes part of your local DSH session (same models and workspace
  permissions as your other DSH conversations)

## License

[MIT](LICENSE)
