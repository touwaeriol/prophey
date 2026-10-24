/**
 * Web search + web fetch, served as the `web` gateway endpoint.
 *
 * pi has no provider-native web tools of its own (its RequestOptions only carry client-side
 * function tools), so both tools live here:
 *
 * - `web_search` uses the active model's provider when the user turned that provider's native
 *   search on (Anthropic `web_search`, OpenAI `web_search_preview`, Google grounding) and falls back
 *   to the Brave Search API otherwise.
 * - `web_fetch` always fetches locally: no key, no third party, the page is converted to
 *   Markdown/plain text in this process.
 *
 * Everything is resolved per call. Switching models or editing the config does not need a restart:
 * the gateway asks `configure()`'d getters each time.
 */
import type { WebSearchMode } from '../shared/types'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getRuntime } from './providers'

export interface WebConfig {
  /** `auto` = the provider's own search when enabled for the active model, otherwise Brave. */
  mode?: WebSearchMode
  /** Brave Search API subscription token. */
  braveApiKey?: string
  /** provider id -> use that provider's own web search. */
  native?: Record<string, boolean>
  /** Results per search. */
  count?: number
  /** Character budget of `web_fetch`. */
  maxChars?: number
}

/** Providers whose own search endpoint is implemented below. */
export const NATIVE_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'google', 'deepseek']

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36 AgentDesktop/1.0'
const SEARCH_TIMEOUT_MS = 45_000
const FETCH_TIMEOUT_MS = 30_000
const MAX_FETCH_BYTES = 3_000_000
const DEFAULT_COUNT = 8
const DEFAULT_SEARCH_CHARS = 7000
const DEFAULT_FETCH_CHARS = 6000
const MAX_SUMMARY_CHARS = 2000

export class WebError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WebError'
  }
}

interface WebRuntime {
  config: () => WebConfig
  /** Provider / model of the session that is asking right now. */
  provider: () => string | undefined
  model: () => string | undefined
}

let runtime: WebRuntime = {
  config: () => ({}),
  provider: () => undefined,
  model: () => undefined
}

export function configure(next: WebRuntime): void {
  runtime = next
}

export interface WebToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const WEB_TOOLS: WebToolSpec[] = [
  {
    name: 'web_search',
    description:
      'Search the public web and return titles, URLs and snippets. Use it for anything newer than ' +
      'the model knowledge or outside this repository (releases, docs, errors, comparisons), then ' +
      'read a promising page with web_fetch. Runs on the active provider’s own search when it is ' +
      'enabled in Settings, otherwise on Brave.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Natural language works better than bare keywords.'
        },
        count: {
          type: 'number',
          description: `Number of results, 1-20. Default ${DEFAULT_COUNT}.`
        },
        freshness: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: 'Only return pages from this recent period (Brave only).'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'web_fetch',
    description:
      'Download one http(s) URL and return its readable content as Markdown (or plain text). Use it ' +
      'to read a page found with web_search, a changelog, an API reference or a raw file. Local and ' +
      'private addresses are refused; use bash for those.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        format: {
          type: 'string',
          enum: ['markdown', 'text'],
          description: 'markdown keeps headings, lists and links (default); text drops the markup.'
        },
        maxChars: {
          type: 'number',
          description: `Character budget, 1000-30000. Default ${DEFAULT_FETCH_CHARS}.`
        }
      },
      required: ['url']
    }
  }
]

interface SearchResult {
  title: string
  url: string
  description?: string
}

interface SearchOutcome {
  backend: 'native' | 'brave'
  provider?: string
  results: SearchResult[]
  summary?: string
  note?: string
}

type Normalized = Required<Pick<WebConfig, 'mode' | 'count' | 'maxChars'>> & WebConfig

function normalize(config: WebConfig): Normalized {
  return {
    ...config,
    mode: config.mode === 'brave' || config.mode === 'native' ? config.mode : 'auto',
    count: clamp(Math.round(config.count ?? DEFAULT_COUNT), 1, 20),
    maxChars: clamp(Math.round(config.maxChars ?? DEFAULT_FETCH_CHARS), 1000, 30_000)
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.round(value), min), max)
}

function numberArg(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** `{ backend }` for the current session, plus the reason when native was requested but unusable. */
export function describeRoute(
  provider: string | undefined,
  config: WebConfig
): { backend: 'native' | 'brave'; provider?: string; reason?: string } {
  const normalized = normalize(config)
  const nativeOn = provider ? config.native?.[provider] === true : false
  const supported = provider ? NATIVE_PROVIDERS.includes(provider) : false
  if (normalized.mode === 'brave') return { backend: 'brave' }
  if (normalized.mode === 'native') {
    if (nativeOn && supported) return { backend: 'native', provider }
    return {
      backend: 'brave',
      reason: `${provider ?? '当前'} 未开启原生搜索，或该服务商没有原生搜索，按 Brave 处理`
    }
  }
  if (nativeOn && supported) return { backend: 'native', provider }
  return { backend: 'brave' }
}

export function nativeProviderEnabled(config: WebConfig): string[] {
  return Object.entries(config.native ?? {})
    .filter(([provider, on]) => on === true && NATIVE_PROVIDERS.includes(provider))
    .map(([provider]) => provider)
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

export async function callWebTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; structured?: Record<string, unknown> }> {
  if (name === 'web_search') return search(args)
  if (name === 'web_fetch') return fetchPage(args)
  throw new WebError('UNKNOWN_TOOL', `未知工具：${name}`)
}

async function search(
  args: Record<string, unknown>
): Promise<{ text: string; structured?: Record<string, unknown> }> {
  const query = stringArg(args.query).trim()
  if (!query) throw new WebError('BAD_ARGUMENT', 'query 不能为空')
  const config = normalize(runtime.config())
  const count = clamp(numberArg(args.count) ?? config.count, 1, 20)
  const freshness = ['day', 'week', 'month', 'year'].includes(stringArg(args.freshness))
    ? stringArg(args.freshness)
    : undefined

  const provider = callerModel.getStore() ? callerModel.getStore()!.provider : runtime.provider()
  let outcome: SearchOutcome
  const route = describeRoute(provider, config)
  const nativeProvider = route.backend === 'native' ? route.provider : undefined
  const braveKey = config.braveApiKey?.trim()
  if (nativeProvider) {
    try {
      outcome = { backend: 'native', provider: nativeProvider, ...(await nativeSearch(nativeProvider, query, count)) }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // Never fail the tool because the provider path is unavailable: Brave is the documented
      // fallback, and the note tells the model (and the user) why the answer came from there.
      if (!braveKey) {
        throw new WebError(
          'NATIVE_FAILED',
          `${nativeProvider} 原生搜索失败（${reason}），且没有配置 Brave Key 可回退`
        )
      }
      outcome = {
        backend: 'brave',
        note: `${nativeProvider} 原生搜索失败（${reason}），已回退 Brave`,
        results: await braveSearch(query, count, freshness, braveKey)
      }
    }
  } else {
    // `mode: native` with nothing usable is a configuration error, not a silent fallback.
    if (route.reason && config.mode === 'native') throw new WebError('NO_BACKEND', route.reason)
    if (!braveKey) {
      throw new WebError(
        'NO_BACKEND',
        route.reason
          ? `${route.reason}；同时未配置 Brave Search Key（设置 → MCP → 网络搜索）`
          : 'web_search 还没有后端：在 设置 → MCP → 网络搜索 填 Brave Search API Key，' +
            '或去 设置 → 服务商 给当前服务商打开“联网”'
      )
    }
    outcome = { backend: 'brave', results: await braveSearch(query, count, freshness, braveKey) }
  }

  return {
    text: formatSearch(query, outcome, route.reason),
    structured: {
      backend: outcome.backend,
      provider: outcome.provider,
      results: outcome.results.slice(0, count)
    }
  }
}

function formatSearch(query: string, outcome: SearchOutcome, routeNote?: string): string {
  const source =
    outcome.backend === 'native'
      ? `${outcome.provider ?? 'provider'} 原生搜索`
      : 'Brave Search API'
  const lines: string[] = [`Web results for **${query}** · ${source}`]
  if (routeNote) lines.push(`> ${routeNote}`)
  if (outcome.note) lines.push(`> ${outcome.note}`)
  if (outcome.results.length === 0) {
    lines.push('', 'No results. Try a shorter query.')
  } else {
    lines.push('')
    outcome.results.forEach((result, index) => {
      lines.push(`${index + 1}. ${result.title || result.url}`)
      lines.push(`   ${result.url}`)
      const description = oneLine(result.description)
      if (description) lines.push(`   ${description}`)
    })
  }
  if (outcome.summary) {
    lines.push('', '### 摘要', '', outcome.summary.slice(0, MAX_SUMMARY_CHARS))
  }
  lines.push('', 'Read a page with `web_fetch` before relying on it.')
  return truncate(lines.join('\n'), DEFAULT_SEARCH_CHARS)
}

function oneLine(value: string | undefined): string {
  if (!value) return ''
  return decodeEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

// ---------------------------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------------------------

async function braveSearch(
  query: string,
  count: number,
  freshness: string | undefined,
  key: string
): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))
  url.searchParams.set('text_decorations', 'false')
  url.searchParams.set('safesearch', 'moderate')
  if (freshness) url.searchParams.set('freshness', freshness)
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new WebError(
      'BRAVE_ERROR',
      response.status === 401 || response.status === 403
        ? `Brave Search Key 无效（HTTP ${response.status}）`
        : `Brave Search 失败（HTTP ${response.status}）${body ? `：${body.slice(0, 200)}` : ''}`
    )
  }
  const json = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
  }
  return (json.web?.results ?? [])
    .filter((entry) => typeof entry.url === 'string' && entry.url)
    .map((entry) => ({
      title: oneLine(entry.title) || (entry.url as string),
      url: entry.url as string,
      description: entry.description
    }))
}

interface ProviderAuth {
  apiKey?: string
  baseUrl?: string
  headers: Record<string, string>
  source?: string
}

/**
 * Request auth as pi itself would send it: OAuth tokens are refreshed inside `getAuth`, so the
 * desktop never touches auth.json directly and never serves a stale token.
 */
async function authFor(provider: string): Promise<ProviderAuth> {
  const modelRuntime = await getRuntime().catch(() => undefined)
  if (!modelRuntime) throw new WebError('NO_RUNTIME', 'pi 模型运行时不可用')
  const result = await modelRuntime.getAuth(provider).catch(() => undefined)
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(result?.auth.headers ?? {})) {
    if (typeof value === 'string' && value) headers[key.toLowerCase()] = value
  }
  return {
    apiKey: result?.auth.apiKey,
    baseUrl: result?.auth.baseUrl,
    headers,
    source: result?.source
  }
}

/** The session's own model when it belongs to that provider, otherwise that provider's cheapest one. */
async function modelFor(provider: string): Promise<string | undefined> {
  const caller = callerModel.getStore()
  if (caller?.provider === provider && caller.id) return caller.id
  if (!caller && runtime.provider() === provider && runtime.model()) return runtime.model()
  const modelRuntime = await getRuntime().catch(() => undefined)
  if (!modelRuntime) return undefined
  const models = modelRuntime.getModels(provider)
  if (models.length === 0) return undefined
  const cheap = models.find((model) => /(mini|flash|haiku|small|lite|nano)/i.test(model.id))
  return (cheap ?? models[0]).id
}

function trimBase(value: string): string {
  return value.replace(/\/+$/, '')
}

function mergeBeta(existing: string | undefined, extra: string): string {
  const values = new Set(
    `${existing ?? ''}`
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )
  values.add(extra)
  return [...values].join(',')
}

async function nativeSearch(
  provider: string,
  query: string,
  count: number
): Promise<{ results: SearchResult[]; summary?: string }> {
  if (provider === 'anthropic') return anthropicSearch(query, count)
  if (provider === 'deepseek') return deepseekSearch(query, count)
  if (provider === 'openai') return openaiSearch(query, count)
  if (provider === 'google') return googleSearch(query)
  throw new WebError('NO_NATIVE', `${provider} 没有原生搜索实现`)
}

/** Messages endpoint for a provider that speaks the Anthropic wire format. */
function messagesUrl(baseUrl: string | undefined): string {
  const base = trimBase(baseUrl || 'https://api.anthropic.com')
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`
}

/** One Messages call carrying Anthropic's native `web_search` server tool. */
async function messagesSearch(options: {
  baseUrl?: string
  headers: Record<string, string>
  model: string
  query: string
  count: number
}): Promise<{ results: SearchResult[]; summary?: string }> {
  const json = (await postJson(
    messagesUrl(options.baseUrl),
    {
      model: options.model,
      max_tokens: 900,
      messages: [{ role: 'user', content: options.query }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
    },
    options.headers
  )) as {
    content?: Array<{
      type?: string
      text?: string
      content?: Array<{ type?: string; url?: string; title?: string }>
    }>
  }

  const results: SearchResult[] = []
  const texts: string[] = []
  for (const block of json.content ?? []) {
    if (block.type === 'web_search_tool_result') {
      for (const entry of block.content ?? []) {
        if (!entry.url || results.some((result) => result.url === entry.url)) continue
        results.push({ title: oneLine(entry.title) || entry.url, url: entry.url })
        if (results.length >= options.count) break
      }
    } else if (block.type === 'text' && block.text?.trim()) {
      texts.push(block.text.trim())
    }
  }
  return { results, summary: texts.join('\n\n').trim() || undefined }
}

async function anthropicSearch(
  query: string,
  count: number
): Promise<{ results: SearchResult[]; summary?: string }> {
  const auth = await authFor('anthropic')
  const model = await modelFor('anthropic')
  if (!model) throw new WebError('NO_MODEL', 'Anthropic 没有可用模型')
  const oauth = Boolean(auth.headers.authorization) || /^sk-ant-oat/i.test(auth.apiKey ?? '')
  if (!oauth && !auth.apiKey) throw new WebError('NO_CREDENTIAL', 'Anthropic 还没有配置凭据')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(oauth
      ? { authorization: `Bearer ${auth.apiKey ?? ''}`, 'anthropic-beta': 'oauth-2025-04-20' }
      : { 'x-api-key': auth.apiKey as string })
  }
  for (const [key, value] of Object.entries(auth.headers)) {
    if (key === 'anthropic-beta') headers[key] = mergeBeta(headers[key], value)
    else if (key === 'authorization' || key === 'x-api-key') headers[key] = value
    else headers[key] ??= value
  }
  if (oauth) headers['anthropic-beta'] = mergeBeta(headers['anthropic-beta'], 'oauth-2025-04-20')

  return messagesSearch({
    baseUrl: auth.baseUrl,
    headers,
    model,
    query,
    count
  })
}

/**
 * DeepSeek has a dedicated Search API (`POST /v1/tools/search`), backed by its own engine: plain
 * JSON in, structured results out, no model turn. That is much cheaper than the alternative —
 * DeepSeek also accepts Anthropic's `web_search_20250305` server tool on `/anthropic`, but then one
 * search costs a whole model turn and the results only exist inside its prose.
 *
 * `models.json` may point the provider at an Anthropic-compatible proxy (`…/anthropic`), so the
 * path is stripped before appending the Search API route.
 */
async function deepseekSearch(
  query: string,
  count: number
): Promise<{ results: SearchResult[]; summary?: string }> {
  const auth = await authFor('deepseek')
  if (!auth.apiKey) throw new WebError('NO_CREDENTIAL', 'DeepSeek 还没有配置 API Key')
  const base = trimBase(auth.baseUrl || 'https://api.deepseek.com').replace(/\/anthropic$/, '')
  const json = (await postJson(
    `${base}/v1/tools/search`,
    { query, count: Math.min(50, Math.max(1, count)), need_content: true },
    {
      'content-type': 'application/json',
      authorization: `Bearer ${auth.apiKey}`,
      ...auth.headers
    }
  )) as {
    results?: Array<{ title?: string; url?: string; summary?: string; content?: string }>
  }
  const results: SearchResult[] = []
  for (const entry of json.results ?? []) {
    if (!entry.url || results.some((result) => result.url === entry.url)) continue
    results.push({
      title: oneLine(entry.title) || entry.url,
      url: entry.url,
      description: oneLine(entry.summary) || oneLine(entry.content)
    })
    if (results.length >= count) break
  }
  return { results }
}

async function openaiSearch(
  query: string,
  count: number
): Promise<{ results: SearchResult[]; summary?: string }> {
  const auth = await authFor('openai')
  const model = await modelFor('openai')
  if (!model) throw new WebError('NO_MODEL', 'OpenAI 没有可用模型')
  if (!auth.apiKey) throw new WebError('NO_CREDENTIAL', 'OpenAI 还没有配置凭据')
  const json = (await postJson(
    `${trimBase(auth.baseUrl ?? 'https://api.openai.com/v1')}/responses`,
    {
      model,
      input: query,
      tools: [{ type: 'web_search_preview' }],
      max_output_tokens: 900
    },
    {
      'content-type': 'application/json',
      authorization: `Bearer ${auth.apiKey}`,
      ...auth.headers
    }
  )) as {
    output?: Array<{
      type?: string
      content?: Array<{
        type?: string
        text?: string
        annotations?: Array<{ type?: string; url?: string; title?: string }>
      }>
    }>
    output_text?: string
  }

  const results: SearchResult[] = []
  const texts: string[] = []
  for (const item of json.output ?? []) {
    if (item.type !== 'message') continue
    for (const part of item.content ?? []) {
      if (part.type !== 'output_text') continue
      if (part.text?.trim()) texts.push(part.text.trim())
      for (const annotation of part.annotations ?? []) {
        if (!annotation.url || results.some((result) => result.url === annotation.url)) continue
        results.push({ title: oneLine(annotation.title) || annotation.url, url: annotation.url })
        if (results.length >= count) break
      }
    }
  }
  if (texts.length === 0 && json.output_text?.trim()) texts.push(json.output_text.trim())
  return { results, summary: texts.join('\n\n').trim() || undefined }
}

async function googleSearch(
  query: string
): Promise<{ results: SearchResult[]; summary?: string }> {
  const auth = await authFor('google')
  const model = await modelFor('google')
  if (!model) throw new WebError('NO_MODEL', 'Google 没有可用模型')
  if (!auth.apiKey) throw new WebError('NO_CREDENTIAL', 'Google 还没有配置凭据')
  const base = trimBase(auth.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta')
  const json = (await postJson(
    `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(auth.apiKey)}`,
    {
      contents: [{ role: 'user', parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 900 }
    },
    { 'content-type': 'application/json', ...auth.headers }
  )) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> }
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
      }
    }>
  }

  const candidate = json.candidates?.[0]
  const results: SearchResult[] = []
  for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
    const uri = chunk.web?.uri
    if (!uri || results.some((result) => result.url === uri)) continue
    results.push({ title: oneLine(chunk.web?.title) || uri, url: uri })
  }
  const summary = (candidate?.content?.parts ?? [])
    .filter((part) => part.thought !== true && part.text?.trim())
    .map((part) => (part.text as string).trim())
    .join('\n\n')
    .trim()
  return { results, summary: summary || undefined }
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new WebError(
      'PROVIDER_ERROR',
      `HTTP ${response.status}：${text.replace(/\s+/g, ' ').trim().slice(0, 300) || '无响应体'}`
    )
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new WebError('BAD_RESPONSE', `返回的不是 JSON：${text.slice(0, 120)}`)
  }
}

// ---------------------------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------------------------

async function fetchPage(
  args: Record<string, unknown>
): Promise<{ text: string; structured?: Record<string, unknown> }> {
  const raw = stringArg(args.url).trim()
  if (!raw) throw new WebError('BAD_ARGUMENT', 'url 不能为空')
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    throw new WebError('BAD_URL', `不是合法的 URL：${raw}`)
  }
  const config = normalize(runtime.config())
  const maxChars = clamp(numberArg(args.maxChars) ?? config.maxChars, 1000, 30_000)
  const asText = stringArg(args.format) === 'text'

  const response = await fetchPublicPage(target)
  if (!response.ok) {
    throw new WebError('HTTP_ERROR', `HTTP ${response.status} ${response.statusText} — ${target.href}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  const { bytes, truncated: bytesTruncated } = await readLimited(response, MAX_FETCH_BYTES)
  const html = decodeBytes(bytes, contentType)

  let title: string | undefined
  let body: string
  if (/json/i.test(contentType)) {
    try {
      body = JSON.stringify(JSON.parse(html) as unknown, null, 2)
    } catch {
      body = html
    }
  } else if (/html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(html)) {
    const converted = htmlToMarkdown(html)
    title = converted.title
    body = asText ? markdownToText(converted.text) : converted.text
  } else {
    body = html
  }

  body = body.trim()
  const clipped = truncate(body, maxChars)
  const size = `${(bytes.byteLength / 1024).toFixed(1)} KB${bytesTruncated ? '+' : ''}`
  // Redirects happen server-side; report where the content actually came from.
  const resolved = response.url || target.href
  const head = `# ${title || resolved}`
  const meta = `${resolved} · ${contentType || 'unknown'} · ${size}`
  return {
    text: `${head}\n\n${meta}\n\n---\n\n${clipped || '（页面没有可读正文）'}`,
    structured: { url: resolved, title, contentType, truncated: clipped.length < body.length }
  }
}

/** Validate every redirect before opening it, and use one deadline for the chain. */
async function fetchPublicPage(initial: URL): Promise<Response> {
  let target = initial
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new WebError('BAD_URL', `只支持 http/https：${target.href}`)
    }
    if (isPrivateHost(target.hostname)) {
      throw new WebError(
        'BLOCKED_HOST',
        `拒绝抓取本机 / 内网地址（${target.hostname}）。需要本地内容时用 read 或 bash。`
      )
    }

    const response = await fetch(target, {
      redirect: 'manual',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      signal
    })
    const location = response.headers.get('location')
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response
    await response.body?.cancel()
    target = new URL(location, target)
  }
  throw new WebError('TOO_MANY_REDIRECTS', '页面重定向次数过多')
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host.includes(':') && (host === '::1' || host === '::' || host.startsWith('fe80:'))) return true
  // Unique local addresses (fc00::/7) are only recognized as such when the host is an IPv6 literal.
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd'))) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ipv4) return false
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

async function readLimited(
  response: Awaited<ReturnType<typeof fetch>>,
  limit: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    return buffer.byteLength > limit
      ? { bytes: buffer.subarray(0, limit), truncated: true }
      : { bytes: buffer, truncated: false }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    size += value.byteLength
    if (size >= limit) {
      truncated = true
      break
    }
  }
  void reader.cancel().catch(() => undefined)
  const merged = new Uint8Array(Math.min(size, limit))
  let offset = 0
  for (const chunk of chunks) {
    const room = merged.byteLength - offset
    if (room <= 0) break
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, room))
    merged.set(slice, offset)
    offset += slice.byteLength
  }
  return { bytes: merged, truncated }
}

function decodeBytes(bytes: Uint8Array, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  const sniffed = /<meta[^>]+charset=["']?([\w-]+)/i.exec(
    new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048))
  )?.[1]
  const charset = (declared ?? sniffed ?? 'utf-8').toLowerCase()
  for (const candidate of [charset, 'utf-8']) {
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes)
    } catch {
      continue
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

const NON_CONTENT = /<(script|style|noscript|template|svg|canvas|iframe|object|embed|head)[^>]*>[\s\S]*?<\/\1>/gi

function htmlToMarkdown(html: string): { title?: string; text: string } {
  const title = oneLine(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]) || undefined
  let body = html.replace(/<!--[\s\S]*?-->/g, ' ')
  body = body.replace(NON_CONTENT, ' ')
  // Prefer the article body when the page offers one; otherwise keep the whole document.
  const main =
    /<article[^>]*>[\s\S]*?<\/article>/i.exec(body)?.[0] ??
    /<main[^>]*>[\s\S]*?<\/main>/i.exec(body)?.[0] ??
    /<div[^>]+(?:id|class)=["'][^"']*(?:article|content|post|markdown)[^"']*["'][^>]*>[\s\S]*?<\/div>/i.exec(
      body
    )?.[0]
  if (main && stripMarkup(main).length > 500) body = main

  body = body
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level: string, inner: string) =>
        `\n\n${'#'.repeat(Number(level))} ${inlineText(inner)}\n\n`
    )
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
      const code = decodeEntities(stripMarkup(inner)).replace(/\n{3,}/g, '\n\n').trim()
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`
    })
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner: string) => {
      const code = inlineText(inner)
      return code ? `\`${code}\`` : ''
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, inner: string) => `\n- ${inlineText(inner)}`)
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner: string) => {
      const text = inlineText(inner)
      return text ? `\n\n> ${text}\n\n` : '\n\n'
    })
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner: string) => {
      const text = inlineText(inner)
      return text ? `**${text}**` : ''
    })
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner: string) => {
      const text = inlineText(inner)
      return text ? `*${text}*` : ''
    })
    .replace(
      /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_match, href: string, inner: string) => {
        const text = inlineText(inner)
        if (!text) return href
        return `[${text}](${href})`
      }
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n\n---\n\n')
    .replace(/<t[dh][^>]*>/gi, ' ')
    .replace(/<\/(p|div|section|article|header|footer|aside|tr|table|figure|figcaption)>/gi, '\n\n')

  const text = normalizeBlankLines(
    decodeEntities(stripMarkup(body)).replace(/[\u00a0]/g, ' ')
  )
  return { title, text }
}

function inlineText(html: string): string {
  return decodeEntities(stripMarkup(html)).replace(/\s+/g, ' ').trim()
}

function stripMarkup(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
}

/** `format: text`: keep the words, drop the Markdown the converter added. */
function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[\w-]*\n?/g, ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_match, label: string, url: string) =>
      label && label !== url ? `${label} (${url})` : label || url
    )
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_`]/g, '')
}

function normalizeBlankLines(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit).trimEnd()}\n\n…（已截断，原文 ${text.length} 字符）`
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·'
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => safeCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePoint(Number(code)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)
}

function safeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return ''
  try {
    return String.fromCodePoint(value)
  } catch {
    return ''
  }
}
const callerModel = new AsyncLocalStorage<{ provider?: string; id?: string }>()
export function withWebModel<T>(model: { provider?: string; id?: string }, action: () => T): T {
  return callerModel.run(model, action)
}
