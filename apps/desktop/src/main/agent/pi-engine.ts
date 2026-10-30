import type { EngineStartOptions } from './engine'
import { engineCapabilities, type EngineCommand } from '../../shared/engine'
import { existsSync } from 'node:fs'
import os from 'node:os'
import type { PiModel, PiStatus, PromptImage, PromptResult } from '@shared/types'
import { PiRpcClient } from '../pi-rpc'
import type { AgentEngine, AgentWorkspace, EngineCapabilities } from './engine'

export interface PiEngineOptions {
  ask?: import('./native-engine').NativeOptions['ask']
  /**
   * Launch args and environment for a workspace (MCP servers, extension, profile, speed tier).
   *
   * The engine does not know what a profile or an MCP server is; it asks for them, so a second
   * engine can be given a completely different set.
   */
  prepare(workspace: AgentWorkspace): Promise<{ args: string[]; env: NodeJS.ProcessEnv }>
  /** Extra args that pin the session (session file, provider/model). */
  sessionArgs(): string[]
  /** Session directory args. */
  sessionDirArgs(): string[]
  /** Every state change, so the app can broadcast its decorated snapshot. */
  onStatus(next: PiStatus): void
  /** Every event line from the engine, already folded into the run state. */
  onEvent(record: Record<string, unknown>): void
  /** A run ended and the engine is idle; the app applies whatever it deferred. */
  onSettled(): void
  /** An assistant message ended with `stopReason: error`; the app decides what that means. */
  onAssistantError(message: string): void
  /** The child exited; the app decides whether to restart it. */
  onExit?(): void
}

/**
 * pi as an agent engine.
 *
 * Owns the child process, the run state machine and the settle waiters. The state machine is the
 * part that caused most of this app's bugs (`agent_end` is not idle; a lost `agent_settled` parks
 * the message queue forever), so it lives in one place and the app only consumes it.
 */
export class PiEngine implements AgentEngine {
  readonly id = 'pi'

  private readonly rpc = new PiRpcClient()
  private snapshot: PiStatus = { phase: 'stopped', cwd: process.cwd() }
  /** Primary plus additional roots; the engine never resolves them itself, it only reports them. */
  private roots: AgentWorkspace = { primary: process.cwd(), additional: [] }
  private starting_ = false
  private startPromise: Promise<PiStatus> | undefined
  private settleWaiters = new Set<() => void>()
  /** Busy from `agent_start`/`compaction_start` until `agent_settled`. */
  private isBusy = false
  private isCompacting = false
  private pollTimer?: ReturnType<typeof setInterval>

  constructor(private readonly options: PiEngineOptions) {
    this.attach()
  }

  state(): PiStatus {
    return this.snapshot
  }

  busy(): boolean {
    return this.isBusy
  }

  compacting(): boolean {
    return this.isCompacting
  }

  running(): boolean {
    return this.rpc.running
  }

  stderrTail(): string {
    return this.rpc.stderrTail
  }

  request<T = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 60_000
  ): Promise<T> {
    return this.rpc.request<T>(type, payload, timeoutMs)
  }

  /** Wire the client's streams into the state machine; called once from the app's bootstrap. */
  attach(): void {
    this.rpc.on('event', (record: Record<string, unknown>) => this.handleRecord(record))
    this.rpc.on('exit', ({ code, signal }: { code?: number | null; signal?: string | null }) => {
      this.isBusy = false
      this.isCompacting = false
      this.setStatus({ phase: 'error', error: `pi exited (${code ?? signal})`, isStreaming: false })
      this.resolveSettled()
      this.options.onExit?.()
    })
  }

  /** True while a start is in flight; the app uses it to avoid restarting over a start. */
  starting(): boolean {
    return this.starting_
  }

  setStatus(patch: Partial<PiStatus>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.options.onStatus(this.snapshot)
  }

  capabilities(): EngineCapabilities {
    return engineCapabilities('pi')
  }

  async nativeCommands(): Promise<EngineCommand[]> {
    const response = await this.request<{
      data?: { commands?: Array<{ name: string; description?: string }> }
    }>('get_commands')
    return (response.data?.commands ?? []).map((c) => ({
      name: '/' + c.name,
      args: '[参数]',
      hint: c.description ?? c.name,
      action: 'native',
      source: 'engine'
    }))
  }

  async executeCommand(name: string, args: string): Promise<{ text?: string }> {
    const result = await this.prompt(name + (args ? ' ' + args : ''))
    if (!result.ok) throw new Error(result.error)
    return {}
  }

  workspace(): AgentWorkspace {
    return { primary: this.roots.primary, additional: [...this.roots.additional] }
  }

  async start(
    workspace?: string | AgentWorkspace,
    options: EngineStartOptions = {}
  ): Promise<PiStatus> {
    const extraArgs = [
      ...(options.session ? ['--session', options.session] : []),
      ...(options.model ? ['--provider', options.model.provider, '--model', options.model.id] : [])
    ]
    // A second caller while a start is running used to receive `phase: 'starting'` and wait forever;
    // hand it the same promise instead.
    if (this.startPromise) return this.startPromise
    const run = this.runStart(workspace, extraArgs).finally(() => {
      if (this.startPromise === run) this.startPromise = undefined
    })
    this.startPromise = run
    return run
  }

  private async runStart(
    requested: string | AgentWorkspace | undefined,
    extraArgs: string[]
  ): Promise<PiStatus> {
    this.starting_ = true
    const wanted =
      typeof requested === 'string'
        ? { primary: requested, additional: [] }
        : (requested ?? this.roots)
    let workspace = wanted.primary || this.snapshot.cwd
    if (!existsSync(workspace)) {
      console.warn(`[pi] workspace does not exist, falling back to home: ${workspace}`)
      workspace = os.homedir()
    }
    this.roots = {
      primary: workspace,
      // A root that no longer exists is dropped instead of being handed to the model.
      additional: [...new Set(wanted.additional)].filter((root) => root && existsSync(root))
    }
    this.rpc.stop()
    this.isBusy = false
    this.isCompacting = false
    this.setStatus({ phase: 'starting', cwd: workspace, error: undefined, stderrTail: undefined })
    try {
      const launch = await this.options.prepare(this.roots)
      this.rpc.start(
        workspace,
        [...extraArgs, ...this.options.sessionDirArgs(), ...launch.args],
        launch.env
      )
      const data = await this.waitForReady()
      this.snapshot = { phase: 'ready', cwd: workspace }
      this.applyState(data)
      return this.snapshot
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.snapshot = {
        phase: 'error',
        cwd: workspace,
        error: message,
        stderrTail: this.rpc.stderrTail || undefined
      }
      this.options.onStatus(this.snapshot)
      return this.snapshot
    } finally {
      this.starting_ = false
    }
  }

  stop(): void {
    this.rpc.stop()
  }

  dispose(): void {
    clearInterval(this.pollTimer)
    this.rpc.killNow()
  }

  private async waitForReady(): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 20_000
    let lastError: unknown
    while (Date.now() < deadline) {
      if (!this.rpc.running) throw new Error(this.rpc.stderrTail || 'pi 进程已退出')
      try {
        const response = await this.rpc.request<{ data?: Record<string, unknown> }>(
          'get_state',
          {},
          3000
        )
        return response.data ?? {}
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    throw new Error(
      `pi 未在预期时间内就绪${lastError instanceof Error ? `: ${lastError.message}` : ''}`
    )
  }

  /**
   * Fold a `get_state` answer into the run state.
   *
   * `get_state` is authoritative: it already counts queued work and compaction as streaming, and
   * reports compaction separately.
   */
  private applyState(data: Record<string, unknown> | undefined): void {
    if (!data) return
    this.isBusy = Boolean(data.isStreaming) || Boolean(data.isCompacting)
    this.isCompacting = Boolean(data.isCompacting)
    this.snapshot = {
      ...this.snapshot,
      model: modelFromState(data) ?? this.snapshot.model,
      thinkingLevel:
        typeof data.thinkingLevel === 'string' ? data.thinkingLevel : this.snapshot.thinkingLevel,
      sessionName: typeof data.sessionName === 'string' ? data.sessionName : undefined,
      sessionFile:
        typeof data.sessionFile === 'string' ? data.sessionFile : this.snapshot.sessionFile,
      isStreaming: this.isBusy,
      compacting: this.isCompacting
    }
    this.options.onStatus(this.snapshot)
  }

  async refresh(): Promise<void> {
    if (!this.rpc.running) return
    try {
      const response = await this.rpc.request<{ data?: Record<string, unknown> }>(
        'get_state',
        {},
        5000
      )
      this.applyState(response.data)
    } catch {
      // transient failures are expected around restarts
    }
  }

  /**
   * Poll the run state while busy, because `busy` is the only thing that unblocks the message queue.
   *
   * It is set from events, and events can be lost: a compaction that ends while pi is restarting, a
   * line dropped by a killed child, an `agent_settled` that never arrived. Nothing else would ever
   * clear it, and the window would keep showing a finished run as running with every queued message
   * stranded behind it. `get_state` is cheap, so ask the engine and let the answer win.
   */
  poll(): void {
    clearInterval(this.pollTimer)
    this.pollTimer = setInterval(() => {
      if (!this.isBusy || !this.rpc.running) return
      void this.refresh()
    }, 3000)
  }

  waitForSettle(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (settled: boolean): void => {
        clearTimeout(timer)
        this.settleWaiters.delete(onSettled)
        resolve(settled)
      }
      const onSettled = (): void => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.settleWaiters.add(onSettled)
    })
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.isBusy && Date.now() < deadline) {
      const left = deadline - Date.now()
      const settled = await this.waitForSettle(Math.min(3000, Math.max(250, left)))
      if (settled) return true
      if (!this.rpc.running) return false
      const state = await this.rpc
        .request<{ data?: Record<string, unknown> }>('get_state', {}, 5000)
        .catch(() => undefined)
      if (state?.data && !state.data.isStreaming && !state.data.isCompacting) {
        this.isBusy = false
        this.isCompacting = false
        return true
      }
    }
    return !this.isBusy
  }

  /**
   * Send one prompt and survive the moments where the window and pi disagree about "busy".
   *
   * pi is busy until `agent_settled`: retries, overflow recovery, compaction and queued turns keep
   * it alive after `agent_end`, and `prompt` rejects anything that arrives in between. Rather than
   * bouncing the text back into the composer, the message is queued exactly like
   * `streamingBehavior` would queue it, and a running compaction is waited out.
   */
  async prompt(
    message: string,
    options: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] } = {}
  ): Promise<PromptResult> {
    if (!this.rpc.running) return { ok: false, error: 'pi 未运行' }
    const { behavior, images } = options
    const payload = {
      message,
      ...(behavior ? { streamingBehavior: behavior } : {}),
      ...(images && images.length > 0 ? { images } : {})
    }
    const send = async (
      extra: Record<string, unknown> = {}
    ): Promise<PromptResult['disposition']> => {
      const response = await this.rpc.request<{ data?: { disposition?: string } }>('prompt', {
        ...payload,
        ...extra
      })
      return (response.data?.disposition as PromptResult['disposition']) ?? 'started'
    }
    const fail = (error: unknown): PromptResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
    try {
      return { ok: true, disposition: await send() }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (/compaction is in progress/i.test(text)) {
        if (!(await this.waitForIdle(180_000))) {
          return { ok: false, error: '上下文压缩还没结束，稍后再发' }
        }
        try {
          return { ok: true, disposition: await send() }
        } catch (retryError) {
          return fail(retryError)
        }
      }
      if (/already processing/i.test(text) && !behavior) {
        try {
          return {
            ok: true,
            disposition: await send({ streamingBehavior: 'followUp' }),
            queued: true
          }
        } catch (retryError) {
          return fail(retryError)
        }
      }
      return fail(error)
    }
  }

  private resolveSettled(): void {
    for (const waiter of this.settleWaiters) waiter()
  }

  // --- session and model operations -------------------------------------------------------------
  // Each one is a thin, semantic wrapper over the command channel, so the window never spells an
  // engine command name and a second engine can implement the same operations differently.

  async models(): Promise<Record<string, unknown>[]> {
    const response = await this.request<{ data?: { models?: Record<string, unknown>[] } }>(
      'get_available_models'
    )
    return response.data?.models ?? []
  }

  async setModel(provider: string, modelId: string): Promise<PiModel | undefined> {
    const response = await this.request<{ data?: Record<string, unknown> }>('set_model', {
      provider,
      modelId
    })
    const model = modelFromState({ model: response.data })
    if (model) this.setStatus({ model })
    await this.refresh()
    return model
  }

  async thinkingLevels(): Promise<string[]> {
    const response = await this.request<{ data?: { levels?: string[] } }>(
      'get_available_thinking_levels'
    )
    return response.data?.levels ?? []
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request('set_thinking_level', { level })
    this.setStatus({ thinkingLevel: level })
  }

  async stats(): Promise<{
    tokens?: { input?: number; output?: number; total?: number }
    cost?: number
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }
  }> {
    const response = await this.request<{ data?: Record<string, unknown> }>('get_session_stats')
    const data = response.data ?? {}
    return {
      tokens: data.tokens as { input?: number; output?: number; total?: number } | undefined,
      cost: typeof data.cost === 'number' ? data.cost : undefined,
      contextUsage: data.contextUsage as
        | { tokens?: number | null; contextWindow?: number; percent?: number | null }
        | undefined
    }
  }


  async messages(): Promise<unknown[]> {
    const response = await this.request<{ data?: { messages?: unknown[] } }>('get_messages')
    return response.data?.messages ?? []
  }

  async lastAssistantText(): Promise<string | null> {
    const response = await this.request<{ data?: { text?: string | null } }>(
      'get_last_assistant_text',
      {},
      10_000
    )
    return response.data?.text ?? null
  }

  async compact(instructions?: string): Promise<{ summary?: string }> {
    const response = await this.request<{ data?: { summary?: string } }>(
      'compact',
      { ...(instructions?.trim() ? { customInstructions: instructions.trim() } : {}) },
      600_000
    )
    await this.refresh()
    return { summary: response.data?.summary }
  }

  async setAutoCompaction(options: { enabled: boolean; reserveTokens?: number }): Promise<void> {
    await this.request('set_auto_compaction', options)
  }

  async newSession(): Promise<{ cancelled?: boolean }> {
    const response = await this.request<{ data?: { cancelled?: boolean } }>('new_session')
    await this.refresh()
    return { cancelled: response.data?.cancelled }
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.request('switch_session', { sessionPath }, 20_000)
    await this.refresh()
  }

  async clone(): Promise<string | undefined> {
    // `fork` requires a specific entry id and rejects the leaf; `clone` is the snapshot we want.
    const cloned = await this.request<{ data?: { cancelled?: boolean } }>('clone', {}, 20_000)
    if (cloned.data?.cancelled) throw new Error('克隆会话被取消')
    const state = await this.request<{ data?: Record<string, unknown> }>('get_state', {}, 5000)
    return typeof state.data?.sessionFile === 'string' ? state.data.sessionFile : undefined
  }

  async abort(): Promise<void> {
    await this.request('abort', {}, 15_000)
  }

  async send(message: string): Promise<void> {
    await this.request('prompt', { message }, 30_000)
  }

  /**
   * pi's own rewind is `fork`: the session is an append-only tree, so the branch after the edited
   * message stays on disk while the window continues from the forked one.
   */
  async rewind(index: number): Promise<{ ok: boolean; removed?: number; error?: string }> {
    const listed = await this.request<{ data?: { messages?: Array<{ entryId?: string }> } }>(
      'get_fork_messages',
      {},
      10_000
    )
    const messages = listed.data?.messages ?? []
    const target = messages[index]
    if (!target?.entryId) return { ok: false, error: '找不到这条消息' }
    const forked = await this.request<{ data?: { cancelled?: boolean } }>(
      'fork',
      { entryId: target.entryId },
      20_000
    )
    if (forked.data?.cancelled) return { ok: false, error: '改写被扩展取消了' }
    // A fork is a new session file; the window has to follow it or it would keep showing the old one.
    const state = await this.request<{ data?: Record<string, unknown> }>('get_state', {}, 5000)
    if (typeof state.data?.sessionFile === 'string') this.setStatus({ sessionFile: state.data.sessionFile })
    return { ok: true, removed: messages.length - index }
  }

  private handleRecord(record: Record<string, unknown>): void {
    if (
      record.type === 'extension_ui_request' &&
      ['select', 'confirm', 'input', 'editor'].includes(String(record.method))
    ) {
      const method = String(record.method)
      const options =
        method === 'confirm'
          ? [{ label: '取消' }, { label: '确认' }]
          : Array.isArray(record.options)
            ? record.options.map((label) => ({ label: String(label) }))
            : undefined
      const response = this.options.ask?.(
        [
          {
            question: [record.title, record.message, record.prefill].filter(Boolean).join('\n'),
            options
          }
        ],
        'pi 扩展命令'
      )
      void Promise.resolve(response)
        .then((answer) => {
          const value = answer && !answer.cancelled ? answer.answers[0] : undefined
          this.rpc.notify({
            type: 'extension_ui_response',
            id: record.id,
            ...(value && !value.skipped
              ? method === 'confirm'
                ? { confirmed: value.selected.includes('确认') }
                : { value: value.other ?? value.selected[0] ?? '' }
              : { cancelled: true })
          })
        })
        .catch(() =>
          this.rpc.notify({ type: 'extension_ui_response', id: record.id, cancelled: true })
        )
      return
    }
    if (record.type === 'agent_start') {
      this.isBusy = true
      this.setStatus({ isStreaming: true })
    }
    if (record.type === 'message_end') {
      const message = record.message as
        | { role?: string; stopReason?: string; errorMessage?: string }
        | undefined
      if (message?.role === 'assistant' && message.stopReason === 'error' && message.errorMessage) {
        this.options.onAssistantError(message.errorMessage)
      }
    }
    if (record.type === 'agent_end') {
      // One low-level run ended, but retries, compaction recovery and queued messages may continue:
      // the session only becomes idle at `agent_settled`.
      void this.refresh()
    }
    if (record.type === 'agent_settled') {
      this.isBusy = false
      this.isCompacting = false
      this.setStatus({ isStreaming: false, compacting: false })
      this.resolveSettled()
      void this.refresh()
      this.options.onSettled()
    }
    if (record.type === 'compaction_start') {
      this.isCompacting = true
      this.setStatus({ isStreaming: true, compacting: true })
    }
    if (record.type === 'compaction_end') {
      this.isCompacting = false
      this.setStatus({ compacting: false })
      // A manual `/compact` never starts a run, and `willRetry` may or may not continue one:
      // `get_state` is the only reliable answer for "busy".
      void this.refresh()
    }
    if (record.type === 'thinking_level_changed' && typeof record.level === 'string') {
      this.setStatus({ thinkingLevel: record.level })
    }
    if (record.type === 'session_info_changed') {
      this.setStatus({ sessionName: typeof record.name === 'string' ? record.name : undefined })
    }
    this.options.onEvent(record)
  }
}

export function modelFromState(data: Record<string, unknown> | undefined): PiModel | undefined {
  const raw = data?.model as Record<string, unknown> | undefined
  if (!raw) return undefined
  const provider = String(raw.provider ?? '')
  const id = String(raw.id ?? raw.modelId ?? '')
  if (!provider && !id) return undefined
  if (id === 'unknown' || provider === 'unknown') return undefined
  return {
    provider,
    id,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : undefined,
    api: typeof raw.api === 'string' ? raw.api : undefined
  }
}
