import type { EngineCapabilities, EngineCommand } from '../../shared/engine'
export type { EngineCapabilities } from '../../shared/engine'
import type { PiModel, PiStatus, PromptImage, PromptResult } from '@shared/types'

/**
 * The directories one session works on.
 *
 * A session always has a primary directory: it is the working directory, and relative paths, bash
 * and the search defaults resolve against it. Additional roots are the other folders of a project —
 * reachable by absolute path, never as subdirectories. This is the agent-layer notion of "working
 * across several folders"; pi happens to implement it with a prompt section and absolute paths, but
 * the contract does not depend on that.
 */
export interface AgentWorkspace {
  primary: string
  additional: string[]
}

/**
 * What the window needs from an agent engine.
 *
 * The desktop app is moving to "our own agent, with a swappable engine underneath". all four implementations share this contract. Protocol-specific details stay in their adapter.
 *
 * Deliberately narrow: an engine runs turns against a session, owns the run state (`busy` /
 * `compacting`, which is what unblocks the message queue).
 * Everything that is app policy — MCP servers, `/btw` forks, compaction thresholds, speed tiers,
 * config, profiles — stays in the app, not in the engine.
 */
export interface EngineStartOptions {
  session?: string
  model?: { provider: string; id: string }
}

export interface AgentEngine {
  /** Stable engine id, shared with session storage and the renderer. */
  readonly id: string

  /** Run state as the window sees it. The app decorates this before broadcasting. */
  state(): PiStatus
  /** True from `agent_start` until `agent_settled`; compaction counts as busy. */
  busy(): boolean
  /** True while the context is being rewritten; prompts are refused meanwhile. */
  compacting(): boolean
  /** True while the child process is alive. */
  running(): boolean
  /** Last few KB of the child's stderr, for error reporting. */
  stderrTail(): string

  /** What this engine supports; see {@link EngineCapabilities}. */
  capabilities(): EngineCapabilities
  nativeCommands?(): Promise<EngineCommand[]>
  executeCommand?(name: string, args: string): Promise<{ text?: string }>
  discardSession?(sessionPath: string): Promise<void>
  /** Deliver a scoped background-task notice without pretending it is a user prompt. */
  notify?(text: string, wake: boolean): void
  /** Directories this session works on. */
  workspace(): AgentWorkspace
  /** Start (or restart) the session; resolves once the engine answers `get_state`. */
  start(workspace?: string | AgentWorkspace, options?: EngineStartOptions): Promise<PiStatus>
  /** True while a start is in flight, so a restart never runs over it. */
  starting(): boolean
  stop(): void
  /** Kill without the grace period, for app shutdown. */
  dispose(): void

  /**
   * Run one turn, absorbing the moments where the window and the engine disagree about "busy":
   * waiting out a compaction, retrying, and turning a refusal into a queued follow-up.
   *
   * This is the only send path; callers must not wrap it in a second retry loop.
   */
  prompt(
    message: string,
    options?: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] }
  ): Promise<PromptResult>
  /** Send one message with no queueing or retry logic (used for the `/btw` fork). */
  send(message: string): Promise<void>
  /**
   * Take back a steer this engine is still holding, before it reached the transcript.
   *
   * Optional on purpose: an engine that hands the message straight to its own agent (pi) cannot
   * un-send it, and then the window keeps the message instead of pretending it was retracted.
   */
  cancelSteer?(id: string): { ok: boolean; error?: string }

  // Session and model operations. These are semantic on purpose: the window must not need to know
  // an engine's command names, or a second engine could never be dropped in.
  models(): Promise<Record<string, unknown>[]>
  setModel(provider: string, modelId: string): Promise<PiModel | undefined>
  thinkingLevels(): Promise<string[]>
  setThinkingLevel(level: string): Promise<void>
  stats(): Promise<{
    tokens?: { input?: number; output?: number; total?: number }
    cost?: number
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }
  }>
  messages(): Promise<unknown[]>
  lastAssistantText(): Promise<string | null>
  compact(instructions?: string): Promise<{ summary?: string }>
  setAutoCompaction(options: { enabled: boolean; reserveTokens?: number }): Promise<void>
  newSession(): Promise<{ cancelled?: boolean }>
  switchSession(sessionPath: string): Promise<void>
  /** Fork the current session; resolves to the new session file when the engine reports one. */
  clone(): Promise<string | undefined>
  abort(): Promise<void>

  /**
   * Stop one background command listed in `PiStatus.backgroundTasks`.
   *
   * Optional on purpose: only the Prophey engine owns a task list, so the session panel shows the
   * stop button when this exists and a plain list otherwise.
   */
  stopBackgroundTask?(id: string): Promise<{ ok: boolean; error?: string }>
  readBackgroundTask?(id: string): Promise<{ ok: boolean; text?: string; error?: string }>

  /**
   * Start whatever background polling the engine needs.
   *
   * pi has to poll `get_state` because its event stream is not authoritative about `busy`; an
   * engine that owns its own state has nothing to poll. Called once, after the engine is created.
   */
  poll(): void
  /** Re-read the run state from the engine (authoritative `busy`). */
  refresh(): Promise<void>
  /** Merge a patch into the state the window sees. */
  setStatus(patch: Partial<PiStatus>): void
  /** Resolves true when the current run settles, false on timeout. */
  waitForSettle(timeoutMs: number): Promise<boolean>
  /** Resolves true once the engine reports no run and no compaction. */
  waitForIdle(timeoutMs: number): Promise<boolean>
}
