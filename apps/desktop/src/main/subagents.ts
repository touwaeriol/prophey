import { writeJsonAtomic } from './storage'
/**
 * Subagent runtime: independent Prophey loops or pi RPC child processes, matching the parent.
 *
 * The main agent drives these through the desktop MCP tools; this module owns the processes, the
 * state machine, the collected messages/tool calls and the limits (concurrency, runtime, idle).
 *
 * Subagents run with `--no-mcp` by default: they must not ask the user questions or start nested
 * subagents. Their sessions live in their own directory so they never show up in the sidebar.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PiRpcClient } from './pi-rpc'
import { withRealBash } from './shell'
import type { AgentMode, AgentPreset } from './agents'
import type { AgentEngine } from './agent/engine'
import type { ContextUsage, PiStatus } from '@shared/types'

export type SubagentStatus = 'starting' | 'idle' | 'streaming' | 'error' | 'stopped'

/**
 * How the parent agent learns that a subagent finished a turn.
 *
 * - `queue`: append a notice to the parent session; the parent reads it on its next turn
 * - `wake`: also start a parent turn right away
 * - `none`: only the `get_subagent` / `wait_subagent` tools can see the result
 */
export type NotifyMode = 'queue' | 'wake' | 'none'

export interface SubagentMessage {
  role: 'assistant' | 'user'
  text: string
  ts: number
  toolCalls?: string[]
}

export interface SubagentCall {
  tool: string
  ts: number
  ok: boolean
  summary?: string
  /** Wall time of the call; both engines report it on `tool_execution_end`. */
  durationMs?: number
}

/** The assistant turn in flight: the panel shows this while the run streams. */
export interface SubagentDraft {
  text: string
  thinking: string
  ts: number
}

/** A tool call that started but has not returned yet. */
export interface SubagentActiveCall {
  id: string
  tool: string
  target?: string
  startedAt: number
}

export interface SubagentRecord {
  engine?: 'pi' | 'prophey'
  id: string
  label?: string
  agent?: string
  mode: AgentMode
  cwd: string
  status: SubagentStatus
  createdAt: number
  startedAt?: number
  settledAt?: number
  error?: string
  model?: { provider: string; id: string }
  tools?: string[]
  messages: SubagentMessage[]
  calls: SubagentCall[]
  /** Assistant text still streaming; cleared when the turn settles. */
  draft?: SubagentDraft
  /** Tool calls in flight, shown as running rows until `tool_execution_end`. */
  activeCalls: SubagentActiveCall[]
  finalText?: string
  tokens?: number
  /**
   * How full the subagent's own request is (the same meter the session ring shows).
   *
   * A subagent burns its own context, and a background run that fills it up produces a worse answer
   * or compacts behind the user's back, so the panel has to show it. Prophey publishes it from its
   * status while the turn streams; pi is asked at the turn boundaries.
   */
  contextUsage?: ContextUsage
  runtimeMs?: number
  timeoutMs: number
  notify: NotifyMode
  /** The subagent's own session file, so a run can be inspected later. */
  sessionFile?: string
  /** The main session that started it, for correlating runs after a restart. */
  parentSession?: string
  /** Loaded from disk: the process is gone, only the result remains. */
  restored?: boolean
}

export interface StartOptions {
  engine?: 'pi' | 'prophey'
  additional?: string[]
  task: string
  preset?: AgentPreset
  mode?: AgentMode
  provider?: string
  model?: string
  thinking?: string
  tools?: string[]
  cwd?: string
  label?: string
  timeoutMs?: number
  waitMs?: number
  desktopTools?: boolean
  notify?: NotifyMode
  parentSession?: string
}

export interface StartResult {
  record: SubagentRecord
  resolved: {
    agent?: string
    mode: AgentMode
    tools?: string[]
    model?: { provider: string; id: string }
    cwd: string
  }
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_WAIT_MS = 120 * 1000
const IDLE_TIMEOUT_MS = 30 * 60 * 1000
const READY_TIMEOUT_MS = 30_000
const MAX_KEPT = 120
const STORE_VERSION = 1
/** pi is polled for context usage at most this often, on assistant-message boundaries. */
const USAGE_POLL_MS = 2500
/** Streaming deltas are coalesced to about eight updates a second before they reach the window. */
const PROGRESS_EMIT_MS = 120

interface PendingCall {
  tool: string
  target?: string
}

interface Internal {
  record: SubagentRecord
  /** Missing for records restored from disk: there is no process behind them. */
  rpc?: PiRpcClient
  own?: AgentEngine
  collecting?: boolean
  interrupting?: boolean
  pendingCalls: Map<string, PendingCall>
  waiters: Array<(record: SubagentRecord) => void>
  totalTimer?: NodeJS.Timeout
  idleTimer?: NodeJS.Timeout
  /** Coalesces `message_update` deltas; see `emitProgress`. */
  progressTimer?: NodeJS.Timeout
  lastProgressAt: number
  settled: boolean
  /** Incremented per turn, so one settle is reported once even though two events fire. */
  runId: number
  notifiedRun: number
  /** Last time pi was asked for its meter; it has no status stream of its own. */
  lastUsageAt: number
}

export class SubagentManager {
  private readonly items = new Map<string, Internal>()
  private maxConcurrent = 4
  private saveTimer?: NodeJS.Timeout

  constructor(
    private readonly options: {
      userData: string
      /** Non-tool extensions shared with the desktop's pi engine (e.g. model metadata). */
      piExtensions?: () => string[]
      /** Called when a record changes, for the settings/UI side. */
      onUpdate?: (record: SubagentRecord) => void
      /** Called once per finished turn when `notify` is not `none`. */
      onSettle?: (record: SubagentRecord) => void
      resolveModel?: (provider: string, id: string) => Promise<boolean>
      createOwnEngine?: (options: {
        id: string; tools?: string[]; appendSystemPrompt?: string
        onEvent: (event: Record<string, unknown>) => void
        /** The own engine's state, so its context meter can follow the turn. */
        onStatus?: (status: PiStatus) => void
      }) => AgentEngine
    }
  ) {
    this.restore()
  }

  private storePath(): string {
    return path.join(this.options.userData, 'subagents.json')
  }

  /**
   * Bring back the records of previous runs. Their processes are gone, so anything that was still
   * running is marked stopped; finished results stay queryable by id (`get_subagent`,
   * `list_subagents`, the subagent panel).
   */
  private restore(): void {
    let parsed: { records?: SubagentRecord[] }
    try {
      parsed = JSON.parse(readFileSync(this.storePath(), 'utf8')) as { records?: SubagentRecord[] }
    } catch {
      return
    }
    const records = Array.isArray(parsed?.records) ? parsed.records : []
    for (const record of records) {
      if (!record || typeof record.id !== 'string') continue
      const restored: SubagentRecord = {
        ...record,
        messages: Array.isArray(record.messages) ? record.messages : [],
        calls: Array.isArray(record.calls) ? record.calls : [],
        // A restored record has no process: nothing is streaming and no call is in flight.
        draft: undefined,
        activeCalls: [],
        notify: record.notify ?? 'none',
        timeoutMs: record.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        restored: true
      }
      if (restored.status === 'starting' || restored.status === 'streaming') {
        restored.status = 'stopped'
        restored.error = restored.error ?? '应用已重启，子代理进程已结束'
      }
      this.items.set(restored.id, {
        record: restored,
        pendingCalls: new Map(),
        waiters: [],
        settled: true,
        lastProgressAt: 0,
        runId: 0,
        notifiedRun: 0,
        lastUsageAt: 0
      })
    }
    this.prune()
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save()
    }, 800)
  }

  private save(): void {
    const records = [...this.items.values()]
      .map((item) => item.record)
      .sort((a, b) => b.createdAt - a.createdAt)
    void writeJsonAtomic(this.storePath(), { version: STORE_VERSION, records }).catch(() => {
      // A lost record is not worth breaking a run over.
    })
  }

  setMaxConcurrent(value: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(value))
  }

  private sessionDir(): string {
    return path.join(this.options.userData, 'subagents')
  }

  private emit(record: SubagentRecord): void {
    this.options.onUpdate?.(record)
    this.scheduleSave()
  }

  /**
   * Streaming text arrives per token; the window only needs a few frames a second. Leading edge
   * fires immediately, the rest is coalesced into one trailing emit.
   */
  private emitProgress(internal: Internal): void {
    if (internal.progressTimer) return
    const wait = PROGRESS_EMIT_MS - (Date.now() - internal.lastProgressAt)
    if (wait <= 0) {
      internal.lastProgressAt = Date.now()
      this.emit(internal.record)
      return
    }
    internal.progressTimer = setTimeout(() => {
      internal.progressTimer = undefined
      internal.lastProgressAt = Date.now()
      this.emit(internal.record)
    }, wait)
  }

  /** Any non-progress update supersedes a queued delta emit. */
  private clearProgress(internal: Internal): void {
    if (!internal.progressTimer) return
    clearTimeout(internal.progressTimer)
    internal.progressTimer = undefined
  }

  private runningCount(): number {
    let count = 0
    for (const item of this.items.values()) {
      if (item.record.restored) continue
      if (item.record.status === 'starting' || item.record.status === 'streaming' || item.record.status === 'idle') {
        count += 1
      }
    }
    return count
  }

  list(): SubagentRecord[] {
    return [...this.items.values()].map((item) => item.record)
  }

  get(id: string): SubagentRecord | undefined {
    return this.items.get(id)?.record
  }

  /** Start a subagent and, in sync mode, wait up to `waitMs` for its first answer. */
  async start(options: StartOptions): Promise<StartResult> {
    if (this.runningCount() >= this.maxConcurrent) {
      throw Object.assign(new Error(`已有 ${this.maxConcurrent} 个子代理在运行，先 stop_subagent 或等其结束`), {
        code: 'SUBAGENT_LIMIT'
      })
    }
    const preset = options.preset
    if (options.engine === 'prophey' && !this.options.createOwnEngine) {
      throw new Error('Prophey 子代理执行器尚未配置；不会回退到 pi')
    }
    if (options.engine === 'prophey' && options.desktopTools) {
      throw new Error('Prophey 子代理暂不接入桌面 MCP；请关闭子代理的桌面工具选项')
    }
    const thinking = options.thinking ?? (preset?.model && preset.model !== 'inherit' ? preset.model.thinking : undefined)
    const mode: AgentMode = options.mode ?? preset?.mode ?? 'background'
    const cwd = options.cwd ?? process.cwd()
    if (!existsSync(cwd)) {
      throw Object.assign(new Error(`工作目录不存在：${cwd}`), { code: 'BAD_CWD' })
    }
    const selectedTools = options.tools ?? preset?.tools
    const tools = selectedTools?.length ? selectedTools : undefined
    const model =
      options.provider && options.model
        ? { provider: options.provider, id: options.model }
        : preset && preset.model && preset.model !== 'inherit'
          ? preset.model
          : undefined
    const id = `sa_${randomUUID().slice(0, 8)}`
    const record: SubagentRecord = {
      id,
      engine: options.engine ?? 'pi',
      label: options.label,
      agent: preset?.id,
      mode,
      cwd,
      status: 'starting',
      createdAt: Date.now(),
      model,
      tools,
      messages: [],
      calls: [],
      activeCalls: [],
      timeoutMs: options.timeoutMs ?? preset?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Sync mode already returns the answer. A background run has nobody waiting on it, so the
      // default wakes the parent: otherwise the notice sits in the transcript until the user
      // happens to write something, and the parent never continues on its own.
      notify: options.notify ?? (mode === 'background' ? 'wake' : 'none'),
      parentSession: options.parentSession
    }
    const rpc = options.engine === 'prophey' ? undefined : new PiRpcClient()
    const internal: Internal = {
      record,
      rpc,
      pendingCalls: new Map(),
      waiters: [],
      settled: false,
      lastProgressAt: 0,
      runId: 0,
      notifiedRun: 0,
      lastUsageAt: 0
    }
    this.items.set(id, internal)
    this.prune()

    if (!rpc) {
      try {
        const own = this.options.createOwnEngine!({
          id, tools, appendSystemPrompt: preset?.appendSystemPrompt,
          onEvent: (event) => this.onEvent(internal, event),
          onStatus: (status) => this.onStatus(internal, status)
        })
        internal.own = own
        await own.start({ primary: cwd, additional: options.additional ?? [] }, { model })
        if (thinking) await own.setThinkingLevel(thinking)
        if (own.state().phase !== 'ready') throw new Error(own.state().error ?? 'Prophey 子代理启动失败')
        const actual = own.state().model
        if (!actual) throw new Error('Prophey 子代理没有可用模型')
        if (model && (model.provider !== actual.provider || model.id !== actual.id)) {
          throw new Error(`Prophey 子代理无法使用指定模型 ${model.provider}/${model.id}`)
        }
        record.model = { provider: actual.provider, id: actual.id }
        record.sessionFile = own.state().sessionFile
        record.startedAt = Date.now()
        internal.totalTimer = setTimeout(() => {
          void this.stop(id, true, '超过子代理运行时限')
        }, record.timeoutMs)
        this.runOwn(internal, options.task)
        const timedOut = mode === 'sync'
          ? await this.waitFor(internal, Math.min(options.waitMs ?? DEFAULT_WAIT_MS, 300_000)) : false
        return { record, resolved: { agent: preset?.id, mode, tools, model: record.model, cwd }, timedOut }
      } catch (error) {
        record.status = 'error'
        record.error = error instanceof Error ? error.message : String(error)
        internal.own?.dispose()
        this.finish(internal)
        throw error
      }
    }

    rpc.on('event', (event: Record<string, unknown>) => this.onEvent(internal, event))
    rpc.on('exit', () => {
      if (record.status === 'stopped' || record.status === 'error') return
      record.status = 'error'
      record.error = record.error ?? `子代理进程退出（${rpc.stderrTail.slice(-200) || '无输出'}）`
      this.finish(internal)
    })

    const args = ['--session-dir', this.sessionDir()]
    for (const file of this.options.piExtensions?.() ?? []) args.push('--extension', file)
    if (!options.desktopTools) args.push('--no-mcp')
    if (tools && tools.length > 0) args.push('--tools', tools.join(','))
    if (model) args.push('--provider', model.provider, '--model', thinking ? `${model.id}:${thinking}` : model.id)
    const appendPrompt = preset?.appendSystemPrompt
    if (appendPrompt) args.push('--append-system-prompt', appendPrompt)

    await fs.mkdir(this.sessionDir(), { recursive: true })
    rpc.start(cwd, args, withRealBash({}))
    record.startedAt = Date.now()
    this.emit(record)

    internal.totalTimer = setTimeout(() => {
      void this.stop(id, true, `超过 ${Math.round(record.timeoutMs / 1000)}s 运行上限`)
    }, record.timeoutMs)

    await this.waitReady(internal)
    if (record.status === 'error') {
      throw Object.assign(new Error(record.error ?? '子代理启动失败'), { code: 'SUBAGENT_START_FAILED' })
    }
    record.status = 'idle'
    this.emit(record)

    await rpc.request('prompt', { message: options.task }, 30_000).catch((error: unknown) => {
      record.status = 'error'
      record.error = error instanceof Error ? error.message : String(error)
      this.finish(internal)
    })

    const resolved = { agent: preset?.id, mode, tools, model, cwd }
    if (mode === 'background') {
      return { record, resolved, timedOut: false }
    }
    const waitMs = Math.min(options.waitMs ?? DEFAULT_WAIT_MS, 300_000)
    const timedOut = await this.waitFor(internal, waitMs)
    return { record, resolved, timedOut }
  }

  private runOwn(internal: Internal, text: string): void {
    if (!internal.own) throw new Error('Prophey 子代理不存在')
    if (internal.idleTimer) clearTimeout(internal.idleTimer)
    const pending = internal.own.prompt(text)
    const run = internal.runId
    void pending.then((result) => {
      if (!result.ok && run === internal.runId && !internal.interrupting && internal.record.status !== 'stopped') {
        internal.record.status = 'error'
        internal.record.error = result.error
        this.finish(internal)
      }
    }).catch((error) => {
      if (run !== internal.runId || internal.interrupting || internal.record.status === 'stopped') return
      internal.record.status = 'error'
      internal.record.error = String(error)
      this.finish(internal)
    })
  }

  private async waitReady(internal: Internal): Promise<void> {
    const rpc = internal.rpc
    if (!rpc) return
    const started = Date.now()
    while (Date.now() - started < READY_TIMEOUT_MS) {
      try {
        const state = await rpc.request<{
          data?: { sessionFile?: string; model?: { provider?: string; id?: string } }
        }>('get_state', {}, 3000)
        const file = state.data?.sessionFile
        if (typeof file === 'string') internal.record.sessionFile = file
        // Record what pi actually loaded: with no explicit model this is the inherited one.
        const actual = state.data?.model
        if (actual && typeof actual.provider === 'string' && typeof actual.id === 'string') {
          internal.record.model = { provider: actual.provider, id: actual.id }
        }
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    internal.record.status = 'error'
    internal.record.error = '子代理未在 30s 内就绪'
    rpc.stop()
    this.finish(internal)
  }

  /**
   * Keep the record's meter in step with a status the subagent's own engine published.
   *
   * Prophey publishes while the round streams, which is why the ring moves before the turn
   * settles; the value is only emitted when it changed, so a status that merely moved the phase
   * does not repaint the drawer.
   */
  private onStatus(internal: Internal, status: PiStatus): void {
    if (!this.recordUsage(internal, status.contextUsage)) return
    this.emit(internal.record)
  }

  /** pi has no status stream: ask for its meter at the turn boundaries, at most every 2.5s. */
  private refreshUsage(internal: Internal): void {
    const rpc = internal.rpc
    if (!rpc) return
    const now = Date.now()
    if (now - internal.lastUsageAt < USAGE_POLL_MS) return
    internal.lastUsageAt = now
    void rpc
      .request<{ data?: { contextUsage?: ContextUsage } }>('get_session_stats', {}, 5000)
      .then((response) => {
        if (this.recordUsage(internal, response.data?.contextUsage)) this.emit(internal.record)
      })
      .catch(() => {
        // The meter is best effort; a refused request must not fail the run.
      })
  }

  /** Store a usage snapshot, reporting whether anything the panel shows actually changed. */
  private recordUsage(internal: Internal, usage: ContextUsage | undefined): boolean {
    if (!usage) return false
    const record = internal.record
    const last = record.contextUsage
    const next: ContextUsage = {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
      ...(usage.breakdown ? { breakdown: usage.breakdown } : {})
    }
    if (
      last &&
      last.tokens === next.tokens &&
      last.contextWindow === next.contextWindow &&
      last.percent === next.percent
    ) {
      return false
    }
    record.contextUsage = next
    return true
  }

  private onEvent(internal: Internal, event: Record<string, unknown>): void {
    const record = internal.record
    switch (event.type) {
      case 'agent_start':
        internal.runId += 1
        internal.settled = false
        record.status = 'streaming'
        record.draft = undefined
        record.activeCalls = []
        this.clearProgress(internal)
        this.emit(record)
        this.refreshUsage(internal)
        return
      case 'message_start': {
        const message = event.message as Record<string, unknown> | undefined
        if (message?.role !== 'assistant') return
        record.draft = { text: '', thinking: '', ts: Date.now() }
        this.clearProgress(internal)
        this.emit(record)
        return
      }
      case 'message_update': {
        const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
        const delta = typeof update?.delta === 'string' ? update.delta : ''
        if (!delta) return
        if (update?.type !== 'text_delta' && update?.type !== 'thinking_delta') return
        const draft = record.draft ?? (record.draft = { text: '', thinking: '', ts: Date.now() })
        if (update.type === 'text_delta') draft.text += delta
        else draft.thinking += delta
        this.emitProgress(internal)
        return
      }
      case 'tool_execution_start': {
        const callId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
        const tool = typeof event.toolName === 'string' ? event.toolName : 'tool'
        const target = callTarget(tool, event.args)
        if (callId) internal.pendingCalls.set(callId, { tool, target })
        record.activeCalls.push({
          id: callId || `call-${record.activeCalls.length}-${Date.now()}`,
          tool,
          ...(target ? { target } : {}),
          startedAt: Date.now()
        })
        this.clearProgress(internal)
        this.emit(record)
        return
      }
      case 'tool_execution_end': {
        const callId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
        const tool = typeof event.toolName === 'string' ? event.toolName : 'tool'
        const pending = callId ? internal.pendingCalls.get(callId) : undefined
        if (callId) internal.pendingCalls.delete(callId)
        const index = callId
          ? record.activeCalls.findIndex((call) => call.id === callId)
          : record.activeCalls.findIndex((call) => call.tool === tool)
        const active = index >= 0 ? record.activeCalls.splice(index, 1)[0] : undefined
        const reported = typeof event.durationMs === 'number' ? event.durationMs : undefined
        const durationMs = reported ?? (active ? Date.now() - active.startedAt : undefined)
        const summary = pending?.target ?? active?.target
        record.calls.push({
          tool,
          ts: Date.now(),
          ok: event.isError !== true && (event.result as { isError?: boolean } | undefined)?.isError !== true,
          ...(summary ? { summary } : {}),
          ...(durationMs !== undefined ? { durationMs } : {})
        })
        this.clearProgress(internal)
        this.emit(record)
        return
      }
      case 'agent_settled':
      case 'agent_end':
        void this.collect(internal)
        return
      case 'message_end': {
        // Live progress: collect() rewrites the transcript when the turn settles, but until then
        // the panel and the transcript card should show what the subagent is saying.
        const message = event.message as Record<string, unknown> | undefined
        if (!message || message.role !== 'assistant') return
        const text = extractText(message)
        if (message.stopReason === 'error') {
          record.status = 'error'
          record.error = text
        }
        record.draft = undefined
        if (text.trim()) {
          record.messages.push({
            role: 'assistant',
            text,
            ts: typeof message.timestamp === 'number' ? message.timestamp : Date.now()
          })
        }
        this.clearProgress(internal)
        this.emit(record)
        this.refreshUsage(internal)
        return
      }
      default:
    }
  }

  /** Pull the transcript after a turn settles; only assistant text is kept. */
  private async collect(internal: Internal): Promise<void> {
    if (internal.collecting) return
    internal.collecting = true
    try { await this.collectResult(internal) } finally { internal.collecting = false }
  }

  private async collectResult(internal: Internal): Promise<void> {
    const record = internal.record
    const rpc = internal.rpc
    const own = internal.own
    const run = internal.runId
    if (!rpc && !own) return
    try {
      const response = own ? { data: { messages: await own.messages() as Array<Record<string, unknown>> } } : await rpc!.request<{ data?: { messages?: Array<Record<string, unknown>> } }>(
        'get_messages',
        {},
        10_000
      )
      const messages = response.data?.messages ?? []
      record.messages = []
      for (const message of messages) {
        const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : undefined
        if (!role) continue
        const text = extractText(message)
        const toolCalls = extractToolCalls(message)
        if (!text && toolCalls.length === 0) continue
        record.messages.push({
          role,
          text,
          ts: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
          ...(toolCalls.length > 0 ? { toolCalls } : {})
        })
      }
      const lastAssistant = [...record.messages].reverse().find((message) => message.role === 'assistant')
      if (lastAssistant?.text) record.finalText = lastAssistant.text
    } catch {
      // transcript is best effort
    }
    try {
      const stats = own
        ? { data: await own.stats() as { tokens?: { total?: number }; contextUsage?: ContextUsage } }
        : await rpc!.request<{ data?: { tokens?: { total?: number }; contextUsage?: ContextUsage } }>(
          'get_session_stats',
          {},
          5000
        )
      const total = stats.data?.tokens?.total
      if (typeof total === 'number') record.tokens = total
      this.recordUsage(internal, stats.data?.contextUsage)
    } catch {
      // stats are optional
    }
    if (run !== internal.runId) return
    record.draft = undefined
    record.activeCalls = []
    if (record.status !== 'stopped' && record.status !== 'error') record.status = 'idle'
    record.settledAt = Date.now()
    record.runtimeMs = record.startedAt ? Date.now() - record.startedAt : undefined
    this.clearProgress(internal)
    this.emit(record)
    this.notifySettle(internal)
    this.resetIdle(internal)
    this.releaseWaiters(internal)
  }

  /** Tell the parent agent that a turn finished, once per run. */
  private notifySettle(internal: Internal): void {
    const record = internal.record
    if (internal.interrupting) return
    if (record.status === 'stopped') return
    if (record.notify === 'none') return
    if (internal.notifiedRun === internal.runId) return
    internal.notifiedRun = internal.runId
    this.options.onSettle?.(record)
  }

  private resetIdle(internal: Internal): void {
    if (internal.idleTimer) clearTimeout(internal.idleTimer)
    if (internal.record.restored) return
    if (internal.record.status !== 'idle') return
    internal.idleTimer = setTimeout(() => {
      void this.stop(internal.record.id, true, '空闲超时，已自动回收')
    }, IDLE_TIMEOUT_MS)
  }

  private releaseWaiters(internal: Internal): void {
    if (internal.record.status === 'streaming' || internal.record.status === 'starting') return
    for (const waiter of internal.waiters.splice(0)) waiter(internal.record)
  }

  private finish(internal: Internal): void {
    if (internal.settled) return
    internal.settled = true
    if (internal.totalTimer) clearTimeout(internal.totalTimer)
    if (internal.idleTimer) clearTimeout(internal.idleTimer)
    this.clearProgress(internal)
    internal.record.draft = undefined
    internal.record.activeCalls = []
    this.emit(internal.record)
    if (internal.record.status === 'error') this.notifySettle(internal)
    this.releaseWaiters(internal)
  }

  /** Resolve when the subagent is no longer running, or after `timeoutMs`. */
  waitFor(internal: Internal, timeoutMs: number): Promise<boolean> {
    if (internal.record.status === 'stopped' || internal.record.status === 'error' ||
      (internal.record.status === 'idle' && internal.record.settledAt !== undefined)) return Promise.resolve(false)
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve(false)
      }
      const timer = setTimeout(() => {
        internal.waiters = internal.waiters.filter((waiter) => waiter !== done)
        resolve(true)
      }, timeoutMs)
      internal.waiters.push(done)
    })
  }

  async wait(id: string, timeoutMs: number): Promise<{ record: SubagentRecord; timedOut: boolean }> {
    const internal = this.items.get(id)
    if (!internal) throw Object.assign(new Error(`未知子代理：${id}`), { code: 'UNKNOWN_SUBAGENT' })
    if (!internal.rpc && !internal.own) return { record: internal.record, timedOut: false }
    if (internal.record.status === 'idle' || internal.record.status === 'stopped' || internal.record.status === 'error') {
      return { record: internal.record, timedOut: false }
    }
    const timedOut = await this.waitFor(internal, Math.min(Math.max(timeoutMs, 1000), 300_000))
    return { record: internal.record, timedOut }
  }

  async prompt(id: string, text: string, mode: 'interrupt' | 'steer' | 'follow-up'): Promise<SubagentRecord> {
    const internal = this.items.get(id)
    if (!internal) throw Object.assign(new Error(`未知子代理：${id}`), { code: 'UNKNOWN_SUBAGENT' })
    if (!internal.rpc && !internal.own) {
      throw Object.assign(
        new Error(`子代理 ${id} 是历史记录（应用已重启），进程已结束，无法再发送消息。需要继续就在同一目录用 start_subagent 重新起一个。`),
        { code: 'SUBAGENT_GONE' }
      )
    }
    if (internal.record.status === 'stopped' || internal.record.status === 'error') {
      throw Object.assign(new Error(`子代理已结束（${internal.record.status}）`), { code: 'SUBAGENT_NOT_RUNNING' })
    }
    if (internal.own) {
      if (internal.own.busy()) {
        if (mode !== 'interrupt') throw new Error('Prophey 子代理运行中不支持 steer/follow-up；请等待完成或使用 interrupt')
        internal.interrupting = true
        try {
          await internal.own.abort()
          while (internal.collecting) await new Promise((resolve) => setTimeout(resolve, 10))
        } finally { internal.interrupting = false }
      }
      internal.settled = false
      internal.record.error = undefined
      this.runOwn(internal, text)
      return internal.record
    }
    if (mode === 'interrupt' && internal.record.status === 'streaming') {
      await internal.rpc!.request('abort', {}, 10_000).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const behavior = mode === 'steer' ? 'steer' : mode === 'follow-up' ? 'followUp' : undefined
    await internal.rpc!.request(
      'prompt',
      behavior ? { message: text, streamingBehavior: behavior } : { message: text },
      30_000
    )
    if (internal.record.status !== 'streaming') internal.record.status = 'streaming'
    internal.record.draft = undefined
    internal.record.activeCalls = []
    this.clearProgress(internal)
    this.emit(internal.record)
    return internal.record
  }

  async stop(id: string, keepMessages = true, reason?: string): Promise<SubagentRecord> {
    const internal = this.items.get(id)
    if (!internal) throw Object.assign(new Error(`未知子代理：${id}`), { code: 'UNKNOWN_SUBAGENT' })
    if (internal.record.status === 'stopped') return internal.record
    const timedOutWhileRunning = !!reason && ['starting', 'streaming'].includes(internal.record.status)
    if (internal.own) {
      internal.record.status = 'stopped'
      await internal.own.abort()
      internal.own.dispose()
    }
    const rpc = internal.rpc
    if (rpc) {
      try {
        await rpc.request('abort', {}, 5000)
      } catch {
        // already idle
      }
      rpc.stop()
    }
    internal.record.status = 'stopped'
    internal.record.runtimeMs = internal.record.startedAt ? Date.now() - internal.record.startedAt : undefined
    internal.record.draft = undefined
    internal.record.activeCalls = []
    if (reason) {
      internal.record.error = reason
      if (timedOutWhileRunning) internal.record.status = 'error'
    }
    if (!keepMessages) {
      internal.record.messages = []
      internal.record.calls = []
      internal.record.finalText = undefined
    }
    this.finish(internal)
    return internal.record
  }

  stopAll(sync = false): void {
    for (const internal of this.items.values()) {
      if (internal.record.status === 'stopped') continue
      if (internal.rpc) {
        if (sync) internal.rpc.killNow()
        else internal.rpc.stop()
      }
      internal.own?.dispose()
      internal.record.status = 'stopped'
      internal.record.draft = undefined
      internal.record.activeCalls = []
      this.finish(internal)
    }
  }

  /** Keep the newest records, dropping the oldest finished ones. */
  private prune(): void {
    if (this.items.size <= MAX_KEPT) return
    const finished = [...this.items.values()]
      .filter((item) => item.record.status === 'stopped' || item.record.status === 'error')
      .sort((a, b) => a.record.createdAt - b.record.createdAt)
    for (const item of finished) {
      if (this.items.size <= MAX_KEPT) break
      this.items.delete(item.record.id)
    }
  }
}
function extractText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const value = block as Record<string, unknown>
      return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractToolCalls(message: Record<string, unknown>): string[] {
  const content = message.content
  if (!Array.isArray(content)) return []
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const value = block as Record<string, unknown>
      return value.type === 'toolCall' && typeof value.name === 'string' ? value.name : ''
    })
    .filter(Boolean)
}

/** What a call touched, taken from its arguments rather than its output. */
function callTarget(_tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const value = args as Record<string, unknown>
  const path = value.path ?? value.file ?? value.filePath ?? value.target
  if (typeof path === 'string') return path.slice(0, 160)
  const command = value.command ?? value.cmd
  if (typeof command === 'string') return command.slice(0, 160)
  const pattern = value.pattern ?? value.query
  if (typeof pattern === 'string') return pattern.slice(0, 120)
  return undefined
}
