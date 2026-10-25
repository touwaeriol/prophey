import type { Project, SessionSummary } from '@shared/types'

export type StatusFilter = 'active' | 'archived' | 'all'
export type EnvironmentFilter = 'all' | 'local'
export type GroupMode = 'folder' | 'date' | 'none'
export type SortMode = 'activity' | 'created' | 'name'

export interface Prefs {
  environment: EnvironmentFilter
  group: GroupMode
  sort: SortMode
  showEmptyGroups: boolean
  /** Hide sessions that belong to another project (or to none) while a project is active. */
  onlyActiveProject: boolean
}

export interface SessionGroup {
  key: string
  label: string
  cwd?: string
  projectId?: string
  rootCount?: number
  sessions: SessionSummary[]
  total: number
  searching: boolean
  latest: number
  /**
   * Oldest `createdAt` in the group: when this directory/project first appeared here.
   *
   * Group order keys off this instead of `latest`, so switching sessions (which touches
   * `updatedAt`) can never reorder the sidebar's directories — only a brand-new directory sorts in.
   */
  born: number
  order: number
}

export function startOfDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dateGroup(value: number): { label: string; order: number } {
  const today = startOfDay(Date.now())
  const day = startOfDay(value)
  if (day === today) return { label: '今天', order: 0 }
  if (day === today - 86400000) return { label: '昨天', order: 1 }
  if (day > today - 86400000 * 7) return { label: '本周', order: 2 }
  return { label: '更早', order: 3 }
}

export function baseName(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** Windows compares paths case-insensitively; the same repo arrives with different casing. */
export function pathKey(dir: string): string {
  return /^[A-Za-z]:/.test(dir) || dir.includes('\\') ? dir.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() : dir
}

interface GroupOptions {
  sessions: SessionSummary[]
  pinned: string[]
  prefs: Prefs
  archived: Set<string>
  projectStatus: Record<string, StatusFilter>
  projectQueries: Record<string, string>
  cwd: string
  activeProject?: Project
  projects?: Project[]
}

/** View policy shared by every grouping mode, independent of DOM and persisted preferences. */
export function buildSessionGroups({
  sessions, pinned, prefs, archived, projectStatus, projectQueries, cwd, activeProject, projects = []
}: GroupOptions): SessionGroup[] {
  const catalogue = new Map(projects.map(project => [project.id, project]))
  if (activeProject) catalogue.set(activeProject.id, activeProject)
  const pinnedPaths = new Set(pinned)
  const visible = sessions.filter(session => !pinnedPaths.has(session.path) &&
    (!prefs.onlyActiveProject || !activeProject || session.projectId === activeProject.id))
  const isMultiRoot = (session: SessionSummary): boolean => {
    const project = session.projectId ? catalogue.get(session.projectId) : undefined
    return project ? project.roots.length > 1 : (session.additional?.length ?? 0) > 0
  }
  const rootsKey = (session: SessionSummary): string =>
    'roots:' + [session.cwd, ...(session.additional ?? [])].map(pathKey).sort().join('|')
  /**
   * When each group first appeared, taken from *every* saved session (pinned and archived too).
   *
   * Pinning or archiving the oldest session of a directory must not make the directory look new and
   * move it; only a directory that genuinely gains its first session sorts in.
   */
  const bornOf = new Map<string, number>()
  const noteBorn = (key: string, session: SessionSummary): void => {
    const createdAt = Number.isFinite(session.createdAt) ? session.createdAt : Number.POSITIVE_INFINITY
    bornOf.set(key, Math.min(bornOf.get(key) ?? Number.POSITIVE_INFINITY, createdAt))
  }
  for (const session of sessions) {
    if (isMultiRoot(session)) {
      noteBorn('project:' + (session.projectId ?? rootsKey(session)), session)
    } else if (prefs.group === 'folder') {
      noteBorn('folder:' + pathKey(session.cwd), session)
    }
  }
  const applyView = (key: string, list: SessionSummary[]) => {
    const status = projectStatus[key] ?? 'active'
    const needle = (projectQueries[key] ?? '').trim().toLowerCase()
    const filtered = list.filter(session => {
      const hidden = archived.has(session.path)
      return !(status === 'active' && hidden) && !(status === 'archived' && !hidden) &&
        (!needle || (session.title + ' ' + session.cwd).toLowerCase().includes(needle))
    })
    filtered.sort((a, b) => prefs.sort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') :
      prefs.sort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt)
    // Rows keep the order of their own sort key. Opening a session must not lift it to the top of
    // its directory — a list that rearranges under the cursor is the bug, not a feature. Sessions
    // past the first page are revealed by expanding the group (see the active-session effect in
    // `Sidebar`), not by moving them.
    return { sessions: filtered, total: list.length, searching: !!needle,
      latest: list.reduce((max, session) => Math.max(max, session.updatedAt), 0),
      born: bornOf.get(key) ?? Number.POSITIVE_INFINITY }
  }
  /** Sort groups by their own age, not by activity: a directory keeps its slot for good. */
  const groupOrder = (a: SessionGroup, b: SessionGroup): number => {
    if (prefs.sort === 'name') return a.label.localeCompare(b.label, 'zh-CN')
    const left = Number.isFinite(a.born) ? a.born : Number.POSITIVE_INFINITY
    const right = Number.isFinite(b.born) ? b.born : Number.POSITIVE_INFINITY
    return right === left ? a.label.localeCompare(b.label, 'zh-CN') : right - left
  }
  // Ownership comes from the saved session, never from a directory shared by multiple projects.
  const projectBuckets = new Map<string, { project?: Project; list: SessionSummary[] }>()
  for (const project of catalogue.values()) {
    if (project.roots.length < 2) continue
    if (prefs.onlyActiveProject && activeProject && project.id !== activeProject.id) continue
    projectBuckets.set(project.id, { project, list: [] })
  }
  const standalone: SessionSummary[] = []
  for (const session of visible) {
    if (isMultiRoot(session)) {
      const id = session.projectId ?? rootsKey(session)
      const project = session.projectId ? catalogue.get(session.projectId) : undefined
      const bucket = projectBuckets.get(id) ?? { project, list: [] }
      bucket.list.push(session)
      projectBuckets.set(id, bucket)
    } else standalone.push(session)
  }
  const projectGroups: SessionGroup[] = [...projectBuckets].map(([id, bucket]) => {
    const primary = bucket.project?.roots.find(root => root.primary) ?? bucket.project?.roots[0]
    const key = 'project:' + id
    return { key, label: bucket.project?.name ?? '多目录项目',
      projectId: bucket.project?.id, rootCount: bucket.project?.roots.length ?? 1 + (bucket.list[0]?.additional?.length ?? 0),
      cwd: primary?.path ?? bucket.list[0]?.cwd, order: 0, ...applyView(key, bucket.list) }
  })
  projectGroups.sort(groupOrder)

  const buckets = new Map<string, { label: string; cwd?: string; order: number; list: SessionSummary[] }>()
  const add = (session: SessionSummary | undefined, directory: string) => {
    const date = dateGroup(session?.updatedAt ?? Date.now())
    const key = prefs.group === 'none' ? 'none' : prefs.group === 'date' ? 'date:' + date.label : 'folder:' + pathKey(directory)
    const bucket = buckets.get(key) ?? {
      label: prefs.group === 'none' ? '全部会话' : prefs.group === 'date' ? date.label : baseName(directory) || '未命名目录',
      cwd: prefs.group === 'folder' ? directory : undefined,
      order: prefs.group === 'date' ? date.order : 0, list: []
    }
    if (session) bucket.list.push(session)
    buckets.set(key, bucket)
  }
  for (const session of standalone) add(session, session.cwd)
  if (prefs.showEmptyGroups && prefs.group === 'folder' && (!prefs.onlyActiveProject || !activeProject)) add(undefined, cwd)
  const ordinary: SessionGroup[] = [...buckets].map(([key, bucket]) => ({
    key, label: bucket.label, cwd: bucket.cwd, order: bucket.order, ...applyView(key, bucket.list)
  }))
  ordinary.sort((a, b) => prefs.group === 'date' ? a.order - b.order : groupOrder(a, b))
  return [...projectGroups, ...ordinary]
}
