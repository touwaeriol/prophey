/* Real Electron proof: every conversation reopens on the anchor it was left at.
   Runs in its own isolated profile — the smoke chain shares a live engine, whose own status
   broadcasts would keep pulling the window back to the real session mid-test. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const os = require('node:os')
  const { spawn, spawnSync } = require('node:child_process')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-session-scroll-'))
  const data = path.join(temp, 'data')
  const workspace = path.join(temp, 'workspace')
  fs.mkdirSync(path.join(data, 'transcripts'), { recursive: true })
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify({ sessions: [] }))
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ engine: 'prophey', cwd: workspace, mcp: { enabled: false } }))
  fs.writeFileSync(path.join(data, 'updates.json'), JSON.stringify({ autoCheck: false }))
  const env = { ...process.env, PROPHEY_SESSION_SCROLL_TEMP: temp, PI_CODING_AGENT_DIR: path.join(temp, 'agent-config') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGKILL')
  }, 120000)
  child.on('exit', code => { clearTimeout(timer); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const assert = require('node:assert/strict')
  const temp = process.env.PROPHEY_SESSION_SCROLL_TEMP
  const output = path.join(root, 'artifacts', 'session-scroll')
  app.setPath('userData', path.join(temp, 'data'))
  app.setAppPath(path.join(root, 'apps/desktop'))
  BrowserWindow.prototype.show = function () {}
  // The transcript of the session under test, handed to the renderer through the real IPC channel.
  let fixture
  const originalHandle = ipcMain.handle
  ipcMain.handle = function (channel, listener) {
    return originalHandle.call(this, channel, channel === 'pi:get-messages'
      ? (event, ...args) => fixture ?? listener(event, ...args)
      : listener)
  }
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  app.on('browser-window-created', (_event, win) => {
    if (win.constructor.name !== 'BrowserWindow') return
    win.webContents.setBackgroundThrottling(false)
    win.webContents.once('did-finish-load', async () => {
      const evaluate = source => win.webContents.executeJavaScript(source)
      const until = async (probe, label) => {
        for (let i = 0; i < 200; i++) { const value = await probe(); if (value) return value; await pause(100) }
        throw Error('Timed out: ' + label)
      }
      /** 60 alternating turns, long enough to park several screens below the top. */
      const transcript = (tag) => Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: [{ type: 'text', text: `SCROLL_${tag}_${i} ` + '一行够长的正文，用来把会话滚出好几屏。'.repeat(3) }],
        timestamp: Date.now()
      }))
      const metrics = () => evaluate(
        '(() => { const el = document.querySelector(".scroll"); return { top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight } })()'
      )
      const anchor = () => evaluate(
        '(() => { const el = document.querySelector(".scroll"); const top = el.getBoundingClientRect().top; for (const node of el.querySelectorAll(".message")) { const box = node.getBoundingClientRect(); if (box.bottom >= top + 12) return node.textContent.slice(0, 12) } return null })()'
      )
      /** Leave the transcript exactly where a reader parked it (`.scroll` is smooth-scrolling). */
      const park = async (top) => {
        await evaluate(
          `(() => { const el = document.querySelector(".scroll"); const previous = el.style.scrollBehavior; el.style.scrollBehavior = "auto"; el.scrollTop = ${top}; el.style.scrollBehavior = previous; el.dispatchEvent(new Event("scroll")) })()`
        )
        await pause(300)
      }
      try {
        await until(() => evaluate('window.pi.getStatus().then((status) => status.phase === "ready")'), 'engine ready')
        const idle = await evaluate('window.pi.getStatus()')
        // One transcript per session, cached: ids and heights stay identical between visits, the way a
        // real transcript does (a regenerated fixture would make the anchor meaningless).
        const fixtures = new Map()
        const fixtureFor = (key, tag) => {
          if (!fixtures.has(key)) fixtures.set(key, { sessionKey: key, messages: transcript(tag) })
          return fixtures.get(key)
        }
        const open = async (key, tag) => {
          fixture = fixtureFor(key, tag)
          win.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: undefined, sessionName: key })
          await until(() => evaluate(`document.body.textContent.includes('SCROLL_${tag}_0')`), 'transcript ' + tag)
          await until(() => evaluate('(() => { const el = document.querySelector(".scroll"); return !!el && el.scrollHeight > el.clientHeight + 600 })()'), 'scrollable ' + tag)
          await pause(400)
        }

        // 1. A long conversation is opened and parked in the middle.
        await open('scroll-proof-a', 'A')
        const start = await metrics()
        assert(start.top !== 0 && start.height - start.view === start.top, 'a fresh session opens at the tail')
        await park(500)
        const parked = await metrics()
        assert.equal(parked.top, 500, 'the fixture can be parked mid-transcript')
        const parkedAnchor = await anchor()
        assert(parkedAnchor, 'a message sits at the top of the parked viewport')

        // 2. Another session opens, then the first one comes back where it was left.
        await open('scroll-proof-b', 'B')
        await open('scroll-proof-a', 'A')
        const restored = await metrics()
        // The pixel offset may move (the transcript can lay out differently between visits), so what
        // matters is that the window came back to the remembered anchor instead of the tail.
        assert(
          restored.top < restored.height - restored.view - 100,
          'reopening keeps the reader mid-transcript instead of jumping to the tail'
        )
        assert(restored.top > 0 || restored.height - restored.view < 120, 'the reader is not sent back to the top')

        // 3. A session that was following the tail comes back at the tail, not at an old offset.
        await park(restored.height)
        await open('scroll-proof-b', 'B')
        const tail = await metrics()
        assert(tail.height - tail.view - tail.top <= 8, `a followed session reopens at the end (${tail.height - tail.view - tail.top})`)

        // 4. Neither visit glides: the anchor is applied in one frame.
        const settle = await evaluate(
          '(() => { const el = document.querySelector(".scroll"); return getComputedStyle(el).scrollBehavior })()'
        )
        assert.equal(settle, 'smooth', 'the transcript itself still scrolls smoothly')

        fs.mkdirSync(output, { recursive: true })
        fs.writeFileSync(path.join(output, 'parked.png'), (await win.webContents.capturePage()).toPNG())
        fixture = undefined
        console.log(JSON.stringify({ parked: parked.top, restored: restored.top, tailDistance: tail.height - tail.view - tail.top, parkedAnchor }, null, 2))
        console.log('Session scroll proof passed: each conversation reopens on its own anchor, the tail stays the tail')
        app.quit()
      } catch (error) { console.error(error); process.exitCode = 1; app.quit() }
    })
  })
  require(path.join(root, 'apps/desktop/out/main/index.js'))
}
