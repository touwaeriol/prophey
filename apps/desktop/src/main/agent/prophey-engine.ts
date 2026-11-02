import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { BashTasks } from './bash-tasks'
import { guardedStream } from './stream-guard'
import type { EngineStartOptions } from './engine'
import { engineCapabilities } from '../../shared/engine'
import type { Model, ThinkingLevel } from '@earendil-works/pi-ai'
import type { ContextBreakdown, PiModel, PiStatus, PromptImage, PromptResult, SessionStats } from '@shared/types'
import * as providers from '../providers'
import * as speed from '../speed'
import type { TranscriptStore, StoredTranscript } from '../transcript-store'
import { loadMcpTools } from './mcp-client'
import { readProjectConventions } from './project-conventions'
import { orderToolResults } from './transcript-order'
import { hasToolCallMarkup, repairToolCallText } from '../../shared/dsml-repair'
import { toolGuidance } from './tool-guidance'
import {
  bridgeContext,
  loadAskTool,
  loadSubagentTools,
  loadWorkspaceTools,
  toolDeclarations,
  type CoreTool,
  type DeferredResult
} from './core-tools'
import type { AgentEngine, AgentWorkspace, EngineCapabilities } from './engine'

/** Provider-backed engine with owned tool execution, transcripts and compaction. */
export class PropheyEngine implements AgentEngine {
  readonly id = 'prophey'

  private snapshot: PiStatus = { phase: 'stopped', cwd: process.cwd() }
  private roots: AgentWorkspace = { primary: process.cwd(), additional: [] }
  /**
   * Repository rules written for other agents (GEMINI.md, .cursorrules, copilot-instructions…).
   * Read once per start, the way pi reads AGENTS.md when it launches.
   */
  private conventions = ''
  private isBusy = false
  /** Set by `steer()`: the running loop must answer one more round before it settles. */
  private steerPending = false
  private model: Model<string> | undefined
  private transcript: Array<Record<string, unknown>> = []
  private tools: CoreTool[] | undefined
  private sessionId: string | undefined
  /** Auto-compaction: enabled plus the percentage of the window that triggers it. */
  private autoCompact: { enabled: boolean; percent: number } = { enabled: false, percent: 50 }
  private loaded = false
  private controller?: AbortController
  private notices: Array<{ text: string; wake: boolean; session?: string }> = []
  private noticeTimer?: ReturnType<typeof setTimeout>
  /**
   * Set while parked on background work: the round is over, but the work is not.
   *
   * A wait that blocks inside the tool call keeps the round alive and costs a model round trip on
   * top; parking ends the round and lets whoever finishes wake it again.
   */
  private parked?: { kind: DeferredResult['kind']; keys: string[]; label?: string; since: number; timer?: ReturnType<typeof setTimeout> }
  private bashTasks = new Map<string | undefined, BashTasks>()
  private lastAbortAt = 0
  private levels: string[] = []
  private restoring = false
  /**
   * True while tool results are still owed. Nothing may be appended to the transcript meanwhile:
   * a user turn between the model's tool calls and their results makes the next request invalid on
   * every OpenAI-compatible provider. See `steer` and `transcript-order.ts`.
   */
  private toolBatchOpen = false
  /** Turns the user steered while a batch was open; appended once its results are in. */
  private queuedSteers: Array<{ id: string; message: Record<string, unknown> }> = []
  /** Ticket counter for `cancelSteer`; ids never repeat, even across sessions. */
  private steerSeq = 0
  /**
   * Prompt size the provider reported for the newest request, plus how much transcript it covered.
   *
   * This is the only honest number for the meter: it already includes the system prompt, the tool
   * declarations and every message, which an estimate over the transcript alone cannot know.
   */
  private usage?: { tokens: number; index: number }
  /** Usage of the round in flight, read from each stream event's partial message. */
  private live?: { prompt: number; output: number; message?: Record<string, unknown> }
  /** System prompt + tool declarations: sent with every request, invisible in the transcript. */
  private promptTokens = 0
  /** The same split by origin (app tools vs each MCP server), for the panel's context card. */
  private promptParts?: Omit<ContextBreakdown, 'messages'>
  /** Last push of the meter to the window; streaming would otherwise broadcast per token. */
  private publishedAt = 0

  constructor(
    private readonly options: {
      onStatus(next: PiStatus): void
      onEvent(record: Record<string, unknown>): void
      onSettled(): void
      /** Absolute path of `tools/workspace.mjs`; the tools are shared with pi's MCP server. */
      toolModulePath?: string
      shellPath?: string
      bashLogDirectory?: string
      allowedTools?: string[]
      appendSystemPrompt?: string
      /**
       * The app's subagent section (`agents.renderAgentsSection`), the same text pi receives through
       * `AGENT_DESKTOP_AGENTS_SECTION`. Only used when the subagent tools are actually declared.
       */
      agentsSection?: () => string | undefined
      /** Where our own transcripts live; without it the conversation stays in memory. */
      transcripts?: TranscriptStore
      /** Current session id; the app allocates it. */
      sessionId?: () => string | undefined
      /** Ask the app for a fresh session id (it also persists it). */
      newSessionId?: () => Promise<string | undefined>
      /** The app's auto-compaction setting (same value the threshold dropdown writes). */
      autoCompact?: () => { enabled: boolean; percent: number }
      /** Bridge URL/token: how the subagent tools reach the app's manager. */
      bridge?: () => { url: string; token: string } | undefined
      /** Directory holding `subagent.mjs`; absent when subagents are off. */
      subagentModulePath?: string
      /** Path of `ask-user.mjs`; the desktop question dialog. */
      askModulePath?: string
      /** The processing tier the window selected; resolved per model. */
      speedMode?: () => 'standard' | 'fast' | 'ultrafast'
      /** Max time without a model stream event, not a limit on a whole task. */
      streamIdleTimeoutMs?: number
      /** The app's MCP endpoints (`/mcp/<key>` on the bridge), configured for this workspace. */
      mcpEndpoints?: (
        workspace: AgentWorkspace
      ) => Promise<Array<{ name: string; url: string; token: string; description?: string }>>
      /**
       * Tools each server actually offered, in the shape pi's extension posts to `/tools`.
       *
       * pi learns this from its own MCP clients; this engine owns the loop, so it has to say it. The
       * window's MCP page and the connectors card read that cache — without this they showed
       * 「0 个工具」 for every built-in server under this engine.
       */
      onTools?: (servers: Record<string, Array<{ name: string }>>) => void
    }
  ) {}

  state(): PiStatus {
    return this.snapshot
  }

  busy(): boolean {
    return this.isBusy || this.compacting()
  }

  compacting(): boolean {
    return !!this.snapshot.compacting
  }

  running(): boolean {
    return this.snapshot.phase === 'ready'
  }

  stderrTail(): string {
    return ''
  }

  capabilities(): EngineCapabilities {
    return engineCapabilities('prophey')
  }

  workspace(): AgentWorkspace {
    return { primary: this.roots.primary, additional: [...this.roots.additional] }
  }

  starting(): boolean {
    return false
  }

  async start(
    workspace?: string | AgentWorkspace,
    options: EngineStartOptions = {}
  ): Promise<PiStatus> {
    const wanted =
      typeof workspace === 'string'
        ? { primary: workspace, additional: [] }
        : (workspace ?? this.roots)
    this.roots = { primary: wanted.primary, additional: [...wanted.additional] }
    this.conventions = readProjectConventions(wanted.primary).text
    this.tools = undefined
    // `starting`, not `ready`: the transcript is restored further down, and a session that reports
    // ready while it still holds nothing answers get_messages with an empty list — which the window
    // painted as 「开始一段对话」 over a conversation with hundreds of turns in it.
    this.snapshot = { phase: 'starting', cwd: wanted.primary, isStreaming: false, compacting: false,
      thinkingLevel: this.snapshot.thinkingLevel }
    this.options.onStatus(this.snapshot)
    // Pick a model up front: the window reads it from the status, and an unset model shows as
    // "未登录 / 无可用模型" even though the engine is perfectly able to run.
    const selected = options.model ?? this.model
    // A settings reload replaces the runtime; refresh the model's endpoint and metadata too.
    this.model = undefined
    if (selected) await this.setModel(selected.provider, selected.id).catch(() => undefined)
    if (!this.model) await this.pickModel().catch(() => undefined)
    const compaction = this.options.autoCompact?.()
    if (compaction) this.autoCompact = compaction
    // A fresh, empty conversation has an identity before its first transcript is saved.
    const currentEmptySession = this.loaded && this.transcript.length === 0 &&
      options.session === this.transcriptPath()
    if (options.session && !currentEmptySession) await this.switchSession(options.session)
    else await this.resume()
    if (options.model) await this.setModel(options.model.provider, options.model.id).catch(() => undefined)
    this.setStatus({ phase: 'ready', sessionFile: this.transcriptPath() })
    this.publishUsage(true)
    return this.snapshot
  }

  stop(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = undefined
    this.controller?.abort()
    // Without this an engine kept alive by a park would fire its failsafe wake after being stopped.
    if (this.parked?.timer) clearTimeout(this.parked.timer)
    this.parked = undefined
    for (const tasks of this.bashTasks.values()) tasks.dispose()
    this.bashTasks.clear()
    this.tools = undefined
    this.snapshot = { ...this.snapshot, phase: 'stopped' }
    this.options.onStatus(this.snapshot)
  }

  dispose(): void {
    this.stop()
  }

  setStatus(patch: Partial<PiStatus>): void {
    if ('sessionFile' in patch) {
      const commands = this.bashTasks.get(this.sessionId)
      patch = {
        ...patch,
        backgroundTasks: commands?.active() ?? [],
        backgroundFinished: commands?.finishedCount() ?? 0,
        backgroundHistory: commands?.history() ?? []
      }
    }
    this.snapshot = { ...this.snapshot, ...patch }
    this.options.onStatus(this.snapshot)
  }

  /**
   * Stop one background command from the session panel.
   *
   * Only this engine owns a task list; pi/Claude/Codex report "unsupported" so the panel can say so
   * instead of showing a button that does nothing.
   */
  async stopBackgroundTask(id: string): Promise<{ ok: boolean; error?: string }> {
    const commands = this.bashTasks.get(this.sessionId)
    if (!commands) return { ok: false, error: '当前会话没有后台命令' }
    try {
      await commands.stop(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async readBackgroundTask(id: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    try {
      const commands = this.bashTasks.get(this.sessionId)
      if (!commands) return { ok: false, error: '当前会话没有后台命令' }
      const result = await commands.read({ task_id: id, tail: true, max_bytes: 12000 })
      return { ok: true, text: result.content.map(block => block.text ?? '').join('\n') }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  poll(): void {
    // Nothing to poll: this engine owns the state it reports.
  }

  async refresh(): Promise<void> {
    // Nothing external to ask: the state lives here.
  }

  async waitForSettle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.busy() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return !this.busy()
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    return this.waitForSettle(timeoutMs)
  }

  private unimplemented(what: string): never {
    throw new Error(`Prophey 引擎 v1 还不支持${what}（请切回 pi 引擎）`)
  }

  /** The provider catalogue, in the shape the window's picker expects. */
  async models(): Promise<Record<string, unknown>[]> {
    const choices = await providers.listModelChoices()
    return choices.map((choice) => ({
      provider: choice.provider,
      id: choice.id,
      name: choice.name,
      contextWindow: choice.contextWindow
    }))
  }

  async setModel(provider: string, modelId: string): Promise<PiModel | undefined> {
    return this.selectModel(provider, modelId)
  }

  private async selectModel(provider: string, modelId: string, initializing = false): Promise<PiModel | undefined> {
    if (!initializing && this.busy()) throw new Error('请等当前回合结束后切换模型')
    const choices = await providers.listModelChoices()
    if (!choices.some(choice => choice.provider === provider && choice.id === modelId)) {
      throw new Error(`模型 ${provider}/${modelId} 未在服务商中启用或尚未配置凭据`)
    }
    const runtime = await providers.getRuntime()
    const model = runtime.getModel(provider, modelId) as Model<string> | undefined
    if (!model) throw new Error(`找不到模型 ${provider}/${modelId}`)
    const levels = await providers.thinkingLevelsFor(model)
    if (!initializing && this.busy()) throw new Error('请等当前回合结束后切换模型')
    const sameModel = this.model?.provider === model.provider && this.model?.id === model.id
    let officialDeepSeek = false
    try { officialDeepSeek = new URL(model.baseUrl).hostname === 'api.deepseek.com' } catch { /* No official endpoint. */ }
    const current = this.snapshot.thinkingLevel
    const thinkingLevel = officialDeepSeek && levels.includes('high') && !sameModel
      ? 'high'
      : levels.includes(current ?? '') ? current : officialDeepSeek && levels.includes('high')
        ? 'high' : levels.includes('medium') ? 'medium' : levels[0]
    this.model = model
    this.levels = levels
    const info = modelInfo(model)
    this.setStatus({ model: info, thinkingLevel })
    this.persist()
    return info
  }

  thinkingLevels(): Promise<string[]> {
    return Promise.resolve([...this.levels])
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (!this.levels.includes(level)) throw new Error('当前模型不支持思考等级 ' + level)
    this.setStatus({ thinkingLevel: level })
    this.persist()
  }

  /**
   * What the conversation occupies right now.
   *
   * Measured first: the newest response's own prompt+output count covers everything that was sent
   * (system prompt, tool declarations, transcript), so the meter starts there and adds whatever was
   * appended since — including the reply being streamed, which is why the ring moves mid-round.
   * Only a session that has never had a response has to be estimated.
   */
  private contextTokens(): number {
    const live = this.live
    const streaming = live ? Math.max(live.output, live.message ? estimateTokens([live.message]) : 0) : 0
    if (live && live.prompt > 0) return live.prompt + streaming
    const measured = this.usage
    const appended = measured
      ? estimateTokens(this.transcript.slice(measured.index))
      : estimateTokens(this.contextMessages()) + this.promptTokens
    return (measured?.tokens ?? 0) + appended + streaming
  }

  private usageSnapshot(): NonNullable<SessionStats['contextUsage']> {
    const tokens = Math.max(0, Math.round(this.contextTokens()))
    const contextWindow = this.model?.contextWindow
    const breakdown = this.contextBreakdown()
    return {
      tokens,
      contextWindow,
      percent: contextWindow ? Math.min(100, (tokens / contextWindow) * 100) : null,
      ...(breakdown ? { breakdown } : {})
    }
  }

  /**
   * The request's tokens by origin.
   *
   * The fixed parts are character estimates, so they are scaled down when the provider measured
   * less than they claim — then the transcript takes the remainder. That way the sections always
   * add up to the number the meter shows instead of silently exceeding it.
   */
  private contextBreakdown(): ContextBreakdown | undefined {
    const parts = this.promptParts
    if (!parts) return undefined
    const total = Math.max(0, Math.round(this.contextTokens()))
    const estimated = parts.systemPrompt + parts.systemTools.tokens + parts.mcpTools.tokens
    const ratio = estimated > total && estimated > 0 ? total / estimated : 1
    const scale = (value: number): number => Math.floor(value * ratio)
    const systemPrompt = scale(parts.systemPrompt)
    const systemTools = { tokens: scale(parts.systemTools.tokens), count: parts.systemTools.count }
    const servers = parts.mcpTools.servers.map((server) => ({ ...server, tokens: scale(server.tokens) }))
    const mcpTools = {
      tokens: servers.reduce((sum, server) => sum + server.tokens, 0),
      count: parts.mcpTools.count,
      servers
    }
    const messages = Math.max(0, total - systemPrompt - systemTools.tokens - mcpTools.tokens)
    return { messages, systemPrompt, systemTools, mcpTools }
  }

  /**
   * Count what the request carries besides the transcript.
   *
   * Tools are charged the declaration the model actually receives; MCP servers are grouped by the
   * name they are announced under, so the panel can say `codegraph 12.4K` instead of `MCP tools`.
   */
  private measurePrompt(systemPrompt: string, tools: CoreTool[]): void {
    const count = (value: unknown): number => Math.ceil(JSON.stringify(value).length / 4)
    const servers = new Map<string, { tokens: number; count: number }>()
    let declared = { tokens: 0, count: 0 }
    for (const tool of tools) {
      const tokens = count({ name: tool.name, description: tool.description, parameters: tool.parameters })
      if (tool.source) {
        const server = servers.get(tool.source) ?? { tokens: 0, count: 0 }
        servers.set(tool.source, { tokens: server.tokens + tokens, count: server.count + 1 })
      } else {
        declared = { tokens: declared.tokens + tokens, count: declared.count + 1 }
      }
    }
    const grouped = [...servers.entries()]
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => b.tokens - a.tokens)
    const mcpTools = {
      tokens: grouped.reduce((total, server) => total + server.tokens, 0),
      count: grouped.reduce((total, server) => total + server.count, 0),
      servers: grouped
    }
    this.promptParts = {
      systemPrompt: Math.ceil(systemPrompt.length / 4),
      systemTools: declared,
      mcpTools
    }
    this.promptTokens = this.promptParts.systemPrompt + declared.tokens + mcpTools.tokens
  }

  /**
   * Push the meter while a round is still streaming.
   *
   * Throttled to a change worth a repaint (1% of the window, or a second of silence), because the
   * window would otherwise re-render for every token.
   */
  private publishUsage(force = false): void {
    const usage = this.usageSnapshot()
    const last = this.snapshot.contextUsage?.tokens ?? 0
    const window = this.model?.contextWindow ?? 0
    const now = Date.now()
    if (!force && now - this.publishedAt < 400 && Math.abs((usage.tokens ?? 0) - last) < Math.max(1000, window / 100)) {
      return
    }
    this.publishedAt = now
    this.setStatus({ contextUsage: usage })
  }

  /**
   * The context was rewritten, so the measured prompt no longer describes it.
   */
  private resetUsage(): void {
    this.usage = undefined
    this.live = undefined
    this.promptTokens = 0
    this.promptParts = undefined
    if (this.snapshot.contextUsage) this.setStatus({ contextUsage: undefined })
  }

  async stats(): Promise<SessionStats> {
    const usage = this.usageSnapshot()
    return {
      tokens: { input: usage.tokens ?? 0, output: this.live?.output ?? 0, total: usage.tokens ?? 0 },
      contextUsage: usage
    }
  }


  async messages(): Promise<unknown[]> {
    return [...this.transcript]
  }

  lastAssistantText(): Promise<string | null> {
    const last = [...this.transcript].reverse().find((entry) => entry.role === 'assistant')
    const content = Array.isArray(last?.content) ? (last?.content as unknown[]) : []
    const text = content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block ? String(block.text) : ''
      )
      .join('')
    return Promise.resolve(text || null)
  }

  async setAutoCompaction(options: { enabled: boolean; reserveTokens?: number }): Promise<void> {
    // Nothing to configure in the engine: the limit comes from the model window and the app's ratio.
    this.autoCompact = {
      ...(this.options.autoCompact?.() ?? this.autoCompact),
      enabled: options.enabled
    }
    this.setStatus({ autoCompactPercent: options.enabled ? this.autoCompact.percent : undefined })
  }

  /** Where the compacted conversation starts: the newest summary, or the top of the transcript. */
  private contextMessages(): Array<Record<string, unknown>> {
    for (let at = this.transcript.length - 1; at >= 0; at -= 1) {
      if (this.transcript[at].compaction === true) return this.transcript.slice(at)
    }
    return this.transcript
  }

  /**
   * Rewrite the context: the model summarizes the conversation, and the summary takes its place.
   *
   * Same idea as pi's compaction — the request becomes "here is what happened" plus whatever came
   * after, so the next turn starts with room to work instead of replaying everything. The transcript
   * itself keeps every turn: the window still shows the conversation the user had (they asked for
   * that), and only what the model receives is narrowed to the summary. A failed summary therefore
   * costs nothing — the conversation is untouched until there is a summary worth storing.
   */
  async compact(instructions?: string): Promise<{ summary?: string }> {
    this.controller ??= new AbortController()
    const signal = this.controller.signal
    const model = this.model ?? (await this.pickModel())
    if (!model) throw new Error('没有可用的模型，无法压缩')
    const context = this.contextMessages()
    if (context.length === 0) return {}
    const runtime = await providers.getRuntime()
    this.setStatus({ compacting: true, activity: { label: '正在压缩上下文', since: Date.now() } })
    this.options.onEvent({ type: 'compaction_start', reason: 'manual' })
    try {
      const answer = (await runtime.completeSimple(
        model,
        {
          systemPrompt:
            '你在压缩一段编码会话的上下文。输出一段中文摘要，保留：用户的目标、已做出的决定、' +
            '改过/读过的文件与其作用、未完成的工作、以及继续工作需要的具体事实（路径、命令、' +
            '错误信息）。不要寒暄，不要复述工具输出全文。' +
            (instructions?.trim()
              ? `

用户额外要求：${instructions.trim()}`
              : ''),
          messages: orderToolResults(structuredClone(context)) as never
        },
        { signal }
      )) as unknown as Record<string, unknown>
      const summary = summaryOf(answer, signal)
      // The summary is an ordinary user message: the window paints it as one (and can edit it). It is
      // appended where the compaction happened, so everything before stays readable and everything
      // after keeps working — the request starts at the newest `compaction` marker, not at the top.
      const summaryMessage = {
        role: 'user',
        content: `【此前对话摘要】\n${summary}`,
        timestamp: Date.now(),
        compaction: true
      }
      this.transcript.push(summaryMessage)
      this.resetUsage()
      this.persist()
      this.options.onEvent({ type: 'compaction_end', summary, message: summaryMessage })
      return { summary }
    } finally {
      this.setStatus({ compacting: false, activity: undefined })
      if (!this.isBusy) {
        this.controller = undefined
        this.options.onEvent({ type: 'agent_settled' })
        this.options.onSettled()
      }
    }
  }

  async newSession(): Promise<{ cancelled?: boolean }> {
    this.tools = undefined
    this.transcript = []
    this.resetUsage()
    // A new session means a new transcript file; the app owns the id so it can persist it.
    this.sessionId =
      (await this.options.newSessionId?.()) ?? this.options.sessionId?.() ?? this.sessionId
    // The window and the side chat read the session from the status, so publish the new file.
    this.setStatus({ sessionFile: this.transcriptPath() })
    this.persist()
    return { cancelled: false }
  }

  /**
   * Fork the conversation for `/btw`: a copy of the transcript under a new id.
   *
   * The side chat then talks to that copy, and closing it switches back to the original, so the
   * real session never sees the throwaway branch.
   */
  async clone(): Promise<string | undefined> {
    const store = this.options.transcripts
    if (!store) this.unimplemented('会话克隆')
    const forkId = `s_${Math.random().toString(16).slice(2, 14)}`
    await store.save(forkId, this.roots, this.transcript, false, this.preferences())
    this.sessionId = forkId
    this.tools = undefined
    this.setStatus({ sessionFile: this.transcriptPath() })
    return this.transcriptPath()
  }

  async switchSession(sessionPath: string): Promise<void> {
    const store = this.options.transcripts
    if (!store) this.unimplemented('切换会话')
    // A park belongs to the session being left; its notice cannot be matched here any more.
    this.wakeParked()
    const id = sessionPath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.jsonl$/, '')
    if (!id) throw new Error(`无法识别的会话：${sessionPath}`)
    const stored = await store.load(id)
    if (!stored) throw new Error('会话不存在：' + sessionPath)
    this.loaded = true
    this.sessionId = id
    this.tools = undefined
    if (stored.workspace.primary) this.roots = stored.workspace
    this.transcript = orderToolResults(stored.messages)
    this.resetUsage()
    await this.restorePreferences(stored)
    this.setStatus({ sessionFile: this.transcriptPath() })
    for (const message of this.transcript) {
      this.options.onEvent({ type: 'message_end', message })
    }
    if (this.drainNotices()) this.scheduleNoticeTurn()
  }

  async discardSession(sessionPath: string): Promise<void> {
    const store = this.options.transcripts
    if (!store) this.unimplemented('删除会话')
    const id = sessionPath.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '')
    if (!id || store.pathFor(id) !== sessionPath) throw new Error('无法识别的会话：' + sessionPath)
    if (id === this.sessionId) throw new Error('不能删除当前会话')
    await store.remove(id)
  }

  async abort(): Promise<void> {
    this.lastAbortAt = Date.now()
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = undefined
    // A park survives: the round it belonged to is already over, and the work it waits for is still
    // running — losing the park would leave the session looking idle while it is not.
    // Background commands outlive the turn too: stopping the round of the moment must not kill work
    // the user started in order to be woken up by it. `stopAll()` is the panel's own button.
    this.controller?.abort()
    await this.waitForSettle(15_000)
  }

  async send(message: string): Promise<void> {
    const result = await this.prompt(message)
    if (!result.ok) throw new Error(result.error ?? '发送失败')
  }
  // --- the turn --------------------------------------------------------------------------------

  /** True when auto-compaction is on and the context is past the trigger point. */
  private shouldCompact(): boolean {
    this.autoCompact = this.options.autoCompact?.() ?? this.autoCompact
    const window = this.model?.contextWindow
    if (!this.autoCompact.enabled || !window || this.transcript.length === 0) return false
    // The trigger has to describe the next request (prompt + tools + transcript), not just the
    // transcript: 40K tokens of tool declarations fill the window whatever the conversation holds.
    return this.contextTokens() >= (window * this.autoCompact.percent) / 100
  }

  /** First configured model, published to the status so the window shows it. */
  private async pickModel(): Promise<Model<string> | undefined> {
    const runtime = await providers.getRuntime()
    const choices = await providers.listModelChoices({ includeUnconfigured: false })
    const first = choices[0]
    if (!first) return undefined
    const model = runtime.getModel(first.provider, first.id) as Model<string> | undefined
    if (model) {
      await this.selectModel(first.provider, first.id, true)
    }
    return model
  }

  /** Restore the stored conversation for this session, once per process. */
  private async resume(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    this.sessionId = this.options.sessionId?.()
    const store = this.options.transcripts
    if (!store || !this.sessionId) return
    const stored = await store.load(this.sessionId).catch(() => undefined)
    if (!stored) return
    this.transcript = orderToolResults(stored.messages)
    this.resetUsage()
    await this.restorePreferences(stored)
    // The window draws the transcript from the engine, so it has to hear about the restored one.
    for (const message of this.transcript) {
      this.options.onEvent({ type: 'message_end', message })
    }
  }

  /** Where this session lives; the window and `/btw` treat it as the session file. */
  private transcriptPath(): string | undefined {
    const store = this.options.transcripts
    if (!store || !this.sessionId) return undefined
    return store.pathFor(this.sessionId)
  }

  private persist(): void {
    const store = this.options.transcripts
    if (!store || !this.sessionId || this.restoring) return
    void store.save(this.sessionId, this.roots, this.transcript, false, this.preferences()).catch(() => undefined)
  }

  private preferences(): StoredTranscript['preferences'] {
    return { model: this.model ? { provider: this.model.provider, id: this.model.id } : undefined,
      thinkingLevel: this.snapshot.thinkingLevel }
  }

  private async restorePreferences(stored: StoredTranscript): Promise<void> {
    this.restoring = true
    try {
      const selected = stored.preferences?.model
      if (selected) await this.setModel(selected.provider, selected.id).catch(() => undefined)
      const level = stored.preferences?.thinkingLevel
      if (level && this.levels.includes(level)) this.setStatus({ thinkingLevel: level })
    } finally { this.restoring = false }
  }

  /** Tools are loaded once; the module is the same one pi's MCP server serves. */
  private async toolSet(): Promise<CoreTool[]> {
    if (this.tools) return this.tools
    const modulePath = this.options.toolModulePath
    if (!modulePath) return []
    // Per-instance context: parallel workers must never overwrite each other's roots.
    const roots = [
      { name: basename(this.roots.primary), path: this.roots.primary, primary: true },
      ...this.roots.additional.map((root) => ({ name: basename(root), path: root }))
    ]
    const owner = this.sessionId
    let commands = this.bashTasks.get(owner)
    if (!commands) {
      commands = new BashTasks({
        directory: this.options.bashLogDirectory ?? path.join(os.tmpdir(), 'prophey-command-logs'),
        shell: this.options.shellPath ?? 'bash',
        notify: text => this.queueNotice(text, true, owner),
        onChange: tasks => {
          if (owner === this.sessionId) {
            this.setStatus({ backgroundTasks: tasks, backgroundFinished: commands!.finishedCount(), backgroundHistory: commands!.history() })
          }
        }
      })
      this.bashTasks.set(owner, commands)
    }
    const workspace = await loadWorkspaceTools(modulePath, {
      roots, shell: this.options.shellPath,
      runBash: (args: Record<string, unknown>, signal?: AbortSignal) => commands!.run(args, signal)
    })
    const bash = workspace.find(tool => tool.name === 'run_bash')
    if (bash) {
      bash.description += ' Output is saved to a log; returns at most 4000 bytes. Use run_in_background for immediate return. Otherwise commands still running after yield_time_ms (default 1000) continue in the background. Use read_bash_task for output and stop_bash_task to stop. Completion sends a short notice. Tasks stop when this engine is stopped or the app exits; logs are retained.'
      bash.parameters = { ...bash.parameters, properties: {
        ...(bash.parameters.properties as Record<string, unknown>),
        run_in_background: { type: 'boolean' },
        yield_time_ms: { type: 'integer', minimum: 0, maximum: 10000 }
      } }
    }
    // Subagents are app-level (they spawn their own processes); the tools just call the bridge.
    const bridge = this.options.bridge?.()
    const subagentPath = this.options.subagentModulePath
    const context = bridge ? bridgeContext(bridge) : undefined
    const subagents =
      context && subagentPath ? await loadSubagentTools(subagentPath, context).catch(() => []) : []
    const askPath = this.options.askModulePath
    const ask = context && askPath ? await loadAskTool(askPath, context).catch(() => []) : []
    // MCP servers (codegraph / warpgrep / web) over the same bridge endpoints pi connects to.
    const endpoints = await this.options.mcpEndpoints?.(this.workspace()).catch(() => [])
    const mcp =
      endpoints && endpoints.length > 0 ? await loadMcpTools(endpoints, this.controller?.signal) : []
    this.tools = [...workspace, ...commands.tools(), ...subagents, ...ask, ...mcp]
    this.reportTools(mcp, [...subagents, ...ask])
    if (this.options.allowedTools) {
      const aliases: Record<string, string> = {
        read: 'read_file', grep: 'grep_files', find: 'list_files', ls: 'list_files',
        edit: 'edit_file', write: 'write_file', bash: 'run_bash'
      }
      const allowed = new Set(this.options.allowedTools.map((name) => aliases[name] ?? name))
      if (allowed.has('run_bash')) {
        allowed.add('read_bash_task')
        allowed.add('stop_bash_task')
      }
      const unknown = [...allowed].filter((name) => !this.tools!.some((tool) => tool.name === name))
      if (unknown.length) {
        this.tools = undefined
        throw new Error('Prophey 子代理不支持这些工具：' + unknown.join(', '))
      }
      this.tools = this.tools.filter((tool) => tool.name === 'workspace_roots' || allowed.has(tool.name))
    }
    return this.tools
  }

  /**
   * Publish the tool inventory the window lists (per-server counts and the per-tool switches).
   *
   * `this.tools` names MCP tools `<server>__<tool>` because we own the loop and the server is part of
   * the name; the cache wants the tool's own name under its server, which is what the extension posts
   * for pi. App-level tools (ask, subagents) belong to the desktop server, exactly like `mcp-core`'s.
   */
  private reportTools(mcp: CoreTool[], appTools: CoreTool[]): void {
    const report = this.options.onTools
    if (!report) return
    const servers: Record<string, Array<{ name: string }>> = {}
    for (const tool of mcp) {
      const server = tool.source
      if (!server || !tool.name.startsWith(server + '__')) continue
      ;(servers[server] ??= []).push({ name: tool.name.slice(server.length + 2) })
    }
    if (appTools.length > 0) servers.desktop = appTools.map((tool) => ({ name: tool.name }))
    if (Object.keys(servers).length === 0) return
    report(servers)
  }

  /**
   * The directory list goes into the prompt instead of costing a `workspace_roots` round trip: the
   * model needs the names anyway to fill `root` on every call, so spelling them out saves a turn
   * and keeps the same names the tools resolve.
   */
  private systemPrompt(): string {
    const all = [
      { name: basename(this.roots.primary), path: this.roots.primary, primary: true },
      ...this.roots.additional.map((root) => ({ name: basename(root), path: root, primary: false }))
    ]
    const workspace = all.length > 1
      ? [
          '工作目录（工具的 `root` 参数取这些目录名，不传就是主目录；路径相对该目录解析）：',
          ...all.map((root) => `- ${root.name}${root.primary ? '（主目录）' : ''}  ${root.path}`)
        ].join('\n')
      : `工作目录：${all[0].path}（单目录会话，工具不需要 root 参数；路径相对它解析）`
    return [
      '你是 Prophey 内置引擎的助手。',
      workspace,
      '相对路径不能越出文件里指定的目录（`..`、符号出根会被拒绝）；绝对路径直接用。目录清单已在上方列出，不必再调用 workspace_roots。',
      '改文件前先读，改完再读回确认；命令用 run_bash 并指明目录。',
      '长命令会后台执行，输出写入日志。完成通知不包含完整输出；需要时用 read_bash_task 的游标增量读取，避免重复读取日志。',
      '后台任务（命令、子代理）不需要等：工具会结束本回合，完成时唤醒你继续，所以不要轮询、也不要空等。有别的活就接着干。',
      // MCP servers cannot bring a prompt of their own, so how to use each declared tool is spelled
      // out here — gated on the tools this round really has.
      toolGuidance({ tools: this.tools ?? [], agentsSection: this.options.agentsSection?.() }),
      this.conventions,
      this.options.appendSystemPrompt ?? ''
    ].filter(line => line !== '').join('\n')
  }

  notify(text: string, wake: boolean): void {
    this.queueNotice(text, wake, this.sessionId)
  }

  private queueNotice(text: string, wake: boolean, session?: string): void {
    // A parked round is waiting for exactly this, so it outranks the "the user just stopped us"
    // guard: the stop was of a turn, not of the work.
    const guard = Date.now() - this.lastAbortAt > 30_000 || this.parked !== undefined
    this.notices.push({ text: text.slice(0, 2000), wake: wake && guard, session })
    // The work we were parked on just reported in; the status must stop claiming we are waiting.
    if (session === this.sessionId) this.wakeParked()
    if (session === this.sessionId && !this.busy()) {
      const shouldWake = this.drainNotices()
      if (shouldWake) this.scheduleNoticeTurn()
    }
  }

  /**
   * Record that the round stopped on purpose to wait for background work, and arm the failsafe.
   *
   * The status carries it so the window can say 「等待 N 个后台任务」 instead of looking idle, and
   * the session stays counted as running — an idle-looking session is exactly what invites a user
   * to close the one thing that will wake it.
   */
  private park(deferred: DeferredResult): void {
    this.wakeParked()
    this.parked = {
      kind: deferred.kind,
      keys: [...deferred.keys],
      label: deferred.label,
      since: Date.now()
    }
    this.setStatus({ waiting: { kind: deferred.kind, label: deferred.label, since: this.parked.since } })
    const timeout = deferred.timeoutMs ?? PARK_TIMEOUT_MS
    if (timeout > 0) {
      this.parked.timer = setTimeout(() => {
        const task = this.parked
        if (!task || this.busy()) return
        // Nothing arrived in time: wake once so the model can look at the task itself rather than
        // sit parked forever on work that may be wedged.
        this.notify(
          `${task.label ?? task.kind} 等了 ${formatDuration(timeout)} 仍没有结束，自己查一下（${task.keys.join(', ')}）。`,
          true
        )
      }, timeout)
    }
  }

  /** Forget the park (and its timer). Called when the awaited work reports in, or a turn starts. */
  private wakeParked(): void {
    if (!this.parked) return
    if (this.parked.timer) clearTimeout(this.parked.timer)
    this.parked = undefined
    this.setStatus({ waiting: undefined })
  }

  private drainNotices(): boolean {
    // A notice is a user turn too: it must not slip between tool calls and their results.
    if (this.toolBatchOpen) return false
    if (this.notices.length === 0) return false
    let wake = false
    const current = this.notices.filter(notice => notice.session === this.sessionId)
    this.notices = this.notices.filter(notice => notice.session !== this.sessionId)
    for (const notice of current) {
      wake ||= notice.wake
      const message = {
        role: 'user', customType: 'subagent_notice', timestamp: Date.now(),
        content: '<system-reminder source="background-task">\n' + notice.text + '\n</system-reminder>'
      }
      this.transcript.push(message)
      this.options.onEvent({ type: 'message_end', message: { ...message, role: 'custom' } })
    }
    this.persist()
    return wake
  }

  private scheduleNoticeTurn(): void {
    if (this.noticeTimer || !this.running()) return
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined
      if (this.running() && !this.busy()) void this.run(undefined)
    }, 0)
  }

  async prompt(
    message: string,
    options: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] } = {}
  ): Promise<PromptResult> {
    // The user sent something themselves, so the park is answered either way.
    if (!this.busy()) this.wakeParked()
    // A steer joins the run that is already going instead of waiting for it to settle.
    if (this.busy() && options.behavior === 'steer') return this.steer(message, options.images)
    return this.run(message, options)
  }

  /**
   * A steer joins the run that is already going: it enters the transcript at the next boundary the
   * following request can read it at, never in the middle of a tool batch.
   *
   * The window does not see the message until then. It shows it as a pending send with a "send now"
   * button, and only the `message_start`/`message_end` pair below turns it into a real bubble — a
   * steer that paints itself immediately is indistinguishable from an interrupt that already
   * happened. `streamRound` hands the provider a `structuredClone` of the transcript, so appending
   * while a model call is in flight cannot disturb that call.
   */
  private steer(message: string, images?: PromptImage[]): PromptResult {
    const user: Record<string, unknown> = {
      role: 'user',
      content: images?.length ? [{ type: 'text', text: message }, ...images] : message,
      timestamp: Date.now()
    }
    const id = `steer-${++this.steerSeq}`
    if (this.toolBatchOpen) {
      // The model already asked for tools whose results are still owed. Appending the steer right
      // now would put a user turn between the calls and their results — the exact shape that makes
      // DeepSeek/OpenAI answer `400 Messages with role 'tool' must be a response to a preceding
      // message with 'tool_calls'`, and it would be persisted that way. Hold it until the batch is
      // answered, which is also the order the model should read it in.
      this.queuedSteers.push({ id, message: user })
    } else {
      this.deliverSteer({ id, message: user })
    }
    this.steerPending = true
    return { ok: true, disposition: 'started', steerId: id }
  }

  /** Put one steer into the transcript and tell the window it is no longer pending. */
  private deliverSteer(steer: { id: string; message: Record<string, unknown> }): void {
    this.transcript.push(steer.message)
    this.persist()
    this.options.onEvent({ type: 'message_start', message: steer.message })
    this.options.onEvent({ type: 'message_end', message: steer.message })
  }

  /**
   * Take back a steer that is still waiting for the tool batch to finish.
   *
   * A steer only waits while a batch is open, so "not in the list" means it is already in the
   * transcript and the honest answer is no — the window then offers "send now" instead.
   */
  cancelSteer(id: string): { ok: boolean; error?: string } {
    const index = this.queuedSteers.findIndex((entry) => entry.id === id)
    if (index < 0) return { ok: false, error: '这条已经发出去了' }
    this.queuedSteers.splice(index, 1)
    // Every steer is held while a batch is open, so an empty list means nothing is left to answer.
    if (this.queuedSteers.length === 0) this.steerPending = false
    return { ok: true }
  }

  /**
   * Cut the conversation back to the `index`-th user message, so an edited one can replace it.
   *
   * The engine owns the transcript here, so this is a plain cut plus a rewrite of the stored file:
   * the turns after the edited message are gone, which is what "rewrite this message" means. A steer
   * still waiting is dropped too — it was written for a turn that no longer exists.
   */
  async rewind(index: number): Promise<{ ok: boolean; removed?: number; error?: string }> {
    if (this.busy()) return { ok: false, error: '先停掉当前回合' }
    const at = this.userTurnOffset(index)
    if (at < 0) return { ok: false, error: '找不到这条消息' }
    const removed = this.transcript.length - at
    this.transcript = this.transcript.slice(0, at)
    this.queuedSteers = []
    this.steerPending = false
    this.usage = undefined
    this.live = undefined
    this.persist()
    return { ok: true, removed }
  }

  /** Position of the `index`-th user turn in the transcript, or -1 when there is no such turn. */
  private userTurnOffset(index: number): number {
    let seen = -1
    for (let at = 0; at < this.transcript.length; at += 1) {
      if (this.transcript[at].role !== 'user') continue
      seen += 1
      if (seen === index) return at
    }
    return -1
  }

  /** Append the steers a tool batch held back, in the order the user sent them. */
  private flushSteers(): void {
    if (this.queuedSteers.length === 0) return
    const held = this.queuedSteers
    this.queuedSteers = []
    for (const steer of held) this.deliverSteer(steer)
  }

  private async run(
    message: string | undefined,
    options: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] } = {}
  ): Promise<PromptResult> {
    if (this.snapshot.phase !== 'ready') return { ok: false, error: '引擎未就绪' }
    if (this.busy()) return { ok: false, error: '上一轮还没结束' }
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.isBusy = true
    this.setStatus({ isStreaming: true, activity: { label: '正在准备模型与工具', since: Date.now() } })
    this.options.onEvent({ type: 'agent_start' })
    // A park belongs to the round that armed it; this one either re-parks or clears it.
    let parkedThisRound = false
    try {
      const user: Record<string, unknown> = {
        role: 'user',
        content: options.images?.length
          ? [{ type: 'text', text: message }, ...options.images]
          : message,
        timestamp: Date.now()
      }
      this.drainNotices()
      if (message !== undefined) {
        this.transcript.push(user)
        this.persist()
        this.options.onEvent({ type: 'message_start', message: user })
      }
      const runtime = await providers.getRuntime()
      const model = this.model ?? (await this.pickModel())
      if (!model) throw new Error('没有已配置的服务商，请先登录')
      const tools = await this.toolSet()
      signal.throwIfAborted()
      // A task ends when the model finishes or the user stops it, never at a silent tool count.
      let autoCompactTried = false
      for (;;) {
        signal.throwIfAborted()
        if (!autoCompactTried && this.shouldCompact()) {
          autoCompactTried = true
          try {
            await this.compact()
          } catch (error) {
            // A summary that fails must not cost the turn. Nothing was rewritten (the summary is only
            // stored once it is worth storing), so the model answers with what the conversation
            // already holds, and the window says why the context stayed as it was.
            this.options.onEvent({ type: 'compaction_failed', error: describeError(error) })
          }
        }
        this.drainNotices()
        this.steerPending = false
        const answer = await this.streamRoundWithRetry(runtime, model, tools)
        if (!answer.ok) throw new Error(answer.error)
        const calls = toolCallsOf(answer.message)
        if (!calls.length) {
          // A steer that landed during that round still needs an answer.
          if (this.steerPending) continue
          if (this.notices.some((notice) => notice.session === this.sessionId && notice.wake)) continue
          break
        }
        this.toolBatchOpen = true
        let deferred: DeferredResult | undefined
        try {
          for (const call of calls) {
            signal.throwIfAborted()
            const outcome = await this.runTool(call, tools)
            this.transcript.push(outcome.message)
            // One parked call parks the batch: the round has nothing left to do that a fresh turn
            // after the wake would not do better. The remaining calls still ran, so their results
            // are in the transcript and the order stays valid.
            if (outcome.deferred) deferred ??= outcome.deferred
            this.persist()
            // A tool result goes into the next prompt, so the context really did grow.
            this.publishUsage(true)
          }
        } finally {
          // Results for every call are in (or the turn was aborted, which leaves the repair to
          // `orderToolResults`); from here a steer may enter the transcript again.
          this.toolBatchOpen = false
          this.flushSteers()
        }
        if (deferred) {
          this.park(deferred)
          parkedThisRound = true
          break
        }
      }
      return { ok: true, disposition: 'started' }
    } catch (error) {
      const text = signal.aborted ? '已停止' : describeError(error)
      if (!signal.aborted) {
        const failure = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'error', timestamp: Date.now() }
        this.transcript.push(failure)
        this.persist()
        this.options.onEvent({ type: 'message_end', message: failure })
      }
      return { ok: false, error: text }
    } finally {
      this.toolBatchOpen = false
      this.flushSteers()
      const wake = this.drainNotices()
      // A steer that arrived after the loop decided to stop still has to be answered.
      const steered = this.steerPending
      this.steerPending = false
      // A re-park is the outcome of this round, so it stays; anything else answers the old one.
      if (!parkedThisRound) this.wakeParked()
      this.isBusy = false
      this.controller = undefined
      // `activity` is cleared but `waiting` may remain: "parked" has to be distinguishable from
      // "idle", otherwise the window looks done while work is still running.
      this.setStatus({ isStreaming: false, compacting: false, activity: undefined })
      this.options.onEvent({ type: 'agent_end' })
      this.options.onEvent({ type: 'agent_settled' })
      this.options.onSettled()
      if ((wake || steered) && !signal.aborted) this.scheduleNoticeTurn()
    }
  }

  /**
   * One model call with a small retry budget.
   *
   * Provider streams fail for transient reasons (connection reset, 429, 5xx). pi retries these too;
   * a turn that dies on the first blip is worse than one that waits two seconds.
   */
  private async streamRoundWithRetry(
    runtime: Awaited<ReturnType<typeof providers.getRuntime>>,
    model: Model<string>,
    tools: CoreTool[]
  ): Promise<{ ok: true; message: Record<string, unknown> } | { ok: false; error: string }> {
    let lastError = ''
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      this.controller?.signal.throwIfAborted()
      const result = await this.streamRound(runtime, model, tools).catch(error => ({ ok: false as const, error: describeError(error) }))
      if (result.ok) return result
      lastError = result.error
      if (isPermanent(lastError) || !isRetryable(lastError)) return result
      this.setStatus({ activity: { label: `连接异常，正在重试（${attempt + 1}/${RETRY_DELAYS_MS.length}）`, since: Date.now() } })
      this.options.onEvent({
        type: 'auto_retry_start',
        attempt: attempt + 1,
        delayMs: RETRY_DELAYS_MS[attempt],
        error: lastError
      })
      await delay(RETRY_DELAYS_MS[attempt], undefined, { signal: this.controller?.signal })
      // Carry the reason: the window turns this into 「重试失败」, which reads like the end of the
      // turn even while another attempt is queued.
      this.options.onEvent({ type: 'auto_retry_end', success: false, finalError: lastError })
    }
    return { ok: false, error: lastError }
  }

  /** One model call; appends the assistant message and streams its deltas to the window. */
  private async streamRound(
    runtime: Awaited<ReturnType<typeof providers.getRuntime>>,
    model: Model<string>,
    tools: CoreTool[]
  ): Promise<{ ok: true; message: Record<string, unknown> } | { ok: false; error: string }> {
    const tier = speed.resolveSpeedMode(modelInfo(model), this.options.speedMode?.() ?? 'standard')
    // Fast tiers are a request-level knob with two different shapes: OpenAI takes `service_tier` in
    // the body, Anthropic takes `speed` plus a beta header. `onPayload`/`transformHeaders` are the
    // SDK's hooks for exactly this, so no global fetch patching is needed.
    const fastOptions =
      tier === 'standard'
        ? {}
        : {
            onPayload: (payload: unknown) => {
              if (!payload || typeof payload !== 'object') return undefined
              const body = payload as Record<string, unknown>
              return model.api === 'anthropic-messages'
                ? { ...body, speed: 'fast' }
                : { ...body, service_tier: tier }
            },
            ...(model.api === 'anthropic-messages'
              ? {
                  transformHeaders: (headers: Record<string, string>) => ({
                    ...headers,
                    'anthropic-beta': mergeBeta(headers['anthropic-beta'], 'fast-mode-2026-02-01')
                  })
                }
              : {})
          }
    this.options.onEvent({ type: 'message_start', message: { role: 'assistant' } })
    this.setStatus({ activity: { label: '正在等待模型回复', since: Date.now() } })
    // Everything the request carries beyond the transcript, so the meter is already right while the
    // model is thinking instead of showing the pre-round number for the whole wait.
    const systemPrompt = this.systemPrompt()
    const declarations = toolDeclarations(tools)
    this.measurePrompt(systemPrompt, tools)
    this.live = undefined
    this.publishUsage(true)
    const stream = guardedStream<Record<string, unknown>>(signal => runtime.streamSimple(
      model,
      {
        systemPrompt,
        // Keep the original provider metadata/signatures untouched. The same pi SDK adapters
        // translate this copy into the target model's protocol at request time. The call/result
        // grouping is repaired first: one user turn persisted inside a tool batch (an old steer, a
        // notice) would otherwise make every request fail with 400 until the session is dropped.
        // The request carries the newest summary onward, not the turns it already summarizes.
        messages: orderToolResults(structuredClone(this.contextMessages())) as never,
        tools: declarations
      },
      { ...fastOptions, signal,
        reasoning: this.snapshot.thinkingLevel === 'off' ? undefined : this.snapshot.thinkingLevel as ThinkingLevel | undefined }
    ) as AsyncIterable<Record<string, unknown>>, this.controller?.signal, this.options.streamIdleTimeoutMs ?? 180_000)
    let partial: Record<string, unknown> | undefined
    let completed = false
    let received = false
    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
      // Providers attach their token counts to every partial message (Anthropic at the start,
      // OpenAI with the final chunk), so reading them here is what makes the meter live.
      const reported = usageOf((event.partial ?? event.message) as Record<string, unknown> | undefined)
      if (reported) {
        this.live = { ...reported, message: (event.partial ?? event.message) as Record<string, unknown> }
        this.publishUsage()
      }
      if (
        event.type === 'text_delta' ||
        event.type === 'thinking_delta' ||
        event.type === 'text_end' ||
        event.type === 'thinking_end'
      ) {
        if (!received) {
          received = true
          this.setStatus({ activity: { label: event.type.startsWith('thinking') ? '模型正在思考' : '正在生成回复', since: Date.now() } })
        }
        partial = event.partial as Record<string, unknown>
        this.options.onEvent({
          type: 'message_update',
          message: partial,
          assistantMessageEvent: { type: event.type, delta: event.delta }
        })
      }
      if (event.type === 'error') {
        this.live = undefined
        return { ok: false, error: describeError(event.error) }
      }
      if (event.type === 'done' && event.message) {
        completed = true
        partial = event.message as Record<string, unknown>
      }
    }
    if (!completed || !partial) {
      this.live = undefined
      return { ok: false, error: '模型流提前关闭，没有完整回复' }
    }
    if (!textOf(partial).trim() && toolCallsOf(partial).length === 0) {
      this.live = undefined
      // A stream that dies arrives as an empty message carrying `stopReason: 'error'` and the
      // provider's own `errorMessage`. Reporting "empty reply" there hid a 503 model_not_found
      // behind a config hint, so the provider's line wins whenever there is one.
      if (partial.stopReason === 'error' || partial.errorMessage) {
        return { ok: false, error: describeError(partial) }
      }
      return { ok: false, error: '模型返回了空回复，请检查模型配置后重试' }
    }
    // A gateway that does not translate the model's tool-call markup leaves it in the reply text: no
    // tool would run and the window would paint `<｜｜DSML｜｜ invoke …>` as prose. Parse it back into
    // calls, and keep the markup out of the transcript either way.
    const repaired = repairToolCallText(textOf(partial))
    if (repaired.calls.length > 0 && toolCallsOf(partial).length === 0) {
      const kept = (Array.isArray(partial.content) ? (partial.content as unknown[]) : []).filter(
        (block) => (block as { type?: string } | undefined)?.type !== 'text'
      )
      const stamp = Date.now().toString(36)
      partial = {
        ...partial,
        stopReason: 'toolUse',
        content: [
          ...kept,
          ...(repaired.text ? [{ type: 'text', text: repaired.text }] : []),
          ...repaired.calls.map((call, index) => ({
            type: 'toolCall',
            id: `call_dsml_${stamp}_${index}`,
            name: call.name,
            arguments: call.arguments
          }))
        ]
      }
      this.options.onEvent({ type: 'tool_calls_repaired', count: repaired.calls.length })
    } else if (repaired.calls.length === 0 && hasToolCallMarkup(textOf(partial))) {
      // Markup with nothing parseable (a truncated stream, a format from the future): still leave it
      // out of the window, and say that the call the model meant did not survive.
      const kept = (Array.isArray(partial.content) ? (partial.content as unknown[]) : []).filter(
        (block) => (block as { type?: string } | undefined)?.type !== 'text'
      )
      partial = {
        ...partial,
        content: [...kept, ...(repaired.text ? [{ type: 'text', text: repaired.text }] : [])]
      }
      this.options.onEvent({ type: 'tool_calls_repaired', count: 0 })
    }
    const message = { ...partial, api: partial.api ?? model.api,
      provider: partial.provider ?? model.provider, model: partial.model ?? model.id }
    this.transcript.push(message)
    // The response's own usage covers everything sent plus the reply, which is exactly the context
    // the next request starts from.
    const usage = usageOf(message)
    this.usage = { tokens: usage ? usage.prompt + usage.output : this.contextTokens(), index: this.transcript.length }
    this.live = undefined
    this.publishUsage(true)
    this.options.onEvent({ type: 'message_end', message })
    this.persist()
    return { ok: true, message }
  }

  /** Execute one tool call and report it the way the window expects tool cards to arrive. */
  private async runTool(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    tools: CoreTool[]
  ): Promise<{ message: Record<string, unknown>; deferred?: DeferredResult }> {
    const tool = tools.find((entry) => entry.name === call.name)
    const started = Date.now()
    this.setStatus({ activity: { label: `正在执行 ${call.name}`, since: started } })
    this.options.onEvent({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments
    })
    let result: { content: Array<{ type: string; text?: string }>; isError?: boolean; deferred?: DeferredResult }
    if (!tool) {
      result = { content: [{ type: 'text', text: `未知工具：${call.name}` }], isError: true }
    } else {
      try {
        result = await tool.call(call.arguments ?? {}, this.controller?.signal)
      } catch (error) {
        result = { content: [{ type: 'text', text: describeError(error) }], isError: true }
      }
    }
    this.options.onEvent({
      type: 'tool_execution_end',
      toolCallId: call.id,
      toolName: call.name,
      result: { content: result.content, isError: Boolean(result.isError) },
      durationMs: Date.now() - started
    })
    return {
      message: {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: Boolean(result.isError),
        timestamp: Date.now()
      },
      deferred: result.isError ? undefined : result.deferred
    }
  }


}

/**
 * Prompt and output tokens a provider reported for a response.
 *
 * `input` excludes the cached parts of the prompt (that is how pi normalises every provider), so
 * the prompt is the sum of the three input fields.
 */
function usageOf(
  message: Record<string, unknown> | undefined
): { prompt: number; output: number } | undefined {
  const usage = message?.usage as Record<string, unknown> | undefined
  if (!usage || typeof usage !== 'object') return undefined
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  const prompt = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite)
  const output = count(usage.output)
  if (prompt === 0 && output === 0) return undefined
  return { prompt, output }
}

/**
 * Characters of what a message actually sends: text, thinking and tool arguments.
 *
 * Counting the serialised message instead would charge the model for JSON field names and quoting,
 * which is where estimates drift furthest from the provider's own count.
 */
function messageCharacters(message: Record<string, unknown>): number {
  const raw = message.content
  const blocks = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? [{ type: 'text', text: raw }]
      : []
  let characters = 0
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const fields = block as Record<string, unknown>
    if (typeof fields.text === 'string') characters += fields.text.length
    if (typeof fields.thinking === 'string') characters += fields.thinking.length
    if (fields.arguments !== undefined && fields.arguments !== null) characters += JSON.stringify(fields.arguments).length
  }
  return characters
}

/** Rough token count of messages; ~4 characters per token is close enough for a meter. */
function estimateTokens(messages: Array<Record<string, unknown>>): number {
  let characters = 0
  for (const message of messages) characters += messageCharacters(message)
  return Math.ceil(characters / 4)
}

/** Concatenated text blocks of a message. */
function textOf(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .map((block) =>
      block && typeof block === 'object' && 'text' in block
        ? String((block as { text: unknown }).text)
        : ''
    )
    .join('')
}

/** Rounds per turn: a tool-using answer rarely needs more, and it bounds a runaway loop. */

/** Backoff before each retry; length is the retry budget. */
const RETRY_DELAYS_MS = [1500, 4000, 9000]

/**
 * How long a park may last without any news before the engine wakes the model anyway.
 *
 * A parked session is an idle session to the user; ten minutes of silence looks broken even when
 * the subagent is genuinely working, and the model is the one that can decide to give up.
 */
const PARK_TIMEOUT_MS = 10 * 60_000

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  return `${Math.round(ms / 60_000)} 分钟`
}

/** Only transient failures are worth another attempt: a bad key or a bad request never recovers. */
function isRetryable(message: string): boolean {
  return /rate.?limit|429|overloaded|timeout|timed out|ECONNRESET|socket hang up|network|fetch failed|502|503|504|stream (ended|closed)|premature close/i.test(
    message
  )
}

/**
 * Failures that fail identically however many times they are retried: a model the account cannot
 * reach, a rejected key, a malformed request. Retrying those only spends the retry budget and
 * leaves another junk message in the transcript.
 */
function isPermanent(message: string): boolean {
  return /model_not_found|no such model|does not exist|invalid_api_key|invalid_request_error|insufficient_quota|unauthorized|forbidden/i.test(
    message
  )
}

/** Merge a beta flag into an existing `anthropic-beta` header value without duplicating it. */
function mergeBeta(existing: string | undefined, flag: string): string {
  const flags = (existing ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (!flags.includes(flag)) flags.push(flag)
  return flags.join(',')
}

/** The status shape the window expects for the current model. */
function modelInfo(model: Model<string>): PiModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    api: model.api
  }
}

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

function describeError(error: unknown): string {
  if (typeof error === 'string') return error.trim()
  if (error instanceof Error) return error.message.trim() || error.name
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    // Providers fail in several shapes, and the one that matters here is the assistant message
    // that ended the stream (`{stopReason: 'error', errorMessage, usage, cost}`). Dumping it put a
    // page of JSON into the transcript where 「503 model_not_found」 belonged.
    for (const key of ['errorMessage', 'message', 'error', 'detail', 'reason']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (value instanceof Error && value.message.trim()) return value.message.trim()
      if (value && typeof value === 'object') {
        const nested = value as Record<string, unknown>
        const text = [nested.code, nested.message].filter((part) => typeof part === 'string' && part).join(': ')
        if (text) return text
      }
    }
    const code = typeof record.code === 'string' ? record.code : typeof record.type === 'string' ? record.type : ''
    return code ? `模型调用失败（${code}）` : '模型调用失败（服务商没有给出原因）'
  }
  return String(error)
}

/**
 * The summary the model produced, or a refusal.
 *
 * A compaction request can come back as an interruption instead of a summary: aborting the request
 * yields an assistant message whose text is "[Request interrupted by user]". That is non-empty, so
 * it passed the old "nothing returned" check and was stored as the entire conversation — session
 * `s_99a5d7e6` lost its history to exactly that line. Anything that is not a plausible summary is
 * rejected here, before the transcript is touched, so a failed compaction costs nothing.
 */
const MIN_SUMMARY_CHARS = 8
const INTERRUPTED_SUMMARY = /^\[?\s*(request|user|generation|message)?\s*(was\s+)?interrupt(ed|ion)\b.*$/i

function summaryOf(answer: Record<string, unknown>, signal: AbortSignal): string {
  const text = textOf(answer).trim()
  if (signal.aborted || answer.stopReason === 'aborted') {
    throw new Error('压缩被中断，原对话保持不变')
  }
  // Say what the provider said: an empty answer hid a 503 model_not_found once already.
  if (answer.stopReason === 'error' || answer.errorMessage) throw new Error(describeError(answer))
  if (!text) throw new Error('压缩没有返回内容。模型可能只回了思考过程，换一个模型或重试一次')
  if (INTERRUPTED_SUMMARY.test(text)) {
    throw new Error(`压缩被中断（模型只回了「${text}」），原对话保持不变`)
  }
  if (text.length < MIN_SUMMARY_CHARS) {
    throw new Error(`压缩返回的内容太短（${text.length} 字），不像摘要，原对话保持不变`)
  }
  return text
}

/** Tool calls the model asked for in one assistant message. */
function toolCallsOf(message: Record<string, unknown>): Array<{
  id: string
  name: string
  arguments: Record<string, unknown>
}> {
  const content = Array.isArray(message.content) ? message.content : []
  const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const entry = block as { type?: string; id?: unknown; name?: unknown; arguments?: unknown }
    if (entry.type !== 'toolCall' || typeof entry.name !== 'string') continue
    calls.push({
      id: typeof entry.id === 'string' ? entry.id : `call_${calls.length}`,
      name: entry.name,
      arguments:
        entry.arguments && typeof entry.arguments === 'object'
          ? (entry.arguments as Record<string, unknown>)
          : {}
    })
  }
  return calls
}
