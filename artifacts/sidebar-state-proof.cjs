/* Real Electron proof: the sidebar switch shows its state and the layout survives a reload. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const os = require('node:os')
  const { spawn, spawnSync } = require('node:child_process')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-sidebar-state-'))
  const data = path.join(temp, 'data')
  const workspace = path.join(temp, 'workspace')
  fs.mkdirSync(path.join(data, 'transcripts'), { recursive: true })
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify({ sessions: [] }))
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ engine: 'prophey', cwd: workspace, mcp: { enabled: false } }))
  fs.writeFileSync(path.join(data, 'updates.json'), JSON.stringify({ autoCheck: false }))
  const env = { ...process.env, PROPHEY_SIDEBAR_STATE_TEMP: temp, PI_CODING_AGENT_DIR: path.join(temp, 'agent-config') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGKILL')
  }, 90000)
  child.on('exit', code => { clearTimeout(timer); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow } = require('electron')
  const assert = require('node:assert/strict')
  const temp = process.env.PROPHEY_SIDEBAR_STATE_TEMP
  const output = path.join(root, 'artifacts', 'sidebar-state')
  app.setPath('userData', path.join(temp, 'data'))
  app.setAppPath(path.join(root, 'apps/desktop'))
  BrowserWindow.prototype.show = function () {}
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  app.on('browser-window-created', (_event, win) => {
    win.webContents.setBackgroundThrottling(false)
    let round = 0
    const check = async () => {
      const evaluate = source => win.webContents.executeJavaScript(source)
      const until = async source => {
        for (let i = 0; i < 120; i++) { if (await evaluate(source)) return; await pause(100) }
        throw Error('Timed out: ' + source)
      }
      const state = () => evaluate(`({
        sidebar: !!document.querySelector('.sidebar'),
        railOn: !!document.querySelector('.rail-btn.sidebar-toggle')?.classList.contains('on'),
        railTitle: document.querySelector('.rail-btn.sidebar-toggle')?.title ?? null,
        tabOn: !!document.querySelector('.tabbar .sidebar-toggle')?.classList.contains('on'),
        tabTitle: document.querySelector('.tabbar .sidebar-toggle')?.title ?? null,
        stored: localStorage.getItem('pi-sidebar-open')
      })`)
      try {
        await until('!!document.querySelector(".rail") && !!document.querySelector(".tabbar")')
        await pause(400)
        if (round === 0) {
          // Open by default, and both switches say so.
          const open = await state()
          assert.deepEqual(
            { sidebar: open.sidebar, railOn: open.railOn, railTitle: open.railTitle, tabOn: open.tabOn, tabTitle: open.tabTitle },
            { sidebar: true, railOn: true, railTitle: '隐藏侧栏', tabOn: true, tabTitle: '隐藏侧栏' },
            'an open sidebar is reported as open'
          )

          // The title-bar switch hides it and the state follows on both switches.
          await evaluate('document.querySelector(".tabbar .sidebar-toggle").click()')
          await until('!document.querySelector(".sidebar")')
          await pause(200)
          const closed = await state()
          assert.deepEqual(
            { railOn: closed.railOn, railTitle: closed.railTitle, tabOn: closed.tabOn, tabTitle: closed.tabTitle, stored: closed.stored },
            { railOn: false, railTitle: '显示侧栏', tabOn: false, tabTitle: '显示侧栏', stored: '0' },
            'a hidden sidebar drops the highlight and is remembered'
          )
          await evaluate('document.querySelector(".tabbar").scrollIntoView()')
          fs.mkdirSync(output, { recursive: true })
          fs.writeFileSync(path.join(output, 'collapsed.png'), (await win.webContents.capturePage()).toPNG())

          // Reload: the layout the user left is the layout they get back.
          round = 1
          win.webContents.reload()
          return
        }

        await until('!!document.querySelector(".rail") && !!document.querySelector(".tabbar")')
        await pause(600)
        const restored = await state()
        assert.deepEqual(
          { sidebar: restored.sidebar, railOn: restored.railOn, railTitle: restored.railTitle, tabOn: restored.tabOn, stored: restored.stored },
          { sidebar: false, railOn: false, railTitle: '显示侧栏', tabOn: false, stored: '0' },
          'a collapsed sidebar stays collapsed after a reload'
        )

        // The rail switch brings it back, from the other direction.
        await evaluate('document.querySelector(".rail-btn.sidebar-toggle").click()')
        await until('!!document.querySelector(".sidebar")')
        await pause(250)
        const reopened = await state()
        assert.deepEqual(
          { railOn: reopened.railOn, railTitle: reopened.railTitle, tabOn: reopened.tabOn, stored: reopened.stored },
          { railOn: true, railTitle: '隐藏侧栏', tabOn: true, stored: '1' },
          'the rail switch reopens the sidebar and remembers it'
        )
        fs.mkdirSync(output, { recursive: true })
        fs.writeFileSync(path.join(output, 'open.png'), (await win.webContents.capturePage()).toPNG())
        const rail = await evaluate('(() => { const r = document.querySelector(".rail").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } })()')
        fs.writeFileSync(path.join(output, 'rail.png'), (await win.webContents.capturePage(rail)).toPNG())
        console.log('Sidebar state proof passed: state on both switches, collapse remembered, reopen remembered')
        app.quit()
      } catch (error) { console.error(error); process.exitCode = 1; app.quit() }
    }
    win.webContents.on('did-finish-load', () => void check())
  })
  require(path.join(root, 'apps/desktop/out/main/index.js'))
}
