/*
 * Real Electron proof for the session panel (环境 / 上下文 / 连接器 / 产出 / 后台任务).
 *
 * Isolated profile + seeded transcript events, so no user data or model request is involved.
 * Screenshots go to artifacts/session-panel/ and the geometry numbers are printed for spacing work.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const { spawn, spawnSync } = require('node:child_process')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-panel-proof-'))
  const data = path.join(temp, 'data')
  const workspace = path.join(temp, 'workspace')
  fs.mkdirSync(data, { recursive: true })
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'src', 'proof.ts'), 'export const proof = true\n')
  fs.writeFileSync(path.join(workspace, 'README.md'), '# proof\n')
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      engine: 'prophey',
      cwd: workspace,
      defaultEngine: 'prophey',
      mcp: { enabled: false, subagents: { enabled: false } },
      updates: { autoCheck: false }
    })
  )
  const env = {
    ...process.env,
    PROPHEY_PANEL_TEMP: temp,
    PROPHEY_PANEL_OUT: path.join(root, 'artifacts', 'session-panel'),
    PI_CODING_AGENT_DIR: path.join(temp, 'agent-config')
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
  const temp = process.env.PROPHEY_PANEL_TEMP
  const output = process.env.PROPHEY_PANEL_OUT
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
        await until('!!document.querySelector(".tabbar")', 'title bar')
        win.setSize(1280, 880)
        await pause(300)
        await evaluate('document.querySelector(".tabbar .icon-btn[title^=\\"显示/隐藏会话概览\\"]").click()')
        await until('!!document.querySelector(".session-panel")', 'panel')

        // Seed a produced file and one running background task, the way the transcript does it.
        win.webContents.send('pi:event', { type: 'message_start', message: { role: 'assistant' } })
        win.webContents.send('pi:event', {
          type: 'tool_execution_start',
          toolCallId: 'proof-write',
          toolName: 'write_file',
          arguments: { path: 'src/proof.ts', content: 'export const proof = true' }
        })
        win.webContents.send('pi:event', {
          type: 'tool_execution_end',
          toolCallId: 'proof-write',
          toolName: 'write_file',
          arguments: { path: 'src/proof.ts', content: 'export const proof = true' },
          result: 'ok'
        })
        win.webContents.send('pi:event', {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: '写好了 src/proof.ts' }] }
        })
        const idle = await evaluate('window.pi.getStatus()')
        win.webContents.send('pi:status', {
          ...idle,
          backgroundTasks: [{ id: 'bash_proof', command: 'npm run dev -- --port 5199', startedAt: Date.now() - 95_000 }],
          backgroundFinished: 4
        })
        await until('document.querySelector(".panel-card") && document.body.textContent.includes("src/proof.ts")', 'seeded rows')
        await pause(400)

        const geometry = await evaluate(`(() => {
          const box = element => { const r = element.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
          const panel = document.querySelector('.session-panel');
          const cards = Array.from(document.querySelectorAll('.panel-card')).map(card => ({
            title: card.querySelector('.panel-card-toggle span').textContent,
            ...box(card),
            overflow: card.scrollWidth > card.clientWidth + 1
          }));
          return {
            panel: box(panel),
            scrollHeight: panel.querySelector('.session-panel-scroll').scrollHeight,
            chatWidth: Math.round(document.querySelector('.chat-column').getBoundingClientRect().width),
            cards
          };
        })()`)
        console.log('PANEL:', JSON.stringify(geometry))
        assert.equal(geometry.cards.length, 5)
        assert(geometry.panel.w >= 250, 'panel width ' + geometry.panel.w)
        assert(geometry.cards.every(card => !card.overflow), 'cards must not overflow horizontally')
        assert(geometry.chatWidth > 600, 'chat must keep room next to the panel: ' + geometry.chatWidth)

        fs.mkdirSync(output, { recursive: true })
        for (const theme of ['light', 'dark']) {
          await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
          await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
          await pause(320)
          const rectangle = await evaluate(`(() => {
            const r = document.querySelector('.session-panel').getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
          })()`)
          await win.webContents.capturePage(rectangle)
          await pause(150)
          fs.writeFileSync(path.join(output, theme + '.png'), (await win.webContents.capturePage(rectangle)).toPNG())
        }
        win.webContents.send('pi:status', idle)
        console.log('Session panel proof passed: five cards, no overflow, chat keeps ' + geometry.chatWidth + 'px')
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
