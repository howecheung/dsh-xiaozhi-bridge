/**
 * 桥接配置持久化：写入 DSH_HOME 下的独立文件，不碰 profile 的 cordis.patch.yml。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULTS = {
  /** 小智 MCP 接入点地址（可含 ?token=...） */
  endpoint: '',
  /** 单独的 token（endpoint 未带时拼接） */
  token: '',
  /** 服务总开关：关闭后不连接接入点，机器人调不到本机 DSH（默认关闭） */
  enabled: false,
  /** 启动自启：DSH 启动时自动连接接入点（关闭时每次重启后需手动打开服务开关） */
  autoStart: false,
  /** 断线自动重连 */
  autoReconnect: true,
  /** DSH Agent 使用的工作目录（空 = 当前会话工作区） */
  cwd: '',
  /** 单次工具调用最长等待秒数 */
  timeoutSeconds: 180,
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function configPath() {
  return join(dshHome(), 'dsh-xiaozhi-bridge', 'config.json')
}

/** 旧版配置目录（插件改名前），仅用于平滑迁移 */
export function legacyConfigPath() {
  return join(dshHome(), 'dsh-stackchan-bridge', 'config.json')
}

async function readConfigFile(file) {
  const raw = await readFile(file, 'utf8')
  // 去掉 UTF-8 BOM：PowerShell 写出的文件常带 BOM，JSON.parse 会直接抛错
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const parsed = JSON.parse(text)
  return parsed && typeof parsed === 'object' ? parsed : {}
}

export async function loadConfig() {
  // 新目录没有就回落到旧目录（插件改名前的配置），保证已有接入点/token 不丢
  for (const file of [configPath(), legacyConfigPath()]) {
    try {
      return { ...DEFAULTS, ...(await readConfigFile(file)) }
    } catch {
      /* try next */
    }
  }
  return { ...DEFAULTS }
}

export async function saveConfig(patch) {
  const current = await loadConfig()
  const next = { ...current, ...patch }
  await mkdir(dirname(configPath()), { recursive: true })
  await writeFile(configPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/** 拼出最终接入点 URL */
export function composeUrl(config) {
  const endpoint = (config.endpoint ?? '').trim()
  if (!endpoint) return ''
  const token = (config.token ?? '').trim()
  if (!token) return endpoint
  if (/[?&]token=/.test(endpoint)) return endpoint
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/** 展示用：隐藏 token */
export function redact(config) {
  const url = composeUrl(config)
  return {
    ...config,
    token: config.token ? '••••••' : '',
    endpoint: url.replace(/([?&]token=)[^&]+/i, '$1***'),
  }
}
