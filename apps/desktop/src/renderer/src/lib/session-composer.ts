import type { DraftImage } from './images'
import type { QueuedMessage } from './chat-types'

/**
 * Composer state that belongs to one conversation.
 *
 * The draft, its pending images and the messages queued behind a running turn are all *session*
 * state: switching to another conversation must show that conversation's own text and queue, and a
 * queue must never be flushed into a session it was not typed in. Keeping them in one window-level
 * state (the previous shape) made every one of those look shared.
 */
export interface SessionComposer {
  draft: string
  images: DraftImage[]
  queued: QueuedMessage[]
  /** When the entry last changed; only used to trim the persisted map. */
  at?: number
}

export type SessionComposerMap = Record<string, SessionComposer>

/** Key used before the window knows which session it is on (startup, `starting` phase). */
export const LOCAL_COMPOSER_KEY = 'local'

/** Stable key for a session's composer: the sidebar identity, which survives engine restarts. */
export function composerKey(sessionPath?: string): string {
  return sessionPath || LOCAL_COMPOSER_KEY
}

export const EMPTY_COMPOSER: SessionComposer = { draft: '', images: [], queued: [] }

/** The composer of `key`, never undefined, and never the stored object itself. */
export function composerFor(map: SessionComposerMap, key: string): SessionComposer {
  const entry = map[key]
  if (!entry) return EMPTY_COMPOSER
  return {
    draft: typeof entry.draft === 'string' ? entry.draft : '',
    images: Array.isArray(entry.images) ? entry.images : [],
    queued: Array.isArray(entry.queued) ? entry.queued : [],
    ...(typeof entry.at === 'number' ? { at: entry.at } : {})
  }
}

export function isEmptyComposer(entry: SessionComposer | undefined): boolean {
  if (!entry) return true
  return !entry.draft && entry.images.length === 0 && entry.queued.length === 0
}

/**
 * Apply a patch (or an updater) to one session's composer, leaving every other session alone.
 *
 * React setState semantics: the updater receives the current entry, so callers can keep the
 * `setQueued((prev) => …)` shape they already use.
 */
export function patchComposer(
  map: SessionComposerMap,
  key: string,
  patch: Partial<SessionComposer> | ((previous: SessionComposer) => Partial<SessionComposer>),
  at = Date.now()
): SessionComposerMap {
  const previous = composerFor(map, key)
  const fields = typeof patch === 'function' ? patch(previous) : patch
  return { ...map, [key]: { ...previous, ...fields, at } }
}

/**
 * Hand the pre-session draft to the session that turned out to own it.
 *
 * On startup the window briefly has no session identity, so the first keystrokes land on
 * `LOCAL_COMPOSER_KEY`. When the session arrives, move that entry instead of losing or duplicating
 * it; an entry the session already has wins.
 */
export function adoptComposer(
  map: SessionComposerMap,
  from: string,
  to: string
): SessionComposerMap {
  if (from === to) return map
  const source = map[from]
  if (!source) return map
  const { [from]: _moved, ...rest } = map
  if (!isEmptyComposer(rest[to])) return rest
  return { ...rest, [to]: source }
}

/** Drop empty entries and keep the newest `limit`, so storage cannot grow without bound. */
export function pruneComposers(map: SessionComposerMap, limit = 60): SessionComposerMap {
  const kept = Object.entries(map)
    .filter(([, entry]) => entry && !isEmptyComposer(entry))
    .sort((left, right) => (left[1].at ?? 0) - (right[1].at ?? 0))
    .slice(-limit)
  return Object.fromEntries(kept)
}

/** Read the persisted map; anything malformed is treated as "nothing saved yet". */
export function parseComposers(raw: string | null | undefined): SessionComposerMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const map: SessionComposerMap = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const queued = (Array.isArray(entry.queued) ? entry.queued : []).filter(
      (item): item is QueuedMessage =>
        Boolean(item) && typeof item === 'object' &&
        typeof (item as QueuedMessage).id === 'string' &&
        typeof (item as QueuedMessage).text === 'string'
    )
    map[key] = {
      draft: typeof entry.draft === 'string' ? entry.draft : '',
      images: Array.isArray(entry.images) ? (entry.images as DraftImage[]) : [],
      queued: queued.map((item) => ({ ...item, images: Array.isArray(item.images) ? item.images : [] })),
      at: typeof entry.at === 'number' ? entry.at : 0
    }
  }
  return map
}

export function serializeComposers(map: SessionComposerMap): string {
  return JSON.stringify(pruneComposers(map))
}
