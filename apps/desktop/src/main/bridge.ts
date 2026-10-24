import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { EngineId } from '../shared/engine'
import type { AgentWorkspace } from './agent/engine'
import type {
  AskAnswer,
  AskQuestion,
  AskRequest,
  AskResult,
  BridgeInfo,
  McpToolInfo
} from '../shared/types'

const MAX_BODY_BYTES = 512 * 1024
const PORT_ATTEMPTS = 12

interface PendingAsk {
  resolve: (result: AskResult) => void
  request: AskRequest
}

export interface ClientContext {
  sessionKey?: string
  engine: EngineId
  workspace: AgentWorkspace
  model?: { provider: string; id: string }
}
const clients = new Map<string, () => ClientContext>()
export function registerClient(context: () => ClientContext): string {
  const credential = randomUUID()
  clients.set(credential, context)
  return credential
}
export function removeClient(credential: string): void { clients.delete(credential) }
export function clientContext(credential: string): ClientContext | undefined { return clients.get(credential)?.() }
function credentialOf(request: http.IncomingMessage): string {
  return typeof request.headers.authorization === 'string'
    ? request.headers.authorization.replace(/^Bearer\s+/i, '')
    : String(request.headers['x-agent-desktop-token'] ?? '')
}
function contextOf(request: http.IncomingMessage): ClientContext | undefined {
  return clients.get(credentialOf(request))?.()
}
export function pendingAsks(): AskRequest[] { return [...pending.values()].map(entry => entry.request) }

let server: http.Server | null = null
let port = 0
let token = ''
let askListener: ((request: AskRequest) => void) | null = null
let askSettledListener: ((id: string) => void) | null = null
export function setAskSettledListener(listener: (id: string) => void): void { askSettledListener = listener }
let toolsListener: ((servers: Record<string, McpToolInfo[]>) => void) | null = null
let mcpHandler:
  | ((engine: string, message: Record<string, unknown>, scope?: string) => Promise<unknown | undefined>)
  | null = null
let apiHandler: ((request: ApiRequest) => Promise<ApiResponse>) | null = null
const pending = new Map<string, PendingAsk>()

export function getBridgeInfo(): BridgeInfo {
  return {
    running: Boolean(server),
    url: port ? `http://127.0.0.1:${port}` : '',
    port,
    pending: pending.size
  }
}

export function getBridgeUrl(): string {
  return port ? `http://127.0.0.1:${port}` : ''
}

export function getBridgeToken(): string {
  return token
}

/**
 * Events the extension running inside pi collects for the model: subagent settlements today.
 * The extension long-polls `GET /events`, so a notice queued while pi restarts is delivered once
 * the new process connects.
 */
export interface BridgeEvent {
  type: string
  text: string
  ts: number
  /** Let the parent start a turn immediately instead of waiting for its next message. */
  wake?: boolean
  /** Only the engine on this session may deliver it; several engines can be alive at once. */
  session?: string
}

const EVENT_LIMIT = 20
const EVENT_MAX_AGE_MS = 10 * 60 * 1000
const eventQueue: BridgeEvent[] = []
const eventWaiters = new Set<() => void>()

export function publishEvent(event: Omit<BridgeEvent, 'ts'> & { ts?: number }): void {
  eventQueue.push({ ...event, ts: event.ts ?? Date.now() })
  while (eventQueue.length > EVENT_LIMIT) eventQueue.shift()
  for (const wake of [...eventWaiters]) wake()
}

function pruneEvents(): void {
  const now = Date.now()
  while (eventQueue.length > 0 && now - eventQueue[0].ts > EVENT_MAX_AGE_MS) eventQueue.shift()
}

function takeEvents(session?: string): BridgeEvent[] {
  pruneEvents()
  const selected = eventQueue.filter(event => event.session === session)
  for (const event of selected) eventQueue.splice(eventQueue.indexOf(event), 1)
  return selected
}

/** Long-poll: returns as soon as an event exists, or with an empty list after `wait` ms. */
async function handleEvents(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  if (!isAuthorized(request)) {
    respond(response, 401, { events: [], error: '桥接令牌无效' })
    return
  }
  const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
  const session = contextOf(request)?.sessionKey
  const requested = Number(parsed.searchParams.get('wait') ?? 20_000)
  const wait = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 60_000) : 20_000
  pruneEvents()
  if (!eventQueue.some(event => event.session === session) && wait > 0) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        eventWaiters.delete(done)
        response.removeListener('close', done)
        resolve()
      }
      const timer = setTimeout(done, wait)
      eventWaiters.add(done)
      response.once('close', done)
    })
  }
  if (!response.destroyed) respond(response, 200, { events: takeEvents(session) })
}

export function setAskListener(listener: ((request: AskRequest) => void) | null): void {
  askListener = listener
}

/** The extension reports the tools its servers offer once they connect. */
export function setToolsListener(
  listener: ((servers: Record<string, McpToolInfo[]>) => void) | null
): void {
  toolsListener = listener
}

/** MCP gateway endpoints (`/mcp/<engine>`), handled by the gateway module. */
export function setMcpHandler(
  handler:
    | ((engine: string, message: Record<string, unknown>, scope?: string) => Promise<unknown | undefined>)
    | null
): void {
  mcpHandler = handler
}

export function answerAsk(id: string, answers: AskAnswer[]): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  askSettledListener?.(id)
  entry.resolve({ answers })
}

export function cancelAsk(id: string, reason?: string): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  askSettledListener?.(id)
  entry.resolve({ cancelled: true, reason })
}

export function cancelAllAsks(reason: string, sessionKey?: string): void {
  for (const [id, entry] of pending) {
    if (!sessionKey || entry.request.sessionKey === sessionKey) cancelAsk(id, reason)
  }
}

function normalizeQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return []
  const questions: AskQuestion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    if (typeof value.question !== 'string' || !value.question.trim()) continue
    const options = Array.isArray(value.options)
      ? value.options
          .map((option) => {
            if (!option || typeof option !== 'object') return null
            const item = option as Record<string, unknown>
            if (typeof item.label !== 'string' || !item.label.trim()) return null
            return {
              label: item.label.trim(),
              ...(typeof item.description === 'string' && item.description.trim()
                ? { description: item.description.trim() }
                : {})
            }
          })
          .filter((option): option is { label: string; description?: string } => option !== null)
      : []
    questions.push({
      question: value.question.trim(),
      ...(typeof value.header === 'string' && value.header.trim()
        ? { header: value.header.trim() }
        : {}),
      ...(value.multiSelect === true ? { multiSelect: true } : {}),
      // Confidential answers (Codex `isSecret`) must stay masked in the panel.
      ...(value.secret === true ? { secret: true } : {}),
      ...(options.length > 0 ? { options } : {})
    })
  }
  return questions
}

function isAuthorized(request: http.IncomingMessage): boolean {
  const presented = credentialOf(request)
  return !token || presented === token || clients.has(presented)
}

async function readJsonBody(request: http.IncomingMessage, allowEmpty = false): Promise<Record<string, unknown>> {
  const text = await readBody(request)
  const value: unknown = allowEmpty && !text.trim() ? {} : JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象')
  return value as Record<string, unknown>
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function respond(response: http.ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

/** Internal engine approvals use the same cancellable queue as desktop tools. */
export function askEngine(questions: AskQuestion[], tool: string, sessionKey?: string): Promise<AskResult> {
  if (!askListener) return Promise.resolve({ cancelled: true, reason: '窗口未就绪' })
  const id = randomUUID()
  return new Promise((resolve) => {
    const request = { id, questions, tool, sessionKey, createdAt: Date.now() }
    pending.set(id, { resolve, request })
    askListener?.(request)
  })
}

async function handleAsk(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  if (!isAuthorized(request)) {
    respond(response, 401, { cancelled: true, reason: '桥接令牌无效' })
    return
  }
  if (!askListener) {
    respond(response, 503, { cancelled: true, reason: '桌面窗口尚未就绪' })
    return
  }
  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(request)
  } catch (error) {
    respond(response, 400, {
      cancelled: true,
      reason: `请求解析失败：${error instanceof Error ? error.message : String(error)}`
    })
    return
  }
  const questions = normalizeQuestions(payload.questions)
  if (questions.length === 0) {
    respond(response, 400, { cancelled: true, reason: '没有可提问的问题' })
    return
  }

  const id = randomUUID()
  const ask: AskRequest = {
    sessionKey: contextOf(request)?.sessionKey,
    id,
    questions,
    createdAt: Date.now(),
    tool: typeof payload.tool === 'string' ? payload.tool : undefined
  }

  // No timeout: the tool waits until the user answers, the run is aborted, or the app closes.
  const disconnected = (): void => cancelAsk(id, '请求已取消')
  response.once('close', disconnected)
  const result = await new Promise<AskResult>((resolve) => {
    pending.set(id, { resolve, request: ask })
    if (response.destroyed) disconnected()
    else askListener?.(ask)
  })
  response.removeListener('close', disconnected)

  if (result.cancelled) respond(response, 200, { cancelled: true, reason: result.reason })
  else respond(response, 200, { answers: result.answers })
}

async function handleTools(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  if (!isAuthorized(request)) {
    respond(response, 401, { ok: false, error: '桥接令牌无效' })
    return
  }
  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(request)
  } catch (error) {
    respond(response, 400, {
      ok: false,
      error: `请求解析失败：${error instanceof Error ? error.message : String(error)}`
    })
    return
  }
  const servers = normalizeTools(payload.servers)
  if (toolsListener) toolsListener(servers)
  respond(response, 200, { ok: true })
}

function normalizeTools(raw: unknown): Record<string, McpToolInfo[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, McpToolInfo[]> = {}
  for (const [server, tools] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(tools)) continue
    result[server] = tools
      .map((tool) => {
        if (!tool || typeof tool !== 'object') return null
        const item = tool as Record<string, unknown>
        if (typeof item.name !== 'string' || !item.name.trim()) return null
        return {
          name: item.name.trim(),
          enabled: item.enabled !== false,
          ...(typeof item.exposure === 'string' ? { exposure: item.exposure } : {})
        }
      })
      .filter((tool): tool is McpToolInfo => tool !== null)
  }
  return result
}

const MCP_ENDPOINT = /^\/mcp\/([A-Za-z0-9_-]+)$/
const API_PREFIX = /^\/(agents|models|subagents)(\/.*)?$/

export interface ApiRequest {
  context?: ClientContext
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown>
}

export interface ApiResponse {
  status: number
  body: unknown
}

/** Internal JSON API behind the desktop tools (agents, models, subagents). */
export function setApiHandler(
  handler: ((request: ApiRequest) => Promise<ApiResponse>) | null
): void {
  apiHandler = handler
}

async function handleApi(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  if (!isAuthorized(request)) {
    respond(response, 401, { ok: false, code: 'UNAUTHORIZED', message: '桥接令牌无效' })
    return
  }
  if (!apiHandler) {
    respond(response, 503, { ok: false, code: 'NOT_READY', message: '桥接尚未就绪' })
    return
  }
  const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
  let body: Record<string, unknown> = {}
  if (request.method === 'POST' || request.method === 'PUT') {
    try {
      body = await readJsonBody(request, true)
    } catch (error) {
      respond(response, 400, {
        ok: false,
        code: 'BAD_BODY',
        message: error instanceof Error ? error.message : String(error)
      })
      return
    }
  }
  try {
    const result = await apiHandler({
      context: contextOf(request),
      method: request.method ?? 'GET',
      path: parsed.pathname,
      query: parsed.searchParams,
      body
    })
    respond(response, result.status, result.body)
  } catch (error) {
    respond(response, 500, {
      ok: false,
      code: 'API_ERROR',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

async function handleMcp(
  engine: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  if (!isAuthorized(request)) {
    respond(response, 401, { error: '桥接令牌无效' })
    return
  }
  if (!mcpHandler) {
    respond(response, 503, { error: '网关尚未就绪' })
    return
  }
  let message: Record<string, unknown>
  try {
    message = await readJsonBody(request)
  } catch (error) {
    respond(response, 400, {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: `请求解析失败：${error instanceof Error ? error.message : String(error)}`
      }
    })
    return
  }
  try {
    const credential = credentialOf(request)
    const result = await mcpHandler(engine, message, clients.has(credential) ? credential : undefined)
    if (result === undefined) {
      response.writeHead(202, { 'content-length': 0 })
      response.end()
      return
    }
    respond(response, 200, result)
  } catch (error) {
    respond(response, 500, {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
    })
  }
}

function createHandler(): http.RequestListener {
  return (request, response) => {
    const url = request.url ?? '/'
    const apiPath = new URL(url, 'http://127.0.0.1').pathname
    if (API_PREFIX.test(apiPath)) {
      void handleApi(request, response).catch((error: unknown) => {
        respond(response, 500, {
          ok: false,
          code: 'API_ERROR',
          message: error instanceof Error ? error.message : String(error)
        })
      })
      return
    }
    const mcp = MCP_ENDPOINT.exec(url)
    if (mcp) {
      const engine = mcp[1]
      if (request.method === 'GET') {
        // No server-to-client stream: pi treats 405 as "this endpoint has none".
        response.writeHead(405, { allow: 'POST, DELETE' })
        response.end()
        return
      }
      if (request.method === 'DELETE') {
        response.writeHead(204)
        response.end()
        return
      }
      if (request.method === 'POST') {
        void handleMcp(engine, request, response).catch((error: unknown) => {
          respond(response, 500, { error: error instanceof Error ? error.message : String(error) })
        })
        return
      }
      response.writeHead(405, { allow: 'POST, DELETE' })
      response.end()
      return
    }
    if (request.method === 'GET' && url === '/health') {
      respond(response, 200, { ok: true, pending: pending.size })
      return
    }
    if (request.method === 'GET' && apiPath === '/events') {
      void handleEvents(request, response).catch((error: unknown) => {
        respond(response, 500, {
          events: [],
          error: error instanceof Error ? error.message : String(error)
        })
      })
      return
    }
    if (request.method === 'POST' && url === '/tools') {
      void handleTools(request, response).catch((error: unknown) => {
        respond(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      })
      return
    }
    if (request.method === 'POST' && url === '/ask') {
      void handleAsk(request, response).catch((error: unknown) => {
        respond(response, 500, {
          cancelled: true,
          reason: error instanceof Error ? error.message : String(error)
        })
      })
      return
    }
    respond(response, 404, { error: 'not found' })
  }
}

function listenOn(candidate: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const next = http.createServer(createHandler())
    // A pending question can stay unanswered for a long time; never cut the socket or request.
    next.requestTimeout = 0
    next.timeout = 0
    const onError = (error: NodeJS.ErrnoException): void => {
      next.removeListener('listening', onListening)
      next.close()
      reject(error)
    }
    const onListening = (): void => {
      next.removeListener('error', onError)
      next.on('error', (error) => console.warn('[bridge] server error:', error.message))
      resolve(next)
    }
    next.once('error', onError)
    next.once('listening', onListening)
    next.listen(candidate, '127.0.0.1')
  })
}

export async function startBridge(options: {
  preferredPort?: number
  token: string
}): Promise<{ url: string; port: number }> {
  token = options.token
  if (server) {
    const address = server.address()
    return {
      url: getBridgeUrl(),
      port: typeof address === 'object' && address ? address.port : port
    }
  }
  const preferred = options.preferredPort && options.preferredPort > 0 ? options.preferredPort : 0
  const candidates =
    preferred > 0
      ? [preferred, ...Array.from({ length: PORT_ATTEMPTS }, (_, index) => preferred + index + 1)]
      : [0]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const started = await listenOn(candidate)
      server = started
      const address = started.address()
      port = typeof address === 'object' && address ? address.port : candidate
      console.log(`[bridge] listening on ${getBridgeUrl()}`)
      return { url: getBridgeUrl(), port }
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') break
    }
  }
  throw new Error(
    `无法启动桌面桥接服务：${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

export function stopBridge(): void {
  cancelAllAsks('桌面端已关闭')
  for (const wake of [...eventWaiters]) wake()
  server?.close()
  server = null
  port = 0
}
