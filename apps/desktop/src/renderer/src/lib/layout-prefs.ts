/**
 * Layout toggles that must survive a restart (left sidebar, right inspector). Both are plain
 * on/off flags in localStorage; they live here together so the two switches cannot drift apart
 * (and so the read path is testable without a DOM).
 */
export const SIDEBAR_OPEN_KEY = 'pi-sidebar-open'
export const PANEL_OPEN_KEY = 'pi-session-panel'
/** Width the user dragged the sidebar to, in CSS pixels. */
export const SIDEBAR_WIDTH_KEY = 'pi-sidebar-width'

/** The slice of `Storage` we need, so tests can pass a fake. */
export type FlagStore = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function defaultStore(): FlagStore | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    // private mode / storage disabled: every pref falls back to its default
    return undefined
  }
}

/**
 * `'1'` is open, `'0'` is closed, anything else (missing key, garbage) means the caller's default.
 * Reading `'0'` as the default would make a window the user never closed start up collapsed.
 */
export function readLayoutFlag(
  key: string,
  fallback: boolean,
  store: FlagStore | undefined = defaultStore()
): boolean {
  try {
    const raw = store?.getItem(key)
    if (raw === '1') return true
    if (raw === '0') return false
    return fallback
  } catch {
    return fallback
  }
}

export function writeLayoutFlag(
  key: string,
  value: boolean,
  store: FlagStore | undefined = defaultStore()
): void {
  try {
    store?.setItem(key, value ? '1' : '0')
  } catch {
    // quota / private mode: the layout just starts from the default next time
  }
}

/** A clamped pixel size (sidebar width); anything unreadable means the caller's default. */
export function readLayoutNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
  store: FlagStore | undefined = defaultStore()
): number {
  try {
    const raw = Number(store?.getItem(key))
    if (!Number.isFinite(raw) || raw <= 0) return fallback
    return Math.min(max, Math.max(min, Math.round(raw)))
  } catch {
    return fallback
  }
}

export function writeLayoutNumber(
  key: string,
  value: number,
  store: FlagStore | undefined = defaultStore()
): void {
  try {
    store?.setItem(key, String(Math.round(value)))
  } catch {
    // quota / private mode: the width just starts from the default next time
  }
}
