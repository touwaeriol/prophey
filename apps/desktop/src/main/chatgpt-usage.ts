/**
 * ChatGPT plan usage for the OpenAI rows in settings.
 *
 * OpenAI restricts "Sign in with ChatGPT" (token sharing) credentials to `api.openai.com/v1/models`
 * and `/v1/responses`: `chatgpt.com/backend-api/wham/usage` answers 401 `no_matching_rule` and
 * `/v1/responses/usage` needs an `api.responses.read` scope the app never gets, so the sign-in
 * itself cannot read a balance. Codex credentials — this app's `openai-codex` OAuth entry or the
 * Codex CLI's own `auth.json` — do carry the ChatGPT account id and can read the *same* plan
 * windows our requests are billed against. Ask with those; when none is available the settings page
 * links to https://chatgpt.com/settings/usage instead of inventing a number.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseChatGptUsage,
  type ChatGptUsage,
  type ChatGptUsageResult,
  type ChatGptUsageSource
} from '../shared/chatgpt-usage'
import { authPath } from './profile'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TIMEOUT_MS = 6000
/** Plan windows move slowly; a minute keeps opening settings instant without stale numbers. */
const CACHE_TTL_MS = 60_000
const CODEX_USER_AGENT = 'codex_cli_rs/0.1.0'

interface UsageCredential {
  access: string
  accountId?: string
  source: ChatGptUsageSource
}

function codexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim()
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.codex')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return undefined
  }
}

/** `openai-codex` in pi's `auth.json`: the one pi credential that also stores an account id. */
async function storedCredential(): Promise<UsageCredential | undefined> {
  const entry = asRecord((await readJson(authPath()))?.['openai-codex'])
  if (!entry || entry.type !== 'oauth' || typeof entry.access !== 'string') return undefined
  return {
    access: entry.access,
    ...(typeof entry.accountId === 'string' ? { accountId: entry.accountId } : {}),
    source: 'openai-codex'
  }
}

/** The Codex CLI's own login: same subscription, and it is what the codex engine runs on. */
async function cliCredential(): Promise<UsageCredential | undefined> {
  const tokens = asRecord((await readJson(path.join(codexHome(), 'auth.json')))?.tokens)
  if (typeof tokens?.access_token !== 'string') return undefined
  return {
    access: tokens.access_token,
    ...(typeof tokens.account_id === 'string' ? { accountId: tokens.account_id } : {}),
    source: 'codex-cli'
  }
}

async function collectCredentials(): Promise<UsageCredential[]> {
  const found = await Promise.all([storedCredential(), cliCredential()])
  return found.filter((credential): credential is UsageCredential => credential !== undefined)
}

function credentialKey(credential: UsageCredential): string {
  return `${credential.source}:${credential.accountId ?? '-'}:${credential.access.slice(-12)}`
}

async function requestUsage(
  credential: UsageCredential,
  fetcher: typeof fetch
): Promise<ChatGptUsage> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential.access}`,
    accept: 'application/json',
    originator: 'codex_cli_rs',
    'user-agent': CODEX_USER_AGENT
  }
  if (credential.accountId) headers['chatgpt-account-id'] = credential.accountId
  const response = await fetcher(USAGE_URL, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? `OpenAI 拒绝了 ${credential.source === 'codex-cli' ? 'Codex CLI' : 'openai-codex'} 凭据的用量查询（HTTP ${response.status}）`
        : `用量查询失败（HTTP ${response.status}）`
    )
  }
  const usage = parseChatGptUsage(await response.json(), { source: credential.source })
  if (!usage) throw new Error('OpenAI 返回的用量数据无法解析')
  return usage
}

let cache: { key: string; at: number; result: ChatGptUsageResult } | undefined

/**
 * Plan windows of the ChatGPT subscription behind the Codex login.
 *
 * Tries the app's own `openai-codex` credential first (it is the one the user manages here), then
 * the Codex CLI's. Failures are cached for the same short window so a broken credential does not
 * mean a request every time settings opens.
 */
export async function chatGptUsage(
  options: { force?: boolean; fetcher?: typeof fetch } = {}
): Promise<ChatGptUsageResult> {
  const fetcher = options.fetcher ?? fetch
  const credentials = await collectCredentials()
  if (credentials.length === 0) {
    return {
      reason:
        '没有可用的 Codex 凭据：OpenAI 只对 Codex 登录开放订阅用量，ChatGPT 登录的令牌没有这个权限'
    }
  }

  const key = credentials.map(credentialKey).join('|')
  if (!options.force && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.result
  }

  let reason = ''
  for (const credential of credentials) {
    try {
      const result: ChatGptUsageResult = { usage: await requestUsage(credential, fetcher) }
      cache = { key, at: Date.now(), result }
      return result
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
  }

  const result: ChatGptUsageResult = { reason: reason || '用量查询失败' }
  cache = { key, at: Date.now(), result }
  return result
}

/** Credentials changed (login / logout): drop the cached answer. */
export function invalidateChatGptUsage(): void {
  cache = undefined
}
