import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppUpdateSnapshot,
  AskAnswer,
  McpState,
  PiBridge,
  PiStatus,
  PromptImage,
  Project,
  ProviderAuthType,
  RepoInfo,
  SessionMessages,
  SessionSummary,
  SpeedMode
} from '../shared/types'
/** Every subscription owns exactly one listener and returns its matching cleanup. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const bridge: PiBridge = {
  getStatus: () => ipcRenderer.invoke('pi:get-status') as Promise<PiStatus>,
  listWorkspaceFiles: () => ipcRenderer.invoke('workspace:files') as Promise<string[]>,
  restart: (cwd?: string) => ipcRenderer.invoke('pi:restart', cwd) as Promise<PiStatus>,
  newProjectSession: (cwd, options) =>
    ipcRenderer.invoke('pi:new-project-session', cwd, options) as Promise<PiStatus>,
  repoInfo: (dir?: string) => ipcRenderer.invoke('pi:repo-info', dir) as Promise<RepoInfo>,
  listRepos: (dirs: string[]) =>
    ipcRenderer.invoke('pi:repos', dirs) as Promise<Record<string, RepoInfo>>,
  recentRepos: () => ipcRenderer.invoke('repos:recent') as Promise<string[]>,
  pickFolders: (title?: string) =>
    ipcRenderer.invoke('repos:pick-folders', title) as Promise<string[]>,
  saveRepoDefaults: () => ipcRenderer.invoke('repos:save-defaults'),
  listProjects: () => ipcRenderer.invoke('projects:list') as Promise<Project[]>,
  createProject: (input) => ipcRenderer.invoke('projects:create', input),
  updateProject: (id, patch) => ipcRenderer.invoke('projects:update', id, patch),
  createProjectFromDialog: () => ipcRenderer.invoke('projects:create-from-dialog'),
  addProjectRoot: (id: string) => ipcRenderer.invoke('projects:add-root', id),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),
  activateProject: (id?: string, options?: { stop?: boolean }) =>
    ipcRenderer.invoke('projects:activate', id, options),
  openSession: (sessionPath: string, cwd: string, options?: { stop?: boolean }) =>
    ipcRenderer.invoke('pi:open-session', sessionPath, cwd, options) as Promise<PiStatus>,
  getEngineCommands: () => ipcRenderer.invoke('engine:commands'),
  executeEngineCommand: (name, args) => ipcRenderer.invoke('engine:command', name, args),
  setEngineSandbox: (mode) => ipcRenderer.invoke('engine:sandbox', mode),
  setEngineCodexQuestions: (enabled) => ipcRenderer.invoke('engine:codex-questions', enabled),
  getDesktopConfig: () => ipcRenderer.invoke('desktop:config'),
  setEngine: (engine: 'pi' | 'prophey' | 'claude' | 'codex') =>
    ipcRenderer.invoke('desktop:set-engine', engine),
  setDefaultEngine: (engine) => ipcRenderer.invoke('desktop:set-default-engine', engine),
  getUpdateSnapshot: () => ipcRenderer.invoke('updates:snapshot') as Promise<AppUpdateSnapshot>,
  checkForUpdates: () => ipcRenderer.invoke('updates:check') as Promise<AppUpdateSnapshot>,
  installUpdate: () => ipcRenderer.invoke('updates:install') as Promise<AppUpdateSnapshot>,
  cancelUpdateDownload: () => ipcRenderer.invoke('updates:cancel') as Promise<AppUpdateSnapshot>,
  setAutoUpdateCheck: (enabled: boolean) =>
    ipcRenderer.invoke('updates:auto', enabled) as Promise<AppUpdateSnapshot>,
  setAutoUpdateDownload: (enabled: boolean) =>
    ipcRenderer.invoke('updates:auto-download', enabled) as Promise<AppUpdateSnapshot>,
  onUpdate: (listener) => subscribe('app-update', listener),
  getProxyInfo: () => ipcRenderer.invoke('app:proxy'),
  chooseWorkspace: (options?: { stop?: boolean }) =>
    ipcRenderer.invoke('pi:choose-workspace', options) as Promise<PiStatus | null>,
  prompt: (message: string, streamingBehavior?: 'steer' | 'followUp', images?: PromptImage[], sessionKey?: string) =>
    ipcRenderer.invoke('pi:prompt', message, streamingBehavior, images, sessionKey),
  abort: () => ipcRenderer.invoke('pi:abort') as Promise<void>,
  newSession: (options) => ipcRenderer.invoke('pi:new-session', options),
  switchSession: (sessionPath: string) => ipcRenderer.invoke('pi:switch-session', sessionPath),
  getMessages: () => ipcRenderer.invoke('pi:get-messages') as Promise<SessionMessages>,
  getSessionStats: () => ipcRenderer.invoke('pi:session-stats'),
  stopBackgroundTask: (id: string, sessionKey?: string) => ipcRenderer.invoke('engine:stop-background-task', id, sessionKey),
  readBackgroundTask: (id: string, sessionKey?: string) => ipcRenderer.invoke('engine:read-background-task', id, sessionKey),
  revealPath: (path: string) => ipcRenderer.invoke('workspace:reveal', path),
  listSessions: () => ipcRenderer.invoke('pi:list-sessions') as Promise<SessionSummary[]>,
  openAgentDir: () => ipcRenderer.invoke('pi:open-agent-dir') as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<void>,
  copyImage: (dataUrl: string) => ipcRenderer.invoke('app:copy-image', dataUrl),
  setTheme: (theme: 'dark' | 'light') =>
    ipcRenderer.invoke('app:set-theme', theme) as Promise<void>,
  listModels: () => ipcRenderer.invoke('pi:list-models'),
  setModel: (provider: string, modelId: string) =>
    ipcRenderer.invoke('pi:set-model', provider, modelId),
  listThinkingLevels: () => ipcRenderer.invoke('pi:list-thinking-levels'),
  setThinkingLevel: (level: string) => ipcRenderer.invoke('pi:set-thinking-level', level),
  setSpeedMode: (mode: SpeedMode) => ipcRenderer.invoke('pi:set-speed-mode', mode),
  listProviderModels: (providerId: string) =>
    ipcRenderer.invoke('providers:list-provider-models', providerId),
  setProviderModels: (providerId: string, enabledIds: string[]) =>
    ipcRenderer.invoke('providers:set-provider-models', providerId, enabledIds),
  setProviderBaseUrl: (providerId: string, baseUrl: string | null) =>
    ipcRenderer.invoke('providers:set-base-url', providerId, baseUrl),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  chatGptUsage: (force?: boolean) =>
    ipcRenderer.invoke('providers:chatgpt-usage', force === true),
  startLogin: (providerId: string, type: ProviderAuthType, loginId: string) =>
    ipcRenderer.invoke('providers:start-login', providerId, type, loginId),
  answerLogin: (loginId: string, promptId: string, value: string) =>
    ipcRenderer.invoke('providers:answer-login', loginId, promptId, value),
  cancelLogin: (loginId: string) => ipcRenderer.invoke('providers:cancel-login', loginId),
  logoutProvider: (providerId: string) => ipcRenderer.invoke('providers:logout', providerId),
  onLoginMessage: (listener) => subscribe('providers:login-message', listener),
  getModelsJson: () => ipcRenderer.invoke('providers:models-json'),
  saveModelsJson: (content: string) => ipcRenderer.invoke('providers:save-models-json', content),
  openModelsJson: () => ipcRenderer.invoke('providers:open-models-json') as Promise<void>,
  getAppSettings: () => ipcRenderer.invoke('settings:get'),
  saveAppSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  listModelChoices: () => ipcRenderer.invoke('settings:models'),
  getMcpState: () => ipcRenderer.invoke('mcp:state') as Promise<McpState>,
  setMcpEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('mcp:set-enabled', enabled) as Promise<McpState>,
  setDesktopToolEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('mcp:set-desktop-tool', enabled) as Promise<McpState>,
  setMcpEngineEnabled: (id: 'codegraph' | 'warpgrep' | 'web', enabled: boolean) =>
    ipcRenderer.invoke('mcp:set-engine-enabled', id, enabled) as Promise<McpState>,
  setMcpEngineEntry: (id: 'codegraph' | 'warpgrep' | 'web', entry: string | null) =>
    ipcRenderer.invoke('mcp:set-engine-entry', id, entry) as Promise<McpState>,
  refreshMcpEngines: () => ipcRenderer.invoke('mcp:refresh-engines') as Promise<McpState>,
  buildMcpIndex: () =>
    ipcRenderer.invoke('mcp:build-index') as Promise<{ ok: boolean; message: string }>,
  setMcpToolEnabled: (server: string, tool: string, enabled: boolean) =>
    ipcRenderer.invoke('mcp:set-tool', server, tool, enabled) as Promise<McpState>,
  setMorphApiKey: (key: string | null) =>
    ipcRenderer.invoke('mcp:set-morph-key', key) as Promise<McpState>,
  setWarpgrepBackend: (patch: { baseUrl?: string | null; model?: string | null; apiKey?: string | null }) =>
    ipcRenderer.invoke('mcp:set-warpgrep', patch) as Promise<McpState>,
  setBraveApiKey: (key: string | null) =>
    ipcRenderer.invoke('mcp:set-brave-key', key) as Promise<McpState>,
  setWebSearchMode: (mode: 'auto' | 'brave' | 'native') =>
    ipcRenderer.invoke('mcp:set-web-mode', mode) as Promise<McpState>,
  setProviderWebSearch: (providerId: string, enabled: boolean) =>
    ipcRenderer.invoke('mcp:set-provider-web-search', providerId, enabled) as Promise<McpState>,
  setSubagentsEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('mcp:set-subagents', enabled) as Promise<McpState>,
  setAgentExposure: (exposure: 'prompt' | 'lazy' | 'hidden') =>
    ipcRenderer.invoke('agents:set-exposure', exposure) as Promise<McpState>,
  openAgentsConfig: () => ipcRenderer.invoke('agents:open-config') as Promise<void>,
  compactSession: (instructions) => ipcRenderer.invoke('pi:compact', instructions),
  setAutoCompact: (enabled) => ipcRenderer.invoke('pi:set-auto-compact', enabled),
  setAutoCompactRatio: (percent) => ipcRenderer.invoke('pi:set-auto-compact-ratio', percent),
  setCompactThreshold: (tokens) => ipcRenderer.invoke('pi:set-compact-threshold', tokens),
  startSideChat: (question) => ipcRenderer.invoke('pi:btw-start', question),
  askSideChat: (question) => ipcRenderer.invoke('pi:btw-ask', question),
  closeSideChat: () => ipcRenderer.invoke('pi:btw-close'),
  saveAgentPreset: (draft) => ipcRenderer.invoke('agents:save-preset', draft),
  deleteAgentPreset: (id) => ipcRenderer.invoke('agents:delete-preset', id),
  chooseMcpEngineEntry: () =>
    ipcRenderer.invoke('mcp:choose-engine-entry') as Promise<string | null>,
  onMcpState: (listener) => subscribe('mcp:state', listener),
  setMcpServerEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke('mcp:set-server-enabled', name, enabled),
  removeMcpServer: (name: string) => ipcRenderer.invoke('mcp:remove-server', name),
  addMcpServer: (name: string, config: string) =>
    ipcRenderer.invoke('mcp:add-server', name, config),
  openMcpConfig: (which: 'user' | 'project') =>
    ipcRenderer.invoke('mcp:open-config', which) as Promise<void>,
  onAskRequest: (listener) => subscribe('ask:request', listener),
  listAsks: () => ipcRenderer.invoke('ask:list'),
  onAskCleared: (listener) => subscribe('ask:cleared', listener),
  answerQuestion: (id: string, answers: AskAnswer[]) =>
    ipcRenderer.invoke('ask:answer', id, answers) as Promise<void>,
  cancelQuestion: (id: string, reason?: string) =>
    ipcRenderer.invoke('ask:cancel', id, reason) as Promise<void>,
  onEvent: (listener) => subscribe('pi:event', listener),
  onStatus: (listener) => subscribe('pi:status', listener),
  listSubagents: () => ipcRenderer.invoke('subagents:list'),
  getSubagent: (id: string) => ipcRenderer.invoke('subagents:get', id),
  stopSubagent: (id: string) => ipcRenderer.invoke('subagents:stop', id),
  promptSubagent: (id: string, text: string, mode) =>
    ipcRenderer.invoke('subagents:prompt', id, text, mode),
  revealSubagentSession: (file: string) => ipcRenderer.invoke('subagents:reveal', file),
  onSubagentUpdate: (listener) => subscribe('subagents:update', listener)
}

contextBridge.exposeInMainWorld('pi', bridge)
