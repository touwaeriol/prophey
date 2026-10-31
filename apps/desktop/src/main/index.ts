import { copyImageToClipboard } from './image-clipboard'
import { ImportedHistoryStore } from './imported-history-store'
import { writeJsonAtomic } from './storage'
import { listEngineCommands, executeEngineCommand } from './engine-commands'
import { conversationHasStarted } from '../shared/session-policy'
import { recentDirectories } from '../shared/recent-directories'
import { checkWarpgrepEndpoint } from '../shared/warpgrep-endpoint'
import { compactionRatio, compactionPercent, reserveFor, ratioFromPercent, ratioFromTokens } from './compaction-policy'
import { isNativeSessionReference, type EngineId } from '../shared/engine'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeCodeEngine } from './agent/claude-engine'
import { CodexEngine } from './agent/codex-engine'
import { PropheyEngine } from './agent/prophey-engine'
import { readProjectConventions } from './agent/project-conventions'
import { PiEngine } from './agent/pi-engine'
import { idleBeforeSwitch } from './agent/switch-guard'
import { listSessions, readSummary } from './sessions'
import { SessionStore, toSummary, type SessionRecord } from './session-store'
import { generateSessionTitle, promptTitle } from './session-title'
import { generateSuggestion } from './suggest'
import { suggestionContext } from './suggestion-text'
import { TranscriptStore } from './transcript-store'
import { ComposerStore } from './composer-store'
import * as providers from './providers'
import { chatGptUsage, invalidateChatGptUsage } from './chatgpt-usage'
import * as updates from './updates'
import * as mcp from './mcp'
import * as engines from './engines'
import * as gateway from './gateway'
import * as web from './web'
import * as agents from './agents'
import { SubagentManager, type SubagentRecord } from './subagents'
import { createApiHandler } from './api'
import * as bridge from './bridge'
import { applySystemProxy, getProxyInfo } from './proxy'
import * as profile from './profile'
import * as repo from './repo'
import * as projects from './projects'
import { realBashPath, withRealBash } from './shell'
import * as speed from './speed'
import type { AgentEngine, AgentWorkspace } from './agent/engine'
import type {
  AgentMessage,
  AppSettings,
  AskAnswer,
  LoginMessage,
  McpEngineId,
  McpEngineState,
  McpServerInfo,
  McpState,
  McpToolInfo,
  PiModel,
  PiStatus,
  PromptImage,
  PromptResult,
  SessionStats,
  SpeedMode
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
/**
 * The window's view of the run state.
 *
 * The engine owns the state machine; this is the mirror it pushes into, decorated with the app's
 * own facts (compaction percentage, speed tier, repository) by `statusSnapshot()`. Reads here stay
 * cheap, writes must go through `engine.setStatus()`.
 */
let status: PiStatus = { phase: 'stopped', cwd: process.cwd() }
/** An MCP/agent config change arrived mid-run and still has to restart pi. */
let configPending = false
let switchingEngine: EngineId | undefined

/**
 * pi behind the `AgentEngine` contract.
 *
 * Everything that is app policy stays on this side: MCP servers, `/btw` forks, compaction
 * thresholds, speed tiers, config and profiles. The engine only runs turns and owns the run state.
 */
let projectStore: projects.ProjectStore | undefined

/**
 * The app's own session list.
 *
 * pi's JSONL files are the engine's storage; the window reads this store instead, so swapping the
 * engine will not change how sessions are listed, sorted or grouped.
 */
let sessionStore: SessionStore | undefined

/**
 * Crash-safe mirror of the composer drafts.
 *
 * `localStorage` is the renderer's fast path (synchronous on the first paint) but its disk commit is
 * batched by Chromium seconds later, so a crash loses the last few seconds of typing. This store is
 * written with `fs` on every change instead — see `composer-store.ts` for the measurements.
 */
const composerStore = new ComposerStore(path.join(app.getPath('userData'), 'composer'))

/** One-time import of the sessions that predate the store. */
async function importPiSessions(): Promise<void> {
  if (!sessionStore) return
  const existing = sessionStore.list()
  if (existing.length > 0) return
  const summaries = await listSessions(currentSessionDir()).catch(() => [])
  for (const summary of summaries) {
    await sessionStore
      .upsert({
        path: summary.path,
        engine: 'pi',
        cwd: summary.cwd,
        title: summary.title,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt
      })
      .catch(() => undefined)
  }
}

let sessionWrite: Promise<void> = Promise.resolve()
const titleJobs = new Map<string, { title: string; source: 'prompt' | 'generated' }>()

function requestSessionTitle(file: string, prompt: string, model?: PiModel): void {
  if (titleJobs.has(file)) return
  const job = { title: promptTitle(prompt), source: 'prompt' as 'prompt' | 'generated' }
  titleJobs.set(file, job)
  void rememberSession()
  void generateSessionTitle(prompt, model).then(title => {
    job.title = title
    job.source = 'generated'
    const write = sessionWrite.then(async () => {
      const record = sessionStore?.byPath(file)
      if (!record || !sessionStore) return // First transcript write has not completed yet.
      if (await sessionStore.setGeneratedTitle(record.id, title)) {
        mainWindow?.webContents.send('pi:event', { type: 'session_title_updated', sessionKey: toSummary(record).path, title })
        broadcastStatus()
      }
      titleJobs.delete(file)
    })
    sessionWrite = write.catch(() => undefined)
    return write
  }).catch(() => {
    // Keep the first-prompt title. A metadata failure must never stop the main task.
  })
}

// --- input suggestions ----------------------------------------------------------------------
/**
 * One cheap request after a turn settles: "what would this user send next?".
 *
 * Opt-in (`config.suggestions`), because it costs one extra (usually prompt-cached) request per
 * turn. Claude Code does this natively (`promptSuggestions`), so the universal request is skipped
 * there — the CLI's own `prompt_suggestion` arrives as the same event, off its prompt cache.
 *
 * The window shows it as ghost text in an empty composer (Tab inserts it) and as a chip above it;
 * `text: null` means "forget the one you have".
 */
let suggestionTicket = 0
let suggestionAbort: AbortController | undefined
/** Session the pending suggestion belongs to, so a late answer cannot land in another one. */
let suggestionKey: string | undefined
let suggestionText: string | undefined
/** Transcript length the last request was made for: one settle never asks twice. */
let suggestionStamp = -1

function suggestionsEnabled(): boolean {
  return desktopConfig.suggestions === true
}

function sendSuggestion(text: string | null, key: string | undefined = suggestionKey): void {
  mainWindow?.webContents.send('pi:event', { type: 'suggestion', text, sessionKey: key })
}

/** Drop what is pending: a new turn started, the session changed, or the setting was turned off. */
function clearSuggestion(): void {
  suggestionTicket += 1
  suggestionAbort?.abort()
  suggestionAbort = undefined
  suggestionStamp = -1
  const key = suggestionKey
  suggestionKey = undefined
  if (suggestionText === undefined) return
  suggestionText = undefined
  sendSuggestion(null, key)
}

async function suggestNext(engine: AgentEngine, model?: PiModel): Promise<void> {
  // Claude Code has its own predictor; asking twice would pay twice for the same guess.
  if (!suggestionsEnabled() || currentEngineId() === 'claude') return
  // A side chat owns the composer, and an engine switch is about to replace the transcript.
  if (btwActive || switchingEngine) return
  const state = engine.state()
  if (!state.sessionFile || state.isStreaming || state.compacting) return
  let messages: Array<Record<string, unknown>>
  try {
    messages = (await engine.messages()) as Array<Record<string, unknown>>
  } catch {
    return
  }
  // A settle that added nothing (a compaction, a replayed session) has nothing to guess from.
  if (messages.length === suggestionStamp) return
  const turns = suggestionContext(messages)
  if (turns.length < 2) return
  clearSuggestion()
  const ticket = suggestionTicket
  const controller = new AbortController()
  suggestionAbort = controller
  suggestionKey = state.sessionFile
  suggestionStamp = messages.length
  try {
    const text = await generateSuggestion(turns, model, controller.signal)
    if (!text || ticket !== suggestionTicket || controller.signal.aborted) return
    if (text === suggestionText) return
    suggestionText = text
    sendSuggestion(text)
  } catch {
    // A suggestion is a nicety: its failures are never worth a toast or a log line.
  } finally {
    if (suggestionAbort === controller) suggestionAbort = undefined
  }
}

/** Finish earlier observations before committing an engine change to the same session. */
function rememberSession(
  extra: { title?: string } = {}, duringSwitch = false
): Promise<void> {
  const next = sessionWrite.then(() => recordCurrentSession(extra, duringSwitch))
  sessionWrite = next.catch(() => undefined)
  return next
}

async function recordCurrentSession(
  extra: { title?: string } = {}, duringSwitch = false
): Promise<void> {
  if (switchingEngine && !duringSwitch) return
  if (!sessionStore || btwActive) return
  const owner = currentEngine
  const snapshot = { ...status }
  const file = snapshot.sessionFile
  if (!file) return
  // Show a real first turn immediately, even while its atomic transcript write is in flight.
  if (!isNativeSessionReference(file) && !existsSync(file) &&
    (!owner.busy() || !conversationHasStarted(await owner.messages()))) return
  // Native IDs can exist before a durable session is materialized. Do not save an empty ID.
  if (isNativeSessionReference(file) && (await owner.messages()).length === 0) return
  if (owner !== currentEngine || (switchingEngine && !duringSwitch)) return
  const engineId = owner.id as EngineId
  const workspace = owner.workspace()
  const projectId = desktopConfig.activeProject
  if (desktopConfig.engineSessions?.[engineId] !== file)
    await saveConfig({ engineSessions: { ...desktopConfig.engineSessions, [engineId]: file } })
  const known = sessionStore.byPath(file)
  const job = titleJobs.get(file)
  const protectedTitle = known?.titleSource === 'manual' || known?.titleSource === 'generated'
  let title = protectedTitle ? known?.title : job?.title || snapshot.sessionName || extra.title
  if (!title && (!known?.title || known.title === path.basename(file, '.jsonl'))) {
    if (isNativeSessionReference(file)) {
      const messages = await owner.messages().catch(() => [])
      const first = messages.find((m: any) => m?.role === 'user') as
        | { content?: string | Array<{ text?: string }> }
        | undefined
      title = (
        typeof first?.content === 'string'
          ? first.content
          : first?.content?.map((b) => b.text ?? '').join('')
      )
        ?.trim()
        .slice(0, 80)
    } else title = (await readSummary(file).catch(() => null))?.title
  }
  if (owner !== currentEngine || (switchingEngine && !duringSwitch)) return
  const saved = await sessionStore.upsert({
      engine: engineId,
      path: file,
      cwd: snapshot.cwd,
      ...(snapshot.model ? { provider: snapshot.model.provider, model: snapshot.model.id } : {}),
      ...(snapshot.thinkingLevel ? { thinkingLevel: snapshot.thinkingLevel } : {}),
      ...(title ? { title } : {}),
      ...(job && !protectedTitle ? { titleSource: job.source } : {}),
      additional: workspace.additional,
      ...(projectId ? { projectId } : {}),
      // Only real work refreshes the activity timestamp. Recording the session the window just
      // switched to is bookkeeping, not activity: bumping it made the row jump to the top of its
      // directory every time the user looked at it.
      updatedAt: duringSwitch && known ? known.updatedAt : Date.now()
    })
  const activeSession = toSummary(saved).path
  if (desktopConfig.activeSession !== activeSession) await saveConfig({ activeSession })
  if (!known || known.title !== saved.title) mainWindow?.webContents.send('pi:event', { type: 'session_title_updated', sessionKey: activeSession, title: saved.title })
  if (job?.source === 'generated') titleJobs.delete(file)
  broadcastStatus()
}

/** The project the window is working in, when one is selected. */
function activeProject(): projects.Project | undefined {
  const id = desktopConfig.activeProject
  return id ? projectStore?.get(id) : undefined
}

let desktopConfig: DesktopConfig = {}

/** The engine id the window should show as selected. */
function currentEngineId(): 'pi' | 'prophey' | 'claude' | 'codex' {
  const wanted = desktopConfig.engine
  return wanted === 'pi' || wanted === 'claude' || wanted === 'codex' ? wanted : 'prophey'
}

function defaultEngineId(): EngineId {
  const id = desktopConfig.defaultEngine
  return id && ['pi', 'prophey', 'claude', 'codex'].includes(id) ? id : 'prophey'
}

function toSummaryKey(file: string): string {
  const record = sessionStore?.byPath(file)
  return record ? toSummary(record).path : file
}

function sessionIdentity(file: string): string {
  const key = toSummaryKey(file)
  return /^[A-Za-z]:/.test(key) || key.includes('\\') ? key.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() : key
}

/**
 * Where the CLIs live.
 *
 * Their npm shims are `.cmd` files, and spawning those needs a shell — which would put the prompt
 * into a command line. Both packages ship a shell-free entry instead: Claude Code a real `.exe`,
 * Codex a `.js` we run with our own node.
 */
function claudeBinary(): string {
  const packaged = path.join(
    process.env.APPDATA ?? '',
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude'
  )
  return existsSync(packaged) ? packaged : 'claude'
}

function codexLaunch(): { command: string; script?: string } {
  const script = path.join(
    process.env.APPDATA ?? '',
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js'
  )
  return existsSync(script) ? { command: process.execPath, script } : { command: 'codex' }
}

let conversationStarted = false

/**
 * An engine plus the status it reported last.
 *
 * The global `status` only mirrors the engine on screen; a parked engine keeps its own mirror so
 * its sidebar dot and session record stay correct while the window shows another conversation.
 */
interface EngineSlot {
  engine: AgentEngine
  credential: string
  status: PiStatus
  /** Set while the session is off screen and its turn is still running. */
  parked?: { key: string; cwd: string; additional: string[]; projectId?: string }
}

const engineSlots = new WeakMap<AgentEngine, EngineSlot>()
/** Engines still running for sessions the window is not showing, keyed by session key. */
const parkedEngines = new Map<string, EngineSlot>()
const restoringEngines = new Map<string, Promise<AgentEngine>>()

/** Engine factory: Prophey is the default; `pi` stays available as the other engine. */
function createEngine(record?: SessionRecord): AgentEngine {
  if (!record) conversationStarted = false
  const engineId = record?.engine ?? currentEngineId()
  const slot: EngineSlot = {
    engine: undefined as unknown as AgentEngine,
    credential: '',
    status: { phase: 'stopped', cwd: status.cwd }
  }
  const isActive = (): boolean => slot.engine === currentEngine
  slot.credential = bridge.registerClient(() => ({
    sessionKey: slot.engine.state().sessionFile,
    engine: slot.engine.id as EngineId,
    workspace: slot.engine.workspace(),
    model: slot.engine.state().model
  }))
  const shared = {
    ask: (questions: Parameters<typeof bridge.askEngine>[0], tool: string) =>
      bridge.askEngine(questions, tool, slot.engine.state().sessionFile),
    onStatus: (next: PiStatus) => {
      const previous = slot.status
      slot.status = next
      if (!isActive()) {
        // Off screen: only the sidebar dot and the saved session record still matter.
        if (slot.parked) {
          if (next.sessionFile && next.sessionFile !== previous.sessionFile) void rememberParkedSession(slot)
          else if (next.sessionName && next.sessionName !== previous.sessionName) void rememberParkedSession(slot)
          if (!next.isStreaming && !next.compacting) setTimeout(() => reapParked(slot), 300)
          broadcastStatus()
        }
        return
      }
      status = next
      if (currentEngine) broadcastStatus()
      if (next.sessionFile && next.sessionFile !== previous.sessionFile) {
        clearSuggestion()
        void rememberSession()
      }
      else if (next.sessionName && next.sessionName !== previous.sessionName) void rememberSession()
    },
    onEvent: (record: Record<string, unknown>) => {
      // A parked run keeps working; its transcript is on disk and comes back when the session does.
      if (!isActive()) return
      // A new turn makes the last guess irrelevant (and pays for a fresh one when it settles).
      if (record.type === 'agent_start') clearSuggestion()
      if (!conversationStarted && !btwActive && record.message && conversationHasStarted([record.message])) {
        conversationStarted = true
        broadcastStatus()
      }
      // While the /btw panel is open the window must not see the fork's transcript.
      if (btwActive || switchingEngine) return
      mainWindow?.webContents.send('pi:event', { ...record, sessionKey: slot.engine.state().sessionFile })
    },
    onSettled: () => {
      if (!isActive()) {
        if (!slot.parked) return
        void rememberParkedSession(slot)
        // Idle off screen: the next open restarts from the transcript, so stop paying for a
        // process (and pick up config changes on the way in).
        setTimeout(() => reapParked(slot), 300)
        return
      }
      void rememberSession()
      // After the run has settled, not during it: the guess costs one short request.
      void suggestNext(slot.engine, slot.status.model)
      if (!configPending || switchingEngine) return
      configPending = false
      void startPi(status.cwd, sessionArgs())
    },
    onAssistantError: (message: string) => {
      if (isActive() && !switchingEngine) noteSpeedRejection(message)
    },
    onExit: () => {
      if (isActive()) handleExit()
      else if (slot.parked) {
        parkedEngines.delete(slot.parked.key)
        slot.parked = undefined
        broadcastStatus()
      }
    }
  }
  let engine: AgentEngine
  if (engineId === 'claude') {
    engine = new ClaudeCodeEngine({
      ...shared,
      binary: claudeBinary(),
      // Claude Code has its own next-message predictor; the app skips its own request for it.
      suggestions: () => suggestionsEnabled(),
      historyStore: new ImportedHistoryStore(path.join(app.getPath('userData'), 'imports', 'claude'))
    })
  } else if (engineId === 'codex') {
    const { command, script } = codexLaunch()
    engine = new CodexEngine({
      ...shared,
      binary: command,
      historyStore: new ImportedHistoryStore(path.join(app.getPath('userData'), 'imports', 'codex')),
      script,
      sandbox: () => desktopConfig.codexSandbox,
      questions: () => desktopConfig.codexRequestUserInput !== false
    })
  } else if (engineId !== 'pi') {
    engine = new PropheyEngine({
      ...shared,
      toolModulePath: coreToolsModule(),
      shellPath: realBashPath(),
      bashLogDirectory: path.join(app.getPath('userData'), 'command-logs'),
      transcripts: new TranscriptStore(path.join(app.getPath('userData'), 'transcripts')),
      sessionId: () => record ? path.basename(record.path, '.jsonl') : desktopConfig.propheySessionId,
      // The app owns the id, so it is saved before the engine starts writing the new transcript.
      newSessionId: async () => {
        const id = `s_${Math.random().toString(16).slice(2, 14)}`
        if (isActive()) await saveConfig({ propheySessionId: id })
        return id
      },
      // The same setting the window's threshold dropdown writes.
      autoCompact: () => ({
        enabled: autoCompactEnabled,
        percent: compactionPercent(autoCompactRatio())
      }),
      // Subagent tools reach the app's manager through the same bridge pi uses.
      bridge: () => {
        const port = desktopConfig.mcp?.bridgePort
        const token = slot.credential
        return port && token ? { url: `http://127.0.0.1:${port}`, token } : undefined
      },
      subagentModulePath: subagentConfig().enabled ? coreToolModule('subagent.mjs') : undefined,
      // The same preset list pi receives through `AGENT_DESKTOP_AGENTS_SECTION`; the engine only
      // injects it while `start_subagent` is actually declared.
      agentsSection: () =>
        subagentConfig().enabled ? agents.renderAgentsSection(agentSettings) : undefined,
      askModulePath: coreToolModule('ask-user.mjs'),
      mcpEndpoints: (workspace) => mcpEndpointsFor(workspace, slot.credential),
      speedMode: () => currentSpeedMode(),
      // Same cache the pi extension fills: the settings list and the connectors card read it.
      onTools: (servers) => {
        const next: ToolCache = { ...toolCache }
        let changed = false
        for (const [server, tools] of Object.entries(servers)) {
          const payload = JSON.stringify(tools)
          if (JSON.stringify(next[server] ?? []) === payload) continue
          next[server] = tools.map((tool) => ({ ...tool, enabled: true }))
          changed = true
        }
        if (!changed) return
        void saveToolCache(next).then(() => broadcastMcpState())
      }
    })
  } else {
    engine = new PiEngine({
      ...shared,
      prepare: async (workspace) => {
        await applySystemProxy()
        const ownerFile = slot.engine.state().sessionFile
        if (ownerFile) cancelPendingAsks('pi 已重启', ownerFile)
        const launch = await mcpLaunch(workspace, slot.credential)
        // Keep the child process and SDK on the same configuration directory.
        const env = withRealBash({ ...launch.env })
        // Read by the extension's request hooks; it re-checks the model before touching the payload.
        env.AGENT_DESKTOP_SPEED = speed.resolveSpeedMode(slot.status.model, currentSpeedMode())
        // The root-aware bash tool runs in the core server, which has no idea where Git Bash lives.
        const bash = realBashPath()
        if (bash) env.AGENT_DESKTOP_SHELL = bash
        // Root-aware file tools need the same list the model is told about, so both come from here.
        if (workspace.additional.length > 0) {
          env.AGENT_DESKTOP_ROOTS = JSON.stringify([
            { name: path.basename(workspace.primary), path: workspace.primary, primary: true },
            ...workspace.additional.map((root) => ({ name: path.basename(root), path: root }))
          ])
        }
        // Several directories need to be explained to the model; one directory is just a normal session
        // and gets no section.
        const project = record ? projectStore?.get(record.projectId ?? '') : activeProject()
        if (project && workspace.additional.length > 0) {
          env.AGENT_DESKTOP_PROJECT = JSON.stringify({
            id: project.id,
            name: project.name,
            roots: [
              { path: workspace.primary, name: path.basename(workspace.primary), primary: true },
              ...workspace.additional.map((root) => ({ path: root, name: path.basename(root) }))
            ]
          })
        }
        env.PI_CODING_AGENT_DIR = profile.agentDir()
        // Rules the repository wrote for other agents (GEMINI.md, .cursorrules, copilot-instructions…);
        // pi only loads AGENTS.md / CLAUDE.md, so the extension injects these as their own section.
        const conventions = readProjectConventions(workspace.primary).text
        if (conventions) env.AGENT_DESKTOP_CONVENTIONS = conventions
        return { args: launch.args, env }
      },
      sessionArgs: () => record ? ['--session', record.path] : sessionArgs(),
      sessionDirArgs: () => record ? ['--session-dir', path.dirname(record.path)] : sessionDirArgs()
    })
  }
  slot.engine = engine
  const dispose = engine.dispose.bind(engine)
  engine.dispose = () => {
    const file = engine.state().sessionFile
    if (file) bridge.cancelAllAsks('会话引擎已关闭', file)
    dispose()
    bridge.removeClient(slot.credential)
    gateway.releaseScope(slot.credential)
  }
  engineSlots.set(engine, slot)
  return engine
}

/** Stop paying for an off-screen engine once its turn is over; false when it must stay alive. */
function reapParked(slot: EngineSlot): boolean {
  if (!slot.parked) return true
  if (restoringEngines.has(sessionIdentity(slot.parked.key))) return false
  if (slot.engine.busy() || slot.engine.compacting() || slot.engine.starting()) return false
  // Background commands belong to the session: keep the engine until they finish.
  if ((slot.engine.state().backgroundTasks?.length ?? 0) > 0) return false
  // A running subagent still has to wake its parent; without the engine the notice would wait.
  const key = slot.parked.key
  const waiting = (subagents?.list() ?? []).some((record) =>
    record.parentSession && toSummaryKey(record.parentSession) === key &&
    (record.status === 'starting' || record.status === 'streaming'))
  if (waiting) return false
  parkedEngines.delete(key)
  slot.parked = undefined
  slot.engine.dispose()
  broadcastStatus()
  return true
}

/** Keep a running engine alive under its session key instead of disposing it. */
function parkEngine(engine: AgentEngine, file: string): void {
  const slot = engineSlots.get(engine)
  if (!slot) return
  const key = toSummaryKey(file)
  const existing = parkedEngines.get(key)
  if (existing && existing !== slot) {
    // Defensive: never leave two engines writing the same transcript.
    existing.parked = undefined
    existing.engine.dispose()
  }
  slot.parked = {
    key,
    cwd: status.cwd,
    additional: currentWorkspace().additional,
    projectId: desktopConfig.activeProject
  }
  parkedEngines.set(key, slot)
  broadcastStatus()
}

/**
 * Take the active engine off screen: a running turn is parked, an idle one is simply disposed.
 * A run that has no durable session yet cannot be reopened later, so it is stopped instead.
 */
async function retireEngine(engine: AgentEngine): Promise<EngineSlot | undefined> {
  const file = engine.state().sessionFile
  const busy = engine.busy() || engine.compacting() || Boolean(engine.state().backgroundTasks?.length) ||
    (subagents?.list() ?? []).some(record => record.parentSession === file &&
      (record.status === 'starting' || record.status === 'streaming'))
  if (busy && file) {
    parkEngine(engine, file)
    return engineSlots.get(engine)
  }
  if (busy) {
    const restore = switchingEngine
    switchingEngine = currentEngineId()
    broadcastStatus()
    try {
      cancelPendingAsks('会话已切换')
      await idleBeforeSwitch(engine, true)
    } finally {
      switchingEngine = restore
    }
  }
  engine.dispose()
  return undefined
}

/** Bring a parked engine back on screen without restarting it. */
function activateParked(slot: EngineSlot): void {
  const parked = slot.parked
  if (!parked) return
  parkedEngines.delete(parked.key)
  slot.parked = undefined
  currentEngine = slot.engine
  status = slot.status
  conversationStarted = true
  void refreshRepo(status.cwd)
  broadcastStatus()
  void slot.engine
    .messages()
    .then((messages) => {
      if (currentEngine !== slot.engine) return
      conversationStarted = conversationHasStarted(messages)
      broadcastStatus()
    })
    .catch(() => undefined)
}

/** Save an off-screen run without touching the active session's config pointers. */
async function rememberParkedSession(slot: EngineSlot): Promise<void> {
  const parked = slot.parked
  if (!parked || !sessionStore) return
  const file = slot.status.sessionFile
  if (!file) return
  if (!isNativeSessionReference(file) && !existsSync(file)) return
  if (isNativeSessionReference(file) && (await slot.engine.messages().catch(() => [])).length === 0) return
  const known = sessionStore.byPath(file)
  const job = titleJobs.get(file)
  const protectedTitle = known?.titleSource === 'manual' || known?.titleSource === 'generated'
  let title = protectedTitle ? known?.title : job?.title || slot.status.sessionName
  if (!title && (!known?.title || known.title === path.basename(file, '.jsonl'))) {
    title = isNativeSessionReference(file)
      ? undefined
      : (await readSummary(file).catch(() => null))?.title
  }
  const saved = await sessionStore.upsert({
    engine: slot.engine.id as EngineId,
    path: file,
    cwd: parked.cwd,
    ...(slot.status.model ? { provider: slot.status.model.provider, model: slot.status.model.id } : {}),
    ...(slot.status.thinkingLevel ? { thinkingLevel: slot.status.thinkingLevel } : {}),
    ...(title ? { title } : {}),
    ...(job && !protectedTitle ? { titleSource: job.source } : {}),
    additional: parked.additional,
    ...(parked.projectId ? { projectId: parked.projectId } : {}),
    updatedAt: Date.now()
  })
  if (!known || known.title !== saved.title) {
    mainWindow?.webContents.send('pi:event', {
      type: 'session_title_updated',
      sessionKey: toSummary(saved).path,
      title: saved.title
    })
  }
  mainWindow?.webContents.send('pi:event', { type: 'session_updated', sessionKey: toSummary(saved).path })
}

/** Created in `whenReady`, once `config.engine` is known; replaced when the engine changes. */
let currentEngine: AgentEngine

if (process.env.PI_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PI_DEBUG_PORT)
}

app.setName('agent-desktop')

async function migrateLegacyUserData(): Promise<void> {
  const legacy = path.join(app.getPath('appData'), '@pi-mcps', 'desktop')
  const current = app.getPath('userData')
  if (legacy === current) return
  for (const name of ['config.json', 'device-id', 'updates.json']) {
    const from = path.join(legacy, name)
    const to = path.join(current, name)
    try {
      if (!existsSync(to) && existsSync(from)) {
        await fs.mkdir(current, { recursive: true })
        await fs.copyFile(from, to)
      }
    } catch {
      // ignore migration failures
    }
  }
}

interface McpEngineConfig {
  enabled?: boolean
  entry?: string
}

interface SubagentConfig {
  enabled?: boolean
  maxConcurrent?: number
  /** Let subagents use the desktop engines (codegraph / warpgrep). */
  desktopTools?: boolean
  defaultMode?: 'sync' | 'background'
}

interface McpConfig {
  enabled?: boolean
  desktopTool?: boolean
  bridgePort?: number
  bridgeToken?: string
  engines?: Partial<Record<McpEngineId, McpEngineConfig>>
  /** Morph API key for WarpGrep. */
  morphApiKey?: string
  /**
   * WarpGrep backend override: an OpenAI-compatible endpoint with tool calling (DeepSeek, OpenAI,
   * a local vLLM). Empty means the hosted Morph model. The key falls back to `morphApiKey`.
   */
  warpgrep?: { baseUrl?: string; model?: string; apiKey?: string }
  /** Web search / fetch: Brave key, per-provider native search, budgets. */
  web?: web.WebConfig
  /** server -> tool -> enabled. A tool set to false is registered as `hidden`. */
  toolToggles?: Record<string, Record<string, boolean>>
  subagents?: SubagentConfig
}

interface DesktopConfig {
  cwd?: string
  /** Sessions always live in pi's own storage; an old `isolated` value is simply ignored. */
  sessionMode?: 'shared' | 'isolated'
  mcp?: McpConfig
  /** Auto-compaction policy; `ratio` is the fraction of the window that triggers it. */
  autoCompact?: { ratio?: number; enabled?: boolean }
  /** Processing tier sent with each request; only applied when the active model offers it. */
  speed?: { mode?: SpeedMode }
  /** Project the window is working in; sessions still start on its primary repository. */
  activeProject?: string
  /**
   * Which engine runs the turn: `prophey` (ours, default), `pi`, `claude` (Claude Code CLI) or
   * `codex` (Codex CLI).
   */
  engine?: 'pi' | 'prophey' | 'claude' | 'codex'
  /** Only used when creating a conversation; changing another session never changes it. */
  defaultEngine?: EngineId
  /** Stable key of the last open conversation. */
  activeSession?: string
  /** Current Prophey-engine session id; rotates when a new session starts. */
  propheySessionId?: string
  engineSessions?: Partial<Record<EngineId, string>>
  /** Recover the source if the process exits before a context transfer commits. */
  pendingEngineSwitch?: { engine: EngineId; cwd: string; session?: string;
    propheySessionId?: string; activeProject?: string; record?: SessionRecord }
  codexSandbox?: 'read-only' | 'workspace-write'
  /** Codex's experimental `request_user_input` tool, so the model can ask instead of guessing. */
  codexRequestUserInput?: boolean
  /** Predict the user's next message after a turn settles (default off; costs one small request). */
  suggestions?: boolean
  /** Repositories the user worked in, most recent first (sidebar "切换仓库" menu). */
  recentRepos?: string[]
  /** Per-repository defaults applied to a new session in that repository. */
  repoDefaults?: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

async function loadConfig(): Promise<DesktopConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as DesktopConfig
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function saveConfig(patch: Partial<DesktopConfig>): Promise<void> {
  desktopConfig = { ...desktopConfig, ...patch }
  await writeJsonAtomic(configPath(), desktopConfig)
}

/** All provider and MCP configuration follows the same directory as pi. */
function applyProfile(): void {
  profile.setAgentDir(profile.CLI_AGENT_DIR)
  providers.invalidateCache()
}

function autoCompactRatio(): number {
  return compactionRatio(desktopConfig.autoCompact?.ratio)
}

/**
 * Keep pi's compaction reserve in step with the active model's window.
 *
 * pi reads `reserveTokens` from settings.json at startup, so a changed window only takes effect
 * after a restart (`reloadPiConfig`, which defers while a run is in flight). Returns the reserve it
 * settled on, or undefined when auto-compaction is off or the model has no window.
 */
async function syncAutoCompact(options: { restart?: boolean } = {}): Promise<number | undefined> {
  const owner = currentEngine
  const model = status.model
  if (owner.id !== 'pi') return undefined
  const settings = await providers.getAppSettings().catch(() => undefined)
  if (owner !== currentEngine || model !== status.model) return undefined
  if (!settings?.compaction?.enabled || !model?.contextWindow) return undefined
  const reserve = reserveFor(model.contextWindow, autoCompactRatio())
  if (settings.compaction.reserveTokens === reserve) return reserve
  await providers.setCompactionSettings({ enabled: true, reserveTokens: reserve })
  if (owner !== currentEngine || model !== status.model) return undefined
  if (options.restart) await reloadPiConfig()
  return reserve
}

/** Default session directory follows the common configuration directory. */
function sharedSessionDir(): string {
  return profile.profileSessionDir()
}

/**
 * Sessions always live in pi's own storage (`<agent dir>/sessions`), so the desktop and the pi
 * CLI/TUI share one set of JSONL files and there is no second place a conversation could hide.
 */
function currentSessionDir(): string {
  const base = sharedSessionDir()
  // A project keeps its conversations together: new sessions land under its own directory, while
  // the list still walks the whole tree so sessions from before the project stay visible.
  const project = activeProject()
  return project ? path.join(base, 'projects', project.id) : base
}

function sessionDirArgs(): string[] {
  // Explicit so `PI_CODING_AGENT_DIR` overrides (tests, portable profiles) land in the same tree.
  return ['--session-dir', currentSessionDir()]
}

function mcpSettings(): { enabled: boolean; desktopTool: boolean } {
  const config = desktopConfig.mcp ?? {}
  return { enabled: config.enabled !== false, desktopTool: config.desktopTool !== false }
}

function engineConfig(): Partial<Record<McpEngineId, McpEngineConfig>> {
  return desktopConfig.mcp?.engines ?? {}
}

/** Web config with the defaults applied, in the shape `web.ts` expects. */
function webConfig(): web.WebConfig {
  const config = desktopConfig.mcp?.web ?? {}
  return {
    mode: config.mode === 'brave' || config.mode === 'native' ? config.mode : 'auto',
    braveApiKey: config.braveApiKey?.trim() || undefined,
    native: config.native ?? {},
    count: config.count,
    maxChars: config.maxChars
  }
}

function saveWebConfig(patch: Partial<web.WebConfig>): Promise<void> {
  return saveConfig({
    mcp: { ...desktopConfig.mcp, web: { ...(desktopConfig.mcp?.web ?? {}), ...patch } }
  })
}

/** Web tools need at least one backend, otherwise the endpoint stays unregistered. */
function webReady(): boolean {
  const config = webConfig()
  return Boolean(config.braveApiKey) || web.nativeProviderEnabled(config).length > 0
}

/** Which backend the next `web_search` would use, for the settings panel. */
function webRouteLabel(config: web.WebConfig): string {
  const route = web.describeRoute(status.model?.provider, config)
  if (route.backend === 'native') return `${route.provider} 原生搜索`
  // `mode: native` refuses to fall back, so say so instead of pretending Brave will answer.
  if (config.mode === 'native') return `不可用（${route.reason ?? '当前服务商没有原生搜索'}）`
  if (config.mode === 'brave')
    return config.braveApiKey ? 'Brave Search API' : 'Brave（未配置 Key）'
  if (route.reason) return `Brave（${route.reason}）`
  return config.braveApiKey ? 'Brave Search API' : 'Brave（未配置 Key）'
}

function toolToggles(): Record<string, Record<string, boolean>> {
  return desktopConfig.mcp?.toolToggles ?? {}
}

function subagentConfig(): Required<SubagentConfig> {
  const config = desktopConfig.mcp?.subagents ?? {}
  return {
    enabled: config.enabled !== false,
    maxConcurrent: config.maxConcurrent ?? 4,
    desktopTools: config.desktopTools === true,
    defaultMode: config.defaultMode ?? 'background'
  }
}

function resourceDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
}

function searchUp(start: string, relative: string, depth = 6): string | undefined {
  let dir = start
  for (let index = 0; index < depth; index += 1) {
    const candidate = path.join(dir, relative)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function desktopExtensionPath(name = 'desktop-mcp.js'): string {
  if (app.isPackaged) return path.join(resourceDir(), 'extension', name)
  return (
    searchUp(app.getAppPath(), path.join('resources', 'extension', name)) ??
    searchUp(
      app.getAppPath(),
      path.join('apps', 'desktop', 'resources', 'extension', name)
    ) ??
    path.join(resourceDir(), 'extension', name)
  )
}

function mcpServerScript(): string {
  if (app.isPackaged) return path.join(resourceDir(), 'mcp', 'server.mjs')
  return (
    searchUp(app.getAppPath(), path.join('packages', 'mcp-core', 'server.mjs')) ??
    path.join(app.getAppPath(), '..', '..', 'packages', 'mcp-core', 'server.mjs')
  )
}

/** A tool module the Prophey engine loads: the same files pi's MCP server serves. */
function coreToolModule(name: string): string | undefined {
  const script = mcpServerScript()
  const candidate = path.join(path.dirname(script), 'tools', name)
  return existsSync(candidate) ? candidate : undefined
}

function coreToolsModule(): string | undefined {
  return coreToolModule('workspace.mjs')
}

/**
 * Configure the MCP gateways for a workspace and describe their endpoints.
 *
 * pi reaches them through its own MCP client; the Prophey engine calls the same endpoints itself,
 * so both engines end up with the same servers for the same project.
 *
 * The CLI engines (Claude Code, Codex) are not given these on purpose: they ship their own web
 * search and their own tool set, and injecting ours would only compete with them.
 */
async function mcpEndpointsFor(
  workspace: AgentWorkspace, credential?: string
): Promise<Array<{ name: string; url: string; token: string; description?: string }>> {
  if (!mcpSettings().enabled) return []
  const port = desktopConfig.mcp?.bridgePort
  const token = credential ?? desktopConfig.mcp?.bridgeToken
  if (!port || !token) return []
  const roots = [
    {
      path: workspace.primary,
      name: path.basename(workspace.primary) || workspace.primary,
      primary: true
    },
    ...workspace.additional.map((root) => ({ path: root, name: path.basename(root) || root }))
  ]
  const targets = await engines.buildEngineTargets({
    roots,
    config: engineConfig(),
    morphApiKey: desktopConfig.mcp?.morphApiKey,
    warpgrep: await warpgrepBackend(),
    webAvailable: webReady()
  })
  // The endpoints must exist before anything connects to them.
  gateway.configure(targets, credential)
  return engines
    .buildEngineRegistrations({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      targets,
      toggles: toolToggles()
    })
    .map((registration) => ({
      name: registration.name,
      url: registration.url,
      token,
      description: registration.description
    }))
}

function desktopToolAvailable(): boolean {
  return existsSync(desktopExtensionPath()) && existsSync(mcpServerScript())
}

let agentSettings: agents.AgentSettings = { exposure: 'prompt', promptLimit: 8, presets: [] }
let subagents: SubagentManager | null = null
const pendingSubagentNotices: SubagentRecord[] = []
let flushingSubagentNotices = false
/** Last time the user stopped a run, used to keep subagent notices from restarting it. */
let lastAbortAt = 0

async function refreshAgents(): Promise<void> {
  agentSettings = await agents.loadAgents(app.getPath('userData'))
}

function subagentManager(): SubagentManager {
  if (!subagents) {
    subagents = new SubagentManager({
      userData: app.getPath('userData'),
      piExtensions: () => [desktopExtensionPath('model-context.ts')].filter(existsSync),
      createOwnEngine: ({ id, tools, appendSystemPrompt, onEvent, onStatus }) => new PropheyEngine({
        onStatus: onStatus ?? (() => {}), onEvent, onSettled: () => {},
        toolModulePath: coreToolsModule(), shellPath: realBashPath(), allowedTools: tools,
        bashLogDirectory: path.join(app.getPath('userData'), 'command-logs'),
        appendSystemPrompt: '你是独立子代理。只完成分配的任务，返回简短结论和必要的文件位置。\n' + (appendSystemPrompt ?? ''),
        transcripts: new TranscriptStore(path.join(app.getPath('userData'), 'subagents-prophey')),
        sessionId: () => id,
        autoCompact: () => ({ enabled: autoCompactEnabled, percent: compactionPercent(autoCompactRatio()) }),
        speedMode: () => currentSpeedMode()
      }),
      onUpdate: (record) => {
        mainWindow?.webContents.send('subagents:update', serializeSubagent(record))
        broadcastStatus()
      },
      onSettle: (record) => {
        if (record.parentSession) pendingSubagentNotices.push({ ...record })
        flushSubagentNotices()
      }
    })
    subagents.setMaxConcurrent(subagentConfig().maxConcurrent)
  }
  return subagents
}

/** The live engine that owns a session, on screen or parked. */
function engineForSession(file: string): AgentEngine | undefined {
  const key = sessionIdentity(file)
  if (currentEngine.state().sessionFile && sessionIdentity(currentEngine.state().sessionFile!) === key) return currentEngine
  return [...parkedEngines.values()].find(slot => sessionIdentity(slot.parked?.key ?? '') === key)?.engine
}

/** A late send goes to its owner, including a session whose idle engine was already released. */
async function promptEngineForSession(key?: string): Promise<AgentEngine> {
  // Navigation owns the engine lifecycle until it has parked the source and installed the target.
  while (switchingEngine || currentEngine.starting()) await new Promise(resolve => setTimeout(resolve, 25))
  if (!key) return currentEngine
  const identity = sessionIdentity(key)
  const pending = restoringEngines.get(identity)
  if (pending) return pending
  const existing = engineForSession(key)
  if (existing?.running()) return existing
  const record = sessionStore?.list().find(item => sessionIdentity(item.path) === identity)
  if (!record) throw new Error('原会话不存在，消息已保留在原会话草稿中')
  const restore = (async () => {
    const engine = createEngine(record)
    const slot = engineSlots.get(engine)!
    slot.parked = { key: toSummaryKey(record.path), cwd: record.cwd, additional: record.additional ?? [], projectId: record.projectId }
    parkedEngines.set(slot.parked.key, slot)
    try {
      await engine.start({ primary: record.cwd, additional: record.additional ?? [] }, {
        session: record.path,
        ...(record.provider && record.model ? { model: { provider: record.provider, id: record.model } } : {})
      })
      if (!engine.running() || engine.state().phase !== 'ready') throw new Error(engine.state().error ?? '原会话启动失败')
      if (record.thinkingLevel) await engine.setThinkingLevel(record.thinkingLevel).catch(() => undefined)
      engine.poll()
      return engine
    } catch (error) {
      parkedEngines.delete(toSummaryKey(record.path))
      slot.parked = undefined
      engine.dispose()
      throw error
    }
  })()
  restoringEngines.set(identity, restore)
  try { return await restore } finally { restoringEngines.delete(identity) }
}

function flushSubagentNotices(): void {
  if (flushingSubagentNotices) return
  if (!currentEngine || switchingEngine || btwActive) return
  flushingSubagentNotices = true
  try {
    for (let i = pendingSubagentNotices.length - 1; i >= 0; i--) {
      const record = pendingSubagentNotices[i]
      if (!record.parentSession) continue
      const owner = engineForSession(record.parentSession)
      if (!owner || !owner.running()) continue
      if (owner.id !== 'prophey' && owner.id !== 'pi') continue
      pendingSubagentNotices.splice(i, 1)
      const text = subagentNotice(record)
      // A parked parent is never the session the user just stopped, so it may wake freely.
      const wake = record.notify === 'wake' &&
        (owner !== currentEngine || Date.now() - lastAbortAt > 30_000)
      if (owner.notify) owner.notify(text, wake)
      else bridge.publishEvent({ type: 'subagent_settled', text, wake, session: record.parentSession })
    }
  } finally { flushingSubagentNotices = false }
}

/** Three lines at most: the parent reads this inside its own transcript. */
function subagentNotice(record: SubagentRecord): string {
  const changed = new Set(
    record.calls
      .filter(
        (call) =>
          ['edit', 'write', 'apply_patch', 'edit_file', 'write_file'].includes(call.tool) &&
          typeof call.summary === 'string' &&
          call.summary
      )
      .map((call) => call.summary as string)
  )
  const head = [
    `子代理 ${record.id}`,
    record.agent ? `· ${record.agent}` : '',
    `· ${record.status}`,
    record.runtimeMs ? `· ${formatSpan(record.runtimeMs)}` : '',
    record.tokens ? `· ${formatTokens(record.tokens)}` : '',
    changed.size > 0 ? `· 改动 ${changed.size} 个文件` : ''
  ]
    .filter(Boolean)
    .join(' ')
  const conclusion = record.error
    ? `错误：${record.error.slice(0, 240)}`
    : (record.finalText ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) || '（没有结论）'
  return [
    head,
    `结论：${conclusion}`,
    `详情调用子代理结果查询工具 get_subagent（id ${record.id}），无需轮询。`
  ].join('\n')
}

function formatSpan(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k tokens` : `${count} tokens`
}

/** Wire shape of a subagent: no rpc handle, timestamps kept as numbers. */
function serializeSubagent(record: SubagentRecord): Record<string, unknown> {
  return {
    id: record.id,
    engine: record.engine ?? 'pi',
    label: record.label,
    agent: record.agent,
    mode: record.mode,
    cwd: record.cwd,
    status: record.status,
    model: record.model,
    tools: record.tools,
    messages: record.messages,
    calls: record.calls,
    draft: record.draft,
    activeCalls: record.activeCalls,
    finalText: record.finalText,
    tokens: record.tokens,
    contextUsage: record.contextUsage,
    runtimeMs: record.runtimeMs,
    createdAt: record.createdAt,
    notify: record.notify,
    sessionFile: record.sessionFile,
    parentSession: record.parentSession,
    restored: record.restored === true,
    error: record.error
  }
}

/** Any built-in server active, which is when the extension has to be loaded. */
/**
 * `--extension` for the desktop extension file, or nothing when it is missing.
 *
 * The extension is not only MCP: it also patches provider requests for the speed tier, which has to
 * keep working when the user turns the built-in servers off.
 */
function extensionArgs(): string[] {
  // Catalog corrections are independent of MCP and apply inside pi, not just its UI.
  return ['model-context.ts', 'desktop-mcp.js'].flatMap((name) => {
    const file = desktopExtensionPath(name)
    return existsSync(file) ? ['--extension', file] : []
  })
}

async function mcpLaunch(
  workspace: AgentWorkspace, credential?: string
): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const settings = mcpSettings()
  if (!settings.enabled) {
    gateway.configure([], credential)
    return { args: ['--no-mcp', ...extensionArgs()], env: {} }
  }
  if (!desktopToolAvailable()) return { args: extensionArgs(), env: {} }
  // Several directories mean code search has to run per directory, so each root gets its own
  // endpoint (capped by the engine module).
  const roots = [
    {
      path: workspace.primary,
      name: path.basename(workspace.primary) || workspace.primary,
      primary: true
    },
    ...workspace.additional.map((root) => ({ path: root, name: path.basename(root) || root }))
  ]
  const targets = await engines.buildEngineTargets({
    roots,
    config: engineConfig(),
    morphApiKey: desktopConfig.mcp?.morphApiKey,
    warpgrep: await warpgrepBackend(),
    webAvailable: webReady()
  })
  // The endpoints must exist before pi connects to them.
  gateway.configure(targets, credential)
  const core = settings.desktopTool
  if (!core && targets.length === 0) return { args: extensionArgs(), env: {} }
  const url = bridge.getBridgeUrl()
  const env: NodeJS.ProcessEnv = { AGENT_DESKTOP_MCP_TOGGLES: JSON.stringify(toolToggles()) }
  if (url) {
    env.AGENT_DESKTOP_MCP_URL = url
    env.AGENT_DESKTOP_MCP_TOKEN = credential ?? bridge.getBridgeToken()
  }
  if (core) {
    env.AGENT_DESKTOP_MCP_CORE_SCRIPT = mcpServerScript()
    // The core server only lists the subagent tools when they are enabled.
    env.AGENT_DESKTOP_SUBAGENTS = subagentConfig().enabled ? '1' : '0'
    const section = agents.renderAgentsSection(agentSettings)
    if (section && subagentConfig().enabled) env.AGENT_DESKTOP_AGENTS_SECTION = section
  }
  if (targets.length > 0 && url) {
    env.AGENT_DESKTOP_MCP_ENGINES = JSON.stringify(
      engines.buildEngineRegistrations({
        baseUrl: url,
        token: credential ?? bridge.getBridgeToken(),
        targets,
        toggles: toolToggles()
      })
    )
  }
  return { args: extensionArgs(), env }
}

/**
 * Tools each built-in server last offered, reported by the extension once its servers connect
 * (`POST /tools` on the bridge). Cached so the settings list survives restarts.
 */
type ToolCache = Record<string, McpToolInfo[]>

function toolCachePath(): string {
  return path.join(app.getPath('userData'), 'mcp-tools.json')
}

let toolCache: ToolCache = {}

async function loadToolCache(): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.readFile(toolCachePath(), 'utf8')) as ToolCache
    toolCache = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    toolCache = {}
  }
}

async function saveToolCache(next: ToolCache): Promise<void> {
  toolCache = next
  try {
    await writeJsonAtomic(toolCachePath(), next)
  } catch {
    // cache only
  }
}

const engineIndexStatus: Record<string, { state: McpEngineState['index']; message?: string }> = {}

/** Roots already indexed by this process, so a project switch does not re-index from scratch. */
const indexedRoots = new Set<string>()

function startCodegraphIndex(cwd: string): void {
  const config = engineConfig().codegraph
  if (config?.enabled === false) return
  const key = path.resolve(cwd)
  if (indexedRoots.has(key)) return
  indexedRoots.add(key)
  void engines
    .engineEntry('codegraph', config?.entry?.trim() || undefined)
    .then((entry) => {
      if (!entry) {
        indexedRoots.delete(key)
        return
      }
      engines.ensureCodegraphIndex(cwd, entry, (indexState) => {
        engineIndexStatus.codegraph = indexState
        void broadcastMcpState()
      })
    })
    .catch(() => {
      indexedRoots.delete(key)
    })
}

/** Files under the session directory, for the composer's `@` context picker. */
const WORKSPACE_SKIP = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'release',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.codegraph',
  '.serena',
  'coverage',
  '.venv',
  'venv',
  '__pycache__'
])
const WORKSPACE_MAX_FILES = 4000

/**
 * Files for the composer's `@` picker, across the whole project.
 *
 * The primary root keeps relative paths (that is how the model resolves them from its working
 * directory); every other repository is listed with absolute paths, which `read`/`edit` accept, so
 * a mention still works without pretending the other repo is a subdirectory.
 */
async function listWorkspaceFiles(roots: string[]): Promise<string[]> {
  const all = roots.length > 0 ? roots : [status.cwd]
  const primary = path.resolve(status.cwd)
  // The repository pi sits in is what the user is working on: it gets the larger share, and the
  // others split the rest instead of flooding the list (an installed tool directory can hold more
  // files than the whole project).
  const ordered = [
    primary,
    ...all.map((root) => path.resolve(root)).filter((root) => root !== primary)
  ]
  const primaryBudget =
    ordered.length > 1 ? Math.floor(WORKSPACE_MAX_FILES * 0.6) : WORKSPACE_MAX_FILES
  const otherBudget =
    ordered.length > 1
      ? Math.floor((WORKSPACE_MAX_FILES - primaryBudget) / (ordered.length - 1))
      : 0
  const files: string[] = []
  for (const [index, absoluteRoot] of ordered.entries()) {
    const budget = index === 0 ? primaryBudget : Math.max(200, otherBudget)
    const queue = [absoluteRoot]
    let count = 0
    while (queue.length > 0 && count < budget) {
      const dir = queue.pop() as string
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (count >= budget) break
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (WORKSPACE_SKIP.has(entry.name)) continue
          queue.push(full)
        } else if (entry.isFile()) {
          count += 1
          files.push(
            absoluteRoot === primary
              ? path.relative(absoluteRoot, full).split(path.sep).join('/')
              : full.split(path.sep).join('/')
          )
        }
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b))
}

async function broadcastMcpState(): Promise<void> {
  try {
    mainWindow?.webContents.send('mcp:state', await buildMcpState())
  } catch {
    // window gone
  }
}

/** Only ever expose a masked hint of the Morph key, never the key itself. */
function maskKey(key: string | undefined): string | undefined {
  const value = key?.trim()
  if (!value) return undefined
  if (value.length <= 10) return '••••'
  return `${value.slice(0, 5)}…${value.slice(-4)}`
}

async function buildMcpState(): Promise<McpState> {
  const settings = mcpSettings()
  const [userServers, projectServers] = await Promise.all([
    mcp.listUserServers().catch(() => []),
    mcp.listProjectServers(status.cwd).catch(() => [])
  ])
  const servers = [...userServers]
  for (const entry of projectServers) {
    const index = servers.findIndex((server) => server.name === entry.name)
    if (index >= 0) servers[index] = entry
    else servers.push(entry)
  }
  const available = desktopToolAvailable()
  const builtin: McpServerInfo[] = []
  if (settings.enabled && settings.desktopTool && available) {
    builtin.push({
      name: 'desktop',
      transport: 'stdio',
      summary: 'Prophey 内置：ask_user_question',
      enabled: true,
      exposure: 'direct',
      description: '在桌面窗口弹窗向用户提问（单选 / 多选 / 手动输入）',
      source: 'extension',
      builtin: true
    })
  }
  const indexState = engineIndexStatus.codegraph
  const codegraphIndexed = engines.findCodegraphIndex(status.cwd)
  const webConf = webConfig()
  const webNatives = web.nativeProviderEnabled(webConf)
  const engineStates = await engines.engineStates({
    config: engineConfig(),
    morphApiKey: desktopConfig.mcp?.morphApiKey,
    warpgrep: await warpgrepBackend(),
    toggles: toolToggles(),
    tools: toolCache,
    indexStatus: {
      codegraph: indexState ?? { state: codegraphIndexed ? 'indexed' : 'missing' }
    },
    gatewayErrors: {
      codegraph: gateway.gatewayError('codegraph'),
      warpgrep: gateway.gatewayError('warpgrep'),
      web: gateway.gatewayError('web')
    },
    web: { braveKey: webConf.braveApiKey, nativeProviders: webNatives }
  })
  const baseUrl = bridge.getBridgeUrl()
  for (const engine of engineStates) {
    if (!settings.enabled || !engine.enabled || !engine.available) continue
    const direct = engine.tools.filter((tool) => tool.enabled && tool.direct).length
    builtin.push({
      name: engine.id,
      transport: 'http',
      summary: `${baseUrl}/mcp/${engine.id}`,
      enabled: true,
      exposure: 'deferred',
      description: `经网关转发 · ${engine.tools.length} 个工具（${direct} 个直接声明，其余按需加载）`,
      source: 'extension',
      builtin: true
    })
  }
  servers.unshift(...builtin)
  return {
    enabled: settings.enabled,
    desktopTool: settings.desktopTool,
    desktopToolAvailable: available,
    desktopTools: (toolCache.desktop ?? []).map((tool) => ({
      ...tool,
      enabled: toolToggles().desktop?.[tool.name] !== false
    })),
    engines: engineStates,
    web: {
      enabled: Boolean(engineConfig().web?.enabled),
      available: Boolean(webConf.braveApiKey) || webNatives.length > 0,
      mode: webConf.mode ?? 'auto',
      braveKeyHint: maskKey(webConf.braveApiKey),
      count: webConf.count ?? 8,
      maxChars: webConf.maxChars ?? 6000,
      nativeSupported: [...web.NATIVE_PROVIDERS],
      nativeProviders: webNatives,
      activeProvider: status.model?.provider,
      route: webRouteLabel(webConf),
      error: engineStates.find((engine) => engine.id === 'web')?.error
    },
    subagents: {
      enabled: subagentConfig().enabled,
      exposure: agentSettings.exposure,
      promptLimit: agentSettings.promptLimit,
      maxConcurrent: subagentConfig().maxConcurrent,
      desktopTools: subagentConfig().desktopTools,
      presets: agentSettings.presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        mode: preset.mode,
        tools: preset.tools,
        model: preset.model,
        appendSystemPrompt: preset.appendSystemPrompt,
        visible: preset.visible,
        timeoutMs: preset.timeoutMs,
        source: preset.source
      })),
      running: subagents?.list().filter((record) => record.status !== 'stopped').length ?? 0,
      configPath: agents.agentsFilePath(app.getPath('userData'))
    },
    morphKeyHint: maskKey(desktopConfig.mcp?.morphApiKey),
    warpgrep: await warpgrepState(),
    servers,
    userConfigPath: profile.mcpPath(),
    projectConfigPath: mcp.projectMcpPath(status.cwd),
    bridge: bridge.getBridgeInfo()
  }
}

let cachedDeviceId: string | undefined

async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId
  const file = path.join(app.getPath('userData'), 'device-id')
  try {
    const stored = (await fs.readFile(file, 'utf8')).trim()
    if (stored) {
      cachedDeviceId = stored
      return stored
    }
  } catch {
    // first login
  }
  const value = randomUUID()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${value}\n`)
  cachedDeviceId = value
  return value
}

function broadcastStatus(): void {
  mainWindow?.webContents.send('pi:status', statusSnapshot())
  flushSubagentNotices()
}

/** pi's own default is on, so the window starts assuming 90% until settings say otherwise. */
let autoCompactEnabled = true

/** Status as the window should see it: the compaction target belongs with the model info. */
function statusSnapshot(): PiStatus {
  const record = status.sessionFile ? sessionStore?.byPath(status.sessionFile) : undefined
  const running = new Set((subagents?.list() ?? [])
    .filter(item => !item.restored && (item.status === 'starting' || item.status === 'streaming') && item.parentSession)
    .map(item => toSummaryKey(item.parentSession!)))
  if (status.sessionFile && (status.isStreaming || status.compacting || status.backgroundTasks?.length)) running.add(toSummaryKey(status.sessionFile))
  // Runs that kept going off screen still light up their session row.
  for (const slot of parkedEngines.values()) {
    const file = slot.status.sessionFile
    if (file && (slot.engine.busy() || slot.engine.compacting() || slot.status.backgroundTasks?.length)) {
      running.add(toSummaryKey(file))
    }
  }
  return {
    ...status,
    sessionLocked: conversationStarted,
    sessionName: record?.title || status.sessionName,
    runningSessionKeys: [...running],
    // The engine that is actually on screen, not the creation default: the picker describes this
    // conversation, and a parked switch could otherwise leave the config pointing elsewhere.
    engine: (currentEngine.id as EngineId) || currentEngineId(),
    sessionKey: status.sessionFile
      ? toSummaryKey(status.sessionFile)
      : undefined,
    switchingEngine,
    ...(switchingEngine ? { phase: 'starting' as const, isStreaming: true } : {}),
    capabilities: currentEngine.capabilities(),
    autoCompactPercent:
      currentEngine.capabilities().autoCompaction === 'configurable' && autoCompactEnabled
        ? compactionPercent(autoCompactRatio())
        : undefined,
    speed: currentEngine.capabilities().speed
      ? speed.speedState(status.model, currentSpeedMode())
      : { mode: 'standard', available: ['standard'] },
    repo: currentRepo
  }
}

async function selectableModels(owner: AgentEngine): Promise<Record<string, unknown>[]> {
  const models = await owner.models()
  if (!owner.capabilities().providerSettings) return models
  const choices = await providers.listModelChoices()
  const allowed = new Set(choices.map(model => `${model.provider}/${model.id}`))
  return models.filter(model => allowed.has(`${model.provider}/${model.id}`))
}

/**
 * Repository of the active session.
 *
 * Kept next to the status instead of being fetched per render: `git` is a process launch, and the
 * composer plus the sidebar both want the branch. Refreshed when pi starts on a directory and when
 * the window asks for it explicitly.
 */
let currentRepo: repo.RepoInfo | undefined

async function refreshRepo(dir: string): Promise<void> {
  const info = await repo.repoInfo(dir)
  if (status.cwd !== dir) return
  currentRepo = info
  broadcastStatus()
}

/** Tier saved in the config; the model still decides whether it can be used (see `speed.ts`). */
function currentSpeedMode(): SpeedMode {
  const mode = desktopConfig.speed?.mode
  return mode === 'fast' || mode === 'ultrafast' ? mode : 'standard'
}

function cancelPendingAsks(reason: string, sessionKey = currentEngine?.state().sessionFile): void {
  if (!sessionKey) return
  bridge.cancelAllAsks(reason, sessionKey)
  mainWindow?.webContents.send('ask:cleared', { sessionKey })
}

/**
 * `/btw` parks the process on a fork of the current session. While that is true the window must not
 * see the fork at all (no `pi:event`), and everything that switches sessions has to close it first.
 */
let btwActive = false
/** Session to return to when the side chat closes. */
let btwOriginal: string | undefined
/** File of the fork that is currently being talked to. */
let btwFork: string | undefined
/** Bumped on every start/close so a start that is still waiting for the run to settle gives up. */
let btwGeneration = 0

function setStatus(patch: Partial<PiStatus>): void {
  currentEngine.setStatus(patch)
  // While the side-chat panel is open the window keeps showing the main session's status.
  if (btwActive) return
  broadcastStatus()
}

/**
 * The directories this session works on.
 *
 * A session started inside a project covers the whole project: its own directory is the primary one
 * and the rest become additional roots. Outside a project there is exactly one root, which is the
 * behaviour every session had before projects existed.
 */
function currentWorkspace(cwd?: string): AgentWorkspace {
  const primary = cwd ?? status.cwd
  const saved = desktopConfig.activeSession ? sessionStore?.byPath(desktopConfig.activeSession) : undefined
  if (saved && path.resolve(saved.cwd) === path.resolve(primary)) {
    return { primary: saved.cwd, additional: [...saved.additional] }
  }
  const project = activeProject()
  if (!project) return { primary, additional: [] }
  const key = path.resolve(primary)
  if (!project.roots.some((root) => path.resolve(root.path) === key)) {
    return { primary, additional: [] }
  }
  return {
    primary,
    additional: project.roots.map((root) => root.path).filter((root) => path.resolve(root) !== key)
  }
}

/** Start or restart the session; the engine hands the in-flight promise to a second caller. */
async function startPi(cwd?: string, extraArgs: string[] = []): Promise<PiStatus> {
  const next = await currentEngine.start(currentWorkspace(cwd), {
    session: extraArgs.includes('--session')
      ? extraArgs[extraArgs.indexOf('--session') + 1]
      : undefined,
    model: extraArgs.includes('--model')
      ? {
          provider: extraArgs[extraArgs.indexOf('--provider') + 1],
          id: extraArgs[extraArgs.indexOf('--model') + 1]
        }
      : undefined
  })
  if (next.phase === 'ready') await afterStart(next.cwd, extraArgs)
  return statusSnapshot()
}

/**
 * Work that follows every successful start: remember the repository, and put a fresh session on
 * the repository's own defaults.
 *
 * A restart (`--session …`, crash recovery, config reload) must keep whatever the user has chosen,
 * so the defaults only apply when there is no session file to restore.
 */
async function afterStart(workspace: string, extraArgs: string[]): Promise<void> {
  const owner = currentEngine
  const started = conversationHasStarted(await owner.messages())
  if (owner === currentEngine) {
    conversationStarted ||= started
    broadcastStatus()
  }
  // The engine owns the start now, so the app refreshes the repository facts here.
  void refreshRepo(workspace)
  // Index every repository of the project, not just the one pi is sitting in: code search that
  // silently only covered the primary root would be worse than no index at all.
  const roots = activeProject()?.roots.map((root) => root.path) ?? [workspace]
  for (const root of new Set([workspace, ...roots])) startCodegraphIndex(root)
  await saveConfig({ recentRepos: recentDirectories([workspace, ...roots, ...(desktopConfig.recentRepos ?? [])]) })
  if (extraArgs.includes('--session')) return
  const defaults = desktopConfig.repoDefaults?.[workspace]
  if (!defaults) return
  if (defaults.provider && defaults.model) {
    const owner = currentEngine
    const choices = await owner.models().catch(() => [])
    // Repository defaults may belong to a different engine; never feed its model ID to this CLI.
    if (owner === currentEngine && choices.some((model) => model.provider === defaults.provider && model.id === defaults.model))
      await owner.setModel(defaults.provider, defaults.model).catch(() => undefined)
  }
  if (defaults.thinkingLevel) {
    await currentEngine.setThinkingLevel(defaults.thinkingLevel).catch(() => undefined)
  }
  await currentEngine.refresh()
}

/**
 * Put a reopened conversation back on the model it was using.
 *
 * A CLI engine starts on its own global default; the record remembers the choice instead, so a
 * conversation that was switched to another model keeps it — and so does every other conversation,
 * independently. Missing support (model removed, level not offered by this model) is skipped
 * silently: a stale preference must never block opening the session.
 */
async function applySessionPreferences(record: SessionRecord | undefined): Promise<void> {
  if (!record) return
  const owner = currentEngine
  const desired = record.provider && record.model
    ? { provider: record.provider, id: record.model }
    : undefined
  if (desired && (status.model?.provider !== desired.provider || status.model?.id !== desired.id)) {
    const choices = await owner.models().catch(() => [])
    if (owner !== currentEngine) return
    if (choices.some((model) => model.provider === desired.provider && model.id === desired.id))
      await owner.setModel(desired.provider, desired.id).catch(() => undefined)
  }
  if (record.thinkingLevel && status.thinkingLevel !== record.thinkingLevel)
    await currentEngine.setThinkingLevel(record.thinkingLevel).catch(() => undefined)
  await currentEngine.refresh().catch(() => undefined)
}

/** Vendor wording for "this account may not use that processing tier". */
const TIER_REJECTED =
  /unsupported service_tier|service_tier[^"]{0,40}(not supported|invalid)|unsupported[^"]{0,20}speed|fast.?mode[^"]{0,30}(not available|not supported)|invalid.*anthropic-beta/i

/**
 * A tier the account cannot use is a 400 that kills the turn, so fall back instead of letting the
 * user resend into the same wall.
 *
 * Measured on a ChatGPT subscription login: `{"detail":"Unsupported service_tier: fast"}` — fast and
 * ultrafast need API billing or a plan that includes them. Nothing advertises that up front, so the
 * first rejection is the signal: drop back to `standard`, restart pi without the tier, and say why.
 */
function noteSpeedRejection(errorMessage: string): void {
  if (currentSpeedMode() === 'standard' || !TIER_REJECTED.test(errorMessage)) return
  void saveConfig({ speed: { mode: 'standard' } })
  broadcastStatus()
  mainWindow?.webContents.send('pi:event', {
    type: 'speed_unsupported',
    detail: errorMessage.slice(0, 200)
  })
  void reloadPiConfig()
}

function sessionArgs(): string[] {
  // While a `/btw` side chat is open the process sits on a fork; a restart must land back on the
  // real session, not on the throwaway branch.
  const file = btwActive ? (btwOriginal ?? status.sessionFile) : status.sessionFile
  const args = file ? ['--session', file] : []
  // A session that has no messages yet has no file on disk, so the restart would otherwise come
  // back on the default model from settings.json — a model switch or a speed change would look
  // like it silently reverted.
  if (status.model) args.push('--provider', status.model.provider, '--model', status.model.id)
  return args
}

/**
 * Park the pi process back on the main session and throw the `/btw` fork away.
 *
 * Every path that switches or restarts the session calls this first: a follow-up question must never
 * be delivered to whatever session happened to be active after the switch.
 */
async function closeSideChat(): Promise<void> {
  // A start that is still waiting for the current run to settle must not fork afterwards.
  btwGeneration += 1
  if (!btwActive) return
  const original = btwOriginal
  const fork = btwFork
  btwActive = false
  btwOriginal = undefined
  btwFork = undefined
  try {
    if (currentEngine.busy() && currentEngine.running()) {
      await currentEngine.abort().catch(() => undefined)
      await currentEngine.waitForSettle(15_000)
    }
    if (original && currentEngine.running()) {
      await currentEngine.switchSession(original)
    }
  } catch {
    // `refreshState` below re-syncs whatever pi ended up on.
  }
  if (fork && fork !== original) {
    if (currentEngine.discardSession)
      await currentEngine.discardSession(fork).catch(() => undefined)
    else await fs.unlink(fork).catch(() => undefined)
  }
  await currentEngine.refresh()
  broadcastStatus()
}

/** One turn on the session pi is currently parked on (the `/btw` fork while a side chat is open). */
async function btwPrompt(message: string): Promise<{ text: string; settled: boolean }> {
  // Arm the waiter first: a short answer can settle before the prompt response even arrives.
  const settling = currentEngine.waitForSettle(300_000)
  await currentEngine.send(message)
  const settled = await settling
  const text = (await currentEngine.lastAssistantText()) ?? ''
  if (text.trim()) return { text, settled }
  return { text: settled ? '（没有回答）' : '（超过 5 分钟仍未结束，可以关闭窗口）', settled }
}

/**
 * Does the model this engine is parked on accept images?
 *
 * Engines take images (pi, Prophey, Claude, Codex all do), but the model is a separate question:
 * pi's catalog reads a missing `input` as text-only and replaces every image with
 * "(image omitted: model does not support images)", so the screenshot never reaches the model.
 */
async function modelAcceptsImages(owner: AgentEngine): Promise<boolean> {
  const model = owner.state().model
  if (!model?.provider || !model.id) return false
  try {
    return await providers.modelSupportsImages(model.provider, model.id)
  } catch {
    // A broken catalog is not a reason to claim the model supports images.
    return false
  }
}

/** The engine owns the turn; the app only forwards the window's request. */
async function submitPrompt(
  message: string,
  behavior?: 'steer' | 'followUp',
  images?: PromptImage[],
  owner = currentEngine
): Promise<PromptResult> {
  const caps = owner.capabilities()
  if (images?.length && !caps.images)
    return { ok: false, error: '当前引擎不支持图片' }
  // Refuse rather than let the picture be replaced by a placeholder: the user keeps the draft and
  // gets told which switch turns the screenshot back on. Only engines that send through pi's model
  // catalog are affected — Claude Code and Codex hand images to their own CLI.
  if (images?.length && caps.imageInput === 'model' && !(await modelAcceptsImages(owner))) {
    const model = owner.state().model
    return {
      ok: false,
      error:
        `当前模型（${model?.provider ?? '?'} / ${model?.id ?? '?'}）没有声明支持图片，` +
        '发送时截图会被替换成“(image omitted)”，模型看不到。到 设置 → 服务商 → 编辑该模型，' +
        '勾选「支持图片」后重新发送。'
    }
  }
  if (behavior === 'steer' && owner.busy() && !caps.steer)
    return { ok: false, error: '当前引擎不支持运行中引导，请排队发送' }
  const firstRequest = owner === currentEngine && !conversationStarted && owner.running() && Boolean(message.trim() || images?.length)
  const titleModel = owner.state().model ? { ...owner.state().model! } : undefined
  if (owner === currentEngine && owner.running() && (message.trim() || images?.length)) {
    conversationStarted = true
    broadcastStatus()
  }
  const pending = owner.prompt(message, { behavior, images })
  if (firstRequest) {
    const file = owner.state().sessionFile
    if (file) requestSessionTitle(file, message, titleModel)
    else void pending.then(() => {
      const created = owner.state().sessionFile
      if (created) requestSessionTitle(created, message, titleModel)
    }).catch(() => undefined)
  }
  return pending
}

async function reloadPiConfig(): Promise<void> {
  if (switchingEngine) { configPending = true; return }
  if (btwActive) await closeSideChat()
  await refreshAgents()
  if (currentEngine.busy()) {
    // pi cannot pick up new MCP servers mid-run; remember it and restart when the run settles,
    // otherwise the switch the user just flipped would silently never apply.
    configPending = true
    mainWindow?.webContents.send('pi:config-pending', true)
    return
  }
  configPending = false
  await startPi(status.cwd, sessionArgs())
}

function sendLoginMessage(message: LoginMessage): void {
  mainWindow?.webContents.send('providers:login-message', message)
}

/** Open the selected conversation, or allocate a fresh one using the creation default. */
async function activateConversation(options: {
  cwd: string
  sessionPath?: string
  projectId?: string
  /** Kept for older callers; a running turn is parked rather than stopped. */
  stop?: boolean
}): Promise<PiStatus> {
  if (switchingEngine || currentEngine.starting()) throw new Error('正在切换会话，请稍候')
  if (btwActive) await closeSideChat()
  const record = options.sessionPath ? sessionStore?.byPath(options.sessionPath) : undefined
  const file = record?.path || options.sessionPath
  const targetKey = file ? toSummaryKey(file) : undefined
  if (file) await restoringEngines.get(sessionIdentity(file))

  // The session's engine is still running off screen: bring it back instead of replacing it, so
  // the turn continues exactly where it was (and no work is lost).
  const parked = targetKey ? parkedEngines.get(targetKey) : undefined
  if (parked && parked.engine.running()) {
    if (reapParked(parked)) {
      // It finished while off screen: fall through and reopen from the transcript, which also
      // picks up any config change made in the meantime.
    } else {
      switchingEngine = parked.engine.id as EngineId
      broadcastStatus()
      try {
        await rememberSession({}, true)
        // The session being left behind is either parked too (if it is running) or disposed.
        if (currentEngine !== parked.engine) await retireEngine(currentEngine)
        activateParked(parked)
        await saveConfig({
          engine: parked.engine.id as EngineId,
          cwd: record?.cwd || options.cwd,
          activeProject: record?.projectId ?? options.projectId,
          activeSession: record ? toSummary(record).path : undefined
        })
        await rememberSession({}, true)
      } finally {
        switchingEngine = undefined
        broadcastStatus()
      }
      return statusSnapshot()
    }
  }
  if (parked && !parked.engine.running()) {
    // The process is gone but the entry was not reaped yet.
    parkedEngines.delete(parked.parked?.key ?? '')
    parked.parked = undefined
    parked.engine.dispose()
  }

  const target: EngineId = file ? record?.engine ??
    (file.startsWith('claude:') ? 'claude' : file.startsWith('codex:') ? 'codex' :
      path.dirname(file) === path.join(app.getPath('userData'), 'transcripts') ? 'prophey' : 'pi')
    : defaultEngineId()
  const source = currentEngine
  const sourceFile = source.state().sessionFile
  let sourceRef: string | undefined
  let parkedSource: EngineSlot | undefined
  switchingEngine = target
  broadcastStatus()
  let original = { ...desktopConfig }
  let replaced = false
  let created = false
  try {
    sourceRef = sourceFile && (isNativeSessionReference(sourceFile)
      ? (await source.messages()).length > 0 : existsSync(sourceFile)) ? sourceFile : undefined
    await rememberSession({}, true)
    original = { ...desktopConfig }
    await saveConfig({ pendingEngineSwitch: {
      engine: source.id as EngineId, cwd: source.workspace().primary, session: sourceRef,
      propheySessionId: original.propheySessionId, activeProject: original.activeProject,
      record: sourceRef ? sessionStore?.byPath(sourceRef) : undefined
    } })
    // A running turn keeps its engine, process and tools; only the window stops watching it.
    parkedSource = await retireEngine(source)
    replaced = !parkedSource
    await saveConfig({
      engine: target, cwd: record?.cwd || options.cwd,
      activeProject: record?.projectId ?? options.projectId,
      activeSession: record ? toSummary(record).path : undefined,
      ...(!file ? { engineSessions: { ...desktopConfig.engineSessions, [target]: undefined } } : {}),
      ...(!file && target === 'prophey' ? { propheySessionId: 's_' + randomUUID() } : {})
    })
    currentEngine = createEngine()
    currentEngine.poll()
    created = true
    const next = await startPi(record?.cwd || options.cwd, file ? ['--session', file] : [])
    if (next.phase === 'error' || currentEngine.state().phase !== 'ready') {
      throw new Error(currentEngine.state().error ?? '会话启动失败')
    }
    // The engine started on its own default model; this conversation's own choice wins.
    await applySessionPreferences(record)
    await rememberSession({}, true)
    await saveConfig({ pendingEngineSwitch: undefined })
  } catch (error) {
    if (replaced || created) currentEngine.dispose()
    await saveConfig({ ...original, activeSession: original.activeSession,
      engineSessions: original.engineSessions, propheySessionId: original.propheySessionId,
      activeProject: original.activeProject, pendingEngineSwitch: undefined })
    if (parkedSource?.parked) {
      // The switch failed, so put the background run back on screen.
      activateParked(parkedSource)
    } else if (replaced) {
      currentEngine = createEngine()
      currentEngine.poll()
      await currentEngine.start(source.workspace(), { session: sourceRef })
    }
    throw error
  } finally {
    switchingEngine = undefined
    broadcastStatus()
  }
  return statusSnapshot()
}

function registerIpc(): void {
  const handle: typeof ipcMain.handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    const mutatesEngine =
      (channel.startsWith('pi:') && !/^pi:(get-|list-|repo|session-stats|open-agent-dir)/.test(channel)) ||
      /^desktop:set-|^engine:(command$|sandbox|codex-questions)|^projects:(activate|create|update|remove|add-root)|^mcp:(set-|add-|remove-)|^agents:(save-|delete-|set-)|^providers:(save-|set-|logout|import-cli)|^settings:save/.test(channel)
    if (switchingEngine && mutatesEngine && channel !== 'pi:prompt') throw new Error('正在迁移对话，请等待引擎切换完成')
    return listener(event, ...args)
  })
  handle('pi:get-status', () => statusSnapshot())

  handle('pi:restart', async (_event, cwd?: string) => {
    if (conversationStarted && cwd && path.resolve(cwd) !== path.resolve(status.cwd)) {
      throw new Error('会话已开始，不能修改目录；请新建会话')
    }
    if (btwActive) await closeSideChat()
    if (cwd) await saveConfig({ cwd })
    return startPi(cwd ?? status.cwd, sessionArgs())
  })

  handle('pi:new-project-session', async (_event, cwd: string, options?: { stop?: boolean }) => {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !(await fs.stat(cwd).catch(() => undefined))?.isDirectory()) {
      throw new Error('目录不存在或不可访问，请选择其他目录')
    }
    if (btwActive) await closeSideChat()
    // A session belongs to one repository: a subdirectory lands on the repo root instead, so the
    // sidebar groups by repository and the agent's cwd is the repo it is working on.
    const workspace = await repo.repoRoot(cwd).then((root) => root ?? cwd)
    return activateConversation({ cwd: workspace, stop: options?.stop === true })
  })

  handle('pi:repo-info', async (_event, dir?: string) => {
    const target = dir ?? status.cwd
    const info = await repo.repoInfo(target)
    // The window's own lookup doubles as a refresh of the active repository (branch/dirty move).
    if (path.resolve(target) === path.resolve(status.cwd)) {
      currentRepo = info
      broadcastStatus()
    }
    return info
  })

  handle('pi:repos', (_event, dirs: string[]) => repo.repoInfos(dirs))

  handle('projects:list', async () => {
    if (!projectStore) return []
    await projectStore.load()
    return projectStore.list()
  })

  handle(
    'projects:create',
    async (_event, input: { name: string; roots: string[]; primary?: string }) => {
      if (!projectStore) return { ok: false, error: '项目存储未就绪' }
      try {
        // A project is a set of repositories: normalise whatever the picker returned to git roots.
        const roots = await Promise.all(
          input.roots.map(async (dir) => (await repo.repoRoot(dir)) ?? dir)
        )
        const project = await projectStore.create({ ...input, roots })
        return { ok: true, project }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handle(
    'projects:update',
    async (_event, id: string, patch: { name?: string; roots?: string[]; primary?: string }) => {
      if (!projectStore) return { ok: false, error: '项目存储未就绪' }
      try {
        const roots = patch.roots
          ? await Promise.all(patch.roots.map(async (dir) => (await repo.repoRoot(dir)) ?? dir))
          : undefined
        const project = await projectStore.update(id, { ...patch, roots })
        if (!project) return { ok: false, error: '项目不存在' }
        return { ok: true, project }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /** Create a project from a folder picker; the first repository becomes the primary root. */
  handle('projects:create-from-dialog', async () => {
    if (!projectStore) return { ok: false, error: '项目存储未就绪' }
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择目录：一个目录创建会话，多个目录创建项目',
      defaultPath: status.cwd,
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: '已取消' }
    try {
      const roots = await Promise.all(
        result.filePaths.map(async (dir) => (await repo.repoRoot(dir)) ?? dir)
      )
      const unique = [...new Map(roots.map(dir => [process.platform === 'win32' ? dir.toLowerCase() : dir, dir])).values()]
      if (unique.length === 1) return { ok: true, cwd: unique[0] }
      const project = await projectStore.create({
        name: path.basename(unique[0]),
        roots: unique,
        primary: unique[0]
      })
      return { ok: true, project }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** Add another repository to a project (the primary root stays where it is). */
  handle('projects:add-root', async (_event, id: string) => {
    const project = projectStore?.get(id)
    if (!projectStore || !project) return { ok: false, error: '项目不存在' }
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: `向「${project.name}」添加仓库`,
      defaultPath: status.cwd,
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: '已取消' }
    try {
      const added = await Promise.all(
        result.filePaths.map(async (dir) => (await repo.repoRoot(dir)) ?? dir)
      )
      const updated = await projectStore.update(id, {
        roots: [...project.roots.map((root) => root.path), ...added]
      })
      return updated ? { ok: true, project: updated } : { ok: false, error: '项目不存在' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('projects:remove', async (_event, id: string) => {
    await projectStore?.remove(id)
    if (desktopConfig.activeProject === id) await saveConfig({ activeProject: undefined })
    return { ok: true }
  })

  /**
   * Work in a project: restart pi on its primary repository. The other roots reach the model
   * through the extension's `<project>` section (see `prepare`).
   */
  handle('projects:activate', async (_event, id?: string, options?: { stop?: boolean }) => {
    const project = id ? projectStore?.get(id) : undefined
    if (id && !project) return { ok: false, error: '项目不存在' }
    const primary = project?.roots.find((root) => root.primary) ?? project?.roots[0]
    return activateConversation({
      cwd: primary?.path ?? status.cwd,
      projectId: project?.id,
      stop: options?.stop === true
    })
  })

  handle('repos:recent', () => recentDirectories([
    ...(desktopConfig.recentRepos ?? []),
    ...(sessionStore?.list().map(record => record.cwd) ?? [])
  ]))

  /** Folder picker without side effects, resolved to git roots; used by the project editor. */
  handle('repos:pick-folders', async (_event, title?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: title ?? '选择仓库',
      defaultPath: status.cwd,
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled) return []
    return Promise.all(result.filePaths.map(async (dir) => (await repo.repoRoot(dir)) ?? dir))
  })

  /** Store the current model/thinking level as this repository's default for new sessions. */
  handle('repos:save-defaults', async () => {
    const defaults = {
      ...(desktopConfig.repoDefaults ?? {}),
      [status.cwd]: {
        provider: status.model?.provider,
        model: status.model?.id,
        thinkingLevel: status.thinkingLevel
      }
    }
    await saveConfig({ repoDefaults: defaults })
    return { ok: true }
  })

  handle('pi:open-session', (_event, sessionPath: string, cwd: string, options?: { stop?: boolean }) =>
    activateConversation({ sessionPath, cwd, stop: options?.stop === true }))

  handle('desktop:config', () => ({
    engine: currentEngineId(),
    defaultEngine: defaultEngineId(),
    capabilities: currentEngine.capabilities(),
    codexSandbox: desktopConfig.codexSandbox,
    codexRequestUserInput: desktopConfig.codexRequestUserInput !== false,
    suggestions: desktopConfig.suggestions === true,
    cwd: status.cwd,
    sessionDir: currentSessionDir(),
    sharedSessionDir: sharedSessionDir(),
    activeProject: desktopConfig.activeProject
  }))

  handle('pi:set-suggestions', async (_event, enabled: boolean) => {
    await saveConfig({ suggestions: enabled === true })
    // Off means off at once, including a request that is already in flight.
    clearSuggestion()
    // Claude Code reads the flag when it connects, so an open session restarts to pick it up (the
    // same rule as Codex's spawn-time options).
    if (currentEngineId() === 'claude') await reloadPiConfig()
    return { ok: true, suggestions: desktopConfig.suggestions === true }
  })

  handle('updates:snapshot', () => updates.getSnapshot())
  handle('updates:check', () => updates.check())
  handle('updates:install', () => updates.install())
  handle('updates:cancel', () => updates.cancel())
  handle('updates:auto', (_event, enabled: boolean) => updates.setAuto(enabled))
  handle('updates:auto-download', (_event, enabled: boolean) => updates.setAutoDownload(enabled))
  handle('app:proxy', () => getProxyInfo())

  handle('desktop:set-default-engine', async (_event, next: EngineId) => {
    if (!['pi', 'prophey', 'claude', 'codex'].includes(next)) throw new Error('未知引擎')
    await saveConfig({ defaultEngine: next })
    return { ok: true }
  })

  // Engine choice is setup for an empty conversation, never a history migration.
  handle('desktop:set-engine', async (_event, next: EngineId) => {
    if (!['pi', 'prophey', 'claude', 'codex'].includes(next)) throw new Error('未知引擎')
    if (switchingEngine || currentEngine.starting()) throw new Error('正在切换会话，请稍候')
    if (next === currentEngineId()) return statusSnapshot()
    if (conversationStarted || currentEngine.busy() || btwActive) throw new Error('会话已开始，不能更换 agent；请新建会话后选择')
    const source = currentEngine
    const workspace = source.workspace()
    const original = { ...desktopConfig }
    const ref = source.state().sessionFile
    const sourceRef = ref && !isNativeSessionReference(ref) && existsSync(ref) ? ref : undefined
    let replaced = false
    switchingEngine = next
    broadcastStatus()
    try {
      if (conversationHasStarted(await source.messages())) throw new Error('会话已开始，不能更换 agent；请新建会话后选择')
      await saveConfig({ pendingEngineSwitch: { engine: source.id as EngineId, cwd: workspace.primary,
        session: sourceRef, propheySessionId: original.propheySessionId, activeProject: original.activeProject } })
      source.dispose()
      replaced = true
      await saveConfig({ engine: next, activeSession: undefined,
        engineSessions: { ...desktopConfig.engineSessions, [next]: undefined },
        ...(next === 'prophey' ? { propheySessionId: 's_' + randomUUID() } : {}) })
      currentEngine = createEngine()
      currentEngine.poll()
      const started = await currentEngine.start(workspace)
      if (started.phase !== 'ready') throw new Error(started.error ?? '目标引擎启动失败')
      await afterStart(workspace.primary, [])
      await saveConfig({ pendingEngineSwitch: undefined })
    } catch (error) {
      if (replaced) {
        currentEngine.dispose()
        await saveConfig({ ...original, activeSession: original.activeSession,
          engineSessions: original.engineSessions, propheySessionId: original.propheySessionId,
          pendingEngineSwitch: undefined })
        currentEngine = createEngine()
        currentEngine.poll()
        await currentEngine.start(workspace, { session: sourceRef })
      }
      throw new Error('未切换引擎：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      switchingEngine = undefined
      broadcastStatus()
    }
    return statusSnapshot()
  })

  handle('pi:choose-workspace', async (_event, options?: { stop?: boolean }) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择一个 git 仓库（将在该仓库新建会话）',
      defaultPath: status.cwd,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // Picking a subdirectory is normal (people browse to `src/`); the session still belongs to the
    // repository, so start at its root and keep the grouping honest.
    const cwd = (await repo.repoRoot(result.filePaths[0])) ?? result.filePaths[0]
    return activateConversation({ cwd, stop: options?.stop === true })
  })

  handle(
    'pi:prompt',
    async (
      _event,
      message: string,
      streamingBehavior?: 'steer' | 'followUp',
      images?: PromptImage[],
      sessionKey?: string
    ) => {
      try {
        const owner = await promptEngineForSession(sessionKey)
        return await submitPrompt(message, streamingBehavior, images, owner)
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  )

  /**
   * The only hard interrupt in the app: stop the running turn, then send this message in a new one.
   *
   * Every other send made mid-run steers instead — it waits for the tool call or reply in flight to
   * finish, which is what 引导 means. `steerId` names the waiting message this one replaces, so the
   * engine drops it rather than delivering it twice (the user pressed 立即发送 on it).
   */
  handle(
    'pi:send-now',
    async (
      _event,
      message: string,
      images?: PromptImage[],
      sessionKey?: string,
      steerId?: string
    ) => {
      try {
        const owner = await promptEngineForSession(sessionKey)
        if (steerId) owner.cancelSteer?.(steerId)
        if (owner.busy()) {
          await owner.abort()
          if (!(await owner.waitForIdle(30_000))) return { ok: false, error: '当前回合停不下来，稍后再试' }
        }
        return await submitPrompt(message, undefined, images, owner)
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  )

  /** Take back a message that is still waiting at the engine's next boundary. */
  handle('pi:cancel-steer', async (_event, steerId: string, sessionKey?: string) => {
    try {
      const owner = await promptEngineForSession(sessionKey)
      return owner.cancelSteer?.(steerId) ?? { ok: false, error: '当前引擎不支持撤回，让它自己发出' }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })

  /**
   * Rewrite history: cut the conversation back to the `index`-th user message, then send the edited
   * text in its place. A running turn is stopped first — everything after the edited message is on
   * its way out anyway, so waiting for it would only make the user click twice.
   */
  handle(
    'pi:edit-turn',
    async (
      _event,
      index: number,
      message: string,
      images?: PromptImage[],
      sessionKey?: string
    ) => {
      try {
        const owner = await promptEngineForSession(sessionKey)
        if (!owner.rewind) return { ok: false, error: '当前引擎不支持改写历史' }
        if (owner.busy()) {
          await owner.abort()
          if (!(await owner.waitForIdle(30_000))) return { ok: false, error: '当前回合停不下来，稍后再试' }
        }
        const rewound = await owner.rewind(index)
        if (!rewound.ok) return { ok: false, error: rewound.error ?? '改写失败' }
        return await submitPrompt(message, undefined, images, owner)
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  )

  handle('pi:abort', async () => {
    cancelPendingAsks('用户中止了本次运行')
    // A subagent that settles right after a manual stop must not start a new turn behind the
    // user's back; the notice is queued instead (see subagentManager onSettle).
    lastAbortAt = Date.now()
    if (!currentEngine.running()) return
    try {
      await currentEngine.abort()
    } catch {
      // ignore
    }
    await currentEngine.refresh()
  })

  handle('pi:new-session', async (_event, options?: { stop?: boolean }) => {
    try {
      await activateConversation({
        cwd: status.cwd,
        projectId: desktopConfig.activeProject,
        stop: options?.stop === true
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('pi:switch-session', async (_event, sessionPath: string) => {
    try {
      await activateConversation({ cwd: status.cwd, sessionPath })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('pi:get-messages', async () => {
    // The engine names the session it answered from: while a switch is in flight it can still hold
    // the previous transcript, and the window must not paint that under the new session.
    const engineState = currentEngine.state()
    const sessionKey = engineState.sessionKey ?? engineState.sessionFile
    // "Not ready" is not "empty". Saying `messages: []` here made the window paint 「开始一段对话」
    // over a session that was merely still starting, and nothing loaded it again: the pane stayed
    // blank while the run it belonged to was visibly going. `pending` tells the window to look again.
    if (!currentEngine.running()) return { sessionKey, messages: [], pending: true }
    return { sessionKey, messages: (await currentEngine.messages()) as AgentMessage[] }
  })

  handle('pi:list-sessions', async () => {
    if (!sessionStore) return listSessions(currentSessionDir())
    await sessionStore.load()
    await importPiSessions()
    for (const record of sessionStore.list()) {
      if (record.titleSource || record.title !== path.basename(record.path, '.jsonl') || isNativeSessionReference(record.path)) continue
      const summary = await readSummary(record.path)
      if (summary?.title && summary.title !== record.title) {
        await sessionStore.upsert({ id: record.id, title: promptTitle(summary.title), titleSource: 'prompt', updatedAt: record.updatedAt })
      }
    }
    // A session deleted from disk (or by another window) must not stay in the list.
    await sessionStore
      .prune((file) => !(file === status.sessionFile && currentEngine.busy()) && !isNativeSessionReference(file) && !existsSync(file))
      .catch(() => undefined)
    return sessionStore.list().map(toSummary)
  })

  handle('pi:session-stats', async () => {
    const owner = currentEngine
    const sessionKey = owner.state().sessionKey ?? owner.state().sessionFile
    if (!owner.running()) return { sessionKey }
    try {
      return { ...((await owner.stats()) as SessionStats), sessionKey }
    } catch {
      return {}
    }
  })

  // Session panel: stop one background command. Only Prophey owns a task list (see engine.ts).
  handle('engine:read-background-task', async (_event, id: string, sessionKey?: string) => {
    const owner = sessionKey ? engineForSession(sessionKey) : currentEngine
    return owner?.readBackgroundTask?.(String(id)) ?? { ok: false, error: '原会话没有可读取的后台命令' }
  })
  handle('engine:stop-background-task', async (_event, id: string, sessionKey?: string) => {
    const owner = sessionKey ? engineForSession(sessionKey) : currentEngine
    if (!owner?.stopBackgroundTask) {
      return { ok: false, error: '当前引擎不提供后台任务列表，请在对话里用 stop_bash_task' }
    }
    return owner.stopBackgroundTask(String(id))
  })

  // Session panel: show a produced file in Explorer/Finder. Only paths inside the session's
  // workspace are accepted (symlinks are resolved first), so a model-provided path cannot open
  // arbitrary files on the machine.
  handle('workspace:reveal', async (_event, target: string) => {
    const workspace = currentEngine?.workspace()
    const roots = [workspace?.primary, ...(workspace?.additional ?? [])].filter(
      (root): root is string => typeof root === 'string' && root !== ''
    )
    const real = async (value: string): Promise<string | undefined> => {
      try {
        return await fs.realpath(value)
      } catch {
        return undefined
      }
    }
    const resolved = await real(path.resolve(String(target ?? '')))
    if (!resolved) return { ok: false, error: '文件不存在或已被删除' }
    const inside = (
      await Promise.all(roots.map((root) => real(path.resolve(root))))
    ).some((root) => root && (resolved === root || resolved.startsWith(root + path.sep)))
    if (!inside) return { ok: false, error: '只能打开当前会话目录里的文件' }
    shell.showItemInFolder(resolved)
    return { ok: true }
  })

  handle('pi:open-agent-dir', async () => {
    const dir = profile.agentDir()
    await fs.mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })

  handle('app:copy-image', (_event, dataUrl: unknown) => copyImageToClipboard(dataUrl))

  // The renderer's own copy lives in localStorage; these two mirror it to disk so a crash cannot
  // swallow the last seconds of typing (localStorage's LevelDB commit is batched, see
  // composer-store.ts). `load` hands back the mirrored map for the startup merge.
  handle('composer:save', async (_event, key: unknown, entry: unknown) => {
    if (typeof key !== 'string' || !entry || typeof entry !== 'object') return
    const value = entry as {
      draft?: unknown; images?: unknown; queued?: unknown; at?: unknown; imagesChanged?: unknown
    }
    composerStore.save(key, {
      draft: typeof value.draft === 'string' ? value.draft : '',
      images: Array.isArray(value.images) ? value.images : undefined,
      imagesChanged: value.imagesChanged !== false,
      queued: Array.isArray(value.queued) ? value.queued : [],
      at: typeof value.at === 'number' ? value.at : Date.now()
    })
  })
  handle('composer:load', () => composerStore.loadRaw())

  handle('app:open-external', async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  handle('app:set-theme', (_event, theme: 'dark' | 'light') => {
    mainWindow?.setTitleBarOverlay({
      color: theme === 'light' ? '#f6f6f7' : '#17181b',
      symbolColor: theme === 'light' ? '#3a3c45' : '#b9bbc2',
      height: 44
    })
  })

  handle('providers:list', () => providers.listProviders())

  /** The provider row's 「测试」: one real request, so a wrong URL or model id is caught here. */
  handle('providers:test', (_event, providerId: string, modelId?: string) =>
    providers.testProvider(providerId, modelId)
  )

  // OpenAI does not expose plan usage to "Sign in with ChatGPT" credentials; see chatgpt-usage.ts.
  handle('providers:chatgpt-usage', (_event, force?: boolean) => chatGptUsage({ force: force === true }))

  handle('ask:answer', (_event, id: string, answers: AskAnswer[]) => {
    bridge.answerAsk(id, Array.isArray(answers) ? answers : [])
  })

  handle('ask:cancel', (_event, id: string, reason?: string) => {
    bridge.cancelAsk(id, reason ?? '用户取消了提问')
  })
  handle('ask:list', () => bridge.pendingAsks())

  handle('mcp:state', () => buildMcpState())

  handle('subagents:list', () =>
    subagentManager()
      .list()
      .map((record) => serializeSubagent(record))
  )
  handle('subagents:get', (_event, id: string) => {
    const record = subagentManager().get(id)
    return record ? serializeSubagent(record) : null
  })
  handle('subagents:stop', async (_event, id: string) => {
    try {
      await subagentManager().stop(id)
      return true
    } catch {
      return false
    }
  })
  handle(
    'subagents:prompt',
    async (_event, id: string, text: string, mode: 'interrupt' | 'steer' | 'follow-up') => {
      try {
        await subagentManager().prompt(id, text, mode)
        return true
      } catch {
        return false
      }
    }
  )
  handle('subagents:reveal', (_event, file: string) => {
    if (typeof file !== 'string' || !existsSync(file)) return false
    shell.showItemInFolder(file)
    return true
  })

  handle('workspace:files', () => {
    // A project's picker covers every repository, not just the one pi sits in.
    const roots = activeProject()?.roots.map((root) => root.path) ?? [status.cwd]
    return listWorkspaceFiles(roots)
  })

  handle('mcp:set-enabled', async (_event, enabled: boolean) => {
    await saveConfig({ mcp: { ...desktopConfig.mcp, enabled: Boolean(enabled) } })
    await reloadPiConfig()
    const state = await buildMcpState()
    mainWindow?.webContents.send('mcp:state', state)
    return state
  })

  handle('mcp:set-desktop-tool', async (_event, enabled: boolean) => {
    await saveConfig({ mcp: { ...desktopConfig.mcp, desktopTool: Boolean(enabled) } })
    await reloadPiConfig()
    return buildMcpState()
  })

  handle('mcp:set-engine-enabled', async (_event, id: McpEngineId, enabled: boolean) => {
    const current = engineConfig()
    await saveConfig({
      mcp: {
        ...desktopConfig.mcp,
        engines: { ...current, [id]: { ...current[id], enabled: Boolean(enabled) } }
      }
    })
    await reloadPiConfig()
    const state = await buildMcpState()
    mainWindow?.webContents.send('mcp:state', state)
    return state
  })

  handle('mcp:set-engine-entry', async (_event, id: McpEngineId, entry: string | null) => {
    const current = engineConfig()
    const next = { ...current[id] }
    if (entry && entry.trim()) next.entry = entry.trim()
    else delete next.entry
    engines.invalidateDetection(id)
    await saveConfig({ mcp: { ...desktopConfig.mcp, engines: { ...current, [id]: next } } })
    await reloadPiConfig()
    return buildMcpState()
  })

  handle('mcp:refresh-engines', async () => {
    engines.invalidateDetection()
    return buildMcpState()
  })

  handle('mcp:build-index', async () => {
    const cwd = status.cwd
    const config = engineConfig().codegraph
    engineIndexStatus.codegraph = { state: 'indexing', message: cwd }
    void broadcastMcpState()
    const result = await engines.runCodegraphIndex(cwd, config)
    engineIndexStatus.codegraph = {
      state: result.ok ? 'indexed' : 'failed',
      message: result.message
    }
    void broadcastMcpState()
    return result
  })

  handle('mcp:set-tool', async (_event, server: string, tool: string, enabled: boolean) => {
    const toggles = { ...toolToggles() }
    const next = { ...(toggles[server] ?? {}) }
    if (enabled) delete next[tool]
    else next[tool] = false
    if (Object.keys(next).length === 0) delete toggles[server]
    else toggles[server] = next
    await saveConfig({ mcp: { ...desktopConfig.mcp, toolToggles: toggles } })
    await reloadPiConfig()
    return buildMcpState()
  })

  handle('mcp:set-morph-key', async (_event, key: string | null) => {
    const next = { ...desktopConfig.mcp }
    if (key && key.trim()) next.morphApiKey = key.trim()
    else delete next.morphApiKey
    await saveConfig({ mcp: next })
    await reloadPiConfig()
    return buildMcpState()
  })

  /**
   * WarpGrep backend: an OpenAI-compatible endpoint plus its model and key. Empty `baseUrl` goes
   * back to the hosted Morph model; an empty key falls back to the stored provider credential.
   */
  handle(
    'mcp:set-warpgrep',
    async (_event, patch: { baseUrl?: string | null; model?: string | null; apiKey?: string | null }) => {
      const current = { ...(desktopConfig.mcp?.warpgrep ?? {}) }
      if ('baseUrl' in patch) {
        // The value is an OpenAI-compatible chat base URL (`…/v1`); refuse Anthropic-protocol
        // addresses here instead of letting a search fail on a 404 two steps later.
        const endpoint = checkWarpgrepEndpoint(patch.baseUrl)
        if (endpoint.error) throw new Error(endpoint.error)
        if (endpoint.baseUrl) current.baseUrl = endpoint.baseUrl
        else delete current.baseUrl
      }
      if ('model' in patch) {
        const model = patch.model?.trim()
        if (model) current.model = model
        else delete current.model
      }
      if ('apiKey' in patch) {
        const key = patch.apiKey?.trim()
        if (key) current.apiKey = key
        else delete current.apiKey
      }
      const next = { ...desktopConfig.mcp }
      if (Object.keys(current).length > 0) next.warpgrep = current
      else delete next.warpgrep
      await saveConfig({ mcp: next })
      await reloadPiConfig()
      return buildMcpState()
    }
  )

  handle('mcp:set-brave-key', async (_event, key: string | null) => {
    await saveWebConfig({ braveApiKey: key && key.trim() ? key.trim() : undefined })
    await reloadPiConfig()
    return buildMcpState()
  })

  handle('mcp:set-web-mode', async (_event, mode: 'auto' | 'brave' | 'native') => {
    const next = mode === 'brave' || mode === 'native' ? mode : 'auto'
    // The route is resolved per call, so no restart is needed here.
    await saveWebConfig({ mode: next })
    void broadcastMcpState()
    return buildMcpState()
  })

  handle(
    'mcp:set-provider-web-search',
    async (_event, providerId: string, enabled: boolean) => {
      if (typeof providerId !== 'string' || !providerId.trim()) return buildMcpState()
      const before = webReady()
      const current = webConfig().native ?? {}
      const native = { ...current }
      if (enabled) native[providerId.trim()] = true
      else delete native[providerId.trim()]
      await saveWebConfig({ native })
      // Turning the last backend on/off changes whether the gateway registers `/mcp/web` at all, so
      // that transition needs the same restart as any other registration change.
      if (webReady() !== before) await reloadPiConfig()
      else void broadcastMcpState()
      return buildMcpState()
    }
  )

  handle('mcp:set-subagents', async (_event, enabled: boolean) => {
    await saveConfig({
      mcp: {
        ...desktopConfig.mcp,
        subagents: { ...(desktopConfig.mcp?.subagents ?? {}), enabled: Boolean(enabled) }
      }
    })
    await reloadPiConfig()
    return buildMcpState()
  })

  handle('agents:set-exposure', async (_event, exposure: 'prompt' | 'lazy' | 'hidden') => {
    await agents.saveExposure(app.getPath('userData'), exposure)
    await reloadPiConfig()
    return buildMcpState()
  })

  handle('engine:commands', () => listEngineCommands(currentEngine))
  handle('engine:codex-questions', async (_event, enabled: boolean) => {
    // Like the sandbox mode this is a spawn-time override, so an active Codex session restarts.
    await saveConfig({ codexRequestUserInput: Boolean(enabled) })
    if (currentEngineId() === 'codex') await reloadPiConfig()
    return { ok: true }
  })
  handle('engine:sandbox', async (_event, mode: string) => {
    if (!['default', 'read-only', 'workspace-write'].includes(mode))
      return { ok: false, error: '无效的沙箱模式' }
    await saveConfig({
      codexSandbox: mode === 'default' ? undefined : (mode as 'read-only' | 'workspace-write')
    })
    if (currentEngineId() === 'codex') await reloadPiConfig()
    return { ok: true }
  })
  handle('engine:command', (_event, name: string, args: string) => {
    const owner = currentEngine
    return executeEngineCommand(owner, name, args, async () => {
      if (owner === currentEngine) await syncAutoCompact({ restart: true })
    }, () => selectableModels(owner))
  })

  handle('pi:compact', async (_event, instructions?: string) => {
    if (!currentEngine.capabilities().compact) return { ok: false, error: '当前引擎不支持压缩' }
    // Compacting the fork would summarize the throwaway branch and leave the real session alone.
    if (btwActive) await closeSideChat()
    try {
      const result = await currentEngine.compact(instructions)
      return { ok: true, summary: result.summary }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * Auto-compaction toggle. Turning it on also writes the reserve that makes pi compact at
   * `autoCompactRatio()` of the current model's window, then restarts pi so it reads that value.
   */
  handle('pi:set-auto-compact', async (_event, enabled: boolean) => {
    if (currentEngine.capabilities().autoCompaction !== 'configurable')
      return { ok: false, error: '自动压缩由当前引擎原生管理' }
    try {
      await currentEngine.setAutoCompaction({ enabled })
      if (currentEngine.id === 'pi') await providers.setCompactionSettings({ enabled })
      autoCompactEnabled = enabled
      await saveConfig({ autoCompact: { ...desktopConfig.autoCompact, enabled } })
      broadcastStatus()
      if (!enabled) return { ok: true }
      const reserveTokens = await syncAutoCompact({ restart: true })
      if (currentEngine.id === 'prophey')
        return {
          ok: true,
          percent: compactionPercent(autoCompactRatio()),
          contextWindow: status.model?.contextWindow
        }
      const percent = compactionPercent(autoCompactRatio())
      if (reserveTokens === undefined) {
        return {
          ok: true,
          percent,
          warning: '当前模型没有上下文窗口信息，自动压缩沿用 pi 的默认余量（16K tokens）'
        }
      }
      return { ok: true, percent, contextWindow: status.model?.contextWindow, reserveTokens }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * `/autocompact 500000`: compact once the context passes that many tokens.
   *
   * The number is stored as a ratio of the window, so a later model switch recomputes it instead of
   * keeping a token count that no longer means anything. Setting a threshold also turns compaction
   * back on: the window's meter and the settings row read `autoCompactPercent`, so leaving
   * `autoCompactEnabled` false here made the UI keep claiming "已关闭 / 90%".
   */
  handle('pi:set-compact-threshold', async (_event, tokens: number) => {
    if (currentEngine.capabilities().autoCompaction !== 'configurable')
      return { ok: false, error: '自动压缩由当前引擎原生管理' }
    try {
      const contextWindow = status.model?.contextWindow
      const ratio = ratioFromTokens(tokens, contextWindow)
      const reserveTokens = reserveFor(contextWindow!, ratio)
      if (currentEngine.id === 'pi')
        await providers.setCompactionSettings({ enabled: true, reserveTokens })
      await saveConfig({ autoCompact: { ratio, enabled: true } })
      autoCompactEnabled = true
      await currentEngine.setAutoCompaction({ enabled: true, reserveTokens })
      broadcastStatus()
      if (btwActive) await closeSideChat()
      await startPi(status.cwd, sessionArgs())
      return {
        ok: true,
        contextWindow,
        reserveTokens,
        percent: compactionPercent(autoCompactRatio())
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * The settings row: auto-compaction starts at this percentage of the model's window.
   *
   * Stored as a ratio (like `/autocompact`) so switching to a model with a different window keeps
   * the same *proportion*; the reserve is recomputed with it. A threshold is only meaningful while
   * compaction is on, so setting one turns it back on.
   */
  handle('pi:set-auto-compact-ratio', async (_event, percent: number) => {
    if (currentEngine.capabilities().autoCompaction !== 'configurable')
      return { ok: false, error: '自动压缩由当前引擎原生管理' }
    try {
      const ratio = ratioFromPercent(percent)
      const value = Math.round(ratio * 100)
      await saveConfig({ autoCompact: { ratio, enabled: true } })
      autoCompactEnabled = true
      if (currentEngine.id === 'pi') await providers.setCompactionSettings({ enabled: true })
      // `syncAutoCompact` only restarts when the reserve changes, so make the switch effective for
      // the process that is running right now (it may have been left with compaction off).
      if (currentEngine.running()) {
        await currentEngine.setAutoCompaction({ enabled: true }).catch(() => undefined)
      }
      broadcastStatus()
      const reserveTokens = await syncAutoCompact({ restart: true })
      if (currentEngine.id === 'prophey')
        return { ok: true, percent: value, contextWindow: status.model?.contextWindow }
      if (reserveTokens === undefined) {
        return {
          ok: true,
          percent: value,
          warning: '当前模型没有上下文窗口信息，阈值会在切到有窗口的模型后生效'
        }
      }
      return { ok: true, percent: value, contextWindow: status.model?.contextWindow, reserveTokens }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * `/btw <question>`: open a side chat on a *fresh fork* of the current branch.
   *
   * `clone` duplicates the session at its current position, so the fork starts exactly at the branch
   * node the user is looking at — same as asking a subagent, except the fork carries this
   * conversation's context. The fork stays alive while the panel is open (follow-ups keep talking to
   * it) and is thrown away when the panel closes.
   *
   * `/btw` is a local command, so it is never queued behind the run: if pi is still working, the
   * fork is taken as soon as it settles, and a second `/btw` replaces the previous fork with a new
   * branch from the node the user is on now.
   */
  handle('pi:btw-start', async (_event, question: string) => {
    const trimmed = question.trim()
    if (!trimmed) return { ok: false, error: '缺少问题' }
    if (!currentEngine.running()) return { ok: false, error: 'pi 未运行' }
    if (btwActive) await closeSideChat()
    const generation = ++btwGeneration
    if (currentEngine.busy() && !(await currentEngine.waitForIdle(600_000))) {
      return { ok: false, error: '当前回合还没结束，稍后再问' }
    }
    if (generation !== btwGeneration) return { ok: false, error: '侧边提问已取消' }
    const original = status.sessionFile
    if (!original) return { ok: false, error: '当前会话还没有保存到文件，先发一条消息' }
    btwActive = true
    btwOriginal = original
    try {
      // `fork` requires a specific entry id and rejects the leaf; `clone` is the snapshot we want.
      const forkPath = await currentEngine.clone()
      if (forkPath) btwFork = forkPath
      const answer = await btwPrompt(trimmed)
      return { ok: true, answer: answer.text, settled: answer.settled, forkPath: btwFork }
    } catch (error) {
      await closeSideChat()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** Follow-up turn inside the open side chat: same fork, same context. */
  handle('pi:btw-ask', async (_event, question: string) => {
    const trimmed = question.trim()
    if (!trimmed) return { ok: false, error: '缺少问题' }
    if (!btwActive) return { ok: false, error: '侧边提问已经关闭了' }
    if (currentEngine.busy() && !(await currentEngine.waitForIdle(600_000))) {
      return { ok: false, error: '上一轮还在回答，稍等一下' }
    }
    if (!btwActive) return { ok: false, error: '侧边提问已经关闭了' }
    try {
      const answer = await btwPrompt(trimmed)
      return { ok: true, answer: answer.text, settled: answer.settled }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('pi:btw-close', async () => {
    await closeSideChat()
    return { ok: true }
  })

  handle('agents:save-preset', async (_event, draft: agents.PresetDraft) => {
    try {
      await agents.savePreset(app.getPath('userData'), draft)
      await refreshAgents()
      await reloadPiConfig()
      return { ok: true, state: await buildMcpState() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('agents:delete-preset', async (_event, id: string) => {
    try {
      await agents.deletePreset(app.getPath('userData'), id)
      await refreshAgents()
      await reloadPiConfig()
      return { ok: true, state: await buildMcpState() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('agents:open-config', async () => {
    await agents.ensureAgentsFile(app.getPath('userData'))
    await shell.openPath(agents.agentsFilePath(app.getPath('userData')))
  })

  handle('mcp:choose-engine-entry', async () => {
    const filters =
      process.platform === 'win32'
        ? [{ name: 'CodeGraph', extensions: ['exe', 'cmd', 'js'] }]
        : [{ name: 'Executable', extensions: [''] }]
    const result = await dialog.showOpenDialog({
      title: '选择 CodeGraph 入口',
      properties: ['openFile'],
      filters
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle('mcp:set-server-enabled', async (_event, name: string, enabled: boolean) => {
    try {
      await mcp.setServerEnabled(name, Boolean(enabled))
      await reloadPiConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('mcp:remove-server', async (_event, name: string) => {
    try {
      await mcp.removeServer(name)
      await reloadPiConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('mcp:add-server', async (_event, name: string, config: string) => {
    try {
      await mcp.addServer(name, config)
      await reloadPiConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('mcp:open-config', (_event, which: 'user' | 'project') =>
    mcp.openConfig(status.cwd, which === 'project' ? 'project' : 'user')
  )

  handle(
    'providers:start-login',
    async (_event, providerId: string, type: 'api_key' | 'oauth', loginId: string) => {
      await applySystemProxy()
      return providers.startLogin(
        providerId,
        type,
        loginId,
        sendLoginMessage,
        () => {
          invalidateChatGptUsage()
          void reloadPiConfig()
        },
        { deviceId: await getDeviceId() }
      )
    }
  )

  handle(
    'providers:answer-login',
    (_event, loginId: string, promptId: string, value: string) => {
      providers.answerLogin(loginId, promptId, value)
    }
  )

  handle('providers:cancel-login', (_event, loginId: string) => {
    providers.cancelLogin(loginId)
  })

  handle('providers:logout', async (_event, providerId: string) => {
    try {
      await providers.logoutProvider(providerId)
      invalidateChatGptUsage()
      await reloadPiConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('providers:models-json', () => providers.getModelsJson())

  handle('providers:save-models-json', async (_event, content: string) => {
    try {
      await providers.saveModelsJson(content)
      await reloadPiConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('providers:open-models-json', async () => {
    const file = await providers.getModelsJson()
    await fs.mkdir(path.dirname(file.path), { recursive: true })
    try {
      await fs.access(file.path)
    } catch {
      await fs.writeFile(file.path, file.content)
    }
    await shell.openPath(file.path)
  })

  handle('settings:get', () => providers.getAppSettings())

  handle(
    'settings:save',
    async (
      _event,
      patch: Partial<Pick<AppSettings, 'defaultProvider' | 'defaultModel' | 'defaultThinkingLevel'>>
    ) => {
      try {
        await providers.saveAppSettings(patch)
        await reloadPiConfig()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handle('settings:models', () => providers.listModelChoices())

  handle('pi:list-models', async () => {
    if (!currentEngine.running()) return []
    try {
      const models = await selectableModels(currentEngine)
      const names = new Map<string, string>()
      try {
        for (const provider of await providers.listProviders()) {
          names.set(provider.id, provider.name)
        }
      } catch {
        // provider display names are optional
      }
      const patterns = currentEngine.capabilities().providerSettings
        ? await providers.getEnabledModelPatterns().catch(() => [])
        : []
      return models
        .map((model) => {
          const provider = String(model.provider ?? '')
          return {
            provider,
            id: String(model.id ?? ''),
            name: typeof model.name === 'string' ? model.name : undefined,
            contextWindow:
              typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
            providerName: names.get(provider) ?? provider,
            reasoning: Boolean(model.reasoning)
          }
        })
        .filter((model) => providers.isModelEnabled(model, patterns))
    } catch {
      return []
    }
  })

  handle('pi:set-model', async (_event, provider: string, modelId: string) => {
    if (!currentEngine.running()) return { ok: false, error: 'pi 未运行' }
    try {
      if (currentEngine.busy()) throw new Error('请等当前回合结束后切换模型')
      const models = await currentEngine.models()
      if (!models.some(model => model.provider === provider && model.id === modelId)) {
        throw new Error('只能选择当前 agent 可用且已配置的模型')
      }
      if (currentEngine.capabilities().providerSettings) {
        const choices = await providers.listModelChoices()
        if (!choices.some(model => model.provider === provider && model.id === modelId)) throw new Error('请先在服务商中配置并启用这个模型')
      }
      await currentEngine.setModel(provider, modelId)
      // Remember it for this conversation: the engines keep one global default, so the choice
      // would otherwise be lost the next time another session is opened.
      void rememberSession()
      // A different window means a different 90% point; pi only reads the reserve at startup, so
      // this restarts when (and only when) the number actually changed.
      await syncAutoCompact({ restart: true }).catch(() => undefined)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('pi:list-thinking-levels', async () => {
    if (!currentEngine.running()) return []
    try {
      return currentEngine.thinkingLevels()
    } catch {
      return []
    }
  })

  handle('pi:set-thinking-level', async (_event, level: string) => {
    if (!currentEngine.running()) return { ok: false, error: 'pi 未运行' }
    try {
      if (currentEngine.busy()) throw new Error('请等当前回合结束后调整思考等级')
      if (!(await currentEngine.thinkingLevels()).includes(level)) throw new Error('当前模型不支持这个思考等级')
      await currentEngine.setThinkingLevel(level)
      setStatus({ thinkingLevel: level })
      void rememberSession()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * Speed / processing tier: OpenAI `service_tier`, Anthropic `speed: fast`.
   *
   * The extension reads it from the environment at load, so the switch restarts pi (deferred while a
   * run is in flight, like every other setting that changes the child's env).
   */
  handle('pi:set-speed-mode', async (_event, mode: SpeedMode) => {
    const support = speed.speedSupport(status.model)
    if (!support.available.includes(mode)) {
      return {
        ok: false,
        error: support.note ?? `${status.model?.id ?? '当前模型'} 不支持这个速度档位`
      }
    }
    await saveConfig({ speed: { mode } })
    broadcastStatus()
    await reloadPiConfig()
    return { ok: true, speed: speed.speedState(status.model, mode) }
  })

  handle('providers:list-provider-models', (_event, providerId: string) =>
    providers.listProviderModels(providerId)
  )

  handle(
    'providers:set-provider-models',
    async (_event, providerId: string, enabledIds: string[]) => {
      try {
        await providers.setProviderModels(providerId, enabledIds)
        await reloadPiConfig()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * Custom endpoint for a built-in provider, stored as `models.json.providers.<id>.baseUrl`.
   *
   * pi reads that file at startup, so the session is restarted; the web engine resolves the same
   * value through `providers.getRuntime()`, which `setProviderBaseUrl` already invalidated.
   */
  handle(
    'providers:set-base-url',
    async (_event, providerId: string, baseUrl: string | null) => {
      try {
        await providers.setProviderBaseUrl(providerId, baseUrl)
        await reloadPiConfig()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}

/**
 * Where a WarpGrep search's key comes from, so the settings pane can say it out loud instead of
 * asking the user to paste a key they already stored.
 */
export interface WarpGrepCredential {
  apiKey?: string
  source: 'own' | 'provider' | 'morph' | 'none'
  /** Provider id whose logged-in credential is reused (`source: 'provider'`). */
  provider?: string
}

/** The own key, else the provider the endpoint belongs to, else Morph's. */
async function warpgrepCredential(baseUrl?: string): Promise<WarpGrepCredential> {
  const configured = desktopConfig.mcp?.warpgrep ?? {}
  const own = configured.apiKey?.trim()
  if (own) return { apiKey: own, source: 'own' }
  if (baseUrl) {
    const provider = /deepseek/i.test(baseUrl)
      ? 'deepseek'
      : /openai/i.test(baseUrl)
        ? 'openai'
        : undefined
    if (provider) {
      const key = await providers.providerApiKey(provider)
      if (key) return { apiKey: key, source: 'provider', provider }
    }
  }
  const morph = desktopConfig.mcp?.morphApiKey?.trim()
  if (morph) return { apiKey: morph, source: 'morph' }
  return { source: 'none' }
}

/**
 * The WarpGrep backend actually used: a custom OpenAI-compatible endpoint when one is configured,
 * else the hosted Morph model. The key falls back to the provider credential the user already
 * stored (DeepSeek / OpenAI), so a custom URL never asks for the same key twice.
 */
async function warpgrepBackend(): Promise<{ baseUrl?: string; model?: string; apiKey?: string }> {
  const configured = desktopConfig.mcp?.warpgrep ?? {}
  const baseUrl = configured.baseUrl?.trim() || undefined
  const model = configured.model?.trim() || undefined
  const { apiKey } = await warpgrepCredential(baseUrl)
  return { baseUrl, model, apiKey }
}

/**
 * The WarpGrep card's view of the backend: what is configured, plus the credential a search would
 * use right now and where it came from — the pane shows that instead of asking for a key again.
 */
async function warpgrepState(): Promise<McpState['warpgrep']> {
  const configured = desktopConfig.mcp?.warpgrep ?? {}
  const baseUrl = configured.baseUrl?.trim() || undefined
  const credential = await warpgrepCredential(baseUrl)
  const hint = credential.apiKey ? maskKey(credential.apiKey) : undefined
  return {
    baseUrl,
    model: configured.model?.trim() || undefined,
    /** The key saved on the endpoint itself; empty means the fallbacks below are in play. */
    keyHint: maskKey(configured.apiKey),
    keySource: credential.source,
    activeKey: hint
      ? {
          source: credential.source === 'none' ? 'morph' : credential.source,
          hint,
          ...(credential.provider ? { provider: credential.provider } : {})
        }
      : undefined
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#17181b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#17181b',
      symbolColor: '#b9bbc2',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** Bounded restarts: an extension that crashes on every start must not loop forever. */
let crashRestarts = 0
let crashWindowStart = 0
let shuttingDown = false

function handleExit(): void {
  if (status.phase === 'stopped') return
  setStatus({
    phase: 'error',
    error: currentEngine.stderrTail() || 'pi 进程已退出',
    isStreaming: false
  })
  if (shuttingDown || switchingEngine) return
  // pi died on its own (a crashing extension, an OOM kill). Leaving the window dead means the next
  // message is lost with "pi 未运行", so bring it back on the same session.
  const now = Date.now()
  if (now - crashWindowStart > 120_000) {
    crashWindowStart = now
    crashRestarts = 0
  }
  if (crashRestarts >= 3) return
  crashRestarts += 1
  console.warn(`[pi] exited unexpectedly, restarting (${crashRestarts}/3)`)
  setTimeout(() => {
    if (!shuttingDown && !switchingEngine && !currentEngine.running() && !currentEngine.starting()) {
      void startPi(status.cwd, sessionArgs())
    }
  }, 1000)
}

app.whenReady().then(async () => {
  registerIpc()
  await migrateLegacyUserData()
  await applySystemProxy()
  desktopConfig = await loadConfig()
  if (!desktopConfig.defaultEngine) await saveConfig({ defaultEngine: currentEngineId() })
  const interruptedSwitch = desktopConfig.pendingEngineSwitch
  if (interruptedSwitch) {
    await saveConfig({ engine: interruptedSwitch.engine, cwd: interruptedSwitch.cwd,
      activeProject: interruptedSwitch.activeProject, propheySessionId: interruptedSwitch.propheySessionId,
      engineSessions: { ...desktopConfig.engineSessions, [interruptedSwitch.engine]: interruptedSwitch.session } })
  }
  // Projects live beside the config, in userData; the store reads the file on first use.
  projectStore = new projects.ProjectStore(path.join(app.getPath('userData'), 'projects.json'))
  await projectStore.load().catch(() => undefined)
  // The window's session list: ids, titles and workspaces we own; pi's files are engine storage.
  sessionStore = new SessionStore(path.join(app.getPath('userData'), 'sessions.json'))
  await sessionStore.load().catch(() => undefined)
  if (interruptedSwitch?.record) {
    await sessionStore.upsert(interruptedSwitch.record, true)
    await saveConfig({ activeSession: toSummary(interruptedSwitch.record).path })
  }
  if (interruptedSwitch) await saveConfig({ pendingEngineSwitch: undefined })
  const activeRecord = desktopConfig.activeSession ? sessionStore.byPath(desktopConfig.activeSession) : undefined
  if (activeRecord?.engine) await saveConfig({ engine: activeRecord.engine, cwd: activeRecord.cwd, activeProject: activeRecord.projectId })
  if (desktopConfig.engine !== 'pi' && !desktopConfig.propheySessionId) {
    await saveConfig({ propheySessionId: `s_${Math.random().toString(16).slice(2, 14)}` })
  }
  currentEngine = createEngine()
  currentEngine.poll()
  // Before anything reads a provider, model list or MCP config: point the modules at the profile.
  applyProfile()
  await loadToolCache()
  // Web tools resolve their backend per call, so a model switch or a config edit needs no restart.
  web.configure({
    config: () => webConfig(),
    provider: () => status.model?.provider,
    model: () => status.model?.id
  })
  const cwd = desktopConfig.cwd || process.env.PI_DESKTOP_CWD || process.cwd()
  status = { phase: 'stopped', cwd }
  await startBridge()
  bridge.setAskListener((request) => {
    request.sessionKey ??= currentEngine.state().sessionFile
    if (mainWindow) mainWindow.webContents.send('ask:request', request)
    else bridge.cancelAsk(request.id, '桌面窗口未就绪')
  })
  bridge.setAskSettledListener(id => mainWindow?.webContents.send('ask:cleared', { id }))
  bridge.setToolsListener((servers) => {
    const next: ToolCache = { ...toolCache }
    for (const [server, tools] of Object.entries(servers)) {
      next[server] = tools
    }
    void saveToolCache(next).then(() => broadcastMcpState())
  })
  bridge.setMcpHandler((engine, message, scope) => {
    if (scope) engine = scope + '/' + engine
    // Endpoints are `codegraph`, `codegraph__<repo>`, `warpgrep`, … — a project adds one per root.
    if (!gateway.isConfigured(engine)) {
      return Promise.reject(new Error(`未知网关端点：${engine}`))
    }
    return scope ? web.withWebModel(bridge.clientContext(scope)?.model ?? {}, () => gateway.handleMessage(engine, message))
      : gateway.handleMessage(engine, message)
  })
  bridge.setApiHandler(
    createApiHandler({
      agentSettings: () => agentSettings,
      subagents: () => subagentManager(),
      listModels: (options) =>
        providers.listModelChoices({ includeUnconfigured: !options.configuredOnly }),
      defaultMode: () => subagentConfig().defaultMode,
      desktopTools: () => subagentConfig().desktopTools,
      parentSession: () => status.sessionFile,
      engine: currentEngineId,
      parentWorkspace: () => currentEngine.workspace(),
      parentModel: () => status.model,
      resolveModel: (provider, id) => providers.resolveModelChoice(provider, id)
    })
  )
  createWindow()
  updates.setupUpdates((next) => mainWindow?.webContents.send('app-update', next))
  console.log(
    '[mcp] settings=',
    JSON.stringify(mcpSettings()),
    'available=',
    desktopToolAvailable(),
    'extension=',
    desktopExtensionPath(),
    'script=',
    mcpServerScript()
  )
  // Warm the model runtime in the background so the first Settings open is instant.
  await refreshAgents()
  // Restores the subagent records of previous runs, so the panel and the tools can query them.
  subagentManager()
  void providers.listProviders().catch(() => undefined)
  void providers.listModelChoices().catch(() => undefined)
  // Keep the compaction reserve matched to whatever model the session restores.
  void providers
    .getAppSettings()
    .then((settings) => {
      autoCompactEnabled =
        currentEngine.id === 'pi'
          ? settings.compaction?.enabled !== false
          : desktopConfig.autoCompact?.enabled !== false
      broadcastStatus()
    })
    .catch(() => undefined)
  const savedSession = activeRecord?.path || desktopConfig.engineSessions?.[currentEngineId()]
  void startPi(cwd, savedSession ? ['--session', savedSession] : [])
    .then(() => syncAutoCompact())
    .then(() => broadcastMcpState())
    .catch((error) => {
      setStatus({ phase: 'error', error: String(error) })
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

async function startBridge(): Promise<void> {
  const config = desktopConfig.mcp ?? {}
  const token = config.bridgeToken ?? randomUUID()
  try {
    const info = await bridge.startBridge({ preferredPort: config.bridgePort, token })
    if (config.bridgePort !== info.port || config.bridgeToken !== token) {
      await saveConfig({ mcp: { ...desktopConfig.mcp, bridgePort: info.port, bridgeToken: token } })
    }
  } catch (error) {
    console.error('[bridge] failed to start:', error instanceof Error ? error.message : error)
  }
}

app.on('window-all-closed', () => {
  shuttingDown = true
  cancelPendingAsks('桌面窗口已关闭')
  currentEngine.dispose()
  for (const slot of parkedEngines.values()) slot.engine.dispose()
  parkedEngines.clear()
  subagents?.stopAll(true)
  gateway.stopAll(true)
  status = { ...status, phase: 'stopped' }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  shuttingDown = true
  // Synchronous on purpose: a pending draft is worthless if the process exits before fs finishes.
  composerStore.flushSync()
  bridge.cancelAllAsks('桌面端已退出')
  for (const slot of parkedEngines.values()) slot.engine.dispose()
  parkedEngines.clear()
  subagents?.stopAll(true)
  gateway.stopAll(true)
  bridge.stopBridge()
  // A `/btw` fork is a throwaway branch: do not leave it behind as an orphan session.
  if (btwFork) {
    try {
      unlinkSync(btwFork)
    } catch {
      // already gone
    }
  }
  currentEngine.dispose()
})
