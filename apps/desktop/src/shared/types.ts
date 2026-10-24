import type { EngineCapabilities, EngineCommand, EngineId } from "./engine";
import type { ChatGptUsageResult } from "./chatgpt-usage";
export interface PiModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  /** Wire API of the provider (`openai-responses`, `anthropic-messages`, …); decides speed support. */
  api?: string;
}

export interface ModelOption extends PiModel {
  providerName?: string;
  reasoning?: boolean;
}

/**
 * Processing tier of a request. `standard` sends nothing; the others map to the vendor's own knob
 * (OpenAI `service_tier`, Anthropic `speed: fast` plus a beta header).
 */
export type SpeedMode = "standard" | "fast" | "ultrafast";

export interface PiSpeedState {
  mode: SpeedMode;
  /** Modes the active model accepts, always including `standard`. */
  available: SpeedMode[];
  /** Why the other modes are missing, when there is something to explain. */
  note?: string;
}

export interface PiStatus {
  runningSessionKeys?: string[];
  sessionLocked?: boolean;
  activity?: { label: string; since: number };
  backgroundTasks?: Array<{ id: string; command: string; startedAt: number }>;
  /** Background commands of this session that already finished; the session panel counts them. */
  backgroundFinished?: number;
  /** A context transfer owns the engine; queued prompts and mutations must wait. */
  switchingEngine?: EngineId;
  engine?: EngineId;
  capabilities?: EngineCapabilities;
  phase: "starting" | "ready" | "error" | "stopped";
  cwd: string;
  model?: PiModel;
  thinkingLevel?: string;
  sessionName?: string;
  sessionFile?: string;
  /** Stable sidebar identity; sessionFile remains the engine-private storage location. */
  sessionKey?: string;
  isStreaming?: boolean;
  /** pi is rewriting the context; prompts are refused until it finishes. */
  compacting?: boolean;
  /** Percentage of the window at which auto-compaction starts; absent when it is off. */
  autoCompactPercent?: number;
  /** The repository the active session works on (a session is scoped to one repo). */
  repo?: RepoInfo;
  /** Processing tier of the next request, plus what the active model supports. */
  speed?: PiSpeedState;
  error?: string;
  stderrTail?: string;
}

export interface SessionSummary {
  path: string;
  engine?: EngineId;
  projectId?: string;
  additional?: string[];
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One repository inside a project. `primary` is the agent's working directory; the others are
 * reachable with absolute paths.
 */
export interface ProjectRoot {
  path: string;
  name: string;
  primary?: boolean;
}

/**
 * A project groups several repositories so one conversation can work across them. Sessions still
 * belong to a single repository (the primary root); the project is the layer above that.
 */
export interface Project {
  id: string;
  name: string;
  roots: ProjectRoot[];
  createdAt: number;
  updatedAt: number;
}

/**
 * The repository a session belongs to. A session is scoped to one git repository (multi-repo
 * "projects" are a later layer), so this is what the sidebar groups by and what the header shows.
 */
export interface RepoInfo {
  /** Absolute git toplevel, and the session's working directory. */
  root: string;
  name: string;
  isRepo: boolean;
  branch?: string;
  remote?: string;
  dirty?: number;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
}

export interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | "system" | "custom";
  content: string | ContentBlock[];
  timestamp?: number;
  provider?: string;
  model?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
}

export interface SessionStats {
  tokens?: { input?: number; output?: number; total?: number };
  cost?: number;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number;
    percent?: number | null;
  };
}

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PromptResult {
  ok: boolean;
  disposition?: "started" | "queued" | "handled";
  /** pi was busier than the window thought and queued the message instead of rejecting it. */
  queued?: boolean;
  error?: string;
}

export interface SwitchResult {
  ok: boolean;
  error?: string;
}

/**
 * Every session switch replaces the engine, so a running turn would be killed. The window asks the
 * user first and then passes `stop`; without it the main process refuses the switch.
 */
export interface SessionSwitchOptions {
  stop?: boolean;
}

export type ProviderAuthType = "api_key" | "oauth";

export interface ProviderAuthOption {
  type: ProviderAuthType;
  label: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  modelCount: number;
  options: ProviderAuthOption[];
  configured: boolean;
  builtin: boolean;
  source?: string;
  sourceLabel?: string;
  storedType?: ProviderAuthType;
  /** `models.json` override for this provider's endpoint, when one is set. */
  baseUrl?: string;
  /** True for the providers whose endpoint the window may override. */
  baseUrlEditable?: boolean;
}

export interface LoginPromptOption {
  id: string;
  label: string;
  description?: string;
}

export interface LoginPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: LoginPromptOption[];
}

export interface LoginInfoLink {
  url: string;
  label?: string;
}

export type LoginEvent =
  | { type: "info"; message: string; links?: LoginInfoLink[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export type LoginMessage =
  | { kind: "prompt"; loginId: string; promptId: string; prompt: LoginPrompt }
  | { kind: "event"; loginId: string; event: LoginEvent }
  | {
      kind: "done";
      loginId: string;
      ok: boolean;
      error?: string;
      credentialType?: ProviderAuthType;
    };

export interface ModelsJsonFile {
  path: string;
  content: string;
}

export interface AppSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  enabledModels: string[];
  settingsPath: string;
  modelsPath: string;
  authPath: string;
  /** Auto-compaction as `~/.pi/agent/settings.json` has it, plus the percentage we target. */
  compaction?: {
    enabled: boolean;
    /** Free context pi keeps below the window; compaction starts at `window - reserveTokens`. */
    reserveTokens?: number;
    /** Where that reserve puts the trigger, as a percentage of the window. */
    thresholdPercent?: number;
  };
}

export interface ProviderModelOption {
  id: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  enabled: boolean;
}

export interface ModelChoice {
  provider: string;
  providerName: string;
  id: string;
  name?: string;
  contextWindow?: number;
  configured: boolean;
}

export interface DesktopConfig {
  defaultEngine?: EngineId;
  cwd: string;
  /** Where sessions are written: always pi's own `<agent dir>/sessions` tree. */
  sessionDir: string;
  sharedSessionDir: string;
  /** Project the window is working in, when one is selected. */
  activeProject?: string;
  /** Which engine runs the turn; also decides which MCP groups apply. */
  engine?: "pi" | "prophey" | "claude" | "codex";
  codexSandbox?: "read-only" | "workspace-write";
  /** Codex's experimental question tool (default on). */
  codexRequestUserInput?: boolean;
  /** What the active engine supports, so the window can hide the rest. */
  capabilities?: EngineCapabilities;
}

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "upToDate"
  | "downloading"
  | "preparing"
  | "installing"
  | "error";

export interface AppUpdateSnapshot {
  sequence: number;
  status: AppUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
  checkedAt: string | null;
  downloaded: number;
  total: number | null;
  autoCheck: boolean;
  canInstall: boolean;
  releasesUrl: string;
  error: { code: string; message: string } | null;
}

export interface ProxyInfo {
  proxy: string | null;
  source: "system" | "none";
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: AskOption[];
  /** Codex `isSecret`: the answer is confidential, so the panel masks it while typing. */
  secret?: boolean;
}

export interface AskRequest {
  id: string;
  questions: AskQuestion[];
  createdAt: number;
  tool?: string;
}

export interface AskAnswer {
  question: string;
  header?: string;
  selected: string[];
  other?: string;
  skipped?: boolean;
}

export type AskResult =
  | { cancelled: true; reason?: string }
  | { cancelled?: false; answers: AskAnswer[] };

export interface BridgeInfo {
  running: boolean;
  url: string;
  port: number;
  pending: number;
}

export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http";
  summary: string;
  enabled: boolean;
  exposure?: string;
  description?: string;
  source: "user" | "project" | "extension";
  builtin?: boolean;
}

export type McpEngineId = "codegraph" | "warpgrep" | "web";

export interface McpToolInfo {
  name: string;
  enabled: boolean;
  exposure?: string;
  /** Declared to the model directly instead of loaded through tool_search. */
  direct?: boolean;
}

export interface McpEngineState {
  id: McpEngineId;
  name: string;
  enabled: boolean;
  available: boolean;
  entry?: string;
  version?: string;
  error?: string;
  index?: "unknown" | "indexed" | "missing" | "indexing" | "syncing" | "failed";
  indexMessage?: string;
  tools: McpToolInfo[];
}

export interface SubagentPresetInfo {
  id: string;
  name: string;
  description: string;
  mode?: "sync" | "background";
  tools?: string[];
  model?: { provider: string; id: string; thinking?: string } | "inherit";
  appendSystemPrompt?: string;
  visible?: boolean;
  timeoutMs?: number;
  source: "builtin" | "user";
}

export interface AgentPresetDraft {
  id: string;
  name?: string;
  description?: string;
  mode?: "sync" | "background";
  tools?: string[] | null;
  model?:
    { provider: string; id: string; thinking?: string } | "inherit" | null;
  appendSystemPrompt?: string;
  visible?: boolean;
  timeoutMs?: number;
}

export interface SubagentState {
  enabled: boolean;
  exposure: "prompt" | "lazy" | "hidden";
  promptLimit: number;
  maxConcurrent: number;
  desktopTools: boolean;
  presets: SubagentPresetInfo[];
  running: number;
  configPath: string;
}

/** One subagent as the window sees it: no process handle, timestamps as numbers. */
export interface SubagentView {
  id: string;
  engine?: "pi" | "prophey";
  label?: string;
  agent?: string;
  mode: "sync" | "background";
  cwd: string;
  status: "starting" | "idle" | "streaming" | "error" | "stopped";
  model?: { provider: string; id: string };
  tools?: string[];
  messages: Array<{
    role: "assistant" | "user";
    text: string;
    ts: number;
    toolCalls?: string[];
  }>;
  calls: Array<{
    tool: string;
    ts: number;
    ok: boolean;
    summary?: string;
    durationMs?: number;
  }>;
  /** Assistant turn still streaming; cleared once the turn settles. */
  draft?: { text: string; thinking: string; ts: number };
  /** Tool calls in flight right now, rendered as running rows in the panel. */
  activeCalls?: Array<{
    id: string;
    tool: string;
    target?: string;
    startedAt: number;
  }>;
  finalText?: string;
  tokens?: number;
  runtimeMs?: number;
  createdAt: number;
  notify: "queue" | "wake" | "none";
  /** The subagent's own session file, for inspecting or resuming the run later. */
  sessionFile?: string;
  /** Session file of the conversation that started it. */
  parentSession?: string;
  /** Loaded from disk after a restart: the result stays queryable, the process does not. */
  restored?: boolean;
  error?: string;
}

/** `auto` = provider native when the active model's provider has it on, else Brave. */
export type WebSearchMode = "auto" | "brave" | "native";

/** Web search / fetch engine as the settings panel sees it. */
export interface McpWebState {
  enabled: boolean;
  /** At least one backend is usable (Brave key or an enabled native provider). */
  available: boolean;
  mode: WebSearchMode;
  /** Masked Brave key (`BSA…abcd`), never the key itself. */
  braveKeyHint?: string;
  count: number;
  maxChars: number;
  /** Providers whose own web search this app can call. */
  nativeSupported: string[];
  /** Providers the user turned native search on for. */
  nativeProviders: string[];
  /** Provider of the active model, which decides the route in `auto` mode. */
  activeProvider?: string;
  /** Backend the next `web_search` would use. */
  route: string;
  error?: string;
}

export interface McpState {
  enabled: boolean;
  desktopTool: boolean;
  desktopToolAvailable: boolean;
  desktopTools: McpToolInfo[];
  engines: McpEngineState[];
  web: McpWebState;
  subagents: SubagentState;
  /** Masked Morph API key (`sk-w_…abcd`), never the key itself. */
  morphKeyHint?: string;
  servers: McpServerInfo[];
  userConfigPath: string;
  projectConfigPath: string;
  bridge: BridgeInfo;
}

/** One turn of a `/btw` side chat: the fork's answer, or why it failed. */
export interface SideChatResult {
  ok: boolean;
  answer?: string;
  settled?: boolean;
  error?: string;
}

export interface PiBridge {
  getStatus(): Promise<PiStatus>;
  listWorkspaceFiles(): Promise<string[]>;
  restart(cwd?: string): Promise<PiStatus>;
  newProjectSession(cwd: string, options?: SessionSwitchOptions): Promise<PiStatus>;
  /** Repository facts for one directory (toplevel, branch, remote, dirty count). */
  repoInfo(dir?: string): Promise<RepoInfo>;
  /** Same lookup for several directories at once; keys are the resolved paths that were asked for. */
  listRepos(dirs: string[]): Promise<Record<string, RepoInfo>>;
  /** Repositories the user worked in, most recent first. */
  recentRepos(): Promise<string[]>;
  /** Folder picker without side effects, resolved to git roots. */
  pickFolders(title?: string): Promise<string[]>;
  /** Remember the current model/thinking level as this repository's default for new sessions. */
  saveRepoDefaults(): Promise<{ ok: boolean; error?: string }>;
  listProjects(): Promise<Project[]>;
  createProject(input: {
    name: string;
    roots: string[];
    primary?: string;
  }): Promise<{ ok: boolean; project?: Project; error?: string }>;
  updateProject(
    id: string,
    patch: { name?: string; roots?: string[]; primary?: string },
  ): Promise<{ ok: boolean; project?: Project; error?: string }>;
  /** Folder picker, then a project named after the first repository. */
  createProjectFromDialog(): Promise<{
    ok: boolean;
    project?: Project;
    cwd?: string;
    error?: string;
  }>;
  /** Folder picker, then that repository is appended to the project. */
  addProjectRoot(
    id: string,
  ): Promise<{ ok: boolean; project?: Project; error?: string }>;
  removeProject(id: string): Promise<{ ok: boolean }>;
  /** Restart pi on the project's primary repository (undefined clears the selection). */
  activateProject(
    id?: string,
    options?: SessionSwitchOptions,
  ): Promise<PiStatus | { ok: false; error: string }>;
  openSession(
    sessionPath: string,
    cwd: string,
    options?: SessionSwitchOptions,
  ): Promise<PiStatus>;
  getEngineCommands(): Promise<EngineCommand[]>;
  executeEngineCommand(
    name: string,
    args: string,
  ): Promise<{ ok: boolean; text?: string; error?: string }>;
  setEngineSandbox(
    mode: "read-only" | "workspace-write" | "default",
  ): Promise<{ ok: boolean; error?: string }>;
  /** Codex only: allow the model to ask questions through `request_user_input`. */
  setEngineCodexQuestions(
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }>;
  getDesktopConfig(): Promise<DesktopConfig>;
  /** Switch the engine; the main process rebuilds it and restarts the session. */
  setEngine(engine: "pi" | "prophey" | "claude" | "codex"): Promise<PiStatus>;
  setDefaultEngine(engine: EngineId): Promise<{ ok: boolean }>;
  getUpdateSnapshot(): Promise<AppUpdateSnapshot>;
  checkForUpdates(): Promise<AppUpdateSnapshot>;
  installUpdate(): Promise<AppUpdateSnapshot>;
  cancelUpdateDownload(): Promise<AppUpdateSnapshot>;
  setAutoUpdateCheck(enabled: boolean): Promise<AppUpdateSnapshot>;
  onUpdate(listener: (snapshot: AppUpdateSnapshot) => void): () => void;
  getProxyInfo(): Promise<ProxyInfo>;
  chooseWorkspace(options?: SessionSwitchOptions): Promise<PiStatus | null>;
  prompt(
    message: string,
    streamingBehavior?: "steer" | "followUp",
    images?: PromptImage[],
  ): Promise<PromptResult>;
  abort(): Promise<void>;
  newSession(options?: SessionSwitchOptions): Promise<SwitchResult>;
  switchSession(sessionPath: string): Promise<SwitchResult>;
  getMessages(): Promise<AgentMessage[]>;
  getSessionStats(): Promise<SessionStats>;
  /** Stop one background command (Prophey only; other engines report it as unsupported). */
  stopBackgroundTask(id: string): Promise<{ ok: boolean; error?: string }>;
  /** Reveal a file the session produced in the OS file manager; must live in the session workspace. */
  revealPath(path: string): Promise<{ ok: boolean; error?: string }>;
  listSessions(): Promise<SessionSummary[]>;
  openAgentDir(): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyImage(dataUrl: string): Promise<{ ok: boolean; error?: string }>;
  setTheme(theme: "dark" | "light"): Promise<void>;
  listModels(): Promise<ModelOption[]>;
  setModel(
    provider: string,
    modelId: string,
  ): Promise<{ ok: boolean; error?: string }>;
  listThinkingLevels(): Promise<string[]>;
  setThinkingLevel(level: string): Promise<{ ok: boolean; error?: string }>;
  /** Processing tier for the active model; restarts pi so the extension picks up the new value. */
  setSpeedMode(
    mode: SpeedMode,
  ): Promise<{ ok: boolean; error?: string; speed?: PiSpeedState }>;
  listProviderModels(providerId: string): Promise<ProviderModelOption[]>;
  setProviderModels(
    providerId: string,
    enabledIds: string[],
  ): Promise<{ ok: boolean; error?: string }>;
  /** `null` clears the override and puts the provider back on its default endpoint. */
  setProviderBaseUrl(
    providerId: string,
    baseUrl: string | null,
  ): Promise<{ ok: boolean; error?: string }>;
  listProviders(): Promise<ProviderInfo[]>;
  /** ChatGPT plan windows (5 h / weekly) for the OpenAI cards; `force` skips the short cache. */
  chatGptUsage(force?: boolean): Promise<ChatGptUsageResult>;
  startLogin(
    providerId: string,
    type: ProviderAuthType,
    loginId: string,
  ): Promise<{ loginId?: string; error?: string }>;
  answerLogin(loginId: string, promptId: string, value: string): Promise<void>;
  cancelLogin(loginId: string): Promise<void>;
  logoutProvider(providerId: string): Promise<{ ok: boolean; error?: string }>;
  onLoginMessage(listener: (message: LoginMessage) => void): () => void;
  getModelsJson(): Promise<ModelsJsonFile>;
  saveModelsJson(content: string): Promise<{ ok: boolean; error?: string }>;
  openModelsJson(): Promise<void>;
  getAppSettings(): Promise<AppSettings>;
  saveAppSettings(
    patch: Partial<
      Pick<
        AppSettings,
        "defaultProvider" | "defaultModel" | "defaultThinkingLevel"
      >
    >,
  ): Promise<{ ok: boolean; error?: string }>;
  listModelChoices(): Promise<ModelChoice[]>;
  getMcpState(): Promise<McpState>;
  setMcpEnabled(enabled: boolean): Promise<McpState>;
  setDesktopToolEnabled(enabled: boolean): Promise<McpState>;
  setMcpEngineEnabled(id: McpEngineId, enabled: boolean): Promise<McpState>;
  setMcpEngineEntry(id: McpEngineId, entry: string | null): Promise<McpState>;
  setMorphApiKey(key: string | null): Promise<McpState>;
  setBraveApiKey(key: string | null): Promise<McpState>;
  setWebSearchMode(mode: WebSearchMode): Promise<McpState>;
  setProviderWebSearch(providerId: string, enabled: boolean): Promise<McpState>;
  setSubagentsEnabled(enabled: boolean): Promise<McpState>;
  setAgentExposure(exposure: "prompt" | "lazy" | "hidden"): Promise<McpState>;
  openAgentsConfig(): Promise<void>;
  compactSession(
    instructions?: string,
  ): Promise<{ ok: boolean; summary?: string; error?: string }>;
  setAutoCompact(enabled: boolean): Promise<{
    ok: boolean;
    error?: string;
    /** Set when the model has no window, so pi's default reserve is kept. */
    warning?: string;
    /** Percentage of the window where compaction starts (absent when it is off). */
    percent?: number;
    contextWindow?: number;
    reserveTokens?: number;
  }>;
  /** Set the compaction trigger as a percentage of the model's window (10–99). */
  setAutoCompactRatio(percent: number): Promise<{
    ok: boolean;
    percent?: number;
    warning?: string;
    contextWindow?: number;
    reserveTokens?: number;
    error?: string;
  }>;
  setCompactThreshold(tokens: number): Promise<{
    ok: boolean;
    percent?: number;
    contextWindow?: number;
    reserveTokens?: number;
    error?: string;
  }>;
  startSideChat(question: string): Promise<SideChatResult>;
  askSideChat(question: string): Promise<SideChatResult>;
  closeSideChat(): Promise<{ ok: boolean }>;
  saveAgentPreset(
    draft: AgentPresetDraft,
  ): Promise<{ ok: boolean; error?: string; state?: McpState }>;
  deleteAgentPreset(
    id: string,
  ): Promise<{ ok: boolean; error?: string; state?: McpState }>;
  refreshMcpEngines(): Promise<McpState>;
  buildMcpIndex(): Promise<{ ok: boolean; message: string }>;
  setMcpToolEnabled(
    server: string,
    tool: string,
    enabled: boolean,
  ): Promise<McpState>;
  chooseMcpEngineEntry(): Promise<string | null>;
  onMcpState(listener: (state: McpState) => void): () => void;
  setMcpServerEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }>;
  removeMcpServer(name: string): Promise<{ ok: boolean; error?: string }>;
  addMcpServer(
    name: string,
    config: string,
  ): Promise<{ ok: boolean; error?: string }>;
  openMcpConfig(which: "user" | "project"): Promise<void>;
  onAskRequest(listener: (request: AskRequest) => void): () => void;
  onAskCleared(listener: () => void): () => void;
  answerQuestion(id: string, answers: AskAnswer[]): Promise<void>;
  cancelQuestion(id: string, reason?: string): Promise<void>;
  onEvent(listener: (record: Record<string, unknown>) => void): () => void;
  onStatus(listener: (status: PiStatus) => void): () => void;
  listSubagents(): Promise<SubagentView[]>;
  getSubagent(id: string): Promise<SubagentView | null>;
  stopSubagent(id: string): Promise<boolean>;
  promptSubagent(
    id: string,
    text: string,
    mode: "interrupt" | "steer" | "follow-up",
  ): Promise<boolean>;
  revealSubagentSession(file: string): Promise<boolean>;
  onSubagentUpdate(listener: (record: SubagentView) => void): () => void;
}
