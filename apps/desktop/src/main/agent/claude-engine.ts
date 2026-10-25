import type { ImportedHistoryStore } from '../imported-history-store'
import type { EngineStartOptions } from './engine'
import { randomUUID } from 'node:crypto'
import type { Query, SDKUserMessage, ModelInfo, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { PiStatus, PiModel, PromptImage, PromptResult } from '../../shared/types'
import type { EngineCommand } from '../../shared/engine'
import type { AgentWorkspace } from './engine'
import { NativeEngine, type NativeOptions, textContent } from './native-engine'

/** A closeable input stream keeps the official SDK control channel alive between turns. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake?: () => void
  private closed = false
  push(message: SDKUserMessage): void {
    this.queue.push(message)
    this.wake?.()
  }
  close(): void {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.queue.length) yield this.queue.shift()!
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}
interface ClaudeOptions extends NativeOptions {
  historyStore?: ImportedHistoryStore
  binary: string
  /** The user's setting for next-message predictions; the CLI produces them natively. */
  suggestions?: () => boolean
}
export class ClaudeCodeEngine extends NativeEngine {
  readonly id = 'claude' as const
  private query?: Query
  private input?: InputQueue
  private sessionId?: string
  private modelCatalog: ModelInfo[] = []
  private commandCatalog: SlashCommand[] = []
  private generation = 0
  private compacted = false
  private commandResult = ''
  private toolNames = new Map<string, string>()
  private launching?: Promise<PiStatus>
  constructor(private readonly options: ClaudeOptions) {
    super(options)
  }

  async start(
    workspace?: string | AgentWorkspace,
    options: EngineStartOptions = {}
  ): Promise<PiStatus> {
    if (this.launching) return this.launching
    const nextPrimary = typeof workspace === 'string' ? workspace : workspace?.primary
    if (nextPrimary && nextPrimary !== this.roots.primary && !options.session) {
      this.sessionId = undefined
      this.transcript = []
      this.usage = {}
      this.setStatus({
        sessionFile: undefined,
        sessionName: undefined,
        model: undefined,
        thinkingLevel: undefined
      })
    }
    this.configureWorkspace(workspace)
    if (options.session) this.sessionId = this.parseRef(options.session)
    this.launching = this.connect().finally(() => {
      this.launching = undefined
    })
    return this.launching
  }
  capabilities() {
    const selected = this.modelCatalog.find(
      (m) => m.value === this.snapshot.model?.id || m.resolvedModel === this.snapshot.model?.id
    )
    return {
      ...super.capabilities(),
      compact: this.commandCatalog.some((c) => c.name === 'compact'),
      models: this.modelCatalog.length > 0,
      thinking: !!selected?.supportedEffortLevels?.length
    }
  }
  private parseRef(ref: string): string {
    if (!/^claude:[a-zA-Z0-9-]+$/.test(ref)) throw new Error('不是 Claude Code 会话')
    return ref.slice(7)
  }
  private async connect(): Promise<PiStatus> {
    this.disconnect()
    const generation = this.generation
    this.setStatus({ phase: 'starting', cwd: this.roots.primary, isStreaming: false })
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk')
      const storage = await this.sessionOptions()
      this.input = new InputQueue()
      const q = sdk.query({
        prompt: this.input,
        options: {
          pathToClaudeCodeExecutable: this.options.binary,
          cwd: this.roots.primary,
          additionalDirectories: this.roots.additional,
          settingSources: ['user', 'project', 'local'],
          // Keep Claude Code's native tools and user-configured MCPs. Prophey does not
          // supply a tools/disallowedTools policy or inject its desktop MCP servers.
          resume: this.sessionId,
          sessionStore: storage.sessionStore,
          model: this.sessionId ? undefined : this.snapshot.model?.id || undefined,
          // Claude Code predicts the user's next message itself, off its own prompt cache. At most
          // one per turn, delivered after `result` — `consume()` keeps iterating past `result`, so
          // the `prompt_suggestion` message below arrives without any extra request.
          promptSuggestions: this.options.suggestions?.() === true,
          includePartialMessages: true,
          stderr: (text) => {
            this.stderr = (this.stderr + text).slice(-4000)
          },
          canUseTool: async (name, input) => {
            if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
              const answer = await this.ask(input.questions, name)
              if (answer.cancelled) return { behavior: 'deny', message: '用户已取消' }
              const answers = Object.fromEntries(
                answer.answers.map((a) => [
                  a.question,
                  [...a.selected, ...(a.other ? [a.other] : [])].join(', ')
                ])
              )
              return { behavior: 'allow', updatedInput: { ...input, answers } }
            }
            const allowed = await this.requestApproval(
              '允许 Claude Code 执行 ' + name + '？\n' + JSON.stringify(input),
              name
            )
            return allowed
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: '用户拒绝或取消' }
          }
        }
      })
      this.query = q
      void this.consume(q, generation)
      ;[this.modelCatalog, this.commandCatalog] = await Promise.all([
        q.supportedModels(),
        q.supportedCommands()
      ])
      if (this.sessionId) await this.readHistory()
      if (!this.snapshot.model)
        this.setStatus({ model: { provider: 'claude-code', id: '', name: 'CLI 默认模型' } })
      if (generation !== this.generation) throw new Error('启动已取消')
      this.setStatus({
        phase: 'ready',
        sessionFile: this.sessionId ? 'claude:' + this.sessionId : undefined
      })
      return this.snapshot
    } catch (error) {
      this.disconnect()
      this.setStatus({ phase: 'error', error: String(error) })
      throw error
    }
  }
  private async consume(q: Query, generation: number): Promise<void> {
    try {
      for await (const message of q) {
        if (generation !== this.generation) return
        this.handle(message as unknown as Record<string, any>)
      }
      if (generation === this.generation) {
        this.query = undefined
        this.finish(this.busy() ? 'Claude Code 连接提前结束' : undefined)
        this.setStatus({ phase: 'stopped' })
      }
    } catch (error) {
      if (generation !== this.generation) return
      this.query = undefined
      this.finish(String(error))
      this.setStatus({ phase: 'error', error: String(error) })
    }
  }
  private disconnect(): void {
    this.generation++
    this.input?.close()
    this.query?.close()
    this.input = undefined
    this.query = undefined
  }
  stop(): void {
    this.disconnect()
    this.finish(this.busy() ? '会话已停止' : undefined)
    this.setStatus({ phase: 'stopped' })
  }
  async abort(): Promise<void> {
    if (!this.busy()) return
    await this.query?.interrupt()
    if (!(await this.waitForSettle(5000))) {
      this.disconnect()
      this.finish('已停止')
      this.setStatus({ phase: 'stopped' })
    }
  }
  private async sessionOptions(sessionId = this.sessionId): Promise<{ dir: string; sessionStore?: ImportedHistoryStore }> {
    const store = this.options.historyStore
    return {
      dir: this.roots.primary,
      sessionStore: sessionId && store && await store.owns(sessionId) ? store : undefined
    }
  }

  private async readHistory(): Promise<void> {
    if (!this.sessionId) {
      this.transcript = []
      return
    }
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const messages = await sdk.getSessionMessages(this.sessionId, await this.sessionOptions())
    this.transcript = normalizeClaudeHistory(messages)
  }
  async newSession(): Promise<{ cancelled?: boolean }> {
    if (this.busy()) throw new Error('请先停止当前回合')
    this.sessionId = undefined
    this.transcript = []
    this.usage = {}
    this.setStatus({ sessionFile: undefined, sessionName: undefined })
    await this.connect()
    return { cancelled: false }
  }
  async switchSession(ref: string): Promise<void> {
    if (this.busy()) throw new Error('请先停止当前回合')
    const id = this.parseRef(ref)
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    if (!(await sdk.getSessionInfo(id, await this.sessionOptions(id))))
      throw new Error('Claude Code 会话不存在')
    this.sessionId = id
    this.setStatus({ model: undefined, thinkingLevel: undefined })
    await this.connect()
  }
  async clone(): Promise<string> {
    if (this.busy() || !this.sessionId) throw new Error('当前会话还不能分叉')
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const fork = await sdk.forkSession(this.sessionId, await this.sessionOptions())
    const ref = 'claude:' + fork.sessionId
    await this.switchSession(ref)
    return ref
  }
  async discardSession(ref: string): Promise<void> {
    const id = this.parseRef(ref)
    if (id === this.sessionId) throw new Error('不能删除当前会话')
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    await sdk.deleteSession(id, await this.sessionOptions(id))
  }
  async models(): Promise<Record<string, unknown>[]> {
    return this.modelCatalog.map((m) => ({
      provider: 'claude-code',
      id: m.value,
      name: m.displayName
    }))
  }
  async setModel(_provider: string, model: string): Promise<PiModel> {
    if (!this.query) throw new Error('Claude Code 未连接')
    if (!this.modelCatalog.some(row => row.value === model)) throw new Error('Claude Code 当前可用模型中没有 ' + model)
    await this.query.setModel(model)
    const info = {
      provider: 'claude-code',
      id: model,
      name: this.modelCatalog.find((m) => m.value === model)?.displayName ?? model
    }
    this.setStatus({ model: info })
    return info
  }
  async thinkingLevels(): Promise<string[]> {
    const model = this.modelCatalog.find(
      (m) => m.value === this.snapshot.model?.id || m.resolvedModel === this.snapshot.model?.id
    )
    return model?.supportedEffortLevels ?? []
  }
  async setThinkingLevel(level: string): Promise<void> {
    if (!(await this.thinkingLevels()).includes(level))
      throw new Error('当前模型不支持思考等级 ' + level)
    if (!this.query) throw new Error('Claude Code 未连接')
    await this.query.applyFlagSettings({
      effortLevel: level as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    })
    this.setStatus({ thinkingLevel: level })
  }
  async nativeCommands(): Promise<EngineCommand[]> {
    if (this.query) this.commandCatalog = await this.query.supportedCommands()
    return this.commandCatalog.flatMap((c) =>
      [c.name, ...(c.aliases ?? [])].map((name) => ({
        name: '/' + name,
        args: c.argumentHint ?? '',
        hint: c.description,
        action:
          c.builtin && c.name === 'clear'
            ? ('clear' as const)
            : c.builtin && c.name === 'effort'
              ? ('thinking' as const)
              : ('native' as const),
        source: 'engine' as const
      }))
    )
  }
  async executeCommand(name: string, args: string): Promise<{ text?: string }> {
    if (!(await this.nativeCommands()).some((c) => c.name === name))
      throw new Error('当前引擎没有命令 ' + name)
    await this.runInput(name + (args ? ' ' + args : ''), [], true)
    return { text: this.commandResult || undefined }
  }
  async compact(instructions?: string): Promise<{ summary?: string }> {
    if (!this.sessionId) throw new Error('当前会话没有可压缩的历史')
    this.compacted = false
    await this.runInput(
      '/compact' + (instructions?.trim() ? ' ' + instructions.trim() : ''),
      [],
      true,
      true
    )
    if (!this.compacted) throw new Error(this.commandResult || '当前历史不足以压缩')
    await this.readHistory()
    return { summary: this.commandResult || '压缩完成' }
  }
  async prompt(
    message: string,
    options: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] } = {}
  ): Promise<PromptResult> {
    if (this.busy()) return { ok: false, error: 'Claude Code 当前回合尚未结束，请排队发送' }
    try {
      await this.runInput(message, options.images ?? [])
      return { ok: true, disposition: 'started' }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }
  private async runInput(
    text: string,
    images: PromptImage[],
    command = false,
    compact = false
  ): Promise<void> {
    if (!this.query) await this.connect()
    const done = this.begin(compact)
    this.commandResult = ''
    // Attach a rejection handler immediately: stream errors may arrive before the input call returns.
    const observed = done.catch((error) => {
      throw error
    })
    void observed.catch(() => undefined)
    if (!command)
      this.emitMessage({
        role: 'user',
        content: [{ type: 'text', text }, ...images],
        timestamp: Date.now()
      })
    const content: any[] = [
      { type: 'text', text },
      ...images.map((i) => ({
        type: 'image',
        source: { type: 'base64', media_type: i.mimeType, data: i.data }
      }))
    ]
    this.input!.push({
      type: 'user',
      uuid: randomUUID(),
      session_id: this.sessionId ?? '',
      parent_tool_use_id: null,
      message: { role: 'user', content }
    })
    await observed
  }
  private handle(m: Record<string, any>): void {
    if (m.type === 'system' && m.subtype === 'api_retry') {
      this.callbacks.onEvent({
        type: 'auto_retry_start',
        attempt: m.attempt,
        delayMs: m.retry_delay_ms,
        error: 'Claude Code 上游请求失败：' + (m.error_status ?? m.error ?? 'unknown')
      })
      return
    }
    if (m.parent_tool_use_id) return
    if (m.type === 'stream_event') {
      const event = m.event
      if (event?.type === 'message_start')
        this.callbacks.onEvent({ type: 'message_start', message: { role: 'assistant' } })
      if (event?.type === 'content_block_delta') {
        const d = event.delta
        if (d?.type === 'text_delta' || d?.type === 'thinking_delta')
          this.callbacks.onEvent({
            type: 'message_update',
            assistantMessageEvent: { type: d.type, delta: d.text ?? d.thinking ?? '' }
          })
      }
      return
    }
    if (m.type === 'system' && m.subtype === 'init') {
      this.sessionId = m.session_id
      this.setStatus({
        sessionFile: 'claude:' + m.session_id,
        model: { provider: 'claude-code', id: m.model, name: m.model },
        thinkingLevel: m.effort ?? undefined
      })
    } else if (m.type === 'system' && m.subtype === 'local_command_output') {
      this.commandResult = m.content ?? ''
    } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
      this.compacted = true
      this.callbacks.onEvent({ type: 'compaction_end' })
    } else if (m.type === 'system' && m.subtype === 'status' && m.compact_result === 'failed') {
      this.finish(m.compact_error || 'Claude Code 原生压缩失败')
    } else if (m.type === 'system' && m.subtype === 'status' && m.status === 'compacting') {
      this.setStatus({ compacting: true })
      this.callbacks.onEvent({ type: 'compaction_start', reason: 'auto' })
    } else if (m.type === 'assistant') {
      const blocks = m.message?.content ?? []
      this.emitMessage({
        ...m.message,
        role: 'assistant',
        content: blocks.map((b: any) =>
          b.type === 'tool_use'
            ? { type: 'toolCall', id: b.id, name: b.name, arguments: b.input }
            : b
        ),
        timestamp: Date.now()
      })
      for (const b of blocks)
        if (b.type === 'tool_use') {
          this.toolNames.set(b.id, b.name)
          this.callbacks.onEvent({
            type: 'tool_execution_start',
            toolCallId: b.id,
            toolName: b.name,
            args: b.input
          })
        }
    } else if (m.type === 'user') {
      for (const b of Array.isArray(m.message?.content) ? m.message.content : [])
        if (b.type === 'tool_result') {
          const name = this.toolNames.get(b.tool_use_id) ?? 'tool'
          const content =
            typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : b.content
          this.emitMessage({
            role: 'toolResult',
            toolCallId: b.tool_use_id,
            toolName: name,
            content,
            isError: b.is_error
          })
          this.callbacks.onEvent({
            type: 'tool_execution_end',
            toolCallId: b.tool_use_id,
            toolName: name,
            result: { content },
            isError: b.is_error
          })
        }
    } else if (m.type === 'result') {
      this.commandResult = m.result ?? ''
      const u = m.usage ?? {}
      const models = Object.values(m.modelUsage ?? {}) as any[]
      const window = models[0]?.contextWindow
      this.usage = {
        tokens: {
          input: u.input_tokens,
          output: u.output_tokens,
          total: (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
        },
        cost: m.total_cost_usd,
        contextUsage: window ? { contextWindow: window, tokens: null, percent: null } : undefined
      }
      this.finish(
        m.is_error || m.subtype !== 'success'
          ? m.errors?.join('\n') || m.result || m.subtype
          : undefined
      )
    } else if (m.type === 'prompt_suggestion') {
      // The CLI's own prediction of the user's next message; same event the universal path emits.
      const text = typeof m.suggestion === 'string' ? m.suggestion.trim() : ''
      if (text) this.options.onEvent({ type: 'suggestion', text })
    }
  }
}

/** Native history has tool_result in user messages; the renderer uses dedicated toolResult rows. */
export function normalizeClaudeHistory(
  messages: Array<{
    type: string
    message: unknown
    uuid?: string
    parent_tool_use_id?: string | null
  }>
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const tools = new Map<string, string>()
  for (const entry of messages) {
    if (entry.parent_tool_use_id) continue
    const m = entry.message as { content?: any }
    if (!m) continue
    if (!Array.isArray(m.content)) {
      out.push({ ...m, role: entry.type, id: entry.uuid })
      continue
    }
    const content = []
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        tools.set(b.id, b.name)
        content.push({ type: 'toolCall', id: b.id, name: b.name, arguments: b.input })
      } else if (b.type === 'tool_result') {
        out.push({
          role: 'toolResult',
          toolCallId: b.tool_use_id,
          toolName: tools.get(b.tool_use_id) ?? 'tool',
          content: typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : b.content,
          isError: b.is_error
        })
      } else if (b.type === 'image' && b.source?.type === 'base64')
        content.push({ type: 'image', mimeType: b.source.media_type, data: b.source.data })
      else content.push(b)
    }
    if (content.length) out.push({ ...m, role: entry.type, content, id: entry.uuid })
  }
  return out
}
