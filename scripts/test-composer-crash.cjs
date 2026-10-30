/**
 * Does a draft survive an abrupt exit?
 *
 * `localStorage` is only eventually durable: Chromium batches its LevelDB commit, and on this machine a
 * write followed by `taskkill /F` was gone even after 2s, while 6s survived. The composer therefore
 * mirrors to the main process, which writes with `fs` on the same change. This script proves the fix
 * against the real built app: type, hard-kill the whole process tree, relaunch, and look at the box.
 *
 * Run it after `npm run build` (it needs `out/`), from the repo root:
 *   node scripts/test-composer-crash.cjs
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const role = process.env.DRAFT_CRASH_ROLE

const SENTINEL = 'DRAFT_CRASH_SENTINEL 崩溃前没发出去的草稿'

if (role === 'type' || role === 'read') {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', process.env.DRAFT_CRASH_DATA)
  app.setAppPath(path.join(root, 'apps/desktop'))
  BrowserWindow.prototype.show = function () {}
  app.on('browser-window-created', (_event, window) => {
    window.webContents.setBackgroundThrottling(false)
    window.webContents.once('did-finish-load', async () => {
      const evaluate = (source) => window.webContents.executeJavaScript(source)
      const waitFor = async (probe, label) => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (await probe()) return
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw new Error('timed out waiting for ' + label)
      }
      try {
        await waitFor(() => evaluate('!!document.querySelector(".composer textarea:not(:disabled)")'), 'composer')
        if (role === 'type') {
          const typed = await evaluate(`(() => {
            const node = document.querySelector('.composer textarea')
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            setter.call(node, ${JSON.stringify(SENTINEL)} + '\\n' + 'x'.repeat(400))
            node.dispatchEvent(new Event('input', { bubbles: true }))
            return node.value.length
          })()`)
          fs.writeFileSync(path.join(process.env.DRAFT_CRASH_DIR, 'typed'), String(typed))
          return
        }
        // Give the window its session identity, then report what the box shows.
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const restored = await evaluate(
          `(() => { const node = document.querySelector('.composer textarea'); return node ? node.value : '' })()`
        )
        console.log('DRAFT-CRASH ' + JSON.stringify({ restored: restored.includes('DRAFT_CRASH_SENTINEL'), length: restored.length }))
        app.quit()
      } catch (error) {
        console.error('DRAFT-CRASH ERROR ' + (error && error.message))
        app.exit(1)
      }
    })
  })
  require(path.join(root, 'apps/desktop/out/main/index.js'))
} else {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-draft-crash-'))
  const workspace = path.join(temporary, 'workspace')
  const userData = path.join(temporary, 'user-data')
  fs.mkdirSync(workspace)
  fs.mkdirSync(userData)
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    engine: 'prophey', cwd: workspace, autoCompact: { enabled: true, ratio: 0.9 },
    mcp: { enabled: false, subagents: { enabled: false } }
  }))
  fs.writeFileSync(path.join(userData, 'updates.json'), '{"autoCheck":false}')

  const electron = require('electron')
  const run = (next) => {
    const env = {
      ...process.env,
      DRAFT_CRASH_ROLE: next,
      DRAFT_CRASH_DIR: temporary,
      DRAFT_CRASH_DATA: userData,
      PI_CODING_AGENT_DIR: path.join(temporary, 'agent-config')
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    delete env.PI_DEBUG_PORT
    return spawn(electron, [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  }

  ;(async () => {
    try {
      for (const wait of [150, 1500]) {
        const typed = run('type')
        let log = ''
        typed.stdout.on('data', (chunk) => { log += chunk })
        typed.stderr.on('data', (chunk) => { log += chunk })
        const marker = path.join(temporary, 'typed')
        for (let attempt = 0; attempt < 300 && !fs.existsSync(marker); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!fs.existsSync(marker)) throw new Error('the app never accepted the draft: ' + log.slice(-500))
        await new Promise((resolve) => setTimeout(resolve, wait))
        // Hard kill: no before-quit, no renderer unload — exactly what a crash looks like.
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(typed.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else {
          typed.kill('SIGKILL')
        }
        await new Promise((resolve) => typed.on('close', resolve))
        fs.rmSync(marker, { force: true })

        const read = run('read')
        let out = ''
        read.stdout.on('data', (chunk) => { out += chunk })
        read.stderr.on('data', (chunk) => { out += chunk })
        await new Promise((resolve) => read.on('close', resolve))
        const line = (out.match(/DRAFT-CRASH \{.*?\}/g) ?? []).at(-1)
        assert.ok(line, 'the relaunched app reported nothing: ' + out.slice(-500))
        const report = JSON.parse(line.slice('DRAFT-CRASH '.length))
        assert.equal(report.restored, true, `draft typed before a kill after ${wait}ms did not come back`)
        assert(report.length > 400, 'the restored draft lost its body')
        console.log(`Draft crash test passed: a hard kill ${wait}ms after typing keeps the draft (${report.length} chars)`)
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
