import { writeJsonAtomic } from './storage'
import type { EngineId } from '../shared/engine'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SessionSummary } from '../shared/types'

/**
 * The app's own session records.
 *
 * pi keeps sessions as JSONL files and the window used to discover them by walking that directory
 * and parsing each file's head — which made pi's storage format the app's data model. This store
 * owns the list instead: id, workspace, title and timestamps live here, and the engine's file is an
 * implementation detail (`path`) that only matters when a session is opened.
 *
 * That is the seam the agent rework needs: swapping the engine must not change how sessions are
 * listed, sorted or grouped.
 */
export interface SessionRecord {
  engine?: EngineId
  /** Stable app-level conversation identity. */
  id: string
  /** Stable sidebar identity, preserving existing pins when the engine-private path changes. */
  key?: string
  /** Engine-private location; empty until the engine reports where it wrote. */
  path: string
  /** Working directory of the session (a project's primary root when it was started in one). */
  cwd: string
  /** Extra directories the session covers, captured when it was created. */
  additional: string[]
  /** Project the session was started in, if any. */
  projectId?: string
  title: string
  titleSource?: 'prompt' | 'generated' | 'manual'
  /**
   * The model and thinking level this conversation last ran with.
   *
   * The CLIs keep one global default model, so without this a conversation switched to another
   * model came back on the default after visiting a different session — a per-session choice that
   * behaved like a window-wide one.
   */
  provider?: string
  model?: string
  thinkingLevel?: string
  createdAt: number
  updatedAt: number
}

interface SessionFile {
  sessions: SessionRecord[]
}

function readRecord(value: unknown): SessionRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  const filePath = typeof raw.path === 'string' ? raw.path : ''
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : ''
  if (!id || (!filePath && !cwd)) return undefined
  const additional = Array.isArray(raw.additional)
    ? raw.additional.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    id,
    key: typeof raw.key === 'string' ? raw.key : filePath || id,
    engine: ['pi', 'prophey', 'claude', 'codex'].includes(String(raw.engine))
      ? (raw.engine as EngineId)
      : undefined,
    path: filePath,
    cwd,
    additional,
    ...(typeof raw.projectId === 'string' ? { projectId: raw.projectId } : {}),
    title: typeof raw.title === 'string' ? raw.title : '',
    titleSource: ['prompt', 'generated', 'manual'].includes(String(raw.titleSource))
      ? raw.titleSource as SessionRecord['titleSource'] : undefined,
    ...(typeof raw.provider === 'string' && raw.provider ? { provider: raw.provider } : {}),
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    ...(typeof raw.thinkingLevel === 'string' && raw.thinkingLevel
      ? { thinkingLevel: raw.thinkingLevel }
      : {}),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
  }
}

/** What the window needs, so the renderer does not learn about the engine's storage. */
export function toSummary(record: SessionRecord): SessionSummary {
  return {
    path: record.key || record.path || record.id,
    engine: record.engine ?? 'pi',
    title: record.title || path.basename(record.path || record.id, '.jsonl'),
    cwd: record.cwd,
    projectId: record.projectId,
    additional: [...record.additional],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

export class SessionStore {
  private readonly filePath: string
  private records: SessionRecord[] | undefined
  private loading?: Promise<SessionRecord[]>

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath)
  }

  async load(): Promise<SessionRecord[]> {
    if (this.records) return this.records
    return (this.loading ??= this.read())
  }

  private async read(): Promise<SessionRecord[]> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<SessionFile>
      const list = Array.isArray(raw?.sessions) ? raw.sessions : []
      this.records = list
        .map(readRecord)
        .filter((record): record is SessionRecord => record !== undefined)
    } catch {
      // A missing or corrupt file means "nothing recorded yet", never an error for the window.
      this.records = []
    }
    return this.records
  }

  list(): SessionRecord[] {
    return [...(this.records ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): SessionRecord | undefined {
    return (this.records ?? []).find((record) => record.id === id)
  }

  byPath(filePath: string): SessionRecord | undefined {
    if (!filePath) return undefined
    const key = path.resolve(filePath).toLowerCase()
    return (this.records ?? []).find(
      (record) => record.id === filePath ||
        (record.key && path.resolve(record.key).toLowerCase() === key) ||
        (record.path && path.resolve(record.path).toLowerCase() === key)
    )
  }

  /**
   * Insert or update the record for an engine session file.
   *
   * `patch` only carries what the caller actually knows (the engine may report a file before a title
   * exists), so an update never wipes a title or timestamps that are already recorded.
   */
  async upsert(
    patch: Partial<SessionRecord> & { path?: string; cwd?: string },
    strict = false
  ): Promise<SessionRecord> {
    await this.load()
    const existing =
      (patch.id ? this.get(patch.id) : undefined) ??
      (patch.path ? this.byPath(patch.path) : undefined)
    const now = Date.now()
    const record: SessionRecord = {
      engine: patch.engine ?? existing?.engine,
      id: existing?.id ?? patch.id ?? `s_${Math.random().toString(16).slice(2, 14)}`,
      key: patch.key ?? existing?.key ?? existing?.path ?? patch.path ?? patch.id,
      path: patch.path ?? existing?.path ?? '',
      cwd: patch.cwd ?? existing?.cwd ?? '',
      additional: patch.additional ?? existing?.additional ?? [],
      ...((patch.projectId ?? existing?.projectId)
        ? { projectId: patch.projectId ?? existing?.projectId }
        : {}),
      title: patch.title || existing?.title || '',
      titleSource: patch.titleSource ?? existing?.titleSource,
      ...((patch.provider ?? existing?.provider)
        ? { provider: patch.provider ?? existing?.provider }
        : {}),
      ...((patch.model ?? existing?.model) ? { model: patch.model ?? existing?.model } : {}),
      ...((patch.thinkingLevel ?? existing?.thinkingLevel)
        ? { thinkingLevel: patch.thinkingLevel ?? existing?.thinkingLevel }
        : {}),
      createdAt: patch.createdAt ?? existing?.createdAt ?? now,
      updatedAt: patch.updatedAt ?? now
    }
    const rest = (this.records ?? []).filter((entry) => entry.id !== record.id)
    const previous = this.records
    this.records = [...rest, record]
    try {
      await this.commit(strict)
    } catch (error) {
      this.records = previous
      throw error
    }
    return record
  }

  async rename(id: string, title: string): Promise<void> {
    await this.load()
    const record = this.get(id)
    if (!record || !title.trim()) return
    record.title = title.trim()
    record.titleSource = 'manual'
    record.updatedAt = Date.now()
    await this.commit()
  }

  async setGeneratedTitle(id: string, title: string): Promise<boolean> {
    await this.load()
    const record = this.get(id)
    if (!record || record.titleSource === 'manual' || !title.trim()) return false
    record.title = title.trim()
    record.titleSource = 'generated'
    // Generating metadata must not reorder conversations by their activity time.
    await this.commit()
    return true
  }

  /** Drop records whose engine file disappeared, so the list cannot point at nothing. */
  async prune(missing: (filePath: string) => boolean): Promise<number> {
    await this.load()
    const before = (this.records ?? []).length
    this.records = (this.records ?? []).filter((record) => !record.path || !missing(record.path))
    const removed = before - this.records.length
    if (removed > 0) await this.commit()
    return removed
  }

  private async commit(strict = false): Promise<void> {
    const payload: SessionFile = { sessions: this.records ?? [] }
    try {
      await writeJsonAtomic(this.filePath, payload)
    } catch (error) {
      if (strict) throw error
      // Keeping the list in memory is still better than failing the window over a write.
    }
  }
}
