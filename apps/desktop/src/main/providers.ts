import { updateJsonFile, writeJsonAtomic } from './storage'
import { createContextProvider } from '../../resources/extension/model-context'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { shell } from 'electron'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Model } from '@earendil-works/pi-ai'
import type {
  AppSettings,
  LoginEvent,
  LoginMessage,
  LoginPrompt,
  ModelChoice,
  ModelsJsonFile,
  ProviderAuthOption,
  ProviderAuthType,
  ProviderInfo,
  ProviderModelOption
} from '../shared/types'
import {
  agentDir,
  authPath,
  mcpPath,
  modelsPath,
  settingsPath
} from './profile'
import { declaresImageInput } from '../shared/model-input'
import { withVersionPath } from '../shared/provider-url'
import { guardedStream } from './agent/stream-guard'
import type { ProviderTestResult } from '../shared/types'

const DEFAULT_MODELS_JSON = JSON.stringify(
  {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {}
  },
  null,
  2
)

let runtimePromise: Promise<ModelRuntime> | null = null

/** Use the SDK's model-specific map, including disabled and extended thinking levels. */
export async function thinkingLevelsFor(model: Model<string>): Promise<string[]> {
  const sdk = await import('@earendil-works/pi-ai/models')
  return sdk.getSupportedThinkingLevels(model)
}
let builtinIdsPromise: Promise<Set<string>> | null = null

async function getBuiltinProviderIds(): Promise<Set<string>> {
  if (!builtinIdsPromise) {
    builtinIdsPromise = (async () => {
      const sdk = await import('@earendil-works/pi-coding-agent')
      const baseline = await sdk.ModelRuntime.create({
        modelsPath: null,
        refreshOnCreate: false
      })
      return new Set(baseline.getProviders().map((provider) => provider.id))
    })()
    builtinIdsPromise.catch(() => {
      builtinIdsPromise = null
    })
  }
  return builtinIdsPromise
}

export function getRuntime(): Promise<ModelRuntime> {
  if (!runtimePromise) {
    const pending = (async () => {
      const sdk = await import('@earendil-works/pi-coding-agent')
      const runtime = await sdk.ModelRuntime.create({
        authPath: authPath(),
        modelsPath: modelsPath(),
        refreshOnCreate: false
      })
      // Correct the builtin catalog below user overrides, so every consumer (UI,
      // execution, compaction, titles and subagents) sees the same window.
      runtime.registerNativeProvider(await createContextProvider(authPath()))
      return runtime
    })()
    runtimePromise = pending
    pending.catch(() => {
      runtimePromise = null
    })
  }
  return runtimePromise
}

function resetRuntime(): void {
  runtimePromise = null
  matchersCache = null
  choicesCache = null
}

/** Drop cached provider/model data after credentials or settings change. */
export function invalidateCache(): void {
  resetRuntime()
}

async function configuredProviderIds(runtime: ModelRuntime): Promise<Set<string>> {
  const entries = await Promise.all(
    runtime.getProviders().map(async (provider) => {
      const check = await runtime.checkAuth(provider.id).catch(() => undefined)
      return [provider.id, Boolean(check)] as const
    })
  )
  return new Set(entries.filter(([, configured]) => configured).map(([id]) => id))
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const runtime = await getRuntime()
  const credentials = await runtime.listCredentials().catch(() => [])
  const configured = await configuredProviderIds(runtime)
  const builtinIds = await getBuiltinProviderIds().catch(() => new Set<string>())
  const overrides = await getBaseUrlOverrides().catch(() => ({}) as Record<string, string>)
  const stored = new Map(credentials.map((credential) => [credential.providerId, credential.type]))
  const providers: ProviderInfo[] = []

  for (const provider of runtime.getProviders()) {
    const isConfigured = configured.has(provider.id)
    const options: ProviderAuthOption[] = []
    if (provider.auth.oauth) {
      options.push({
        type: 'oauth',
        label: provider.auth.oauth.loginLabel ?? 'OAuth 登录'
      })
    }
    if (provider.auth.apiKey?.login) {
      options.push({ type: 'api_key', label: 'API Key' })
    }
    if (options.length === 0 && !isConfigured) continue
    providers.push({
      id: provider.id,
      name: provider.name,
      modelCount: provider.getModels().length,
      options,
      configured: isConfigured,
      builtin: builtinIds.has(provider.id),
      source: stored.has(provider.id) ? 'stored' : undefined,
      sourceLabel: stored.has(provider.id) ? '已保存凭据' : undefined,
      storedType: stored.get(provider.id) as ProviderAuthType | undefined,
      baseUrl: overrides[provider.id],
      baseUrlEditable: BASE_URL_PROVIDERS.includes(provider.id)
    })
  }

  return providers.sort(
    (a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name)
  )
}

interface PendingPrompt {
  resolve: (value: string) => void
  reject: (error: Error) => void
}

interface LoginSession {
  controller: AbortController
  pending: Map<string, PendingPrompt>
}

const sessions = new Map<string, LoginSession>()

type LoginInteraction = Parameters<ModelRuntime['login']>[2]

export async function startLogin(
  providerId: string,
  type: ProviderAuthType,
  loginId: string,
  emit: (message: LoginMessage) => void,
  onChanged: () => void,
  options: { deviceId?: string } = {}
): Promise<{ loginId?: string; error?: string }> {
  const runtime = await getRuntime().catch((error: unknown) => {
    throw new Error(`无法加载 pi 模型运行时：${error instanceof Error ? error.message : String(error)}`)
  })
  const provider = runtime.getProvider(providerId)
  if (!provider) return { error: '未知服务商' }
  if (type === 'oauth' && !provider.auth.oauth) return { error: '该服务商不支持 OAuth 登录' }
  if (type === 'api_key' && !provider.auth.apiKey?.login) {
    return { error: '该服务商不支持 API Key 登录' }
  }

  const controller = new AbortController()
  const pending = new Map<string, PendingPrompt>()
  sessions.set(loginId, { controller, pending })

  const interaction = {
    signal: controller.signal,
    prompt: (prompt: LoginPrompt) =>
      new Promise<string>((resolve, reject) => {
        const promptId = randomUUID()
        const onAbort = (): void => {
          pending.delete(promptId)
          reject(new Error('登录已取消'))
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
        pending.set(promptId, {
          resolve: (value) => {
            controller.signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          reject
        })
        emit({ kind: 'prompt', loginId, promptId, prompt })
      }),
    notify: (event: LoginEvent) => {
      if (event.type === 'auth_url') void shell.openExternal(event.url)
      if (event.type === 'device_code') void shell.openExternal(event.verificationUri)
      emit({ kind: 'event', loginId, event })
    }
  } as unknown as LoginInteraction

  void runtime
    .login(providerId, type, interaction, {
      agentName: 'pi desktop',
      ...(options.deviceId ? { getDeviceId: () => options.deviceId! } : {})
    })
    .then((credential) => {
      sessions.delete(loginId)
      invalidateCache()
      emit({ kind: 'done', loginId, ok: true, credentialType: credential.type })
      onChanged()
    })
    .catch((error: unknown) => {
      sessions.delete(loginId)
      emit({
        kind: 'done',
        loginId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    })

  return { loginId }
}

export function answerLogin(loginId: string, promptId: string, value: string): void {
  const session = sessions.get(loginId)
  const pending = session?.pending.get(promptId)
  if (!session || !pending) return
  session.pending.delete(promptId)
  pending.resolve(value)
}

export function cancelLogin(loginId: string): void {
  const session = sessions.get(loginId)
  if (!session) return
  sessions.delete(loginId)
  session.controller.abort()
  for (const pending of session.pending.values()) {
    pending.reject(new Error('登录已取消'))
  }
  session.pending.clear()
}

export async function logoutProvider(providerId: string): Promise<void> {
  const runtime = await getRuntime()
  await runtime.logout(providerId)
  invalidateCache()
}

export async function getModelsJson(): Promise<ModelsJsonFile> {
  try {
    return { path: modelsPath(), content: await fs.readFile(modelsPath(), 'utf8') }
  } catch {
    return { path: modelsPath(), content: DEFAULT_MODELS_JSON }
  }
}

export async function saveModelsJson(content: string): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('models.json 顶层必须是 JSON 对象')
  }
  normalizeBaseUrls(parsed as Record<string, unknown>)
  await writeJsonAtomic(modelsPath(), parsed)
  resetRuntime()
}

/**
 * Accept both `https://host` and `https://host/v1` for OpenAI-compatible endpoints.
 *
 * The adapter appends `/chat/completions` to the Base URL it is given, so a bare host asks the
 * gateway's web page for a completion — the request “works” (200, HTML) and the answer is empty. Most
 * gateways serve the same API under both spellings, so the missing version segment is filled in at
 * save time instead of being reported as a broken protocol later. A URL that already carries a path
 * (`/v1`, `/openai`, …) is left exactly as typed.
 */
export function normalizeBaseUrls(file: Record<string, unknown>): void {
  const providers = providersOf(file)
  for (const config of Object.values(providers)) {
    if (!config || typeof config !== 'object') continue
    const api = typeof config.api === 'string' ? config.api : ''
    const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''
    if (!baseUrl || !/^openai-(completions|responses)$/i.test(api)) continue
    config.baseUrl = withVersionPath(baseUrl)
  }
}

/** `https://host` → `https://host/v1`; anything with a path is returned unchanged. */
export { withVersionPath }

/**
 * Providers whose endpoint the window may override.
 *
 * `models.json` accepts `providers.<id>.baseUrl` for any provider and keeps that provider's built-in
 * models, but only these four are exposed in the UI: they are the ones people actually proxy
 * (Anthropic-compatible gateways, ChatGPT relays, Gemini endpoints, DeepSeek mirrors).
 */
export const BASE_URL_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'google', 'deepseek']

type ModelsJsonProviders = Record<string, Record<string, unknown>>

async function readModelsJsonObject(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(modelsPath(), 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // missing or unreadable: start from an empty file
  }
  return {}
}

function providersOf(file: Record<string, unknown>): ModelsJsonProviders {
  const providers = file.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return {}
  return { ...(providers as ModelsJsonProviders) }
}

/** provider id -> configured base URL override (absent when the provider uses its default). */export async function getBaseUrlOverrides(): Promise<Record<string, string>> {
  const providers = providersOf(await readModelsJsonObject())
  const overrides: Record<string, string> = {}
  for (const [id, config] of Object.entries(providers)) {
    if (config && typeof config === 'object' && typeof config.baseUrl === 'string' && config.baseUrl) {
      overrides[id] = config.baseUrl
    }
  }
  return overrides
}

/** Set or clear `providers.<id>.baseUrl`, leaving every other field of that provider untouched. */
export async function setProviderBaseUrl(providerId: string, baseUrl: string | null): Promise<void> {
  if (!BASE_URL_PROVIDERS.includes(providerId)) throw new Error(`不支持修改 ${providerId} 的地址`)
  const trimmed = baseUrl?.trim() ?? ''
  if (trimmed && !/^https?:\/\//i.test(trimmed)) throw new Error('地址必须以 http:// 或 https:// 开头')
  await updateJsonFile<Record<string, unknown>>(modelsPath(), {}, (file) => {
    const providers = providersOf(file)
    const current = { ...(providers[providerId] ?? {}) }
    if (trimmed) current.baseUrl = trimmed
    else delete current.baseUrl
    if (Object.keys(current).length === 0) delete providers[providerId]
    else providers[providerId] = current
    file.providers = providers
    return file
  })
  resetRuntime()
}

interface RawSettings {
  defaultProvider?: unknown
  defaultModel?: unknown
  defaultThinkingLevel?: unknown
  enabledModels?: unknown
  [key: string]: unknown
}

interface PatternMatchers {
  key: string
  exact: Set<string>
  globs: RegExp[]
}

let matchersCache: PatternMatchers | null = null
let choicesCache: { key: string; data: ModelChoice[] } | null = null

function globToRegExp(pattern: string): RegExp | null {
  const source = pattern
    .split('')
    .map((char) => {
      if (char === '*') return '.*'
      if (char === '?') return '.'
      if (/[.+^${}()|[\]\\]/.test(char)) return `\\${char}`
      return char
    })
    .join('')
  try {
    return new RegExp(`^${source}$`, 'i')
  } catch {
    return null
  }
}

function getMatchers(patterns: string[]): PatternMatchers {
  const key = patterns.join('\u0000')
  if (matchersCache && matchersCache.key === key) return matchersCache
  const exact = new Set<string>()
  const globs: RegExp[] = []
  for (const pattern of patterns) {
    if (/[*?[]/.test(pattern)) {
      const compiled = globToRegExp(pattern)
      if (compiled) globs.push(compiled)
    } else {
      exact.add(pattern.toLowerCase())
    }
  }
  matchersCache = { key, exact, globs }
  return matchersCache
}

function readEnabledModels(raw: RawSettings): string[] {
  return Array.isArray(raw.enabledModels)
    ? raw.enabledModels.filter((value): value is string => typeof value === 'string')
    : []
}

export async function getEnabledModelPatterns(): Promise<string[]> {
  return readEnabledModels(await readRawSettings())
}

export function isModelEnabled(
  model: { provider: string; id: string },
  patterns: string[]
): boolean {
  if (patterns.length === 0) return true
  const { exact, globs } = getMatchers(patterns)
  const reference = `${model.provider}/${model.id}`.toLowerCase()
  if (exact.has(reference) || exact.has(model.id.toLowerCase())) return true
  if (globs.length === 0) return false
  return globs.some((glob) => glob.test(reference) || glob.test(model.id))
}

async function readRawSettings(): Promise<RawSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as RawSettings
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist compaction settings into `~/.pi/agent/settings.json`, keeping the other keys. */
export async function setCompactionSettings(next: {
  enabled?: boolean
  reserveTokens?: number
}): Promise<void> {
  await updateJsonFile<RawSettings>(settingsPath(), {}, (raw) => {
    const compaction = { ...((raw.compaction as Record<string, unknown>) ?? {}) }
    if (typeof next.enabled === 'boolean') compaction.enabled = next.enabled
    if (typeof next.reserveTokens === 'number') {
      compaction.reserveTokens = Math.max(0, Math.round(next.reserveTokens))
    }
    raw.compaction = compaction
    return raw
  })
  invalidateCache()
}

/**
 * The stored API key of one provider, for features that call a provider's own endpoint (the custom
 * WarpGrep backend). Returns `undefined` for OAuth-only providers and unreadable auth files.
 */
export async function providerApiKey(providerId: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(authPath(), 'utf8')) as Record<
      string,
      { type?: string; key?: unknown } | undefined
    >
    const key = parsed?.[providerId]?.key
    return typeof key === 'string' && key.trim() ? key.trim() : undefined
  } catch {
    return undefined
  }
}

export async function getAppSettings(): Promise<AppSettings> {  const raw = await readRawSettings()
  const compaction = (raw.compaction as Record<string, unknown> | undefined) ?? {}
  return {
    defaultProvider:
      typeof raw.defaultProvider === 'string' ? raw.defaultProvider : undefined,
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
    defaultThinkingLevel:
      typeof raw.defaultThinkingLevel === 'string' ? raw.defaultThinkingLevel : undefined,
    enabledModels: readEnabledModels(raw),
    settingsPath: settingsPath(),
    modelsPath: modelsPath(),
    authPath: authPath(),
    compaction: {
      enabled: compaction.enabled !== false,
      reserveTokens:
        typeof compaction.reserveTokens === 'number' ? compaction.reserveTokens : undefined
    }
  }
}

export async function saveAppSettings(
  patch: Partial<
    Pick<
      AppSettings,
      'defaultProvider' | 'defaultModel' | 'defaultThinkingLevel' | 'enabledModels'
    >
  >
): Promise<void> {
  await updateJsonFile<RawSettings>(settingsPath(), {}, (raw) => {
    for (const key of ['defaultProvider', 'defaultModel', 'defaultThinkingLevel'] as const) {
      const value = patch[key]
      if (value === undefined) continue
      if (value === '') delete raw[key]
      else raw[key] = value
    }
    if (patch.enabledModels !== undefined) {
      if (patch.enabledModels.length === 0) delete raw.enabledModels
      else raw.enabledModels = [...new Set(patch.enabledModels)]
    }
    return raw
  })
  invalidateCache()
}

export async function listProviderModels(providerId: string): Promise<ProviderModelOption[]> {
  const runtime = await getRuntime()
  const provider = runtime.getProvider(providerId)
  if (!provider) return []
  const patterns = readEnabledModels(await readRawSettings())
  return provider.getModels().map((model) => ({
    id: `${model.provider}/${model.id}`,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: Boolean(model.reasoning),
    enabled: isModelEnabled(model, patterns)
  }))
}

export async function setProviderModels(
  providerId: string,
  enabledIds: string[]
): Promise<void> {
  const runtime = await getRuntime()
  const allModels = runtime.getModels()
  await updateJsonFile<RawSettings>(settingsPath(), {}, (raw) => {
    const patterns = readEnabledModels(raw)
    const enabled = new Set(
      allModels
        .filter((model) => isModelEnabled(model, patterns))
        .map((model) => `${model.provider}/${model.id}`)
    )
    const prefix = `${providerId}/`
    for (const id of [...enabled]) {
      if (id.startsWith(prefix)) enabled.delete(id)
    }
    for (const id of enabledIds) {
      if (id.startsWith(prefix)) enabled.add(id)
    }
    const allIds = allModels.map((model) => `${model.provider}/${model.id}`)
    const allEnabled = allIds.length > 0 && allIds.every((id) => enabled.has(id))
    if (allEnabled) delete raw.enabledModels
    else {
      // Keep the allowlist small: a fully enabled provider becomes "provider/*".
      const byProvider = new Map<string, { total: number; on: number }>()
      for (const id of allIds) {
        const provider = id.slice(0, id.indexOf('/'))
        const entry = byProvider.get(provider) ?? { total: 0, on: 0 }
        entry.total += 1
        if (enabled.has(id)) entry.on += 1
        byProvider.set(provider, entry)
      }
      const patterns: string[] = []
      for (const id of [...enabled].sort()) {
        const provider = id.slice(0, id.indexOf('/'))
        const entry = byProvider.get(provider)
        if (entry && entry.on === entry.total) {
          const wildcard = `${provider}/*`
          if (!patterns.includes(wildcard)) patterns.push(wildcard)
          continue
        }
        patterns.push(id)
      }
      raw.enabledModels = patterns
    }
    return raw
  })
  invalidateCache()
}

export async function listModelChoices(
  options: { includeUnconfigured?: boolean } = {}
): Promise<ModelChoice[]> {  const runtime = await getRuntime()
  const providers = new Map(runtime.getProviders().map((provider) => [provider.id, provider]))
  const configured = await configuredProviderIds(runtime)
  const patterns = readEnabledModels(await readRawSettings())
  const cacheKey = `${options.includeUnconfigured === true ? 'all' : 'configured'}\u0000${patterns.join('\u0000')}\u0000${[...configured].sort().join(',')}`
  if (choicesCache && choicesCache.key === cacheKey) return choicesCache.data
  const data = runtime
    .getModels()
    .filter((model) => isModelEnabled(model, patterns))
    .filter((model) => options.includeUnconfigured === true || configured.has(model.provider))
    .map((model) => {
      const provider = providers.get(model.provider)
      return {
        provider: model.provider,
        providerName: provider?.name ?? model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        configured: configured.has(model.provider)
      }
    })
  choicesCache = { key: cacheKey, data }
  return data
}

/**
 * Whether a model entry accepts images at all.
 *
 * pi defaults a missing `input` to `['text']` and then swaps every image for
 * "(image omitted: model does not support images)" before the request goes out, so a screenshot
 * sent to an undeclared model disappears without an error. Callers use this to tell the user
 * instead of letting the picture vanish.
 */
export async function modelSupportsImages(provider: string, id: string): Promise<boolean> {
  const runtime = await getRuntime()
  const model = runtime.getModels().find((entry) => entry.provider === provider && entry.id === id)
  return declaresImageInput(model?.input)
}

export interface ModelResolution {
  model?: { provider: string; id: string }
  error?: { code: string; message: string }
}

/**
 * Resolve a `provider` / `model` pair requested by a caller (the subagent tools).
 *
 * pi happily accepts an unknown model id and then produces an empty answer, so a typo would look
 * like a successful run with no output. The catalog is checked here instead: it includes custom
 * `models.json` entries, and the allowlist does not apply — pi can run any catalog model.
 */
export async function resolveModelChoice(
  provider: string | undefined,
  id: string | undefined
): Promise<ModelResolution> {
  if (!id && !provider) return {}
  const runtime = await getRuntime()
  const configured = await configuredProviderIds(runtime)
  const models = await listModelChoices({ includeUnconfigured: true })
  const providerIds = runtime.getProviders().map((entry) => entry.id)

  if (provider && !providerIds.includes(provider)) {
    return {
      error: {
        code: 'UNKNOWN_PROVIDER',
        message: `未知服务商 ${provider}。可用：${providerIds.slice(0, 10).join(', ')}`
      }
    }
  }

  if (provider) {
    const candidates = models.filter((model) => model.provider === provider)
    if (id && !candidates.some((model) => model.id === id)) {
      return {
        error: {
          code: 'UNKNOWN_MODEL',
          message: `${provider} 下没有模型 ${id}。可用：${candidates.slice(0, 8).map((model) => model.id).join(', ')}`
        }
      }
    }
    if (!configured.has(provider)) {
      return {
        error: {
          code: 'PROVIDER_NOT_CONFIGURED',
          message: `${provider} 还没有配置凭据，先在 设置 → 服务商 登录或填 API key`
        }
      }
    }
    return { model: { provider, id: id as string } }
  }

  const matches = models.filter((model) => model.id === id)
  const owners = [...new Set(matches.map((model) => model.provider))]
  const usable = owners.filter((owner) => configured.has(owner))

  // Exactly one provider offers this id: use it, and let the credential check speak for itself.
  if (owners.length === 1) {
    const [owner] = owners
    if (!configured.has(owner)) {
      return {
        error: {
          code: 'PROVIDER_NOT_CONFIGURED',
          message: `模型 ${id} 只属于 ${owner}，但 ${owner} 还没有配置凭据，先在 设置 → 服务商 登录或填 API key`
        }
      }
    }
    return { model: { provider: owner, id: id as string } }
  }

  // Several providers offer it: a single configured one wins, otherwise the caller must choose.
  if (usable.length === 1) return { model: { provider: usable[0], id: id as string } }
  if (usable.length > 1) {
    return {
      error: {
        code: 'AMBIGUOUS_MODEL',
        message: `模型 ${id} 在多个已配置的服务商下存在，请同时指定 provider：${usable.join(', ')}`
      }
    }
  }
  if (owners.length > 1) {
    return {
      error: {
        code: 'AMBIGUOUS_MODEL',
        message: `模型 ${id} 在多个服务商下存在（都未配置凭据），请同时指定 provider：${owners.join(', ')}`
      }
    }
  }
  const near = models
    .filter((model) => model.id.includes(id as string))
    .slice(0, 8)
    .map((model) => `${model.provider}/${model.id}`)
  return {
    error: {
      code: 'UNKNOWN_MODEL',
      message: `找不到模型 ${id}${near.length > 0 ? `。相近：${near.join(', ')}` : ''}。用 list_models 查看可用模型`
    }
  }
}

/**
 * One real request through the same runtime a chat turn uses, so the answer is about the path the
 * app actually takes — headers, auth, URL joining and all — and not a second implementation of it.
 *
 * Failures are translated into what the user can act on: a gateway that answers with an HTML page
 * (almost always a Base URL without `/v1`), a model id the channel does not sell, or a key that is
 * refused. When the model is the problem we also ask the endpoint which ids it does offer.
 */
export async function testProvider(providerId: string, modelId?: string): Promise<ProviderTestResult> {
  const runtime = await getRuntime()
  const provider = runtime.getProvider(providerId)
  if (!provider) return { ok: false, detail: '未知服务商' }
  const models = provider.getModels() as Model<string>[]
  const model = modelId ? models.find((entry) => entry.id === modelId) : models[0]
  if (!model) {
    return {
      ok: false,
      detail: modelId ? `该服务商里没有模型 ${modelId}` : '这个服务商没有可测试的模型'
    }
  }
  const started = Date.now()
  try {
    const stream = guardedStream<Record<string, unknown>>(
      (signal) =>
        runtime.streamSimple(
          model,
          {
            systemPrompt: '这是连通性测试，只回复 OK。',
            messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
            tools: []
          },
          { signal, maxTokens: 16, reasoning: undefined }
        ) as AsyncIterable<Record<string, unknown>>,
      AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
      PROVIDER_TEST_TIMEOUT_MS
    )
    for await (const event of stream) {
      if (event.type === 'error') {
        const raw = (event as { error?: unknown }).error
        throw new Error(typeof raw === 'string' ? raw : JSON.stringify(raw))
      }
      if (event.type === 'done') return { ok: true, model: model.id, ms: Date.now() - started }
    }
    return { ok: true, model: model.id, ms: Date.now() - started }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    const detail = await describeFailure(providerId, raw)
    const available = /model|模型|渠道/i.test(raw) ? await probeRemoteModels(providerId) : undefined
    return { ok: false, model: model.id, ms: Date.now() - started, detail, available }
  }
}

const PROVIDER_TEST_TIMEOUT_MS = 25_000

/** Turn an adapter error into something a user can act on instead of a JSON blob. */
export function describeProviderFailure(raw: string): string {
  const text = raw.trim()
  if (/<html|<!doctype html/i.test(text)) {
    return '接口返回的是网页而不是 JSON：Base URL 很可能少了 /v1（OpenAI 兼容地址一般以 /v1 结尾）'
  }
  if (/model_not_found|无可用渠道|model not found|does not exist|invalid model/i.test(text)) {
    return '该渠道没有这个模型：换一个模型 ID，或到服务商控制台开通这个模型'
  }
  if (/(401|403)|invalid api key|unauthorized|incorrect api key/i.test(text)) {
    return '凭据被拒绝（401/403）：检查 API Key 是否填对、是否已过期'
  }
  if (/404/.test(text)) {
    return '接口地址 404：检查 Base URL（OpenAI 兼容地址一般以 /v1 结尾）'
  }
  if (/429/.test(text)) return '请求太频繁（429）：稍后再试'
  if (/ETIMEDOUT|timeout|timed out/i.test(text)) return '请求超时：检查网络或代理'
  if (/stream ended without finish_reason/i.test(text)) {
    return '接口没有返回可用的流式响应：Base URL 很可能少了 /v1，或这个地址不是 OpenAI 兼容接口'
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return '域名解析失败：检查 Base URL 是否写对'
  if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(text)) return '连接被拒绝或中断：检查地址与代理设置'
  return text.length > 400 ? text.slice(0, 400) + '…' : text
}

/**
 * The address itself is the usual culprit, and the adapter's own error does not say so: an
 * OpenAI-compatible client that is handed a bare host asks the gateway's web page for a completion
 * and reports “stream ended without finish_reason”. So look at the configured address first.
 */
async function describeFailure(providerId: string, raw: string): Promise<string> {
  const address = await addressProblem(providerId)
  return address ?? describeProviderFailure(raw)
}

async function addressProblem(providerId: string): Promise<string | undefined> {
  try {
    const config = providersOf(await readModelsJsonObject())[providerId] as
      | { api?: string; baseUrl?: string; apiKey?: string }
      | undefined
    const baseUrl = String(config?.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!baseUrl) return undefined
    let bare = false
    try {
      bare = new URL(baseUrl).pathname.replace(/\/+$/, '') === ''
    } catch {
      return `Base URL 不是合法地址：${baseUrl}`
    }
    // Deterministic: no request needed to know where `/chat/completions` will land.
    if (bare && /^openai-/i.test(String(config?.api ?? ''))) {
      return `Base URL 少了 /v1：适配器会请求 ${baseUrl}/chat/completions，打到的是网页而不是接口（一般应写成 ${baseUrl}/v1）`
    }
    const key = String(config?.apiKey ?? '').trim() || (await providerApiKey(providerId))
    if (!key) return undefined
    // Ask the address what it serves too: a gateway page answers 200 with HTML.
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${key}`, 'x-api-key': key },
      signal: AbortSignal.timeout(8_000)
    }).catch(() => undefined)
    if ((response?.headers.get('content-type') ?? '').includes('text/html')) {
      return '接口返回的是网页而不是 JSON：Base URL 很可能少了 /v1（OpenAI 兼容地址一般以 /v1 结尾）'
    }
  } catch {
    // Whatever went wrong here is not the answer; the request's own error still is.
  }
  return undefined
}

/** Ask the endpoint which model ids it sells; a wrong id is otherwise a guessing game. */
async function probeRemoteModels(providerId: string): Promise<string[] | undefined> {
  try {
    const config = providersOf(await readModelsJsonObject())[providerId] as
      | { baseUrl?: string; apiKey?: string }
      | undefined
    const baseUrl = config?.baseUrl?.trim().replace(/\/+$/, '')
    const key = config?.apiKey?.trim() || (await providerApiKey(providerId))
    if (!baseUrl || !key) return undefined
    const roots = /\/v\d+$/.test(baseUrl) ? [baseUrl] : [baseUrl + '/v1', baseUrl]
    for (const root of roots) {
      const response = await fetch(`${root}/models`, {
        headers: { authorization: `Bearer ${key}`, 'x-api-key': key },
        signal: AbortSignal.timeout(10_000)
      }).catch(() => undefined)
      if (!response?.ok) continue
      const body = (await response.json().catch(() => undefined)) as
        | { data?: Array<{ id?: unknown }> }
        | undefined
      const ids = (body?.data ?? [])
        .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
        .filter(Boolean)
      if (ids.length > 0) return ids.slice(0, 12)
    }
  } catch {
    // A probe that fails is not the answer; the original error still is.
  }
  return undefined
}
