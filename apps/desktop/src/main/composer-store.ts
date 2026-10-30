import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readTextFile, writeTextAtomic } from './storage'

/**
 * Crash-safe storage for composer drafts.
 *
 * The renderer keeps its own copy in `localStorage` because that reads back synchronously on the
 * first paint, but localStorage is only *eventually* durable: Chromium batches writes into LevelDB
 * and commits seconds later, so a crash or a forced kill loses everything typed since the last
 * commit (measured on this app: a write followed by `taskkill /F` after 2s was gone, after 6s it
 * survived). The main process writes with `fs`, which is on disk when the call returns, so the draft
 * mirrors here on every change — a crash then costs at most the debounce, not seconds of typing.
 *
 * One file per session key: a keystroke in a session with a 10MB screenshot attached must not rewrite
 * the whole map 40 times a second, and an entry that does not change cannot be corrupted by one that
 * does. Keys are hashed for the file name because they are absolute paths (Windows paths carry
 * separators, colons and case variants).
 */
export interface PersistedComposer {
  draft: string
  images: unknown[]
  queued: unknown[]
  /** When the entry last changed; the renderer picks the newest of localStorage and this file. */
  at: number
}

/** What a save may carry: the images are skipped on plain keystrokes (they did not change). */
export interface ComposerPatch {
  draft: string
  queued: unknown[]
  at: number
  images?: unknown[]
  imagesChanged?: boolean
}

/** Writes are batched so holding a key down does not turn into one fs write per character. */
const DEBOUNCE_MS = 250
/**
 * Entries below this size are written at once instead of on the debounce.
 *
 * A draft is normally a few hundred bytes and the user's last keystroke is exactly what a crash must
 * not eat, so waiting 250ms there buys nothing. The debounce exists for the other case: a session with
 * a multi-megabyte screenshot attached, where every keystroke would otherwise rewrite all of it.
 */
const IMMEDIATE_BYTES = 256 * 1024
/** An entry is mostly base64 screenshots; anything past this is a bug, not a draft. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

export class ComposerStore {
  private readonly pending = new Map<string, ComposerPatch>()
  /** Last written entry per key, so a keystroke can keep the images it does not mention. */
  private readonly cache = new Map<string, PersistedComposer>()
  private timer: NodeJS.Timeout | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly dir: string) {}

  private fileFor(key: string): string {
    const name = createHash('sha256').update(key).digest('hex').slice(0, 32)
    return path.join(this.dir, `${name}.json`)
  }

  /** Mark an entry dirty; small entries are written now, big ones on the debounce. */
  save(key: string, entry: ComposerPatch): void {
    if (!key || typeof entry.draft !== 'string') return
    this.pending.set(key, entry)
    const heavy = (entry.imagesChanged !== false && Array.isArray(entry.images))
      ? entry.draft.length + JSON.stringify(entry.images).length
      : entry.draft.length
    if (heavy < IMMEDIATE_BYTES) {
      void this.flush()
      return
    }
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS)
  }

  /** Images this save did not carry: the ones already on disk (or cached) stay. */
  private async resolveImages(key: string, entry: ComposerPatch): Promise<unknown[]> {
    if (entry.imagesChanged !== false && Array.isArray(entry.images)) return entry.images
    const cached = this.cache.get(key)
    if (cached) return cached.images
    const stored = await this.readEntry(key)
    return stored?.images ?? []
  }

  private async readEntry(key: string): Promise<PersistedComposer | undefined> {
    try {
      const parsed = JSON.parse(await readTextFile(this.fileFor(key))) as PersistedComposer
      return {
        draft: typeof parsed.draft === 'string' ? parsed.draft : '',
        images: Array.isArray(parsed.images) ? parsed.images : [],
        queued: Array.isArray(parsed.queued) ? parsed.queued : [],
        at: typeof parsed.at === 'number' ? parsed.at : 0
      }
    } catch {
      return undefined
    }
  }

  /** Write everything pending now. Called on the debounce, on quit, and by tests. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.pending.size === 0) return this.writing
    const batch = [...this.pending.entries()]
    this.pending.clear()
    this.writing = this.writing.then(async () => {
      for (const [key, patch] of batch) {
        const entry: PersistedComposer = {
          draft: patch.draft,
          queued: patch.queued,
          at: patch.at,
          images: await this.resolveImages(key, patch)
        }
        const body = JSON.stringify({ key, ...entry })
        if (body.length > MAX_ENTRY_BYTES) continue
        try {
          await writeTextAtomic(this.fileFor(key), body)
          this.cache.set(key, entry)
        } catch {
          // A draft that cannot be persisted must not take the window down with it.
        }
      }
    })
    return this.writing
  }

  /** Synchronous flush for `before-quit`: async fs work does not survive process exit. */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.pending.size === 0) return
    const batch = [...this.pending.entries()]
    this.pending.clear()
    for (const [key, patch] of batch) {
      // Only the cached images are reachable synchronously; that is the common case, because the
      // renderer sends a full entry whenever the images change.
      const entry: PersistedComposer = {
        draft: patch.draft,
        queued: patch.queued,
        at: patch.at,
        images: Array.isArray(patch.images) && patch.imagesChanged !== false
          ? patch.images
          : (this.cache.get(key)?.images ?? [])
      }
      const body = JSON.stringify({ key, ...entry })
      if (body.length > MAX_ENTRY_BYTES) continue
      try {
        fsSync.mkdirSync(this.dir, { recursive: true })
        const target = this.fileFor(key)
        const temporary = target + '.tmp'
        fsSync.writeFileSync(temporary, body, 'utf8')
        fsSync.renameSync(temporary, target)
        this.cache.set(key, entry)
      } catch {
        // Same rule as above: quit must proceed.
      }
    }
  }

  /** Every mirrored entry, as the same JSON shape the renderer keeps in localStorage. */
  async loadRaw(): Promise<string | null> {
    await this.writing
    let names: string[]
    try {
      names = (await fs.readdir(this.dir)).filter((name) => name.endsWith('.json'))
    } catch {
      return null
    }
    if (names.length === 0) return null
    const map: Record<string, PersistedComposer> = {}
    for (const name of names) {
      const file = path.join(this.dir, name)
      try {
        const parsed = JSON.parse(await readTextFile(file)) as PersistedComposer & { key?: unknown }
        if (typeof parsed.key !== 'string' || !parsed.key) continue
        map[parsed.key] = {
          draft: typeof parsed.draft === 'string' ? parsed.draft : '',
          images: Array.isArray(parsed.images) ? parsed.images : [],
          queued: Array.isArray(parsed.queued) ? parsed.queued : [],
          at: typeof parsed.at === 'number' ? parsed.at : 0
        }
        this.cache.set(parsed.key, map[parsed.key])
      } catch {
        // A torn file is not a reason to lose the other sessions' drafts.
        continue
      }
    }
    return JSON.stringify(map)
  }

  /** Entries that went away (an empty composer) must not resurrect on the next start. */
  async remove(key: string): Promise<void> {
    this.pending.delete(key)
    try {
      await fs.rm(this.fileFor(key), { force: true })
    } catch {
      // ignore
    }
  }
}
