import type { EngineCapabilities, EngineCommand } from '@shared/engine'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AppUpdateSnapshot,
  AskAnswer,
  AskRequest,
  ContextUsage,
  McpState,
  PiStatus,
  Project,
  RepoInfo,
  SessionSummary,
  SideChatResult,
  SubagentView
} from '@shared/types'
import { Conversation } from './components/Conversation'
import { Composer } from './components/Composer'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { ProjectEditor } from './components/ProjectEditor'
import { WorkspacePicker } from './components/WorkspacePicker'
import { SettingsModal } from './components/SettingsModal'
import { SessionNavigator } from './components/SessionNavigator'
import { buildOutline } from './lib/outline'
import { AskQuestionPanel } from './components/AskQuestionPanel'
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog'
import { SubagentsDrawer } from './components/SubagentsDrawer'
import { RunStatusBar } from './components/RunStatusBar'
import { SessionPanel } from './components/SessionPanel'
import { Markdown } from './components/Markdown'
import type { DraftImage } from './lib/images'
import { isSubagentRunning } from './lib/subagents'

import type { BtwChat, QueuedMessage } from './lib/chat-types'
import {
  adoptComposer,
  composerFor,
  composerKey,
  LOCAL_COMPOSER_KEY,
  parseComposers,
  patchComposer,
  serializeComposers,
  type SessionComposerMap
} from './lib/session-composer'
import { PANEL_OPEN_KEY, SIDEBAR_OPEN_KEY, readLayoutFlag, writeLayoutFlag } from './lib/layout-prefs'
import { updateStatusText } from './lib/updates'
import { toChatItems, type ChatItem } from './lib/messages'
import { messagesBelong } from './lib/session-messages'
import {
  recallScroll,
  rememberScroll,
  restoreScroll,
  type SessionScroll,
  type SessionScrollMap
} from './lib/session-scroll'
import { applyConversationEvent } from './lib/conversation-events'

/** Draft, images and queue of every conversation, keyed by sidebar session key. */
const COMPOSER_STORAGE_KEY = 'pi-session-composer'

/**
 * The message a reader is actually looking at: the first one whose bottom edge is inside the
 * viewport, plus how far into it the viewport starts.
 */
function viewportAnchor(container: HTMLElement): { id: string; offset: number } | undefined {
  const top = container.getBoundingClientRect().top
  for (const node of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const box = node.getBoundingClientRect()
    if (box.bottom <= top + 12) continue
    const id = node.dataset.messageId
    if (id) return { id, offset: box.top - top }
  }
  return undefined
}

/**
 * Where a message sits inside the scroll box, or `null` when it is not rendered any more.
 *
 * A restored transcript can briefly hold two copies of the same id (the outgoing list is cleared in
 * stages), so `near` — the offset the session was remembered at — picks the copy the reader meant.
 */
function messageOffset(container: HTMLElement, id: string, near?: number): number | null {
  const top = container.getBoundingClientRect().top
  const offsets = [...container.querySelectorAll<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)]
    .map((node) => node.getBoundingClientRect().top - top + container.scrollTop)
  if (offsets.length === 0) return null
  if (offsets.length === 1 || near === undefined) return offsets[0]
  return offsets.reduce((best, offset) =>
    Math.abs(offset - near) < Math.abs(best - near) ? offset : best
  )
}

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<PiStatus>({ phase: 'starting', cwd: '' })
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const activePath = status.sessionKey ?? status.sessionFile
  const [items, setItems] = useState<ChatItem[]>([])
  /**
   * Composer state is per conversation.
   *
   * A draft, its pending images and the messages queued behind a running turn all belong to the
   * session they were typed in: showing them in another session (or flushing a queue into one)
   * mixed two conversations together. One map keyed by the sidebar identity fixes both — the
   * derived value below is simply "the active session's composer".
   */
  const [composers, setComposers] = useState<SessionComposerMap>(() => {
    try {
      return parseComposers(localStorage.getItem(COMPOSER_STORAGE_KEY))
    } catch {
      // private mode / storage disabled: start empty rather than fail the window
      return {}
    }
  })
  /** Session the composer currently belongs to; a ref so async callbacks target the same one. */
  const composerKeyRef = useRef(LOCAL_COMPOSER_KEY)
  /**
   * The predicted next message, and the conversation it was predicted in.
   *
   * Owned here rather than in the composer map: it is not the user's text, it is replaced whenever a
   * turn settles, and it must never follow a session switch (the key decides whether it renders).
   */
  const [suggestion, setSuggestion] = useState<{ text: string; key: string } | null>(null)
  const activeComposerKey = composerKey(status.sessionKey ?? status.sessionFile)
  useEffect(() => { composerKeyRef.current = activeComposerKey }, [activeComposerKey])
  const activeComposer = composerFor(composers, activeComposerKey)
  const draft = activeComposer.draft
  const draftImages = activeComposer.images
  // Messages written while a run is streaming: they wait here and are sent when it settles.
  const queued = activeComposer.queued
  /** React-shaped setters that only ever touch the active session's composer. */
  const setDraft = useCallback((next: string | ((previous: string) => string)) => {
    setComposers((map) =>
      patchComposer(map, activeComposerKey, (previous) => ({
        draft: typeof next === 'function' ? next(previous.draft) : next
      }))
    )
  }, [activeComposerKey])
  const setDraftImages = useCallback(
    (next: DraftImage[] | ((previous: DraftImage[]) => DraftImage[])) => {
      setComposers((map) =>
        patchComposer(map, activeComposerKey, (previous) => ({
          images: typeof next === 'function' ? next(previous.images) : next
        }))
      )
    },
    [activeComposerKey]
  )
  const setQueued = useCallback(
    (next: QueuedMessage[] | ((previous: QueuedMessage[]) => QueuedMessage[])) => {
      setComposers((map) =>
        patchComposer(map, activeComposerKey, (previous) => ({
          queued: typeof next === 'function' ? next(previous.queued) : next
        }))
      )
    },
    [activeComposerKey]
  )
  useEffect(() => {
    // Keystrokes typed before the window knew its session belong to the session it lands on.
    if (!activePath) return
    setComposers((map) => adoptComposer(map, LOCAL_COMPOSER_KEY, composerKey(activePath)))
  }, [activePath])
  useEffect(() => {
    try {
      localStorage.setItem(COMPOSER_STORAGE_KEY, serializeComposers(composers))
    } catch {
      // storage refused the write: the map still lives in memory
    }
  }, [composers])
  const [btwChat, setBtwChat] = useState<BtwChat | undefined>(undefined)
  const [btwDraft, setBtwDraft] = useState('')
  const [mcpOpen, setMcpOpen] = useState(false)
  const [subagentsOpen, setSubagentsOpen] = useState(false)
  const [subagentFocus, setSubagentFocus] = useState<string | undefined>(undefined)
  const [allSubagents, setSubagents] = useState<SubagentView[]>([])
  const subagents = allSubagents.filter(record => record.parentSession && messagesBelong(record.parentSession, status))
  const [mcpState, setMcpState] = useState<McpState | undefined>(undefined)
  /** Context-window usage of the current session, shown next to the composer. */
  const [contextUsage, setContextUsage] = useState<ContextUsage | undefined>(undefined)
  /** Bumped after a queued command runs, so the queue keeps draining without a run to end. */
  const [queueTick, setQueueTick] = useState(0)
  const queueSending = useRef(new Set<string>())
  const [run, setRun] = useState<{
    startedAt?: number
    endedAt?: number
    runningTools: number
    tokens?: number
  }>({ runningTools: 0 })
  const [, setTick] = useState(0)
  /** Left sidebar; open by default, and remembered like the inspector below. */
  const [sidebarOpen, setSidebarOpen] = useState(() => readLayoutFlag(SIDEBAR_OPEN_KEY, true))
  useEffect(() => {
    writeLayoutFlag(SIDEBAR_OPEN_KEY, sidebarOpen)
  }, [sidebarOpen])
  /** Right-hand inspector; persisted so the layout survives a restart like the sidebar does. */
  const [panelOpen, setPanelOpen] = useState(() => readLayoutFlag(PANEL_OPEN_KEY, false))
  useEffect(() => {
    writeLayoutFlag(PANEL_OPEN_KEY, panelOpen)
  }, [panelOpen])
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  /** Pending window-level question (e.g. “delete this project?”). */
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | undefined>(undefined)
  const confirmResolveRef = useRef<((confirmed: boolean) => void) | undefined>(undefined)

  const resolveConfirm = useCallback((confirmed: boolean) => {
    const resolve = confirmResolveRef.current
    confirmResolveRef.current = undefined
    setConfirmRequest(undefined)
    resolve?.(confirmed)
  }, [])

  /**
   * Window-level confirmation for actions that destroy something (a project). Switching sessions
   * is not one of them: a running turn keeps going in the background.
   */
  const askConfirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        confirmResolveRef.current = resolve
        setConfirmRequest(request)
      }),
    []
  )
  const [stick, setStick] = useState(true)
  const [activeUserIndex, setActiveUserIndex] = useState(0)
  const [activeOutlineId, setActiveOutlineId] = useState<string | undefined>(undefined)
  const [update, setUpdate] = useState<AppUpdateSnapshot>({
    sequence: 0,
    status: 'idle',
    currentVersion: '0.0.0',
    latestVersion: null,
    notes: null,
    checkedAt: null,
    downloaded: 0,
    total: null,
    autoCheck: true,
    autoDownload: true,
    canInstall: false,
    releasesUrl: '',
    error: null
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'providers' | 'mcp' | 'general'>(
    'providers'
  )
  const [askQueue, setAskQueue] = useState<AskRequest[]>([])
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('pi-desktop-theme') === 'light' ? 'light' : 'dark'
  )

  /**
   * Last *committed* status. Written from an effect, not during render: a render that React throws
   * away would otherwise leave the ref holding a `busy` value the window never showed, and every
   * `piBusy()` check would then disagree with the status the flush effect is looking at.
   */
  const statusRef = useRef(status)
  useEffect(() => {
    statusRef.current = status
  }, [status])
  /** pi refuses prompts while it runs or compacts, so both count as busy everywhere. */
  const piBusy = useCallback(
    () => Boolean(statusRef.current.isStreaming || statusRef.current.compacting),
    []
  )
  const sessionsRef = useRef<SessionSummary[]>([])
  sessionsRef.current = sessions
  const historyRef = useRef<{ stack: string[]; index: number }>({ stack: [], index: -1 })
  const [historyNav, setHistoryNav] = useState({ canBack: false, canForward: false })
  const askQueueRef = useRef<AskRequest[]>([])
  const sessionAsks = askQueue.filter(request => messagesBelong(request.sessionKey, status))
  askQueueRef.current = sessionAsks
  const btwChatRef = useRef<BtwChat | undefined>(undefined)
  btwChatRef.current = btwChat
  const ask = sessionAsks[0]
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  stickRef.current = stick
  /** Where each conversation was left, so reopening it lands on the same line (see lib/session-scroll). */
  const scrollMemory = useRef<SessionScrollMap>(new Map())
  /** A restore waiting for the incoming transcript to render; cleared once it is applied. */
  const pendingScroll = useRef<{ key: string; scroll: SessionScroll } | null>(null)

  const userItems = useMemo(() => items.filter((item) => item.role === 'user'), [items])
  const outline = useMemo(() => buildOutline(items), [items])

  const syncHistoryNav = useCallback(() => {
    const { stack, index } = historyRef.current
    setHistoryNav({ canBack: index > 0, canForward: index < stack.length - 1 })
  }, [])

  const rememberSession = useCallback(
    (path: string) => {
      const state = historyRef.current
      if (state.stack[state.index] === path) return
      state.stack = [...state.stack.slice(0, state.index + 1), path]
      if (state.stack.length > 50) state.stack = state.stack.slice(-50)
      state.index = state.stack.length - 1
      syncHistoryNav()
    },
    [syncHistoryNav]
  )

  const updateActiveUser = useCallback(() => {
    const container = scrollRef.current
    if (!container || userItems.length === 0) return
    const containerTop = container.getBoundingClientRect().top
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    let active = 0
    userItems.forEach((item, index) => {
      const element = container.querySelector(
        `[data-message-id="${CSS.escape(item.id)}"]`
      ) as HTMLElement | null
      if (element && element.getBoundingClientRect().top - containerTop <= 120) {
        active = index
      }
    })
    setActiveUserIndex(distance < 24 ? userItems.length - 1 : active)

    // The outline follows the same anchor rule, so the panel highlights the section in view.
    let activeEntry: string | undefined
    for (const entry of outline) {
      const element = container.querySelector(
        `[data-message-id="${CSS.escape(entry.messageId)}"]`
      ) as HTMLElement | null
      if (element && element.getBoundingClientRect().top - containerTop <= 120) {
        activeEntry = entry.id
      }
    }
    setActiveOutlineId(activeEntry)
  }, [userItems, outline])

  useEffect(() => {
    updateActiveUser()
  }, [items, updateActiveUser])

  const jumpToMessage = useCallback((itemId: string) => {
    const container = scrollRef.current
    const target = container?.querySelector(
      `[data-message-id="${CSS.escape(itemId)}"]`
    ) as HTMLElement | null
    if (!container || !target) return
    const top =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      12
    container.scrollTo({ top, behavior: 'smooth' })
    setStick(false)
  }, [])

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await window.pi.listSessions())
    } catch {
      setSessions([])
    }
  }, [])

  /**
   * Repository facts for every directory that appears in the list, plus the active one.
   *
   * A session is scoped to one repository, so this is what the sidebar groups by and what the
   * header shows (`main · 3 改动`). Refreshed whenever the session list or the working directory
   * changes; the main process caches each lookup for a few seconds.
   */
  const [repos, setRepos] = useState<Record<string, RepoInfo>>({})
  useEffect(() => {
    const dirs = [...new Set([status.cwd, ...sessions.map((session) => session.cwd)])].filter(
      Boolean
    )
    if (dirs.length === 0) return
    let cancelled = false
    void window.pi
      .listRepos(dirs)
      .then((next) => {
        if (!cancelled) setRepos(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessions, status.cwd])

  const [projects, setProjects] = useState<Project[]>([])
  const [editingProject, setEditingProject] = useState<Project>()
  const [activeProjectId, setActiveProjectId] = useState<string>()
  const [recentRepos, setRecentRepos] = useState<string[]>([])
  /** What the active engine supports; the composer hides the rest. */
  const [capabilities, setCapabilities] = useState<EngineCapabilities | undefined>(undefined)

  const [commandOutput, setCommandOutput] = useState<{ title: string; text: string }>()
  const [engineCommands, setEngineCommands] = useState<EngineCommand[]>([])
  useEffect(() => {
    let stale = false
    setEngineCommands([])
    setCapabilities(status.capabilities)
    if (status.phase === 'ready') {
      void window.pi
        .getEngineCommands()
        .then((commands) => {
          if (!stale) setEngineCommands(commands)
        })
        .catch(() => undefined)
    }
    return () => {
      stale = true
    }
  }, [status.engine, status.phase, status.sessionFile, status.isStreaming])

  const loadProjects = useCallback(async () => {
    try {
      const list = await window.pi.listProjects()
      setProjects(list)
      const config = await window.pi.getDesktopConfig()
      setActiveProjectId(config.activeProject)
      setCapabilities(config.capabilities)
      setRecentRepos(await window.pi.recentRepos())
    } catch {
      // a missing projects file is not an error, just no projects
    }
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects, status.cwd, status.sessionFile])

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId),
    [projects, activeProjectId]
  )

  const selectProject = useCallback(
    async (id: string) => {
      try {
      const current = projects.find((project) => project.id === id)
      const result = await window.pi.activateProject(id, { stop: true })
      if (!('phase' in result)) { setToast(result.error); return }
      setActiveProjectId(id)
      setStatus(result)
      setItems([])
      if (current) setToast(`已在项目「${current.name}」新建会话`)
      await loadSessions()
      } catch (error) { setToast(error instanceof Error ? error.message : String(error)) }
    },
    [projects, loadSessions]
  )

  const createProject = useCallback(async () => {
    try {
    const result = await window.pi.createProjectFromDialog()
    if (!result.ok) {
      if (result.error && result.error !== '已取消') setToast(result.error)
      return
    }
    await loadProjects()
    if (result.cwd) {
      const started = await window.pi.newProjectSession(result.cwd, { stop: true })
      setStatus(started)
      setActiveProjectId(undefined)
      setItems([])
      setToast('已创建单目录会话')
      await loadSessions()
    }
    if (result.project) {
      const started = await window.pi.activateProject(result.project.id, { stop: true })
      if (!('phase' in started)) { setToast(started.error); return }
      setActiveProjectId(result.project.id)
      setStatus(started)
      setItems([])
      setToast(`已创建项目「${result.project.name}」`)
      await loadSessions()
    }
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)) }
  }, [loadProjects, loadSessions])

  const editProject = useCallback(
    (id: string) => {
      const project = projects.find((item) => item.id === id)
      if (project) setEditingProject(project)
    },
    [projects]
  )

  const deleteProject = useCallback(
    async (id: string) => {
      const name = projects.find((project) => project.id === id)?.name ?? '项目'
      const confirmed = await askConfirm({
        title: `删除项目「${name}」`,
        message: '只删除项目分组，目录和会话都不会被删除。',
        confirmLabel: '删除项目',
        danger: true
      })
      if (!confirmed) return
      await window.pi.removeProject(id)
      if (activeProjectId === id) {
        setActiveProjectId(undefined)
        const started = await window.pi.activateProject(undefined, { stop: true })
        if ('phase' in started) setStatus(started)
      }
      await loadProjects()
      setToast(`已删除「${name}」`)
    },
    [activeProjectId, askConfirm, projects, loadProjects]
  )
  const messagesRequest = useRef(0)
  const loadMessages = useCallback(async (attempt = 0) => {
    const request = ++messagesRequest.current
    const owner = statusRef.current
    const isCurrent = (): boolean => request === messagesRequest.current &&
      statusRef.current.phase === 'ready' && !statusRef.current.switchingEngine &&
      statusRef.current.engine === owner.engine && messagesBelong(owner.sessionKey ?? owner.sessionFile, statusRef.current)
    try {
      const payload = await window.pi.getMessages()
      // The engine names the session it answered from. While a switch is in flight it can still
      // hold the previous transcript; painting that under the new title is the "conversation from
      // another directory" bug. Wait for it instead of showing the wrong conversation.
      if (!messagesBelong(payload.sessionKey, owner)) {
        if (attempt < 20 && request === messagesRequest.current) {
          window.setTimeout(() => void loadMessages(attempt + 1), 150)
        }
        return
      }
      if (!isCurrent()) return
      setItems(toChatItems(payload.messages))
      setStick(true)
      const stats = await window.pi.getSessionStats().catch(() => undefined)
      if (!isCurrent() || !messagesBelong(stats?.sessionKey, owner)) return
      // Reopening a session that kept running in the background: the run already started, so the
      // status bar has to keep counting instead of disappearing until the next `agent_start`.
      setRun({
        ...(statusRef.current.isStreaming
          ? { startedAt: statusRef.current.activity?.since ?? Date.now() }
          : {}),
        runningTools: 0,
        tokens: stats?.tokens?.total
      })
      setContextUsage(stats?.contextUsage)
    } catch {
      // ignore
    }
  }, [])

  const handleEvent = useCallback(
    (record: Record<string, unknown>) => {
      if (record.type === 'session_title_updated' || record.type === 'session_updated') {
        void loadSessions()
        return
      }
      const owner = statusRef.current
      if (owner.switchingEngine || !messagesBelong(record.sessionKey as string | undefined, owner)) return
      const type = String(record.type ?? '')
      // A prediction is not transcript: it must not invalidate a transcript snapshot being fetched.
      if (type === 'suggestion') {
        const text = typeof record.text === 'string' ? record.text.trim() : ''
        setSuggestion(text ? { text, key: composerKey(record.sessionKey as string | undefined) } : null)
        return
      }
      // Invalidate snapshots begun before this event so a late fetch cannot erase new output.
      messagesRequest.current++
      const now = Date.now()
      setItems((prev) => applyConversationEvent(prev, record, now))
      switch (type) {
        case 'agent_start':
          setRun({ startedAt: Date.now(), runningTools: 0 })
          break
        case 'tool_execution_start':
          setRun((prev) => ({ ...prev, runningTools: prev.runningTools + 1 }))
          break
        case 'tool_execution_end':
          setRun((prev) => ({ ...prev, runningTools: Math.max(0, prev.runningTools - 1) }))
          break
        case 'agent_settled':
          setRun((prev) => ({ ...prev, endedAt: Date.now(), runningTools: 0 }))
          void window.pi
            .getSessionStats()
            .then((stats) => {
              if (!messagesBelong(stats.sessionKey, statusRef.current)) return
              setRun((prev) => ({ ...prev, tokens: stats.tokens?.total }))
              setContextUsage(stats.contextUsage)
            })
            .catch(() => undefined)
          void loadSessions()
          break
        case 'auto_retry_start':
          setToast(`模型请求失败，${String(record.delayMs ?? 0)}ms 后重试`)
          break
        case 'auto_retry_end':
          if (record.success === false) setToast(String(record.finalError ?? '重试失败'))
          break
        case 'extension_error':
          setToast(`扩展错误：${String(record.error ?? '未知错误')}`)
          break
        case 'speed_unsupported':
          // The main process already dropped the setting back to `standard` and restarted pi.
          setToast(
            '这个账号不能使用该速度档位，已回退标准（需要 API 计费或支持该档位的套餐），请重新发送'
          )
          break
        default:
          break
      }
    },
    [loadSessions]
  )

  useEffect(() => {
    void window.pi.getUpdateSnapshot().then(setUpdate)
    return window.pi.onUpdate(setUpdate)
  }, [])

  useEffect(() => {
    void window.pi.getStatus().then(setStatus)
    const offStatus = window.pi.onStatus((next) => {
      // IPC events can arrive in the same React batch; route them using the latest wire status.
      statusRef.current = next
      setStatus(next)
    })
    const offEvent = window.pi.onEvent(handleEvent)
    const offAsk = window.pi.onAskRequest((request) => setAskQueue((queue) => [...queue, request]))
    const offAskCleared = window.pi.onAskCleared((payload) => setAskQueue(queue =>
      payload?.id ? queue.filter(request => request.id !== payload.id) :
        payload?.sessionKey ? queue.filter(request => !messagesBelong(request.sessionKey, payload)) : []))
    void window.pi.listAsks().then(setAskQueue)
    return () => {
      offStatus()
      offEvent()
      offAsk()
      offAskCleared()
    }
  }, [handleEvent])

  useEffect(() => {
    void window.pi
      .listSubagents()
      .then(setSubagents)
      .catch(() => undefined)
    return window.pi.onSubagentUpdate((record) => {
      setSubagents((prev) => {
        const index = prev.findIndex((item) => item.id === record.id)
        if (index === -1) return [record, ...prev]
        const next = prev.slice()
        next[index] = record
        return next
      })
    })
  }, [])

  // Connectors in the session panel follow the main process instead of asking once on open.
  useEffect(() => {
    void window.pi.getMcpState().then(setMcpState).catch(() => undefined)
    return window.pi.onMcpState((state) => setMcpState(state))
  }, [])

  const answerAsk = useCallback((answers: AskAnswer[]) => {
    const current = askQueueRef.current[0]
    if (!current) return
    setAskQueue((queue) => queue.filter((item) => item.id !== current.id))
    void window.pi.answerQuestion(current.id, answers)
  }, [])

  const cancelAsk = useCallback(() => {
    const current = askQueueRef.current[0]
    if (!current) return
    setAskQueue((queue) => queue.filter((item) => item.id !== current.id))
    void window.pi.cancelQuestion(current.id, '用户取消了提问')
  }, [])

  useEffect(() => {
    if (status.phase === 'ready') {
      void loadSessions()
    }
  }, [status.phase, loadSessions])

  useEffect(() => {
    if (status.phase !== 'ready') return
    void loadMessages()
    void loadSessions()
  }, [status.phase, status.sessionFile, status.sessionKey, status.engine, loadMessages, loadSessions])

  // Never leave the previous session's transcript on screen while the next one loads: a dropped or
  // late answer must show an empty conversation, not another directory's messages.
  const shownSession = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (status.phase !== 'ready') return
    const key = status.sessionKey ?? status.sessionFile
    if (!key || shownSession.current === key) return
    // Leave the outgoing transcript where it is (remembered per session) and plan the incoming one's
    // restore before the items are cleared: the anchor is the point of switching back to a session.
    const leaving = shownSession.current
    const container = scrollRef.current
    const leavingAnchor = container ? viewportAnchor(container) : undefined
    rememberScroll(
      scrollMemory.current,
      leaving,
      container,
      leavingAnchor
    )
    const saved = recallScroll(scrollMemory.current, key)
    pendingScroll.current = { key, scroll: saved ?? { top: 0, stuck: true } }
    shownSession.current = key
    setItems([])
    setContextUsage(undefined)
    setRun({ runningTools: 0 })
    setSubagentsOpen(false)
    setSubagentFocus(undefined)
    setCommandOutput(undefined)
    setToast(null)
    setStick(saved ? saved.stuck : true)
  }, [status.phase, status.sessionKey, status.sessionFile])

  /**
   * Apply the planned anchor once the incoming transcript is actually on screen. A layout effect so
   * the user never sees the new conversation jump from the top; the second pass covers heights that
   * settle after markdown and images lay out.
   */
  useLayoutEffect(() => {
    const pending = pendingScroll.current
    const container = scrollRef.current
    if (!pending || !container) return
    if (pending.key !== shownSession.current) {
      pendingScroll.current = null
      return
    }
    if (items.length === 0) return
    pendingScroll.current = null
    const locate = (id: string): number | null =>
      messageOffset(container, id, pending.scroll.top + (pending.scroll.anchorOffset ?? 0))
    restoreScroll(container, pending.scroll, locate)
    const frame = requestAnimationFrame(() => restoreScroll(container, pending.scroll, locate))
    return () => cancelAnimationFrame(frame)
  }, [items])

  /**
   * Auto-compaction decides what counts as "full", so re-read the usage whenever the trigger moves
   * (`/autocompact`, the settings row), the model changes (a new window means a new ceiling) or pi
   * comes back up on a new reserve. Without this the meter kept describing the previous threshold
   * and window until the next run settled.
   */
  useEffect(() => {
    if (status.phase !== 'ready') return
    let cancelled = false
    void window.pi
      .getSessionStats()
      .then((stats) => {
        if (cancelled || !stats?.contextUsage || !messagesBelong(stats.sessionKey, statusRef.current)) return
        setContextUsage(stats.contextUsage)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [status.phase, status.sessionKey, status.sessionFile, status.autoCompactPercent, status.model?.id, status.model?.contextWindow])

  /**
   * Prophey measures its own usage and publishes it while a round streams, so the ring moves during
   * the run instead of jumping at `agent_settled`. Other engines leave `status.contextUsage` unset
   * and the meter keeps coming from `get_session_stats`.
   */
  useEffect(() => {
    const usage = status.contextUsage
    if (!usage) return
    setContextUsage(usage)
    setRun((prev) =>
      prev.startedAt && !prev.endedAt ? { ...prev, tokens: usage.tokens ?? prev.tokens } : prev
    )
  }, [status.contextUsage])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('pi-desktop-theme', theme)
    void window.pi.setTheme(theme)
  }, [theme])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!stickRef.current) return
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [items])

  useEffect(() => {
    if (!run.startedAt || run.endedAt) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [run.startedAt, run.endedAt])

  const runStatus = run.startedAt
    ? {
        active: !run.endedAt,
        elapsedMs: Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt),
        runningTools: run.runningTools,
        tokens: run.tokens
      }
    : undefined

  const openSubagents = useCallback((id?: string) => {
    setSubagentFocus(id)
    setSubagentsOpen(true)
  }, [])

  const deliver = useCallback(
    async (
      text: string,
      images: DraftImage[],
      behavior?: 'steer' | 'followUp',
      owner = composerKeyRef.current,
      restoreDraft = true
    ): Promise<boolean> => {
      // pi is parked on the `/btw` fork while that panel is open; nothing may go there by accident.
      if (btwChatRef.current) {
        setToast('先关闭侧边提问窗口')
        return false
      }
      // The session that asked for the send, captured before any await: a failure has to restore
      // the text there even if the user switched conversations in the meantime.
      if (owner !== composerKeyRef.current || statusRef.current.switchingEngine) return false
      setStick(true)
      const localId = `local-${Date.now()}`
      setItems((prev) => [
        ...prev,
        {
          id: localId,
          role: 'user',
          text,
          images: images.map((image) => ({ data: image.data, mimeType: image.mimeType })),
          toolCalls: [],
          pending: true
        }
      ])
      const result = await window.pi.prompt(
        text,
        behavior,
        images.map((image) => ({
          type: 'image' as const,
          data: image.data,
          mimeType: image.mimeType
        })), owner
      ).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error), queued: false }))
      if (!result.ok) {
        setItems((prev) => prev.filter((item) => item.id !== localId))
        if (restoreDraft) setComposers((map) => patchComposer(map, owner, previous => ({
          draft: previous.draft ? `${text}\n${previous.draft}` : text,
          images: [...images, ...previous.images]
        })))
        if (owner === composerKeyRef.current) setToast(result.error ?? '发送失败')
        return false
      }
      if (result.queued) setToast('pi 还在收尾，这条已排队，会在本轮结束后发送')
      return true
    },
    []
  )

  /** Runs a desktop slash command; returns true when the text was consumed. */

  /**
   * While a run is streaming, a new message queues instead of interrupting it. Ctrl+Enter, or the
   * send button on a queued item, forces it into the current turn with `steer`.
   */

  const newSession = useCallback(async () => {
    const result = await window.pi.newSession({ stop: true })
    if (!result.ok) {
      setToast(result.error ?? '无法新建会话')
      return
    }
    setItems([])
    void loadSessions()
  }, [loadSessions])

  const closeBtw = useCallback(async () => {
    if (!btwChatRef.current) return
    setBtwChat(undefined)
    setBtwDraft('')
    try {
      await window.pi.closeSideChat()
    } catch {
      // the branch is discarded on the main side anyway
    }
  }, [])

  /**
   * Park a command that needs an idle session until the current run ends.
   *
   * `/btw` and `/mcp` are local and run immediately; `/clear`, `/compact` and the numeric
   * `/autocompact` restart or replace the session, which pi cannot do mid-run. They wait in the
   * same queue as messages (marked `command`) instead of being rejected with a toast.
   */
  const queueCommand = useCallback((text: string): void => {
    const id = `qc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setQueued((prev) => [...prev, { id, text, images: [], command: true }])
    setToast(`${text.split(' ')[0]} 已排队，本轮结束后自动执行`)
  }, [setQueued])

  const runCommand = useCallback(
    async (raw: string, options: { queued?: boolean } = {}): Promise<boolean> => {
      const owner = composerKeyRef.current
      const stillHere = (): boolean => owner === composerKeyRef.current && !statusRef.current.switchingEngine
      // Called from the queue flush: pi picked up work again, so report "not handled" and let the
      // flush put the item back instead of running a session command mid-run.
      if (options.queued && piBusy()) return false
      const text = raw.trim()
      const space = text.search(/\s/)
      const name = (space === -1 ? text : text.slice(0, space)).toLowerCase()
      const arg = space === -1 ? '' : text.slice(space + 1).trim()
      /** True when the command has to wait for the current run to end. */
      const defer = (): boolean => {
        if (!piBusy()) return false
        queueCommand(text)
        return true
      }
      if (!text.startsWith('/')) return false
      const command = engineCommands.find((entry) => entry.name.toLowerCase() === name)
      if (!command) {
        setToast('当前引擎没有此命令：' + name)
        return true
      }
      if (['native', 'model', 'thinking', 'status'].includes(command.action)) {
        if (defer()) return true
        if (btwChatRef.current) {
          setToast('先关闭侧边提问')
          return true
        }
        const result = await window.pi.executeEngineCommand(command.name, arg)
        if (!stillHere()) return true
        if (result.ok && result.text) setCommandOutput({ title: command.name, text: result.text })
        else setToast(result.ok ? '命令已执行' : result.error || '命令失败')
        await loadMessages()
        return true
      }
      switch (command.action) {
        case 'clear': {
          if (defer()) return true
          // A session switch drops the `/btw` fork on the main side; close the panel with it.
          await closeBtw()
          if (!stillHere()) return false
          await newSession()
          setToast('已清空当前会话')
          return true
        }
        case 'compact': {
          if (defer()) return true
          await closeBtw()
          if (!stillHere()) return false
          setToast(arg ? `正在压缩（自定义提示词：${arg}）…` : '正在压缩上下文…')
          const result = await window.pi.compactSession(arg || undefined)
          if (!stillHere()) return true
          if (!result.ok) {
            setToast(result.error ?? '压缩失败')
            return true
          }
          await loadMessages()
          setToast('上下文已压缩')
          return true
        }
        case 'autocompact': {
          if (!arg) {
            setToast('用法：/autocompact 500000（阈值 token 数）或 /autocompact off')
            return true
          }
          if (arg === 'off' || arg === 'on') {
            const result = await window.pi.setAutoCompact(arg === 'on')
            setToast(
              result.ok
                ? `自动压缩已${arg === 'on' ? '开启' : '关闭'}`
                : (result.error ?? '设置失败')
            )
            return true
          }
          const tokens = Number(arg.replace(/[^0-9]/g, ''))
          if (!Number.isFinite(tokens) || tokens <= 0) {
            setToast('阈值要写数字，例如 /autocompact 500000')
            return true
          }
          if (defer()) return true
          await closeBtw()
          if (!stillHere()) return false
          const result = await window.pi.setCompactThreshold(tokens)
          setToast(
            result.ok
              ? `自动压缩阈值：${tokens} tokens（保留 ${result.reserveTokens}，窗口 ${result.contextWindow}）`
              : (result.error ?? '设置失败')
          )
          return true
        }
        case 'mcp': {
          // Local: reads the current MCP state and opens the panel. Never waits for the run.
          setMcpState(await window.pi.getMcpState())
          setMcpOpen(true)
          return true
        }
        case 'btw': {
          if (!arg) {
            setToast('用法：/btw <问题>')
            return true
          }
          // Local too: the panel opens now and the main process forks as soon as the run settles.
          setBtwDraft('')
          setBtwChat({ busy: true, turns: [{ question: arg }] })
          let result: SideChatResult
          try {
            result = await window.pi.startSideChat(arg)
          } catch (cause) {
            result = { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
          }
          if (!result.ok) {
            // The branch is already discarded on the main side; leave no half-open panel behind.
            // Closing the panel during the wait cancels the start, and that is not worth a toast.
            if (btwChatRef.current) setToast(result.error ?? '侧边提问失败')
            setBtwChat(undefined)
            return true
          }
          setBtwChat({ busy: false, turns: [{ question: arg, answer: result.answer }] })
          return true
        }
        default:
          return false
      }
    },
    [closeBtw, loadMessages, newSession, piBusy, queueCommand, engineCommands]
  )

  /**
   * Send the next queued item when a run settles: a message goes to pi, a command runs here.
   *
   * Deliberately depends on the run status only: adding an item must not trigger a send, otherwise
   * the second item races the first one into pi while `isStreaming` is still false. `queueTick` is
   * bumped after a queued command finishes, because a command (e.g. `/clear`) does not change
   * `isStreaming` and the remaining items would otherwise wait for the next run to end. `btwChat`
   * is here for the same reason: closing the side chat is what unblocks the queue. A failed attempt
   * re-arms the effect itself, because `busy` is an opinion that can be wrong (see `restore`).
   */
  useEffect(() => {
    // `compacting` counts as busy: pi refuses prompts while it rewrites the context.
    if (status.isStreaming || status.compacting || status.switchingEngine || status.phase !== 'ready') return
    // The queue belongs to the main session: never flush it into an open `/btw` fork.
    if (btwChatRef.current) return
    const owner = composerKeyRef.current
    if (queueSending.current.has(owner)) return
    const next = queued[0]
    if (!next || (next.command && engineCommands.length === 0)) return
    queueSending.current.add(owner)
    // The queue is the active session's, so this is a no-op filter for any other session.
    setComposers((map) =>
      patchComposer(map, owner, (previous) => ({
        queued: previous.queued.filter((item) => item.id !== next.id)
      }))
    )
    /**
     * Put the item back and arrange the next attempt.
     *
     * The item left the queue and came back without any status change, so this effect will not run
     * again by itself — that is how a queued command could sit there forever while the run was long
     * over. Ask main for its status (the push may have been missed) and retry after a pause.
     */
    const restore = (): void => {
      queueSending.current.delete(owner)
      setComposers((map) =>
        patchComposer(map, owner, (previous) => ({
          queued: previous.queued.some((item) => item.id === next.id)
            ? previous.queued
            : [next, ...previous.queued]
        }))
      )
      void window.pi.getStatus().then(setStatus)
      window.setTimeout(() => setQueueTick((value) => value + 1), 2000)
    }
    if (next.command) {
      // `queued: true` keeps a command that is still blocked from re-queueing itself forever.
      void runCommand(next.text, { queued: true }).then(
        (handled) => {
          if (!handled) restore()
          else { queueSending.current.delete(owner); setQueueTick((value) => value + 1) }
        },
        () => restore()
      )
      return
    }
    void deliver(next.text, next.images, undefined, owner, false).then(
      (ok) => {
        if (!ok) restore()
        else { queueSending.current.delete(owner); setQueueTick((value) => value + 1) }
      },
      () => restore()
    )
  }, [status.isStreaming, status.compacting, status.switchingEngine, status.phase, activeComposerKey, deliver, runCommand, queueTick, btwChat])

  const askBtw = useCallback(async () => {
    const text = btwDraft.trim()
    const current = btwChatRef.current
    if (!text || !current || current.busy) return
    setBtwDraft('')
    setBtwChat({ busy: true, turns: [...current.turns, { question: text }] })
    let result: SideChatResult
    try {
      result = await window.pi.askSideChat(text)
    } catch (cause) {
      result = { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
    setBtwChat((prev) => {
      if (!prev) return prev
      const turns = [...prev.turns]
      const last = turns.length - 1
      turns[last] = {
        question: turns[last].question,
        answer: result.ok ? result.answer : undefined,
        error: result.ok ? undefined : (result.error ?? '提问失败')
      }
      return { busy: false, turns }
    })
  }, [btwDraft])

  useEffect(() => {
    if (!btwChat) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void closeBtw()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [btwChat, closeBtw])
  const send = useCallback(
    async (mode: 'send' | 'steer') => {
      const owner = activeComposerKey
      if (statusRef.current.switchingEngine || owner !== composerKeyRef.current) return
      const text = draft.trim()
      if (!text && draftImages.length === 0) return
      // The guess was for the message the user is about to send; it is spent either way.
      setSuggestion(null)
      // Slash commands are local: they run here and never become a message, streaming or not.
      // Only an unknown `/xxx` falls through and goes to pi like any other prompt. This runs before
      // the `/btw` guard below so `/mcp` and `/btw` still work while a side chat is open.
      if (text.startsWith('/') && draftImages.length === 0) {
        // Clear first: `/btw` keeps the promise pending until its answer arrives, and the text
        // should leave the box the moment Enter is pressed.
        setDraft('')
        const handled = await runCommand(text)
        if (handled) return
        if (owner !== composerKeyRef.current) return
      }
      // pi is parked on the `/btw` fork while that panel is open; nothing may go there by accident.
      if (btwChatRef.current) {
        setToast('先关闭侧边提问窗口')
        return
      }
      const streaming = piBusy()
      if (streaming && (mode === 'send' || !capabilities?.steer)) {
        setQueued((prev) => [
          ...prev,
          {
            id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            text,
            images: draftImages
          }
        ])
        setDraft('')
        setDraftImages([])
        return
      }
      setDraft('')
      setDraftImages([])
      await deliver(text, draftImages, streaming ? 'steer' : undefined, owner)
    },
    [draft, draftImages, deliver, runCommand, capabilities?.steer, activeComposerKey, setDraft, setDraftImages, setQueued]
  )
  const selectSession = useCallback(
    async (session: SessionSummary, options: { remember?: boolean } = {}) => {
      if (session.path === activePath) return
      try {
        const next = await window.pi.openSession(session.path, session.cwd, { stop: true })
        if (next.phase === 'error') throw new Error(next.error ?? '切换会话失败')
      } catch (error) {
        setToast(error instanceof Error ? error.message : String(error))
        return
      }
      if (options.remember !== false) rememberSession(session.path)
      setStick(true)
      await loadMessages()
      void loadSessions()
    },
    [activePath, loadMessages, loadSessions, rememberSession]
  )

  const goHistory = useCallback(
    (delta: number) => {
      const state = historyRef.current
      const index = state.index + delta
      if (index < 0 || index >= state.stack.length) return
      state.index = index
      syncHistoryNav()
      const path = state.stack[index]
      const session = sessionsRef.current.find((entry) => entry.path === path)
      if (session) void selectSession(session, { remember: false })
    },
    [selectSession]
  )

  const chooseWorkspace = useCallback(async () => {
    setSettingsOpen(false)
    setWorkspacePickerOpen(true)
    const recent = await window.pi.recentRepos().catch(() => undefined)
    if (recent) setRecentRepos(recent)
  }, [])

  const browseWorkspace = useCallback(async (): Promise<boolean> => {
    const next = await window.pi.chooseWorkspace({ stop: true })
    if (!next) return false
    if (next.phase === 'error') throw new Error(next.error ?? '无法打开目录')
    setStatus(next)
    setActiveProjectId(undefined)
    setItems([])
    setStick(true)
    setToast(`已在 ${next.cwd} 新建会话`)
    await loadProjects()
    void loadSessions()
    return true
  }, [loadProjects, loadSessions])

  const openRecentWorkspace = useCallback(async (cwd: string): Promise<void> => {
    const next = await window.pi.newProjectSession(cwd, { stop: true })
    if (next.phase === 'error') throw new Error(next.error ?? '无法打开目录')
    setStatus(next)
    setActiveProjectId(undefined)
    setItems([])
    setStick(true)
    setToast(`已在 ${cwd} 新建会话`)
    await loadProjects()
    void loadSessions()
  }, [loadProjects, loadSessions])

  const newSessionInProject = useCallback(
    async (cwd: string) => {
      try { await openRecentWorkspace(cwd) }
      catch (error) { setToast(error instanceof Error ? error.message : String(error)) }
    },
    [openRecentWorkspace]
  )

  const restart = useCallback(async () => {
    const next = await window.pi.restart()
    if (next.phase === 'error') setToast(next.error ?? 'pi 启动失败')
    else setToast('pi 已重新启动')
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void chooseWorkspace()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setSidebarOpen((value) => !value)
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [chooseWorkspace])

  const title =
    status.sessionName || sessions.find((session) => session.path === activePath)?.title || '新会话'
  /** Extra roots of the active session, for the session panel's environment card. */
  const activeAdditional =
    sessions.find((session) => session.path === activePath)?.additional ?? []

  return (
    <div className={`app ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      {sidebarOpen && (
        <Sidebar
          sessions={sessions}
          repos={repos}
          projects={projects}
          activeProject={activeProject}
          recentRepos={recentRepos}
          activePath={activePath}
          status={status}
          theme={theme}
          canGoBack={historyNav.canBack}
          canGoForward={historyNav.canForward}
          onBack={() => goHistory(-1)}
          onForward={() => goHistory(1)}
          onNew={() => void newSession()}
          onSelect={(session) => void selectSession(session)}
          onNewInProject={(cwd) => void newSessionInProject(cwd)}
          onChooseWorkspace={() => void chooseWorkspace()}
          onSelectProject={(id) => void selectProject(id)}
          onCreateProject={() => void createProject()}
          onEditProject={(id) => void editProject(id)}
          onDeleteProject={(id) => void deleteProject(id)}
          onNewInRepo={(dir) => void newSessionInProject(dir)}
          onSaveRepoDefaults={() => {
            void window.pi.saveRepoDefaults().then(() => {
              setToast('已把当前模型与思考等级设为该仓库的默认')
              void loadProjects()
            })
          }}
          onOpenSettings={() => {
            setSettingsTab('providers')
            setSettingsOpen(true)
          }}
          onOpenAgentDir={() => void window.pi.openAgentDir()}
          onRestart={() => void restart()}
          onCollapse={() => setSidebarOpen(false)}
          onToggleTheme={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
        />
      )}
      <main className="main">
        <TabBar
          title={title}
          status={status}
          streaming={Boolean(status.isStreaming || status.compacting)}
          panelOpen={panelOpen}
          sidebarOpen={sidebarOpen}
          subagentsRunning={subagents.filter(isSubagentRunning).length}
          subagentsFinished={
            subagents.filter((record) => !record.restored && record.status === 'idle').length
          }
          onNew={() => void chooseWorkspace()}
          onToggleSidebar={() => setSidebarOpen((value) => !value)}
          onTogglePanel={() => setPanelOpen((value) => !value)}
          onOpenSubagents={() => setSubagentsOpen(true)}
        />

        {status.phase === 'error' && (
          <div className="banner error">
            <div>
              <strong>引擎未连接</strong>
              <span>{status.error}</span>
              {status.stderrTail && (
                <code>{status.stderrTail.split('\n').slice(-3).join('\n')}</code>
              )}
            </div>
            <button onClick={() => void restart()}>重试</button>
          </div>
        )}

        {status.phase === 'ready' && capabilities?.providerSettings && !status.model && (
          <div className="banner warn">
            <div>
              <strong>尚未配置模型</strong>
              <span>在设置里登录 Anthropic、OpenAI 等服务商，或配置自定义端点。</span>
            </div>
            <div className="banner-actions">
              <button
                onClick={() => {
                  setSettingsTab('providers')
                  setSettingsOpen(true)
                }}
              >
                去登录
              </button>
              <button onClick={() => void restart()}>重启引擎</button>
            </div>
          </div>
        )}

        {update.latestVersion &&
          ['available', 'downloading', 'preparing', 'installing'].includes(update.status) && (
            <div className="banner update">
              <div>
                <strong>
                  {update.status === 'available'
                    ? `发现新版本 ${update.latestVersion}`
                    : update.status === 'downloading'
                      ? '正在下载更新'
                      : '正在安装更新'}
                </strong>
                <span>
                  {update.status === 'available'
                    ? `当前 ${update.currentVersion} · 可在设置中下载安装`
                    : `${updateStatusText(update)} · 当前 ${update.currentVersion}`}
                </span>
              </div>
              <div className="banner-actions">
                <button
                  onClick={() => {
                    setSettingsTab('general')
                    setSettingsOpen(true)
                  }}
                >
                  查看更新
                </button>
              </div>
            </div>
          )}

        <div className="main-body">
          <div className="chat-column">
            <div className="chat-area">
              <div
                className="scroll"
                ref={scrollRef}
                onScroll={(event) => {
                  const element = event.currentTarget
                  const distance = element.scrollHeight - element.scrollTop - element.clientHeight
                  setStick(distance < 80)
                  updateActiveUser()
                }}
              >
                <Conversation
                  items={items}
                  workspace={status.cwd}
                  connected={status.phase === 'ready'}
                  loggedIn={Boolean(status.model)}
                  subagents={subagents}
                  onOpenSubagent={openSubagents}
                  onSuggestion={(text) => {
                    setDraft(text)
                    requestAnimationFrame(() => {
                      const textarea =
                        document.querySelector<HTMLTextAreaElement>('.composer textarea')
                      textarea?.focus()
                    })
                  }}
                />
              </div>
              {items.length > 0 && (
                <SessionNavigator
                  items={items}
                  outline={outline}
                  activeUserIndex={activeUserIndex}
                  activeOutlineId={activeOutlineId}
                  onJump={jumpToMessage}
                />
              )}
            </div>

            {ask && (
              <AskQuestionPanel
                request={ask}
                queued={sessionAsks.length - 1}
                onSubmit={answerAsk}
                onCancel={cancelAsk}
              />
            )}

            <Composer
              key={activeComposerKey}
              capabilities={capabilities}
              commands={engineCommands}
              value={draft}
              onChange={setDraft}
              suggestion={suggestion && suggestion.key === activeComposerKey ? suggestion.text : undefined}
              onSuggestionUsed={() => setSuggestion(null)}
              images={draftImages}
              onImagesChange={setDraftImages}
              queued={queued}
              contextUsage={contextUsage}
              autoCompactPercent={status.autoCompactPercent}
              onQueueRemove={(id) => setQueued((prev) => prev.filter((item) => item.id !== id))}
              onQueueEdit={(id) => {
                const target = queued.find((item) => item.id === id)
                if (!target) return
                setQueued((prev) => prev.filter((item) => item.id !== id))
                setDraft(target.text)
                setDraftImages(target.images)
              }}
              onQueueSteer={(id) => {
                const target = queued.find((item) => item.id === id)
                if (!target || target.command) return
                if (!capabilities?.steer) {
                  setToast('当前引擎不支持运行中引导')
                  return
                }
                setQueued((prev) => prev.filter((item) => item.id !== id))
                void deliver(target.text, target.images, 'steer')
              }}
              onNotice={setToast}
              onSend={(mode) => void send(mode)}
              onStop={() => void window.pi.abort()}
              streaming={Boolean(status.isStreaming || status.compacting)}
              disabled={status.phase !== 'ready' || Boolean(status.switchingEngine) || Boolean(btwChat)}
              status={status}
              onChooseWorkspace={() => void chooseWorkspace()}
              statusBar={
                status.isStreaming || status.compacting || (status.backgroundTasks?.length ?? 0) > 0 || subagents.some(isSubagentRunning) ? (
                  <RunStatusBar
                    active={Boolean(status.isStreaming || status.compacting)}
                    activity={status.activity}
                    backgroundTasks={status.backgroundTasks}
                    onStop={() => void window.pi.abort()}
                    elapsedMs={runStatus?.elapsedMs ?? 0}
                    tokens={runStatus?.tokens}
                    runningTools={runStatus?.runningTools ?? 0}
                    subagents={subagents}
                    onOpenSubagent={openSubagents}
                  />
                ) : undefined
              }
            />
          </div>

          {panelOpen && (
            <SessionPanel
              key={activeComposerKey}
              subagents={subagents}
              onOpenSubagent={openSubagents}
              status={status}
              contextUsage={contextUsage}
              additional={activeAdditional}
              mcp={mcpState}
              items={items}
              onClose={() => setPanelOpen(false)}
              onOpenSettings={(tab) => {
                setSettingsTab(tab)
                setSettingsOpen(true)
              }}
              onNotice={setToast}
            />
          )}

          {subagentsOpen && (
            <SubagentsDrawer
              records={subagents}
              initialId={subagentFocus}
              onClose={() => {
                setSubagentsOpen(false)
                setSubagentFocus(undefined)
              }}
            />
          )}
        </div>

        {btwChat && (
          <div
            className="btw-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) void closeBtw()
            }}
          >
            <div className="btw-dialog">
              <div className="btw-dialog-head">
                <span className="btw-dialog-title">侧边提问</span>
                <span className="btw-dialog-sub">
                  从当前分支节点新开一个分支，在这里可以继续追问；关闭后分支丢弃，主会话不受影响
                </span>
                <button className="icon-btn" onClick={() => void closeBtw()} title="关闭（Esc）">
                  ×
                </button>
              </div>
              <div className="btw-dialog-body">
                {btwChat.turns.map((turn, index) => (
                  <div className="btw-turn" key={`btw-${index}`}>
                    <div className="btw-q">{turn.question}</div>
                    {turn.answer !== undefined && (
                      <div className="btw-a">
                        <Markdown>{turn.answer}</Markdown>
                      </div>
                    )}
                    {turn.error && <div className="btw-error">{turn.error}</div>}
                    {btwChat.busy &&
                      index === btwChat.turns.length - 1 &&
                      turn.answer === undefined &&
                      !turn.error && <div className="btw-loading">正在回答…</div>}
                  </div>
                ))}
              </div>
              <form
                className="btw-dialog-input"
                onSubmit={(event) => {
                  event.preventDefault()
                  void askBtw()
                }}
              >
                <input
                  autoFocus
                  value={btwDraft}
                  disabled={btwChat.busy}
                  placeholder="继续追问（Enter 发送，Esc 关闭）"
                  onChange={(event) => setBtwDraft(event.target.value)}
                />
                <button
                  type="submit"
                  className="primary"
                  disabled={btwChat.busy || !btwDraft.trim()}
                >
                  发送
                </button>
              </form>
            </div>
          </div>
        )}

        {mcpOpen && (
          <div
            className="mcp-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setMcpOpen(false)
            }}
          >
            <div className="mcp-overlay-card">
              <div className="mcp-overlay-head">
                <span>MCP 服务器</span>
                <button className="icon-btn" onClick={() => setMcpOpen(false)} title="关闭">
                  ×
                </button>
              </div>
              <div className="mcp-overlay-body">
                {(mcpState?.servers ?? []).length === 0 && (
                  <div className="provider-empty">没有 MCP 服务器</div>
                )}
                {(mcpState?.servers ?? []).map((server) => (
                  <div className="mcp-overlay-row" key={server.name}>
                    <div className="mcp-overlay-main">
                      <span className="mcp-overlay-name">
                        {server.name}
                        {server.builtin && <span className="badge">内置</span>}
                        <span className="mcp-overlay-transport">{server.transport}</span>
                      </span>
                      <span className="mcp-overlay-sub">
                        {server.summary || server.description || ''}
                      </span>
                    </div>
                    <span className={`mcp-overlay-state ${server.enabled ? 'on' : ''}`}>
                      {server.enabled ? '启用' : '停用'}
                    </span>
                  </div>
                ))}
                <div className="mcp-overlay-tools">
                  {(mcpState?.desktopTools ?? []).map((tool) => (
                    <span key={tool.name} className="mcp-overlay-tool">
                      desktop:{tool.name}
                    </span>
                  ))}
                  {(mcpState?.engines ?? []).flatMap((engine) =>
                    (engine.tools ?? []).map((tool) => (
                      <span key={`${engine.id}-${tool.name}`} className="mcp-overlay-tool">
                        {engine.id}:{tool.name}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="mcp-overlay-foot">
                完整配置在 设置 → MCP。工具数量：桌面 {mcpState?.desktopTools.length ?? 0}
                {(mcpState?.engines ?? [])
                  .map((engine) => ` · ${engine.name} ${engine.tools?.length ?? 0}`)
                  .join('')}
              </div>
            </div>
          </div>
        )}

        {!stick && items.length > 0 && (
          <button
            className="jump-bottom"
            onClick={() => {
              setStick(true)
              const element = scrollRef.current
              if (element) element.scrollTop = element.scrollHeight
            }}
          >
            回到最新
          </button>
        )}

        {commandOutput && (
          <div className="mcp-overlay" onClick={() => setCommandOutput(undefined)}>
            <div
              className="mcp-overlay-card"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-label="命令结果"
            >
              <header className="mcp-overlay-head">
                <strong>{commandOutput.title}</strong>
                <button onClick={() => setCommandOutput(undefined)}>关闭</button>
              </header>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  padding: 20,
                  maxHeight: '65vh',
                  overflow: 'auto'
                }}
              >
                {commandOutput.text}
              </pre>
            </div>
          </div>
        )}
        {toast && (
          <div className="toast" onClick={() => setToast(null)}>
            {toast}
          </div>
        )}
      </main>

      {editingProject && (
        <ProjectEditor
          project={editingProject}
          onClose={() => setEditingProject(undefined)}
          onSaved={(saved) => {
            void loadProjects()
            setToast(`已保存「${saved.name}」：${saved.roots.length} 个仓库`)
          }}
        />
      )}

      {workspacePickerOpen && <WorkspacePicker directories={recentRepos} current={status.cwd}
        onChoose={openRecentWorkspace} onBrowse={browseWorkspace} onClose={() => setWorkspacePickerOpen(false)} />}

      {confirmRequest && <ConfirmDialog request={confirmRequest} onResolve={resolveConfirm} />}

      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        status={status}
        theme={theme}
        onThemeChange={setTheme}
        update={update}
        onCheckUpdate={() => void window.pi.checkForUpdates().then(setUpdate)}
        onInstallUpdate={() => void window.pi.installUpdate().then(setUpdate)}
        onCancelUpdate={() => void window.pi.cancelUpdateDownload().then(setUpdate)}
        onSetAutoUpdate={(enabled) => void window.pi.setAutoUpdateCheck(enabled).then(setUpdate)}
        onSetAutoDownload={(enabled) => void window.pi.setAutoUpdateDownload(enabled).then(setUpdate)}
        onOpenReleases={() => void window.pi.openExternal(update.releasesUrl)}
        onClose={() => setSettingsOpen(false)}
        onRestart={restart}
        onChooseWorkspace={chooseWorkspace}
      />
    </div>
  )
}
