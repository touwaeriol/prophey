/**
 * Runtime configuration: CLI flags first, environment second, defaults last.
 *
 * No API key is ever written to disk by this package. Discovery order for the key is
 * `WARPGREP_API_KEY` → provider key env (`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`) → an explicit
 * `WARPGREP_KEY_FILE` → the credential store pi already owns (`PI_CODING_AGENT_DIR` or
 * `~/.pi/agent`, `auth.json`). That last step is what makes the desktop app work without asking
 * the user for the same key twice.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_MODEL = 'deepseek-flash'
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
export const DEFAULT_MAX_TURNS = 6
const DEFAULT_MAX_CHARS = 12000

const USAGE = `warpgrep-mcp — natural-language code search as an MCP server

Usage: warpgrep-mcp [options]

  --path <dir>        repository to search (default: cwd)
  --model <id>        chat model with tool calling (default: ${DEFAULT_MODEL})
  --base-url <url>    OpenAI-compatible endpoint (default: ${DEFAULT_BASE_URL})
  --max-turns <n>     tool-calling rounds before giving up (default: ${DEFAULT_MAX_TURNS})
  --max-chars <n>     response budget (default: ${DEFAULT_MAX_CHARS})
  --help              print this text
  --version           print the package version

Environment:
  WARPGREP_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY   API key
  WARPGREP_KEY_FILE                                      read the key from this JSON file
  WARPGREP_MODEL, WARPGREP_BASE_URL                      same as --model / --base-url
  WARPGREP_MAX_TURNS, WARPGREP_MAX_CHARS                 same as above
  WARPGREP_TURN_TIMEOUT_MS                               per-model-call timeout (default 45000)
  WARPGREP_TOTAL_TIMEOUT_MS                              whole search timeout (default 100000)
`

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function flagValue(argv, index, name) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new ConfigError(`${name} 需要一个值`)
  return value
}

/** Number with a floor, so `--max-turns 0` cannot make the loop a no-op. */
function positive(value, fallback, minimum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.floor(parsed))
}

function providerFromBaseUrl(baseUrl) {
  const host = baseUrl.toLowerCase()
  if (host.includes('deepseek')) return 'deepseek'
  if (host.includes('openai')) return 'openai'
  return undefined
}

function keyFromPiAuth(provider) {
  if (!provider) return undefined
  const directory = process.env.PI_CODING_AGENT_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_DIR)
    : path.join(os.homedir(), '.pi', 'agent')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(directory, 'auth.json'), 'utf8'))
  } catch {
    return undefined
  }
  const entry = parsed?.[provider]
  const key = typeof entry?.key === 'string' ? entry.key : undefined
  return key?.trim() || undefined
}

function keyFromFile(file) {
  if (!file) return undefined
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  } catch (error) {
    throw new ConfigError(`WARPGREP_KEY_FILE 读取失败：${error.message}`)
  }
  // Accept `{"key": "…"}`, `{"apiKey": "…"}` and a bare `{"<provider>": {"key": "…"}}` object.
  if (typeof parsed?.key === 'string') return parsed.key.trim() || undefined
  if (typeof parsed?.apiKey === 'string') return parsed.apiKey.trim() || undefined
  for (const value of Object.values(parsed ?? {})) {
    if (typeof value?.key === 'string' && value.key.trim()) return value.key.trim()
  }
  return undefined
}

/**
 * Resolve every option once at startup. `key` may legitimately be empty: the server then still
 * answers `tools/list` (the client can list the tool and the failure is reported per call).
 */
export function resolveConfig(argv = process.argv.slice(2), env = process.env) {
  let cwd = env.WARPGREP_PATH ?? process.cwd()
  let model = env.WARPGREP_MODEL ?? DEFAULT_MODEL
  let baseUrl = env.WARPGREP_BASE_URL ?? DEFAULT_BASE_URL
  let maxTurns = positive(env.WARPGREP_MAX_TURNS, DEFAULT_MAX_TURNS, 1)
  let maxChars = positive(env.WARPGREP_MAX_CHARS, DEFAULT_MAX_CHARS, 1000)

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--path':
        cwd = flagValue(argv, index, '--path')
        index += 1
        break
      case '--model':
        model = flagValue(argv, index, '--model')
        index += 1
        break
      case '--base-url':
        baseUrl = flagValue(argv, index, '--base-url')
        index += 1
        break
      case '--max-turns':
        maxTurns = positive(flagValue(argv, index, '--max-turns'), DEFAULT_MAX_TURNS, 1)
        index += 1
        break
      case '--max-chars':
        maxChars = positive(flagValue(argv, index, '--max-chars'), DEFAULT_MAX_CHARS, 1000)
        index += 1
        break
      case '--help':
      case '-h':
        return { help: true, usage: USAGE }
      case '--version':
        return { version: true }
      default:
        throw new ConfigError(`未知参数：${arg}（--help 查看用法）`)
    }
  }

  const resolvedDir = path.resolve(cwd)
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    throw new ConfigError(`搜索目录不存在：${resolvedDir}`)
  }

  const trimmedBase = baseUrl.replace(/\/+$/, '')
  const provider = providerFromBaseUrl(trimmedBase)
  const key =
    env.WARPGREP_API_KEY?.trim() ||
    (provider === 'deepseek' ? env.DEEPSEEK_API_KEY?.trim() : undefined) ||
    (provider === 'openai' ? env.OPENAI_API_KEY?.trim() : undefined) ||
    env.OPENAI_API_KEY?.trim() ||
    keyFromFile(env.WARPGREP_KEY_FILE) ||
    keyFromPiAuth(provider) ||
    ''

  return {
    cwd: resolvedDir,
    model,
    baseUrl: trimmedBase,
    maxTurns,
    maxChars,
    key,
    provider,
    keySource: key ? (env.WARPGREP_API_KEY ? 'WARPGREP_API_KEY' : provider ? `${provider} 凭据` : 'env') : 'none',
    turnTimeoutMs: positive(env.WARPGREP_TURN_TIMEOUT_MS, 45_000, 1_000),
    totalTimeoutMs: positive(env.WARPGREP_TOTAL_TIMEOUT_MS, 100_000, 2_000)
  }
}
