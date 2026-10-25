/**
 * MCP gateway: the desktop app speaks MCP to pi itself and forwards to the real engines.
 *
 * One service (the loopback bridge) exposes one endpoint per engine — `/mcp/codegraph`, `/mcp/lsp` —
 * and each endpoint is a gateway that spawns the upstream engine as a stdio MCP server. Only the
 * tools in the target's allowlist are listed, so the model sees a curated set instead of everything
 * the engine happens to offer (Serena alone exposes 29 tools).
 *
 * The endpoints speak streamable HTTP in its simplest legal form: a POST answers with
 * `application/json`, GET answers 405 (no server-to-client stream), DELETE ends the session.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { McpEngineId } from '../shared/types'
import { killTree } from './proc'
import { createJsonLineDecoder } from './json-lines'
import { callWebTool, WEB_TOOLS, WebError } from './web'
import { WARPGREP_TOOL, WarpGrep, WarpGrepError, type WarpGrepBackend } from './warpgrep'

export interface EngineTarget {
  id: McpEngineId
  /** Endpoint key: the engine id for the primary root, `<id>__<repo>` for the others. */
  key: string
  /** `upstream` spawns a stdio MCP server; `warpgrep` and `web` run in-process. */
  kind: 'upstream' | 'warpgrep' | 'web'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd: string
  /** Upstream tool names to expose; everything else is dropped. */
  allowlist: string[]
  timeoutMs: number
  /** WarpGrep only: key plus an optional custom OpenAI-compatible endpoint. */
  warpgrep?: WarpGrepBackend
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const PROTOCOL_VERSION = '2025-06-18'
const STDERR_TAIL = 20

/** A stdio MCP client for one engine process (JSONL framing, same as pi uses). */
class Upstream {
  private child: ChildProcessWithoutNullStreams | null = null
  private seq = 0
  private pending = new Map<number, PendingRequest>()
  private stderrTail: string[] = []
  private starting: Promise<void> | null = null
  private failure: string | undefined

  constructor(private readonly target: EngineTarget) {}

  /** Only real failures, never the engine's own log output (Serena logs every request to stderr). */
  get error(): string | undefined {
    return this.failure
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      const error = message.error as { message?: string }
      entry.reject(new Error(error.message ?? 'upstream error'))
    } else {
      entry.resolve(message.result)
    }
  }

  private failAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.child) return
    const command = this.target.command
    const args = this.target.args ?? []
    if (!command) throw new Error('上游命令未配置')
    this.stderrTail = []
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.target.cwd,
        env: { ...process.env, ...(this.target.env ?? {}) },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.child = child
      child.stdout.setEncoding('utf8')
      const decode = createJsonLineDecoder((message) => {
        if (this.child === child) this.handleMessage(message)
      })
      child.stdout.on('data', (chunk: string) => {
        if (this.child === child) decode(chunk)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (this.child !== child) return
        for (const line of chunk.split('\n')) {
          const text = line.trim()
          if (!text) continue
          this.stderrTail.push(text)
          if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift()
        }
      })
      const onError = (error: Error): void => {
        if (this.child !== child) return
        this.child = null
        killTree(child)
        this.failure = `上游启动失败：${error.message}`
        this.failAll(this.failure)
        reject(error)
      }
      child.on('error', onError)
      child.stdin.on('error', onError)
      child.on('exit', (code) => {
        if (this.child !== child) return
        this.child = null
        this.failure =
          `上游已退出（code ${code ?? 'null'}）` +
          (this.stderrTail.length > 0 ? `：${this.stderrTail.slice(-2).join(' ').slice(0, 300)}` : '')
        this.failAll(this.failure)
      })
      this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'agent-desktop-gateway', version: '0.2.0' }
      })
        .then(() => {
          if (this.child !== child) {
            reject(new Error('网关已停止'))
            return
          }
          this.failure = undefined
          this.notify('notifications/initialized')
          resolve()
        })
        .catch((error: unknown) => {
          if (this.child !== child) {
            reject(error)
            return
          }
          this.failure =
            `上游初始化失败：${error instanceof Error ? error.message : String(error)}` +
            (this.stderrTail.length > 0 ? `：${this.stderrTail.slice(-2).join(' ').slice(0, 300)}` : '')
          this.stop()
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    }).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  request(method: string, params: unknown, timeoutMs = this.target.timeoutMs): Promise<unknown> {
    const child = this.child
    if (!child || child.killed || child.stdin.destroyed) return Promise.reject(new Error('上游未运行'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.target.id} 在 ${Math.round(timeoutMs / 1000)}s 内没有响应`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method: string, params?: unknown): void {
    const child = this.child
    if (!child || child.killed || child.stdin.destroyed) return
    const message = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  cancel(id: number): void {
    this.notify('notifications/cancelled', { requestId: id, reason: 'client cancelled' })
  }

  stop(sync = false): void {
    this.failAll('网关已停止')
    const child = this.child
    this.child = null
    if (child) killTree(child, sync)
  }
}

/** One endpoint: curated tool list plus forwarding to its upstream. */
class EngineGateway {
  private upstream: Upstream
  private tools: Array<Record<string, unknown>> | null = null
  private inflight = new Map<string, number>()

  constructor(readonly target: EngineTarget) {
    this.upstream = new Upstream(target)
  }

  get error(): string | undefined {
    return this.upstream.error
  }

  private async loadTools(): Promise<Array<Record<string, unknown>>> {
    if (this.tools) return this.tools
    await this.upstream.start()
    const result = (await this.upstream.request('tools/list', {})) as {
      tools?: Array<Record<string, unknown>>
    }
    const allowed = new Set(this.target.allowlist)
    const tools = (result.tools ?? []).filter(
      (tool) => typeof tool.name === 'string' && allowed.has(tool.name)
    )
    this.tools = this.target.id === 'codegraph' ? tools.map(trimCodegraphTool) : tools
    return this.tools
  }

  async handle(message: Record<string, unknown>): Promise<unknown> {
    const method = typeof message.method === 'string' ? message.method : ''
    const params = (message.params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `agent-desktop-${this.target.id}`, version: '0.3.0' },
          instructions:
            'CodeGraph gateway. Only curated tools are exposed; results list symbols and ' +
            'file:line locations without source bodies unless a tool is asked for them.'
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: await this.loadTools() }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        if (!this.target.allowlist.includes(name)) {
          throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 })
        }
        const tools = await this.loadTools()
        if (!tools.some((tool) => tool.name === name)) {
          throw Object.assign(new Error(`工具 ${name} 当前不可用（引擎未提供）`), { code: -32603 })
        }
        const requestId = typeof message.id === 'number' ? message.id : undefined
        const forwarded =
          this.target.id === 'codegraph'
            ? codegraphCall(name, (params.arguments ?? {}) as Record<string, unknown>)
            : { name, arguments: params.arguments ?? {} }
        const promise = this.upstream.request('tools/call', forwarded)
        if (requestId !== undefined) this.inflight.set(String(requestId), requestId)
        try {
          return await promise
        } finally {
          if (requestId !== undefined) this.inflight.delete(String(requestId))
        }
      }
      case 'resources/list':
        return { resources: [] }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'prompts/list':
        return { prompts: [] }
      default:
        throw Object.assign(new Error(`method not supported: ${method}`), { code: -32603 })
    }
  }

  cancel(requestId: string): void {
    const id = this.inflight.get(requestId)
    if (id !== undefined) this.upstream.cancel(id)
  }

  stop(sync = false): void {
    this.upstream.stop(sync)
    this.tools = null
    this.inflight.clear()
  }
}

/**
 * CodeGraph returns source bodies by default. The desktop tool is for locating code, not for
 * reading it, so `codegraph_explore` is turned into a plain search unless `includeSource` is set,
 * and `codegraph_node` loses its code block the same way.
 */
function trimCodegraphTool(tool: Record<string, unknown>): Record<string, unknown> {
  if (tool.name !== 'codegraph_explore') return tool
  const schema = (tool.inputSchema ?? {}) as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  return {
    ...tool,
    description:
      'Locate relevant symbols in this project. By default returns names, signatures and ' +
      'file:line locations, NOT source bodies. Use callers/impact for relationships and read ' +
      'files for source. Only includeSource=true returns source excerpts.',
    inputSchema: {
      ...schema,
      properties: {
        ...(schema.properties ?? {}),
        includeSource: {
          type: 'boolean',
          default: false,
          description: 'Return source excerpts. Default false: only locations and signatures.'
        }
      }
    }
  }
}

function codegraphCall(
  name: string,
  args: Record<string, unknown>
): { name: string; arguments: Record<string, unknown> } {
  if (name === 'codegraph_explore') {
    const includeSource = args.includeSource === true
    const rest = { ...args }
    delete rest.includeSource
    if (includeSource) return { name: 'codegraph_explore', arguments: rest }
    const search: Record<string, unknown> = { query: rest.query, limit: 10 }
    if (typeof rest.projectPath === 'string') search.projectPath = rest.projectPath
    return { name: 'codegraph_search', arguments: search }
  }
  if (name === 'codegraph_node') {
    return {
      name,
      arguments: { ...args, includeCode: args.includeCode === true }
    }
  }
  return { name, arguments: args }
}

/** WarpGrep runs inside the gateway: no upstream process, one tool, hosted search. */
class WarpGrepGateway {
  private client: WarpGrep
  private failure: string | undefined

  constructor(readonly target: EngineTarget) {
    this.client = new WarpGrep(target.cwd, target.warpgrep ?? {})
  }

  get error(): string | undefined {
    return this.failure
  }

  async handle(message: Record<string, unknown>): Promise<unknown> {
    const method = typeof message.method === 'string' ? message.method : ''
    const params = (message.params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-desktop-warpgrep', version: '0.3.0' },
          instructions:
            'WarpGrep gateway: natural-language code search over this project. File excerpts read ' +
            'during a search are sent to ' +
            (this.target.warpgrep?.baseUrl?.trim() || 'api.morphllm.com/v1') +
            '.',
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: [WARPGREP_TOOL] }
      case 'tools/call': {
        if (params.name !== WARPGREP_TOOL.name) {
          throw Object.assign(new Error(`unknown tool: ${String(params.name)}`), { code: -32602 })
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>
        const query = typeof args.search_string === 'string' ? args.search_string.trim() : ''
        if (!query) {
          throw Object.assign(new Error('search_string 不能为空'), { code: -32602 })
        }
        const budget = Math.min(Math.max(Number(args.maxChars ?? 12000) || 12000, 1000), 48000)
        try {
          const result = await this.client.search(query)
          this.failure = undefined
          const sections: string[] = []
          if (result.files) sections.push(result.files)
          else if (result.answer) sections.push(result.answer)
          if (args.includeSource === true && result.files) {
            const source = await this.client.sources(result.files, budget)
            if (source) sections.push(source)
          }
          const text = sections.join('\n\n') || 'No results.'
          return {
            content: [{ type: 'text', text: text.slice(0, budget) }],
            structuredContent: { files: result.files, answer: result.answer }
          }
        } catch (error) {
          const messageText =
            error instanceof WarpGrepError
              ? `${error.code}: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error)
          this.failure = messageText.slice(0, 300)
          throw Object.assign(new Error(messageText), { code: -32603 })
        }
      }
      case 'resources/list':
        return { resources: [] }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'prompts/list':
        return { prompts: [] }
      default:
        throw Object.assign(new Error(`method not supported: ${method}`), { code: -32603 })
    }
  }

  cancel(): void {
    // Hosted search is short-lived; there is nothing to cancel upstream.
  }

  stop(): void {
    this.failure = undefined
  }
}

/**
 * Web search + fetch run in-process: the gateway owns the providers, so no child process and no
 * upstream tool list. Which search backend answers is decided per call (see `web.ts`).
 */
class WebGateway {
  private failure: string | undefined

  constructor(readonly target: EngineTarget) {}

  get error(): string | undefined {
    return this.failure
  }

  async handle(message: Record<string, unknown>): Promise<unknown> {
    const method = typeof message.method === 'string' ? message.method : ''
    const params = (message.params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-desktop-web', version: '0.3.0' },
          instructions:
            'Web gateway: web_search returns titles, URLs and snippets; web_fetch downloads one page ' +
            'and converts it to Markdown. Local and private addresses are refused.'
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: WEB_TOOLS }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        if (!this.target.allowlist.includes(name)) {
          throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 })
        }
        try {
          const result = await callWebTool(name, (params.arguments ?? {}) as Record<string, unknown>)
          this.failure = undefined
          return {
            content: [{ type: 'text', text: result.text }],
            ...(result.structured ? { structuredContent: result.structured } : {})
          }
        } catch (error) {
          const text =
            error instanceof WebError
              ? `${error.code}: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error)
          this.failure = text.slice(0, 300)
          throw Object.assign(new Error(text), { code: -32603 })
        }
      }
      case 'resources/list':
        return { resources: [] }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'prompts/list':
        return { prompts: [] }
      default:
        throw Object.assign(new Error(`method not supported: ${method}`), { code: -32603 })
    }
  }

  cancel(): void {
    // Requests are short-lived HTTP calls; there is nothing to cancel upstream.
  }

  stop(): void {
    this.failure = undefined
  }
}

interface Gateway {
  readonly target: EngineTarget
  readonly error: string | undefined
  handle(message: Record<string, unknown>): Promise<unknown>
  cancel(requestId: string): void
  stop(sync?: boolean): void
}

const gateways = new Map<string, Gateway>()

function createGateway(target: EngineTarget): Gateway {
  if (target.kind === 'warpgrep') return new WarpGrepGateway(target)
  if (target.kind === 'web') return new WebGateway(target)
  return new EngineGateway(target)
}

/** Point the endpoints at the engines for the current session directory. */
export function configure(targets: EngineTarget[], scope = ''): void {
  const prefix = scope ? scope + '/' : ''
  targets = targets.map(target => ({ ...target, key: prefix + target.key }))
  const wanted = new Set(targets.map((target) => target.key))
  for (const [key, gateway] of gateways) {
    if (scope ? !key.startsWith(prefix) : key.includes('/')) continue
    if (!wanted.has(key)) {
      gateway.stop()
      gateways.delete(key)
    }
  }
  for (const target of targets) {
    const existing = gateways.get(target.key)
    const same =
      existing &&
      existing.target.kind === target.kind &&
      existing.target.command === target.command &&
      existing.target.cwd === target.cwd &&
      JSON.stringify(existing.target.warpgrep ?? {}) === JSON.stringify(target.warpgrep ?? {}) &&
      (existing.target.args ?? []).join('\u0000') === (target.args ?? []).join('\u0000')
    if (same) continue
    existing?.stop()
    gateways.set(target.key, createGateway(target))
  }
}

export function releaseScope(scope: string): void { configure([], scope) }

export function isConfigured(key: string): boolean {
  return gateways.has(key)
}

export function gatewayError(key: string): string | undefined {
  return gateways.get(key)?.error
}

/** Every endpoint key that currently has a gateway (primary engines plus per-repository ones). */
export function configuredKeys(): string[] {
  return [...gateways.keys()]
}

/**
 * Handle one JSON-RPC message for an endpoint. Returns the response object, or undefined for
 * notifications (which the bridge answers with 202).
 */
export async function handleMessage(
  key: string,
  message: Record<string, unknown>
): Promise<unknown | undefined> {
  const gateway = gateways.get(key)
  const method = typeof message.method === 'string' ? message.method : ''
  if (message.id === undefined || message.id === null) {
    if (method === 'notifications/cancelled' && gateway) {
      const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId
      if (requestId !== undefined) gateway.cancel(String(requestId))
    }
    return undefined
  }
  if (!gateway) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32603, message: `${key} 网关未启用` }
    }
  }
  try {
    const result = await gateway.handle(message)
    return { jsonrpc: '2.0', id: message.id, result }
  } catch (error) {
    const code = (error as { code?: number }).code ?? -32603
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

export function stopAll(sync = false): void {
  for (const gateway of gateways.values()) gateway.stop(sync)
  gateways.clear()
}
