const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = process.env.PROPHEY_SMOKE_ROOT
const desktop = process.env.PROPHEY_SMOKE_APP || path.join(root, 'apps/desktop')
app.setPath('userData', process.env.PROPHEY_SMOKE_DATA)
app.setAppPath(desktop)
// Exercise the real renderer without interrupting the user's desktop.
BrowserWindow.prototype.show = function () {}
// Session-history fixture only; real preload and image-copy IPC stay untouched.
let imageCopySessionFixture
const originalHandle = ipcMain.handle
ipcMain.handle = function (channel, listener) {
  return originalHandle.call(this, channel, channel === 'pi:get-messages'
    ? (event, ...args) => imageCopySessionFixture ?? listener(event, ...args)
    : listener)
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(probe, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await probe()
    if (value) return value
    await delay(100)
  }
  throw Error('Timed out: ' + label)
}
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    const evaluate = source => window.webContents.executeJavaScript(source).catch(error => {
      throw Error(`${error.message}\nRenderer script: ${source}`)
    })
    try {
      await until(() => evaluate('window.pi.getStatus().then(s => s.phase === "ready")'), 'engine ready')
      const config = await evaluate('window.pi.getDesktopConfig()')
      assert.equal(config.engine, 'prophey')
      assert.equal(config.profile, undefined)
      const settingsPaths = await evaluate('window.pi.getAppSettings()')
      assert.equal(settingsPaths.authPath, path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json'))
      assert.equal(config.sharedSessionDir, path.join(process.env.PI_CODING_AGENT_DIR, 'sessions'))
      assert.equal(config.sessionDir, path.join(process.env.PI_CODING_AGENT_DIR, 'sessions'))
      assert.equal(config.sessionMode, undefined, 'sessions always live in pi storage')
      assert.equal(config.isolatedSessionDir, undefined)
      assert.equal((await evaluate('window.pi.getMcpState()')).userConfigPath, path.join(process.env.PI_CODING_AGENT_DIR, 'mcp.json'))
      assert.equal(config.capabilities.autoCompaction, 'configurable')
      assert.equal((await evaluate('window.pi.getStatus()')).autoCompactPercent, 0.1)
      assert.equal((await evaluate('window.pi.setAutoCompactRatio(75)')).ok, true)
      assert.equal((await evaluate('window.pi.getStatus()')).autoCompactPercent, 75)
      assert.equal((await evaluate('window.pi.setCompactThreshold(NaN)')).ok, false)
      const commands = await evaluate('window.pi.getEngineCommands()')
      assert(commands.some(command => command.name === '/compact'))
      assert(commands.some(command => command.name === '/thinking'))
      assert.equal((await evaluate('window.pi.executeEngineCommand("/unknown", "")')).ok, false)
      assert.equal((await evaluate('window.pi.executeEngineCommand("/status", "")')).ok, true)
      await until(() => evaluate('!!document.querySelector(".attach-btn")'), 'composer')
      await evaluate('document.querySelector(".attach-btn").click()')
      await until(() => evaluate('!!document.querySelector(".context-picker")'), 'context menu')
      await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
      await until(() => evaluate('!document.querySelector(".context-picker")'), 'Escape dismiss')
      await evaluate('document.querySelector("button[title=设置]").click()')
      await until(() => evaluate('!!document.querySelector(".settings")'), 'settings dialog')
      const nav = await evaluate('Array.from(document.querySelectorAll(".settings-nav button"), b => b.textContent).join(" ")')
      assert.match(nav, /服务商/)
      assert.match(nav, /MCP/)
      await require('./provider-settings-smoke.cjs')(evaluate, until)
      await evaluate('Array.from(document.querySelectorAll(".settings-nav button")).find(b => b.textContent.trim() === "通用").click()')
      await until(() => evaluate('!!document.querySelector(".settings-content.general")'), 'general settings')
      assert(!await evaluate('document.querySelector(".settings-body").textContent.includes("配置来源")'))
      assert(
        !(await evaluate('document.querySelector(".settings-body").textContent.includes("会话存储")')),
        'session storage is no longer configurable'
      )
      await evaluate('document.querySelector(".modal-backdrop").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))')
      await until(() => evaluate('!document.querySelector(".settings")'), 'settings dismiss')
      const pi = await evaluate('window.pi.setEngine("pi")')
      assert.equal(pi.phase, 'ready')
      assert.equal(pi.engine, 'pi')
      assert((await evaluate('window.pi.getEngineCommands()')).some(c => c.name === '/thinking'))
      const own = await evaluate('window.pi.setEngine("prophey")')
      assert.equal(own.phase, 'ready')
      assert.equal(own.engine, 'prophey')
      const proofModels = { providers: {
        'proof': { api: 'openai-completions', baseUrl: 'https://example.invalid', apiKey: 'local-test', models: [
          { id: 'reasoning', name: 'Reasoning', contextWindow: 32000, maxTokens: 2048, reasoning: true,
            thinkingLevelMap: { off: null, minimal: null, medium: null, xhigh: null, max: null } },
          { id: 'plain', name: 'Plain', contextWindow: 32000, maxTokens: 2048, reasoning: false }
        ] },
        'unconfigured-proof': { api: 'openai-completions', baseUrl: 'https://example.invalid', models: [
          { id: 'hidden', contextWindow: 32000, maxTokens: 2048 }
        ] }
      } }
      assert.equal((await evaluate('window.pi.saveModelsJson(' + JSON.stringify(JSON.stringify(proofModels)) + ')')).ok, true)
      const selectable = await evaluate('window.pi.listModels()')
      assert(selectable.length > 0 && selectable.every(model => model.provider === 'proof'))
      assert.equal((await evaluate('window.pi.setModel("unconfigured-proof", "hidden")')).ok, false)
      assert.equal((await evaluate('window.pi.setModel("proof", "reasoning")')).ok, true)
      assert.deepEqual(await evaluate('window.pi.listThinkingLevels()'), ['low', 'high'])
      await until(() => evaluate('!!document.querySelector(".pill-seg.thinking")'), 'model-specific thinking control')
      await evaluate('document.querySelector(".pill-seg.thinking").click()')
      await until(() => evaluate('document.querySelectorAll(".thinking-option").length === 2'), 'supported thinking choices')
      await evaluate('Array.from(document.querySelectorAll(".thinking-option")).find(e => e.querySelector("code")?.textContent === "high").click()')
      await until(() => evaluate('window.pi.getStatus().then(s => s.thinkingLevel === "high")'), 'thinking applied')
      assert.equal((await evaluate('window.pi.setThinkingLevel("max")')).ok, false)
      assert.equal((await evaluate('window.pi.setModel("proof", "plain")')).ok, true)
      assert.deepEqual(await evaluate('window.pi.listThinkingLevels()'), ['off'])
      // Verify authoritative background status is visible even without agent_start events.
      // Re-send on every attempt: the engine broadcasts its own status after a model change, which
      // can overwrite this injected one before the window renders it (that race made CI flaky).
      const state = await evaluate('window.pi.getStatus()')
      let backgroundVisible = false
      for (let attempt = 0; attempt < 30 && !backgroundVisible; attempt++) {
        window.webContents.send('pi:status', { ...state, isStreaming: false, backgroundTasks: [{ id: 'proof', command: 'test fixture', startedAt: Date.now() }] })
        await new Promise((resolve) => setTimeout(resolve, 150))
        backgroundVisible = await evaluate('document.querySelector(".run-status")?.textContent.includes("后台命令运行中 1")')
      }
      assert.equal(backgroundVisible, true, 'background status without foreground turn')
      window.webContents.send('pi:status', state)
      await until(() => evaluate('!document.querySelector(".run-status")?.textContent.includes("后台命令运行中 1")'), 'background status cleared')
      await require('./ask-panel-smoke.cjs')(evaluate, until)
      await require('./session-switch-smoke.cjs')(evaluate, until, window)
      await require('./image-copy-smoke.cjs')(evaluate, until, window, fixture => { imageCopySessionFixture = fixture })
      await require('./session-messages-smoke.cjs')(evaluate, until, window, fixture => { imageCopySessionFixture = fixture })
      await require('./session-isolation-smoke.cjs')(evaluate, until, window, fixture => { imageCopySessionFixture = fixture })
      await require('./queue-smoke.cjs')(evaluate, until, window)
      await require('./session-panel-smoke.cjs')(evaluate, until, window)
      await require('./session-title-smoke.cjs')(evaluate, until)
      await require('./warpgrep-card-smoke.cjs')(evaluate, until)
      const version = (await evaluate('window.pi.getUpdateSnapshot()')).currentVersion
      assert.equal(version, require(path.join(desktop, 'package.json')).version)
      console.log('Electron smoke passed: isolated startup, IPC, compaction, command menus, settings, dismissal, pi/Prophey switching, version ' + version)
      app.quit()
    } catch (error) {
      console.error(error)
      process.exitCode = 1
      app.quit()
    }
  })
})
require(path.join(desktop, 'out/main/index.js'))
