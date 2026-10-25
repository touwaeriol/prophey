const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-updates-'))
const userData = path.join(temp, 'user-data')
fs.mkdirSync(userData)
// Auto-check off: the test drives the updater events itself and must not race a scheduled check.
fs.writeFileSync(path.join(userData, 'updates.json'), JSON.stringify({ autoCheck: false }))

const stub = (name, source) => {
  const file = path.join(temp, name)
  fs.writeFileSync(file, source)
  return file.replaceAll('\\', '/')
}

const electron = stub('electron.mjs', `
export const app = {
  isPackaged: true,
  getPath: (name) => name === 'exe' ? 'C:\\\\Apps\\\\Prophey\\\\Prophey.exe' : ${JSON.stringify(userData)},
  getVersion: () => '1.0.0',
  getAppPath: () => 'C:\\\\Apps\\\\Prophey\\\\resources\\\\app.asar'
}
`)

const updater = stub('updater.mjs', `
import { EventEmitter } from 'node:events'
export class CancellationToken {
  constructor() { this.cancelled = false }
  cancel() { this.cancelled = true }
}
class FakeUpdater extends EventEmitter {
  constructor() {
    super()
    this.autoDownload = true
    this.autoInstallOnAppQuit = true
    this.installDirectory = undefined
    this.calls = { check: 0, download: 0, quit: [] }
    globalThis.__updater = this
  }
  setFeedURL() {}
  async checkForUpdates() { this.calls.check += 1; return null }
  async downloadUpdate(token) {
    this.calls.download += 1
    if (globalThis.__downloadGate) await globalThis.__downloadGate
    if (token && token.cancelled) throw new Error('cancelled')
    this.emit('update-downloaded', { version: this.nextVersion ?? '1.1.0' })
  }
  quitAndInstall(silent, relaunch) { this.calls.quit.push([silent, relaunch]) }
}
export const autoUpdater = new FakeUpdater()
`)

const storage = stub('storage.mjs', `
import { promises as fs } from 'node:fs'
export async function writeJsonAtomic(file, data) { await fs.writeFile(file, JSON.stringify(data)) }
`)
const proxy = stub('proxy.mjs', 'export async function applySystemProxy() {}')

const source = fs.readFileSync(path.join(root, 'apps/desktop/src/main/updates.ts'), 'utf8')
  .replace("from 'electron-updater'", 'from ' + JSON.stringify(updater))
  .replace("from 'electron'", 'from ' + JSON.stringify(electron))
  .replace("from './proxy'", 'from ' + JSON.stringify(proxy))
  .replace("from './storage'", 'from ' + JSON.stringify(storage))
const outfile = path.join(temp, 'updates.cjs')
esbuild.buildSync({
  stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'apps/desktop/src/main') },
  outfile, bundle: true, platform: 'node', packages: 'external', format: 'cjs'
})
const updates = require(outfile)
const fake = globalThis.__updater

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
const states = []
const latest = () => states.at(-1)

after(() => fs.rmSync(temp, { recursive: true, force: true }))

test('an available update downloads itself and installs silently into the running directory', async () => {
  updates.setupUpdates((state) => states.push({ ...state }))
  await tick()
  assert.equal(latest().autoCheck, false, 'the stored setting wins')
  assert.equal(latest().autoDownload, true, 'downloading on its own is the default')
  // A silent update must stay where the app runs, or the assisted installer would use its default.
  assert.equal(fake.installDirectory, 'C:\\Apps\\Prophey')
  assert.equal(fake.autoInstallOnAppQuit, true, 'a downloaded update applies on quit')

  fake.emit('update-available', { version: '1.1.0', releaseNotes: 'notes' })
  await tick()
  assert.equal(fake.calls.download, 1, 'auto download starts without a settings visit')
  assert.equal(states.some((state) => state.status === 'downloading'), true)
  assert.equal(latest().status, 'preparing', 'the installer is on disk')
  assert.equal(latest().latestVersion, '1.1.0')
  assert.equal(latest().notes, 'notes')

  await updates.install()
  await new Promise((resolve) => setTimeout(resolve, 650))
  // Silent + relaunch: an assisted NSIS installer shows its install-mode page otherwise, which is
  // exactly the "reinstall me" experience an automatic update must not have.
  assert.deepEqual(fake.calls.quit, [[true, true]])
  assert.equal(fake.calls.download, 1, 'the downloaded installer is reused')
  assert.equal(latest().status, 'installing')
})

test('with auto download off the check only reports, and installing still downloads first', async () => {
  await updates.setAutoDownload(false)
  assert.equal(latest().autoDownload, false)
  const downloads = fake.calls.download
  fake.nextVersion = '1.2.0'
  fake.emit('update-available', { version: '1.2.0' })
  await tick()
  assert.equal(fake.calls.download, downloads, 'nothing is fetched behind the user s back')
  assert.equal(latest().status, 'available')

  await updates.install()
  await new Promise((resolve) => setTimeout(resolve, 650))
  assert.equal(fake.calls.download, downloads + 1, 'the button fetches it')
  assert.deepEqual(fake.calls.quit.at(-1), [true, true], 'and installs it the same silent way')

  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'updates.json'), 'utf8'))
  assert.deepEqual(saved, { autoCheck: false, autoDownload: false }, 'both switches persist')
})

test('cancelling a download returns the card to "available" without installing', async () => {
  // A new version means a fresh download: the installer from the previous test is stale.
  fake.nextVersion = '1.3.0'
  fake.emit('update-available', { version: '1.3.0' })
  await tick()
  assert.equal(latest().status, 'available')
  let release
  globalThis.__downloadGate = new Promise((resolve) => { release = resolve })
  try {
    const quits = fake.calls.quit.length
    const installing = updates.install()
    await tick()
    assert.equal(latest().status, 'downloading')
    const cancelled = updates.cancel()
    assert.equal(cancelled.status, 'available')
    release()
    await installing
    await new Promise((resolve) => setTimeout(resolve, 650))
    assert.equal(fake.calls.quit.length, quits, 'a cancelled download never reaches the installer')
    assert.equal(latest().status, 'available')
  } finally {
    delete globalThis.__downloadGate
  }
})
