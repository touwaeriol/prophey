import { writeJsonAtomic } from './storage'
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { autoUpdater, CancellationToken } from 'electron-updater'
import type { AppUpdateSnapshot } from '../shared/types'
import { applySystemProxy } from './proxy'

const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const INITIAL_DELAY = 5000

const repoSetting = process.env.PI_DESKTOP_UPDATE_REPO
const defaultOwner = process.env.PI_DESKTOP_UPDATE_OWNER ?? 'touwaeriol'
const [owner = defaultOwner, repo = 'prophey'] =
  repoSetting && repoSetting.includes('/')
    ? repoSetting.split('/').slice(0, 2)
    : [defaultOwner, repoSetting ?? 'prophey']
const genericUrl = process.env.PI_DESKTOP_UPDATE_URL
const releasesUrl =
  process.env.PI_DESKTOP_RELEASES_URL ??
  (genericUrl
    ? genericUrl.replace(/\/+$/, '')
    : `https://github.com/${owner}/${repo}/releases`)

let sender: (snapshot: AppUpdateSnapshot) => void = () => {}
let timer: NodeJS.Timeout | undefined
let initialTimer: NodeJS.Timeout | undefined
let checking = false
let cancelToken: CancellationToken | undefined
/** A download is in flight; `update-available` and the install button must not start a second one. */
let downloading = false
/** The installer sits in the cache and only needs `quitAndInstall`. */
let downloaded = false

let snapshot: AppUpdateSnapshot = {
  sequence: 0,
  status: 'idle',
  currentVersion: '0.0.0',
  latestVersion: null,
  notes: null,
  checkedAt: null,
  downloaded: 0,
  total: null,
  autoCheck: true,
  // Downloading on its own is what makes an update actually "automatic": the check happens anyway,
  // and a download nobody started would otherwise wait for a settings visit.
  autoDownload: true,
  canInstall: false,
  releasesUrl,
  error: null
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'updates.json')
}

async function loadSettings(): Promise<{ autoCheck: boolean; autoDownload: boolean }> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as { autoCheck?: boolean; autoDownload?: boolean }
    return { autoCheck: parsed.autoCheck !== false, autoDownload: parsed.autoDownload !== false }
  } catch {
    return { autoCheck: true, autoDownload: true }
  }
}

async function saveSettings(): Promise<void> {
  await writeJsonAtomic(configPath(), {
    autoCheck: snapshot.autoCheck,
    autoDownload: snapshot.autoDownload
  })
}

function publish(patch: Partial<AppUpdateSnapshot>): AppUpdateSnapshot {
  snapshot = { ...snapshot, ...patch, sequence: snapshot.sequence + 1 }
  sender(snapshot)
  return snapshot
}

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const status = /^(\d{3})\b/.exec(raw)?.[1]
  if (status === '404') {
    return `更新源不存在或还没有发布 Release（${owner}/${repo}）`
  }
  if (status) return `更新检查失败（HTTP ${status}）`
  const firstLine = raw.split('\n').find((line) => line.trim()) ?? raw
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
}

function fail(code: string, message: string): AppUpdateSnapshot {
  return publish({
    status: 'error',
    checkedAt: new Date().toISOString(),
    error: { code, message }
  })
}

function notesFrom(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const record = item as { version?: unknown; note?: unknown }
        return `${String(record.version ?? '')}\n${String(record.note ?? '')}`.trim()
      })
      .filter(Boolean)
      .join('\n\n')
  }
  return null
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

async function checkViaApi(): Promise<AppUpdateSnapshot> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pi-desktop'
    }
  })
  if (!response.ok) {
    throw new Error(`GitHub Release 请求失败（${response.status}）`)
  }
  const data = (await response.json()) as { tag_name?: string; body?: string }
  const latest = String(data.tag_name ?? '').replace(/^v/i, '')
  if (!latest) throw new Error('Release 中没有版本号')
  const available = compareVersions(latest, snapshot.currentVersion) > 0
  return publish({
    status: available ? 'available' : 'upToDate',
    latestVersion: available ? latest : snapshot.currentVersion,
    notes: available ? (data.body ?? null) : null,
    checkedAt: new Date().toISOString(),
    canInstall: false,
    error: null
  })
}

export async function check(): Promise<AppUpdateSnapshot> {
  if (checking) return snapshot
  checking = true
  await applySystemProxy()
  publish({ status: 'checking', error: null })
  try {
    if (!app.isPackaged) {
      return await checkViaApi()
    }
    await autoUpdater.checkForUpdates()
    if (snapshot.status === 'checking') {
      return publish({
        status: 'upToDate',
        latestVersion: snapshot.currentVersion,
        checkedAt: new Date().toISOString()
      })
    }
    return snapshot
  } catch (error) {
    return fail('UPDATE_CHECK_FAILED', `无法检查更新：${friendlyError(error)}`)
  } finally {
    checking = false
  }
}

export async function install(): Promise<AppUpdateSnapshot> {
  if (!app.isPackaged) {
    return fail('UPDATE_DEV', '开发模式无法安装更新，请使用打包后的安装包。')
  }
  if (!snapshot.latestVersion || snapshot.status === 'upToDate') {
    return fail('UPDATE_NONE', '没有可安装的更新。')
  }
  if (snapshot.status === 'installing') return snapshot
  if (!downloaded) {
    const ready = await download()
    if (!ready) return snapshot
  }
  publish({ status: 'installing' })
  setTimeout(() => {
    // Silent + relaunch: the assisted NSIS installer would otherwise show its pages (the update skips
    // the license and directory pages but not the install-mode one), which reads as "reinstall me".
    autoUpdater.quitAndInstall(true, true)
  }, 500)
  return snapshot
}

/** Fetch the installer and leave it ready; the same step `update-available` runs when auto-download is on. */
async function download(): Promise<boolean> {
  if (downloading) return false
  downloading = true
  cancelToken = new CancellationToken()
  publish({ status: 'downloading', downloaded: 0, total: null, error: null })
  try {
    await autoUpdater.downloadUpdate(cancelToken)
    downloaded = true
    return true
  } catch (error) {
    downloaded = false
    if (cancelToken?.cancelled) {
      publish({ status: 'available', downloaded: 0, total: null, error: null })
      return false
    }
    fail('UPDATE_DOWNLOAD_FAILED', `下载更新失败：${friendlyError(error)}`)
    return false
  } finally {
    downloading = false
    cancelToken = undefined
  }
}

export function cancel(): AppUpdateSnapshot {
  if (snapshot.status !== 'downloading') return snapshot
  cancelToken?.cancel()
  return publish({ status: 'available', downloaded: 0, total: null, error: null })
}

export async function setAuto(enabled: boolean): Promise<AppUpdateSnapshot> {
  publish({ autoCheck: enabled })
  await saveSettings()
  if (enabled) void check()
  return snapshot
}

/**
 * Download the next version without being asked.
 *
 * Off means "ask me first": the card then offers a button, and the download still ends in the same
 * silent install. Turning it back on picks up an update that is already known to exist.
 */
export async function setAutoDownload(enabled: boolean): Promise<AppUpdateSnapshot> {
  publish({ autoDownload: enabled })
  await saveSettings()
  if (enabled && snapshot.status === 'available') void download()
  return snapshot
}

export function getSnapshot(): AppUpdateSnapshot {
  return snapshot
}

function schedule(): void {
  if (initialTimer) clearTimeout(initialTimer)
  if (timer) clearInterval(timer)
  initialTimer = setTimeout(() => {
    if (snapshot.autoCheck) void check()
  }, INITIAL_DELAY)
  timer = setInterval(() => {
    if (snapshot.autoCheck) void check()
  }, CHECK_INTERVAL)
  // A timer must never be the reason the process stays alive (tests, CLI runs).
  initialTimer.unref?.()
  timer.unref?.()
}

/**
 * The running app version.
 *
 * `app.getVersion()` reports Electron's own version when the app is launched as `electron <file>`
 * (the dev flow), which made Settings claim "45.0.0 · 已是 最新版本". In dev we read the workspace
 * package.json instead, so the update check compares the real version.
 */
function appVersion(): string {
  if (app.isPackaged) return app.getVersion()
  // Walk up from the bundle directory: `out/main` -> `apps/desktop` -> repo root.
  let dir = app.getAppPath()
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (typeof parsed.version === 'string' && /desktop/i.test(parsed.name ?? '')) {
        return parsed.version
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return app.getVersion()
}

export function setupUpdates(send: (next: AppUpdateSnapshot) => void): void {
  sender = send
  snapshot.currentVersion = appVersion()
  snapshot.canInstall = app.isPackaged
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = console
  if (app.isPackaged) {
    // The assisted installer skips its directory page on `--updated`; pinning the directory keeps a
    // silent update in the folder the app actually runs from instead of its default location.
    // (`installDirectory` lives on the NSIS updater, not on the base class the export is typed as.)
    ;(autoUpdater as typeof autoUpdater & { installDirectory?: string }).installDirectory =
      path.dirname(app.getPath('exe'))
  }

  if (genericUrl) {
    autoUpdater.setFeedURL({ provider: 'generic', url: genericUrl })
  } else {
    autoUpdater.setFeedURL({ provider: 'github', owner, repo })
  }

  autoUpdater.on('checking-for-update', () => {
    publish({ status: 'checking', error: null })
  })
  autoUpdater.on('update-available', (info) => {
    downloaded = false
    publish({
      status: 'available',
      latestVersion: info.version,
      notes: notesFrom(info.releaseNotes),
      checkedAt: new Date().toISOString(),
      canInstall: app.isPackaged,
      error: null
    })
    // The check runs on its own schedule, so the download should not wait for a settings visit.
    if (snapshot.autoDownload && app.isPackaged) void download()
  })
  autoUpdater.on('update-not-available', () => {
    downloaded = false
    publish({
      status: 'upToDate',
      latestVersion: snapshot.currentVersion,
      notes: null,
      checkedAt: new Date().toISOString(),
      error: null
    })
  })
  autoUpdater.on('download-progress', (progress) => {
    publish({
      status: 'downloading',
      downloaded: progress.transferred,
      total: progress.total || null
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true
    publish({
      status: 'preparing',
      latestVersion: info.version,
      total: snapshot.total ?? snapshot.downloaded
    })
  })
  autoUpdater.on('error', (error) => {
    fail('UPDATE_ERROR', friendlyError(error))
  })

  void loadSettings().then(({ autoCheck, autoDownload }) => {
    publish({ autoCheck, autoDownload })
    if (autoCheck) schedule()
  })
}
