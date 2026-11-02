/** Renders the suggestion chip + ghost text in the real window and saves a PNG for review. */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.PROPHEY_SMOKE_ROOT || path.resolve(__dirname, '..')
const desktop = path.join(root, 'apps/desktop')
app.setPath('userData', process.env.PROPHEY_SMOKE_DATA)
app.setAppPath(desktop)
BrowserWindow.prototype.show = function () {}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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
    const evaluate = (source) => window.webContents.executeJavaScript(source)
    try {
      await until(() => evaluate('window.pi.getStatus().then(s => s.phase === "ready")'), 'engine ready')
      const sessionKey = await evaluate('window.pi.getStatus().then(s => s.sessionKey ?? s.sessionFile ?? "")')
      await until(() => evaluate('!!document.querySelector(".composer textarea")'), 'composer')
      await evaluate('document.querySelector(".composer textarea").focus()')
      window.webContents.send('pi:event', {
        type: 'suggestion',
        text: '跑一遍单元测试，把失败的用例贴出来',
        sessionKey
      })
      await until(() => evaluate('!!document.querySelector(".composer-ghost-rest")'), 'ghost text')
      await delay(400)
      const image = await window.capturePage()
      const out = path.join(root, 'artifacts', 'suggestions')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'composer-ghost.png'), image.toPNG())
      console.log('saved artifacts/suggestions/composer-ghost.png')
      app.exit(0)
    } catch (error) {
      console.error('FAILED:', error && error.stack ? error.stack : error)
      app.exit(1)
    }
  })
})

require(path.join(desktop, 'out/main/index.js'))
