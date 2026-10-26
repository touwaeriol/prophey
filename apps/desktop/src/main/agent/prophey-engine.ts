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
import { toolGuidance } from './tool-guidance'
import {
  bridgeContext,
  loadAskTool,
  loadSubagentTools,
  loadWorkspaceTools,
  toolDeclarations,
  type CoreTool
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
  private queuedSteers: Array<Record<string, unknown>> = []
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
    this.snapshot = { phase: 'ready', cwd: wanted.primary, isStreaming: false, compacting: false,
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
    this.setStatus({ sessionFile: this.transcriptPath() })
    this.publishUsage(true)
    return this.snapshot
  }

  stop(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = undefined
    this.controller?.abort()
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
      : estimateTokens(this.transcript) + this.promptTokens
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

  /** The transcript was replaced, so the measured prompt no longer describes it. */
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

  /**
   * Rewrite the context: the model summarizes the conversation, and the summary replaces it.
   *
   * Same idea as pi's compaction — the transcript becomes a single "here is what happened" message,
   * so the next turn starts with room to work instead of replaying everything.
   */
  async compact(instructions?: string): Promise<{ summary?: string }> {
    this.controller ??= new AbortController()
    const model = this.model ?? (await this.pickModel())
    if (!model) throw new Error('没有可用的模型，无法压缩')
    if (this.transcript.length === 0) return {}
    const runtime = await providers.getRuntime()
    this.setStatus({ compacting: true, activity: { label: '正在压缩上下文', since: Date.now() } })
    this.options.onEvent({ type: 'compaction_start', reason: 'manual' })
    try {
      const stream = guardedStream<Record<string, unknown>>(signal => runtime.streamSimple(
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
          messages: orderToolResults(structuredClone(this.transcript)) as never
        },
        { signal }
      ) as AsyncIterable<Record<string, unknown>>, this.controller.signal, this.options.streamIdleTimeoutMs ?? 180_000)
      let text = ''
      let partial: Record<string, unknown> | undefined
      for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        if (event.type === 'text_delta') {
          partial = event.partial as Record<string, unknown>
        }
        if (event.type === 'text_end')
          text = String((event as { content?: unknown }).content ?? text)
        if (event.type === 'done' && event.message) text = textOf(event.message as Record<string, unknown>)
        if (event.type === 'error') throw new Error(describeError(event.error))
      }
      if (!text.trim() && partial) text = textOf(partial)
      if (!text.trim()) throw new Error('压缩没有返回内容')
      this.transcript = [
        {
          role: 'user',
          content: `【此前对话摘要】
${text.trim()}`,
          timestamp: Date.now()
        }
      ]
      this.resetUsage()
      this.persist()
      this.options.onEvent({ type: 'compaction_end', summary: text.trim() })
      return { summary: text.trim() }
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
    this.controller?.abort()
    await this.bashTasks.get(this.sessionId)?.stopAll()
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
      '越界（`..`、绝对路径、符号出根）会被拒绝；目录清单已在上方列出，不必再调用 workspace_roots。',
      '改文件前先读，改完再读回确认；命令用 run_bash 并指明目录。',
      '长命令会后台执行，输出写入日志。完成通知不包含完整输出；需要时用 read_bash_task 的游标增量读取，避免重复读取日志。任务需要命令结果时，应等待完成后再下结论。',
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
    this.notices.push({ text: text.slice(0, 2000), wake: wake && Date.now() - this.lastAbortAt > 30_000, session })
    if (session === this.sessionId && !this.busy()) {
      const shouldWake = this.drainNotices()
      if (shouldWake) this.scheduleNoticeTurn()
    }
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
    // A steer joins the run that is already going instead of waiting for it to settle.
    if (this.busy() && options.behavior === 'steer') return this.steer(message, options.images)
    return this.run(message, options)
  }

  /**
   * A steer goes straight into the transcript; the running loop answers it in its next round.
   *
   * `streamRound` hands the provider a `structuredClone` of the transcript, so appending while a
   * model call is in flight cannot disturb that call.
   */
  private steer(message: string, images?: PromptImage[]): PromptResult {
    const user: Record<string, unknown> = {
      role: 'user',
      content: images?.length ? [{ type: 'text', text: message }, ...images] : message,
      timestamp: Date.now()
    }
    // The window shows the message at once; where it may enter the transcript is a separate
    // question, answered below.
    this.options.onEvent({ type: 'message_start', message: user })
    this.options.onEvent({ type: 'message_end', message: user })
    if (this.toolBatchOpen) {
      // The model already asked for tools whose results are still owed. Appending the steer right
      // now would put a user turn between the calls and their results — the exact shape that makes
      // DeepSeek/OpenAI answer `400 Messages with role 'tool' must be a response to a preceding
      // message with 'tool_calls'`, and it would be persisted that way. Hold it until the batch is
      // answered, which is also the order the model should read it in.
      this.queuedSteers.push(user)
    } else {
      this.transcript.push(user)
      this.persist()
    }
    this.steerPending = true
    return { ok: true, disposition: 'started' }
  }

  /** Append the steers a tool batch held back, in the order the user sent them. */
  private flushSteers(): void {
    if (this.queuedSteers.length === 0) return
    this.transcript.push(...this.queuedSteers)
    this.queuedSteers = []
    this.persist()
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
      for (;;) {
        signal.throwIfAborted()
        if (this.shouldCompact()) await this.compact()
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
        try {
          for (const call of calls) {
            signal.throwIfAborted()
            this.transcript.push(await this.runTool(call, tools))
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
      this.isBusy = false
      this.controller = undefined
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
      if (!isRetryable(lastError)) return result
      this.setStatus({ activity: { label: `连接异常，正在重试（${attempt + 1}/${RETRY_DELAYS_MS.length}）`, since: Date.now() } })
      this.options.onEvent({
        type: 'auto_retry_start',
        attempt: attempt + 1,
        delayMs: RETRY_DELAYS_MS[attempt],
        error: lastError
      })
      await delay(RETRY_DELAYS_MS[attempt], undefined, { signal: this.controller?.signal })
      this.options.onEvent({ type: 'auto_retry_end', success: false })
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
        messages: orderToolResults(structuredClone(this.transcript)) as never,
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
      return { ok: false, error: '模型返回了空回复，请检查模型配置后重试' }
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
  ): Promise<Record<string, unknown>> {
    const tool = tools.find((entry) => entry.name === call.name)
    const started = Date.now()
    this.setStatus({ activity: { label: `正在执行 ${call.name}`, since: started } })
    this.options.onEvent({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments
    })
    let result: { content: Array<{ type: string; text?: string }>; isError?: boolean }
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
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      isError: Boolean(result.isError),
      timestamp: Date.now()
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

/** Only transient failures are worth another attempt: a bad key or a bad request never recovers. */
function isRetryable(message: string): boolean {
  return /rate.?limit|429|overloaded|timeout|timed out|ECONNRESET|socket hang up|network|fetch failed|502|503|504|stream (ended|closed)|premature close/i.test(
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
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') return JSON.stringify(error).slice(0, 400)
  return String(error)
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
