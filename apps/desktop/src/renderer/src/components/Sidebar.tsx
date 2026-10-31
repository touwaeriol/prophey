import { engineLabel } from '@shared/engine'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { PiStatus, Project, RepoInfo, SessionSummary } from '@shared/types'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BriefcaseIcon,
  CheckIcon,
  ArchiveIcon,
  BranchIcon,
  ChevronIcon,
  CloseIcon,
  EllipsisIcon,
  FilterIcon,
  FolderIcon,
  MoonIcon,
  PanelIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon
} from './Icons'
import {
  buildSessionGroups, baseName, pathKey, sortSessions, startOfDay,
  type Prefs, type StatusFilter, type EnvironmentFilter, type GroupMode, type SortMode
} from '../lib/session-groups'
import { moveSession, rankOrder, reconcileOrder } from '../lib/session-order'

const PAGE_SIZE = 10
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 520

/**
 * Drag the right edge of the session list.
 *
 * The handle keeps pointer capture so the drag survives the cursor running ahead of a repaint, and
 * the width is clamped: the conversation must never be squeezed out of the window.
 */
function startResize(
  event: React.PointerEvent<HTMLDivElement>,
  width: number,
  onResize: (width: number) => void
): void {
  event.preventDefault()
  const startX = event.clientX
  const startWidth = width
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {
    // synthetic events have no pointer to capture; the window listeners still carry the drag
  }
  document.body.classList.add('resizing-sidebar')
  const move = (moveEvent: PointerEvent): void => {
    const next = startWidth + (moveEvent.clientX - startX)
    onResize(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(next))))
  }
  const finish = (): void => {
    document.body.classList.remove('resizing-sidebar')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
}
const PREFS_KEY = 'pi-sidebar-prefs'
const ARCHIVE_KEY = 'pi-archived-sessions'
const PINNED_KEY = 'pi-pinned-sessions'
/** The row order the user arranged by dragging. Persisted, so it survives a restart. */
const ORDER_KEY = 'pi-session-order'

const DEFAULT_PREFS: Prefs = {
  environment: 'all',
  group: 'folder',
  sort: 'activity',
  showEmptyGroups: false,
  onlyActiveProject: false
}

const STATUS_LABELS: Record<StatusFilter, string> = {
  active: '活跃',
  archived: '已归档',
  all: '全部'
}

const ENVIRONMENT_LABELS: Record<EnvironmentFilter, string> = {
  all: '全部',
  local: '本地'
}

const GROUP_LABELS: Record<GroupMode, string> = {
  folder: '文件夹',
  date: '日期',
  none: '不分组'
}

const SORT_LABELS: Record<SortMode, string> = {
  activity: '最近活动',
  created: '创建时间',
  name: '名称'
}

const STATUS_OPTIONS: StatusFilter[] = ['active', 'archived', 'all']
const ENVIRONMENT_OPTIONS: EnvironmentFilter[] = ['all', 'local']
const GROUP_OPTIONS: GroupMode[] = ['folder', 'date', 'none']
const SORT_OPTIONS: SortMode[] = ['activity', 'created', 'name']

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    return {
      environment: ENVIRONMENT_OPTIONS.includes(raw.environment as EnvironmentFilter)
        ? (raw.environment as EnvironmentFilter)
        : DEFAULT_PREFS.environment,
      group: GROUP_OPTIONS.includes(raw.group as GroupMode)
        ? (raw.group as GroupMode)
        : DEFAULT_PREFS.group,
      sort: SORT_OPTIONS.includes(raw.sort as SortMode)
        ? (raw.sort as SortMode)
        : DEFAULT_PREFS.sort,
      showEmptyGroups: Boolean(raw.showEmptyGroups),
      onlyActiveProject: Boolean(raw.onlyActiveProject)
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function loadArchived(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVE_KEY) ?? '[]') as unknown
    return new Set(
      Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : []
    )
  } catch {
    return new Set()
  }
}

function loadPinned(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]') as unknown
    return Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

function loadOrder(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as unknown
    return Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

function formatTime(value: number): string {
  const date = new Date(value)
  const today = startOfDay(Date.now())
  if (startOfDay(value) === today) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}

const STATUS_TEXT: Record<PiStatus['phase'], string> = {
  starting: '启动中',
  ready: '已连接',
  error: '连接失败',
  stopped: '已停止'
}

export function Sidebar({
  sessions,
  repos,
  projects,
  activeProject,
  recentRepos,
  activePath,
  status,
  theme,
  width,
  onResize,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onNew,
  onSelect,
  onNewInProject,
  onChooseWorkspace,
  onSelectProject,
  onCreateProject,
  onEditProject,
  onDeleteProject,
  onNewInRepo,
  onSaveRepoDefaults,
  onOpenSettings,
  onOpenAgentDir,
  onRestart,
  onCollapse,
  onToggleTheme
}: {
  sessions: SessionSummary[]
  /** Repository facts per working directory, used for the branch badge in each group head. */
  repos: Record<string, RepoInfo>
  projects: Project[]
  /** The project the window works in; its repositories are grouped together in the list. */
  activeProject?: Project
  recentRepos: string[]
  activePath?: string
  status: PiStatus
  theme: 'dark' | 'light'
  /** Sidebar width in px; the user drags the right edge to change it. */
  width: number
  onResize: (width: number) => void
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onNew: () => void
  onSelect: (session: SessionSummary) => void
  onNewInProject: (cwd: string) => void
  onChooseWorkspace: () => void
  onSelectProject: (id: string) => void
  onCreateProject: () => void
  onEditProject: (id: string) => void
  onDeleteProject: (id: string) => void
  onNewInRepo: (dir: string) => void
  onSaveRepoDefaults: () => void
  onOpenSettings: () => void
  onOpenAgentDir: () => void
  onRestart: () => void
  onCollapse: () => void
  onToggleTheme: () => void
}) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [archived, setArchived] = useState<Set<string>>(loadArchived)
  const [pinned, setPinned] = useState<string[]>(loadPinned)
  const [order, setOrder] = useState<string[]>(loadOrder)
  const [dragFrom, setDragFrom] = useState<string>()
  const [dropTarget, setDropTarget] = useState<{ path: string; after: boolean }>()
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('prophey-sidebar-collapsed') ?? '[]')) } catch { return new Set() }
  })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [section, setSection] = useState<'environment' | 'group' | 'sort' | null>(null)
  const [searchKey, setSearchKey] = useState<string>()
  const [sessionMenu, setSessionMenu] = useState<string>()
  const [menuAbove, setMenuAbove] = useState(false)
  const [filterKey, setFilterKey] = useState<string>()
  const [pendingDelete, setPendingDelete] = useState<string>()
  const [projectQueries, setProjectQueries] = useState<Record<string, string>>({})
  const [projectStatus, setProjectStatus] = useState<Record<string, StatusFilter>>({})
  const menuRef = useRef<HTMLDivElement>(null)
  const sessionMenuRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const projectFilterRef = useRef<HTMLDivElement>(null)
  const selectedKey = status.sessionKey ?? activePath ?? status.sessionFile
  const isSelected = (session: SessionSummary): boolean => !!selectedKey && pathKey(session.path) === pathKey(selectedKey)
  const isRunning = (session: SessionSummary): boolean =>
    (status.runningSessionKeys ?? []).some(key => pathKey(key) === pathKey(session.path)) ||
    (isSelected(session) && !!(status.isStreaming || status.compacting || status.backgroundTasks?.length))

  const updatePrefs = (patch: Partial<Prefs>): void => {
    // Picking a different sort key is the user asking for that order, so the arranged one is spent.
    if (patch.sort && patch.sort !== prefs.sort) {
      setOrder([])
      localStorage.removeItem(ORDER_KEY)
    }
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      return next
    })
  }

  const toggleArchive = (path: string): void => {
    setArchived((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const togglePin = (path: string): void => {
    setPinned((prev) => {
      const next = prev.includes(path) ? prev.filter((value) => value !== path) : [...prev, path]
      localStorage.setItem(PINNED_KEY, JSON.stringify(next))
      return next
    })
  }

  const pinnedSessions = useMemo(
    () =>
      pinned
        .map((path) => sessions.find((session) => session.path === path))
        .filter((session): session is SessionSummary => Boolean(session)),
    [pinned, sessions]
  )

  useEffect(() => {
    if (!sessionMenu) return
    const onMouseDown = (event: MouseEvent): void => {
      if (!sessionMenuRef.current?.contains(event.target as Node)) setSessionMenu(undefined)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSessionMenu(undefined)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [sessionMenu])

  useEffect(() => {
    if (!menuOpen) return
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (menuRef.current?.contains(event.target as Node)) return
      if (target?.closest('.view-trigger')) return
      setMenuOpen(false)
      setSection(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setSection(null)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!filterKey) return
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (projectFilterRef.current?.contains(event.target as Node)) return
      if (target?.closest('.project-filter-trigger')) return
      setFilterKey(undefined)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setFilterKey(undefined)
        setSearchKey(undefined)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [filterKey])

  useEffect(() => {
    if (!moreOpen) return
    const onMouseDown = (event: MouseEvent): void => {
      if (moreRef.current?.contains(event.target as Node)) return
      setMoreOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [moreOpen])

  /**
   * Fold the sessions that are present into the arranged order, once per list change.
   *
   * A session seen for the first time sorts in by the chosen key at the place it would have had;
   * everything the user placed stays exactly where it is. This is the only place the order grows or
   * shrinks, which is why opening, running or renaming a session never moves a row.
   */
  useEffect(() => {
    const sorted = sortSessions(sessions, prefs.sort).map((session) => session.path)
    setOrder((prev) => {
      const next = reconcileOrder(prev, sorted)
      if (next.length === prev.length && next.every((path, index) => path === prev[index])) return prev
      localStorage.setItem(ORDER_KEY, JSON.stringify(next))
      return next
    })
  }, [sessions, prefs.sort])

  const dropSession = (target: string, after: boolean): void => {
    const from = dragFrom
    setDragFrom(undefined)
    setDropTarget(undefined)
    if (!from || from === target) return
    const next = moveSession(order, from, target, after ? 'after' : 'before')
    setOrder(next)
    localStorage.setItem(ORDER_KEY, JSON.stringify(next))
  }

  const groups = useMemo(
    () => buildSessionGroups({
      sessions, pinned, prefs, archived, projectStatus, projectQueries, cwd: status.cwd, activeProject, projects,
      order: rankOrder(order)
    }),
    [sessions, pinned, prefs, archived, projectStatus, projectQueries, status.cwd, activeProject, projects, order]
  )

  useEffect(() => {
    if (!activePath) return
    const group = groups.find((item) =>
      item.sessions.some((session) => session.path === activePath)
    )
    if (!group) return
    setCollapsed((prev) => {
      if (!prev.has(group.key)) return prev
      const next = new Set(prev)
      next.delete(group.key)
      return next
    })
    setExpanded((prev) => {
      if (prev.has(group.key)) return prev
      const index = group.sessions.findIndex((session) => session.path === activePath)
      if (index < PAGE_SIZE) return prev
      const next = new Set(prev)
      next.add(group.key)
      return next
    })
  }, [activePath, groups])

  const toggleCollapsed = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      localStorage.setItem('prophey-sidebar-collapsed', JSON.stringify([...next]))
      return next
    })
  }

  const toggleExpanded = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const filtersActive =
    prefs.environment !== 'all' ||
    prefs.group !== 'folder' ||
    prefs.sort !== 'activity' ||
    prefs.showEmptyGroups

  const renderOptions = (): React.JSX.Element | null => {
    if (!section) return null
    const config = {
      environment: {
        values: ENVIRONMENT_OPTIONS,
        labels: ENVIRONMENT_LABELS,
        current: prefs.environment,
        apply: (value: EnvironmentFilter) => updatePrefs({ environment: value })
      },
      group: {
        values: GROUP_OPTIONS,
        labels: GROUP_LABELS,
        current: prefs.group,
        apply: (value: GroupMode) => updatePrefs({ group: value })
      },
      sort: {
        values: SORT_OPTIONS,
        labels: SORT_LABELS,
        current: prefs.sort,
        apply: (value: SortMode) => updatePrefs({ sort: value })
      }
    }[section]

    return (
      <div className="filter-submenu">
        {config.values.map((value) => {
          const active = value === config.current
          return (
            <button
              key={value}
              className={`filter-option ${active ? 'active' : ''}`}
              onClick={() => {
                config.apply(value as never)
                setSection(null)
                setMenuOpen(false)
              }}
            >
              <span>{config.labels[value as never]}</span>
              {active && <CheckIcon size={12} />}
            </button>
          )
        })}
        {section === 'environment' && (
          <button className="filter-option disabled" disabled title="暂未接入 SSH 环境">
            <span>SSH</span>
            <span className="filter-option-tag">未接入</span>
          </button>
        )}
      </div>
    )
  }

  return (
    <aside className="sidebar" style={{ width, flexBasis: width }}>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话栏宽度"
        title="拖动调整宽度（双击恢复 280px）"
        onPointerDown={(event) => startResize(event, width, onResize)}
        onDoubleClick={() => onResize(280)}
      >
        <span className="sidebar-resizer-grip" aria-hidden="true" />
      </div>
      <div className="sidebar-toolbar">
        <button className="icon-btn" title="隐藏会话列表" onClick={onCollapse}>
          <PanelIcon size={15} />
        </button>
        <button
          className={`icon-btn view-trigger ${menuOpen ? 'on' : ''} ${
            filtersActive ? 'has-filter' : ''
          }`}
          title="视图选项（分组 / 排序 / 环境）"
          onClick={() => {
            setMenuOpen((value) => !value)
            setSection(null)
          }}
        >
          <FilterIcon size={14} />
        </button>
        <div className="toolbar-spacer" />
        <button className="icon-btn" title="上一个会话" disabled={!canGoBack} onClick={onBack}>
          <ArrowLeftIcon size={14} />
        </button>
        <button
          className="icon-btn"
          title="下一个会话"
          disabled={!canGoForward}
          onClick={onForward}
        >
          <ArrowRightIcon size={14} />
        </button>
      </div>

      {menuOpen && (
        <div className="sidebar-filter" ref={menuRef}>
          <button
            className={`filter-row ${section === 'environment' ? 'active' : ''}`}
            onClick={() => setSection('environment')}
          >
            <span>环境</span>
            <span className="filter-value">
              {ENVIRONMENT_LABELS[prefs.environment]}
              <ChevronIcon size={11} />
            </span>
          </button>
          <div className="filter-divider" />
          <button
            className={`filter-row ${section === 'group' ? 'active' : ''}`}
            onClick={() => setSection('group')}
          >
            <span>分组</span>
            <span className="filter-value">
              {GROUP_LABELS[prefs.group]}
              <ChevronIcon size={11} />
            </span>
          </button>
          <button
            className={`filter-row ${section === 'sort' ? 'active' : ''}`}
            onClick={() => setSection('sort')}
          >
            <span>排序</span>
            <span className="filter-value">
              {SORT_LABELS[prefs.sort]}
              <ChevronIcon size={11} />
            </span>
          </button>
          <div className="filter-divider" />
          <button
            className="filter-row"
            onClick={() => updatePrefs({ showEmptyGroups: !prefs.showEmptyGroups })}
          >
            <span>显示空分组</span>
            <span className={`filter-check ${prefs.showEmptyGroups ? 'on' : ''}`}>
              {prefs.showEmptyGroups && <CheckIcon size={11} />}
            </span>
          </button>
          {activeProject && (
            <button
              className="filter-row"
              onClick={() => updatePrefs({ onlyActiveProject: !prefs.onlyActiveProject })}
            >
              <span>只看「{activeProject.name}」</span>
              <span className={`filter-check ${prefs.onlyActiveProject ? 'on' : ''}`}>
                {prefs.onlyActiveProject && <CheckIcon size={11} />}
              </span>
            </button>
          )}
          <button className="filter-row disabled" disabled title="pi 会话没有 PR 元数据">
            <span>显示 PR 状态</span>
            <span className="filter-option-tag">不支持</span>
          </button>
          {renderOptions()}
        </div>
      )}

      <div className="sidebar-nav">
        <button className="nav-row" onClick={onChooseWorkspace} title="从最近目录新建会话">
          <span className="nav-glyph">
            <PlusIcon size={13} />
          </span>
          <span className="nav-label">新会话</span>
        </button>
        <button className="nav-row" onClick={onCreateProject} title="选择多个目录创建项目">
          <span className="nav-glyph"><FolderIcon size={13} /></span>
          <span className="nav-label">新项目</span>
        </button>
        <button className="nav-row" onClick={onOpenSettings}>
          <span className="nav-glyph">
            <BriefcaseIcon size={13} />
          </span>
          <span className="nav-label">设置</span>
        </button>
        <div className="nav-more" ref={moreRef}>
          <button
            className={`nav-row ${moreOpen ? 'open' : ''}`}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <span className="nav-glyph">
              <ChevronIcon size={12} className={moreOpen ? 'open' : ''} />
            </span>
            <span className="nav-label">更多</span>
          </button>
          {moreOpen && (
            <div className="nav-menu">
              <button className="nav-menu-row" onClick={() => { setMoreOpen(false); onNew() }}>在当前工作区新建</button>
              <button
                className="nav-menu-row"
                onClick={() => {
                  setMoreOpen(false)
                  setMenuOpen(true)
                  setSection(null)
                }}
              >
                视图选项
              </button>
              <button
                className="nav-menu-row"
                onClick={() => {
                  setMoreOpen(false)
                  onChooseWorkspace()
                }}
              >
                在新目录新建会话
              </button>
              {recentRepos.length > 0 && (
                <>
                  <div className="nav-menu-label">最近目录</div>
                  {recentRepos.slice(0, 6).map((dir) => (
                    <button
                      key={dir}
                      className={`nav-menu-row recent-repo ${
                        pathKey(dir) === pathKey(status.cwd) ? 'active' : ''
                      }`}
                      title={dir}
                      onClick={() => {
                        setMoreOpen(false)
                        onNewInRepo(dir)
                      }}
                    >
                      <BranchIcon size={11} />
                      <span className="recent-repo-name">{baseName(dir)}</span>
                    </button>
                  ))}
                </>
              )}
              <button
                className="nav-menu-row"
                onClick={() => {
                  setMoreOpen(false)
                  onSaveRepoDefaults()
                }}
              >
                设为该仓库默认模型
              </button>
              <button
                className="nav-menu-row"
                onClick={() => {
                  setMoreOpen(false)
                  onOpenAgentDir()
                }}
              >
                打开配置目录
              </button>
              <button
                className="nav-menu-row"
                onClick={() => {
                  setMoreOpen(false)
                  onRestart()
                }}
              >
                重启引擎
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="session-list">
      {pinnedSessions.length > 0 && (
        <div className="pinned-block">
          <div className="pinned-head">
            <button
              className="pinned-toggle"
              onClick={() => setPinnedCollapsed((value) => !value)}
              aria-expanded={!pinnedCollapsed}
              title={pinnedCollapsed ? '展开置顶' : '收起置顶'}
            >
              <ChevronIcon size={11} className={pinnedCollapsed ? '' : 'open'} />
              <span>置顶</span>
            </button>
            <span className="pinned-count">{pinnedSessions.length}</span>
          </div>
          {!pinnedCollapsed && pinnedSessions.map((session, index) => (
            <div
              key={session.path}
              className={`pinned-item ${isSelected(session) ? 'active' : ''} ${isRunning(session) ? 'running' : ''}`}
              role="button"
              tabIndex={0}
              title={`${session.title}\n${session.cwd}\n${engineLabel(session.engine)} · ${formatTime(session.updatedAt)}`}
              aria-current={isSelected(session) ? 'page' : undefined}
              onClick={() => onSelect(session)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(session)
                }
              }}
            >
              {isSelected(session) || isRunning(session)
                ? <span className={`session-dot current ${isRunning(session) ? 'running' : ''}`} role="img" aria-label={isRunning(session) ? '正在执行' : '当前会话'} />
                : <span className="pinned-index">{index + 1}</span>}
              <span className="pinned-title">{session.title}</span>
              {isRunning(session) && (
                <span className="session-spinner" role="img" aria-label="正在执行" title="正在执行" />
              )}
              <button
                className="pinned-unpin"
                title="取消置顶"
                onClick={(event) => {
                  event.stopPropagation()
                  togglePin(session.path)
                }}
              >
                <CloseIcon size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

        {groups.length === 0 && pinnedSessions.length === 0 && (
          <div className="session-empty">
            {sessions.length === 0
              ? '还没有会话，发送第一条消息即可创建'
              : '没有符合当前筛选的会话'}
          </div>
        )}
        {groups.map((group, groupIndex) => {
          const isProject = !!group.rootCount && group.rootCount > 1
          const previousIsProject = groupIndex > 0 && (groups[groupIndex - 1].rootCount ?? 0) > 1
          const isCollapsed = collapsed.has(group.key)
          const isExpanded = expanded.has(group.key) || group.searching
          const visible = isExpanded ? group.sessions : group.sessions.slice(0, PAGE_SIZE)
          const hidden = group.sessions.length - PAGE_SIZE
          const projectStatusValue = projectStatus[group.key] ?? 'active'
          return (
            <Fragment key={group.key}>
            {(groupIndex === 0 || isProject !== previousIsProject) && <div className="section-label sidebar-section-label">{isProject ? '项目' : '会话'}</div>}
            <section className={`project-group ${isProject ? 'multi-directory-project' : ''}`} data-group-key={group.key}>
              {group.label && (
                <div className="project-head">
                  <button
                    className="project-toggle"
                    onClick={() => toggleCollapsed(group.key)}
                    aria-expanded={!isCollapsed}
                    title={
                      group.cwd
                        ? `${repos[group.cwd]?.root ?? group.cwd}${
                            repos[group.cwd]?.remote ? `\n${repos[group.cwd]?.remote}` : ''
                          }`
                        : group.label
                    }
                  >
                    <ChevronIcon size={11} className={isCollapsed ? '' : 'open'} />
                    <span className="project-name">{group.label}</span>
                    {isProject && <span className="project-root-count">{group.rootCount} 个目录</span>}
                    <span className="project-count" title={`${group.sessions.length} 个会话`}>
                      {group.sessions.length}
                    </span>
                  </button>
                  <div className="project-actions">
                    {group.cwd && (
                      <button
                        className="project-action"
                        title={`在 ${group.label} 新建会话`}
                        onClick={() => group.projectId ? onSelectProject(group.projectId) : onNewInProject(group.cwd!)}
                      >
                        <PlusIcon size={13} />
                      </button>
                    )}
                    <button
                      className={`project-action ${searchKey === group.key ? 'on' : ''}`}
                      title={`搜索 ${group.label}`}
                      onClick={() => {
                        setSearchKey((value) => (value === group.key ? undefined : group.key))
                        setFilterKey(undefined)
                      }}
                    >
                      <SearchIcon size={12} />
                    </button>
                    <button
                      className={`project-action project-filter-trigger ${
                        filterKey === group.key ? 'on' : ''
                      }`}
                      title={`筛选 ${group.label}`}
                      onClick={() => {
                        setPendingDelete(undefined)
                        setFilterKey((value) => (value === group.key ? undefined : group.key))
                        setSearchKey(undefined)
                      }}
                    >
                      <EllipsisIcon size={13} />
                    </button>
                  </div>
                </div>
              )}

              {searchKey === group.key && (
                <div className="project-search">
                  <SearchIcon size={12} />
                  <input
                    autoFocus
                    value={projectQueries[group.key] ?? ''}
                    onChange={(event) =>
                      setProjectQueries((prev) => ({ ...prev, [group.key]: event.target.value }))
                    }
                    placeholder={`搜索 ${group.label}`}
                    spellCheck={false}
                  />
                  {(projectQueries[group.key] ?? '') && (
                    <button
                      className="project-search-clear"
                      title="清空"
                      onClick={() => setProjectQueries((prev) => ({ ...prev, [group.key]: '' }))}
                    >
                      <CloseIcon size={11} />
                    </button>
                  )}
                </div>
              )}

              {filterKey === group.key && (
                <div className="project-filter" ref={projectFilterRef}>
                  {group.projectId && <>
                    <button className="filter-option" onClick={() => { onEditProject(group.projectId!); setFilterKey(undefined) }}>管理项目目录</button>
                    <button className="filter-option" onClick={() => {
                      if (pendingDelete !== group.projectId) { setPendingDelete(group.projectId); return }
                      onDeleteProject(group.projectId!); setFilterKey(undefined); setPendingDelete(undefined)
                    }}>{pendingDelete === group.projectId ? '确认移除项目（保留会话）' : '移除项目'}</button>
                    <div className="filter-divider" />
                  </>}
                  <div className="project-filter-head">筛选 {group.label}</div>
                  {STATUS_OPTIONS.map((value) => (
                    <button
                      key={value}
                      className={`filter-option ${projectStatusValue === value ? 'active' : ''}`}
                      onClick={() => {
                        setProjectStatus((prev) => ({ ...prev, [group.key]: value }))
                        setFilterKey(undefined)
                      }}
                    >
                      <span>{STATUS_LABELS[value]}</span>
                      {projectStatusValue === value && <CheckIcon size={12} />}
                    </button>
                  ))}
                </div>
              )}

              {!isCollapsed && (
                <div className="project-sessions">
                  {group.sessions.length === 0 && (
                    <div className="session-empty-group">暂无会话</div>
                  )}
                  {visible.map((session) => {
                    const isArchived = archived.has(session.path)
                    return (
                      <div
                        key={session.path}
                        className={`session-item ${isSelected(session) ? 'active' : ''} ${isRunning(session) ? 'running' : ''} ${
                          isArchived ? 'archived' : ''
                        } ${
                          dropTarget?.path === session.path ? (dropTarget.after ? 'drop-after' : 'drop-before') : ''
                        } ${
                          dragFrom === session.path ? 'dragging' : ''
                        }`}
                        draggable
                        onDragStart={(event) => {
                          setDragFrom(session.path)
                          event.dataTransfer.effectAllowed = 'move'
                          // Firefox refuses to start a drag without payload.
                          event.dataTransfer.setData('text/plain', session.path)
                        }}
                        onDragOver={(event) => {
                          if (!dragFrom || dragFrom === session.path) return
                          event.preventDefault()
                          event.dataTransfer.dropEffect = 'move'
                          const rect = event.currentTarget.getBoundingClientRect()
                          const after = event.clientY > rect.top + rect.height / 2
                          setDropTarget((prev) =>
                            prev?.path === session.path && prev.after === after ? prev : { path: session.path, after }
                          )
                        }}
                        onDragLeave={() =>
                          setDropTarget((prev) => (prev?.path === session.path ? undefined : prev))
                        }
                        onDragEnd={() => {
                          setDragFrom(undefined)
                          setDropTarget(undefined)
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          const rect = event.currentTarget.getBoundingClientRect()
                          dropSession(session.path, event.clientY > rect.top + rect.height / 2)
                        }}
                        role="button"
                        tabIndex={0}
                        title={`${session.title}\n${session.cwd}\n${engineLabel(session.engine)} · ${formatTime(session.updatedAt)}${isArchived ? ' · 已归档' : ''}`}
                        aria-current={isSelected(session) ? 'page' : undefined}
                        onClick={() => onSelect(session)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onSelect(session)
                          }
                        }}
                      >
                        <span className={`session-dot ${isSelected(session) ? 'current' : ''} ${isRunning(session) ? 'running' : ''}`} role="img" aria-label={isRunning(session) ? '正在执行' : isSelected(session) ? '当前会话' : '未运行'} />
                        <div className="session-main">
                          <span className="session-title">{session.title}</span>
                          {isArchived && <ArchiveIcon size={11} />}
                          {isRunning(session) && (
                            <span className="session-spinner" role="img" aria-label="正在执行" title="正在执行" />
                          )}
                        </div>
                        <div
                          className="session-menu-wrap"
                          ref={sessionMenu === session.path ? sessionMenuRef : undefined}
                        >
                          <button
                            className={`session-pin-btn ${pinned.includes(session.path) ? 'on' : ''}`}
                            title={pinned.includes(session.path) ? '取消置顶' : '置顶到顶部'}
                            aria-pressed={pinned.includes(session.path)}
                            onClick={(event) => {
                              event.stopPropagation()
                              togglePin(session.path)
                            }}
                          >
                            <PinIcon size={12} />
                          </button>
                          <button
                            className={`session-menu-btn ${sessionMenu === session.path ? 'open' : ''}`}
                            title="更多操作"
                            onClick={(event) => {
                              event.stopPropagation()
                              const boundary = event.currentTarget.closest('.session-list')?.getBoundingClientRect()
                              setMenuAbove(!!boundary && event.currentTarget.getBoundingClientRect().bottom + 90 > boundary.bottom)
                              setSessionMenu((current) =>
                                current === session.path ? undefined : session.path
                              )
                            }}
                          >
                            <EllipsisIcon size={13} />
                          </button>
                          {sessionMenu === session.path && (
                            <div
                              className={`session-menu ${menuAbove ? 'above' : ''}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <button
                                className="session-menu-item"
                                onClick={() => {
                                  togglePin(session.path)
                                  setSessionMenu(undefined)
                                }}
                              >
                                {pinned.includes(session.path) ? '取消置顶' : '置顶'}
                              </button>
                              <button
                                className="session-menu-item"
                                onClick={() => {
                                  toggleArchive(session.path)
                                  setSessionMenu(undefined)
                                }}
                              >
                                {isArchived ? '取消归档' : '归档'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {hidden > 0 && !group.searching && (
                    <button className="show-more" onClick={() => toggleExpanded(group.key)}>
                      {isExpanded ? '收起' : `显示其余 ${hidden} 条`}
                    </button>
                  )}
                </div>
              )}
            </section>
            </Fragment>
          )
        })}
      </div>

      <div className="sidebar-foot">
        <div className="status-card">
          <div className="status-card-row">
            <button
              className="status-card-head"
              onClick={onChooseWorkspace}
              title={`${status.cwd}（切换工作目录）`}
            >
              <FolderIcon size={14} />
              <span className="status-card-name">{baseName(status.cwd) || status.cwd}</span>
            </button>
            <div className="status-card-actions">
              <button
                className="status-card-btn"
                title={theme === 'light' ? '切换到深色主题' : '切换到亮色主题'}
                onClick={onToggleTheme}
              >
                {theme === 'light' ? <MoonIcon size={14} /> : <SunIcon size={14} />}
              </button>
              <button className="status-card-btn" title="设置（Ctrl+,）" onClick={onOpenSettings}>
                <SettingsIcon size={14} />
              </button>
            </div>
          </div>
          <div className="status-card-meta">
            <span className={`status-pill ${status.phase}`} title={`内核${STATUS_TEXT[status.phase]}`}>
              {engineLabel(status.engine)} · {STATUS_TEXT[status.phase]}
            </span>
            {status.model && (
              <span className="status-model-pill" title={status.model.id}>
                {status.model.id}
              </span>
            )}
            <span className={`status-dot ${status.phase}`} title={STATUS_TEXT[status.phase]} />
          </div>
        </div>
      </div>
    </aside>
  )
}
