/*
 * Real Electron proof for the ChatGPT plan-usage row in 设置 → 服务商.
 *
 * The OpenAI card is seeded with a (fake) ChatGPT OAuth credential so the row renders without the
 * user's own `.pi` profile. Plan numbers come from a Codex credential: the local Codex CLI login is
 * copied into the isolated profile when it exists, otherwise the run proves the fallback ("需在
 * ChatGPT 设置中查看" + the 查看用量 link). Screenshots land in `artifacts/usage/`.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const codexAuth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json')
const hasCodexLogin = fs.existsSync(codexAuth)

if (!process.versions.electron) {
  const { spawn, spawnSync } = require('node:child_process')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-usage-row-'))
  const data = path.join(temp, 'data')
  const agent = path.join(temp, 'agent')
  const codex = path.join(temp, 'codex')
  const workspace = path.join(temp, 'workspace')
  for (const dir of [data, agent, codex, workspace]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(agent, 'auth.json'),
    JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'usage-row-preview',
        refresh: 'usage-row-preview',
        expires: Date.now() + 3600_000,
        clientId: 'usage-row-preview',
        scopes: ['openid', 'offline_access', 'chatgpt.tokens.use.direct', 'resource.invoke']
      }
    })
  )
  if (hasCodexLogin) fs.copyFileSync(codexAuth, path.join(codex, 'auth.json'))
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      engine: 'prophey',
      cwd: workspace,
      defaultEngine: 'prophey',
      mcp: { enabled: false },
      updates: { autoCheck: false }
    })
  )
  const env = {
    ...process.env,
    PROPHEY_USAGE_TEMP: temp,
    PROPHEY_USAGE_OUT: path.join(root, 'artifacts', 'usage'),
    PROPHEY_USAGE_EXPECT: hasCodexLogin ? 'numbers' : 'fallback',
    PI_CODING_AGENT_DIR: agent,
    CODEX_HOME: codex
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGKILL')
  }, 90000)
  child.on('exit', code => {
    clearTimeout(timer)
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    process.exitCode = code ?? 1
  })
} else {
  const { app, BrowserWindow } = require('electron')
  const assert = require('node:assert/strict')
  const temp = process.env.PROPHEY_USAGE_TEMP
  const output = process.env.PROPHEY_USAGE_OUT
  const expect = process.env.PROPHEY_USAGE_EXPECT
  app.setPath('userData', path.join(temp, 'data'))
  app.setAppPath(path.join(root, 'apps/desktop'))
  BrowserWindow.prototype.show = function () {}
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  app.on('browser-window-created', (_event, win) => {
    win.webContents.setBackgroundThrottling(false)
    win.webContents.once('did-finish-load', async () => {
      const evaluate = source => win.webContents.executeJavaScript(source)
      const until = async (source, label) => {
        for (let i = 0; i < 120; i++) {
          if (await evaluate(source)) return
          await pause(100)
        }
        throw Error('Timed out: ' + (label || source))
      }
      try {
        await until('!!document.querySelector(".rail-btn[title=设置]")', 'icon rail')
        await evaluate('document.querySelector(".rail-btn[title=设置]").click()')
        await until('!!document.querySelector(".provider-usage-value")', 'usage row')
        await until(
          '!document.querySelector(".provider-usage-value").textContent.includes("正在查询")',
          'usage answer'
        )

        const text = await evaluate('document.querySelector(".provider-usage-value").textContent')
        const rowTitle = await evaluate('document.querySelector(".provider-usage").title')
        const link = await evaluate('document.querySelector(".provider-usage-link").textContent')
        assert.equal(link, '查看用量')
        if (expect === 'numbers') {
          assert.match(text, /^剩余 \d+%（.+）/, 'usage row must show the remaining percentage: ' + text)
          assert.match(rowTitle, /已用 \d+%/)
          assert.match(rowTitle, /来源：/)
        } else {
          assert.equal(text, '需在 ChatGPT 设置中查看')
          assert.match(rowTitle, /Codex/)
        }

        fs.mkdirSync(output, { recursive: true })
        for (const theme of ['light', 'dark']) {
          await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
          await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
          await pause(300)
          const rectangle = await evaluate(`(() => {
            const row = Array.from(document.querySelectorAll('.provider-row'))
              .find(row => row.querySelector('.provider-usage'));
            const r = row.getBoundingClientRect();
            return { x: Math.round(r.x) - 8, y: Math.round(r.y) - 8, width: Math.round(r.width) + 16, height: Math.round(r.height) + 16 };
          })()`)
          await win.webContents.capturePage(rectangle)
          await pause(150)
          fs.writeFileSync(
            path.join(output, 'openai-' + theme + '.png'),
            (await win.webContents.capturePage(rectangle)).toPNG()
          )
        }
        console.log('Usage row check passed (' + expect + '): ' + text)
        app.quit()
      } catch (error) {
        console.error(error)
        process.exitCode = 1
        app.quit()
      }
    })
  })
  require(path.join(root, 'apps/desktop/out/main/index.js'))
}
