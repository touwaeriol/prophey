/* Real Electron proof for the card-style sidebar: geometry, theme colours and screenshots. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const os = require('node:os')
  const { spawn, spawnSync } = require('node:child_process')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-sidebar-cards-'))
  const data = path.join(temp, 'data')
  fs.mkdirSync(path.join(data, 'transcripts'), { recursive: true })
  const dirs = ['frontend', 'backend', 'tools'].map(name => path.join(temp, name))
  dirs.forEach(dir => fs.mkdirSync(dir))
  const projects = [{ id: 'fullstack', name: '工作台重构', roots: dirs.slice(0, 2).map((dir, i) => ({ path: dir, name: path.basename(dir), primary: !i })), createdAt: 1, updatedAt: 1 }]
  const titles = ['调整模型选择与会话列表', '优化登录流程与错误提示', '检查消息队列并发处理', '补充项目目录管理', '整理文档和配置说明', '修复图片粘贴', '改善小窗口体验', '验证暗色主题', '统一服务商设置', '检查本地构建', '更新说明', '处理测试反馈']
  const sessions = titles.map((title, i) => {
    const id = 'proof_' + i, cwd = dirs[0], file = path.join(data, 'transcripts', id + '.jsonl')
    const multi = i < 3, additional = multi ? [dirs[1]] : []
    const header = JSON.stringify({ type: 'header', sessionId: id, workspace: { primary: cwd, additional } }) + '\n'
    fs.writeFileSync(file, header)
    return { id, key: id, path: file, engine: ['prophey', 'pi', 'claude'][i % 3], title, cwd, additional, ...(multi ? { projectId: 'fullstack' } : {}), createdAt: 1, updatedAt: Date.now() - i * 1000 }
  })
  sessions[4].title = '置顶的会话'
  fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify({ sessions }))
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ projects }))
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ engine: 'prophey', cwd: dirs[0], mcp: { enabled: false }, defaultEngine: 'prophey', activeSession: 'proof_0', propheySessionId: 'proof_0', activeProject: 'fullstack', engineSessions: { prophey: sessions[0].path } }))
  fs.writeFileSync(path.join(data, 'updates.json'), JSON.stringify({ autoCheck: false }))
  const env = { ...process.env, PROPHEY_SIDEBAR_CARDS_TEMP: temp, PI_CODING_AGENT_DIR: path.join(temp, 'agent-config') }
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
  const temp = process.env.PROPHEY_SIDEBAR_CARDS_TEMP
  const output = path.join(root, 'artifacts', 'sidebar-cards')
  app.setPath('userData', path.join(temp, 'data'))
  app.setAppPath(path.join(root, 'apps/desktop'))
  BrowserWindow.prototype.show = function () {}
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  app.on('browser-window-created', (_event, win) => {
    win.webContents.setBackgroundThrottling(false)
    win.webContents.once('did-finish-load', async () => {
      const evaluate = source => win.webContents.executeJavaScript(source)
      const until = async source => {
        for (let i = 0; i < 100; i++) { if (await evaluate(source)) return; await pause(100) }
        throw Error('Timed out: ' + source)
      }
      const metrics = () => evaluate(`(() => {
        const pick = (selector) => {
          const el = document.querySelector(selector)
          if (!el) return null
          const style = getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          return {
            height: Math.round(rect.height * 10) / 10,
            width: Math.round(rect.width * 10) / 10,
            font: style.fontSize,
            radius: style.borderRadius,
            background: style.backgroundColor,
            border: style.borderColor,
            color: style.color
          }
        }
        return {
          sessionItem: pick('.session-item:not(.active)'),
          activeItem: pick('.session-item.active'),
          activeTitle: pick('.session-item.active .session-title'),
          pinnedItem: pick('.pinned-item'),
          pinnedHead: pick('.pinned-head'),
          group: pick('.project-group'),
          nav: pick('.sidebar-nav'),
          navRow: pick('.nav-row'),
          sectionLabel: pick('.sidebar-section-label'),
          showMore: pick('.show-more'),
          projectCount: document.querySelector('.project-count')?.textContent ?? null,
          pinnedCount: document.querySelector('.pinned-count')?.textContent ?? null
        }
      })()`)
      try {
        await until('document.querySelectorAll(".session-item").length === 12')
        // Pin one session so the pinned card is on screen too.
        await evaluate('document.querySelectorAll(".session-item")[3].querySelector(".session-menu-btn").click()')
        await evaluate('document.querySelector(".session-menu-item").click()')
        await until('document.querySelectorAll(".pinned-item").length === 1')
        await pause(400)

        fs.mkdirSync(output, { recursive: true })
        for (const theme of ['light', 'dark']) {
          await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
          await pause(350)
          const card = await metrics()
          const rectangle = await evaluate('(() => { const r = document.querySelector(".sidebar").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } })()')
          fs.writeFileSync(path.join(output, theme + '.png'), (await win.webContents.capturePage(rectangle)).toPNG())
          console.log(theme, JSON.stringify(card, null, 2))
          assert.equal(card.group.radius, '10px', 'a group is a card')
          assert.equal(card.nav.radius, '10px', 'the nav block is a card')
          assert.equal(card.sessionItem.height, 30, 'session rows keep their 30px density')
          assert.notEqual(card.group.background, 'rgba(0, 0, 0, 0)', 'cards have their own surface')
          assert.notEqual(card.activeItem.background, card.sessionItem.background, 'the open row is highlighted')
        }
        console.log('Sidebar cards proof passed: card surfaces, 30px rows and active chip in both themes')
        app.quit()
      } catch (error) { console.error(error); process.exitCode = 1; app.quit() }
    })
  })
  require(path.join(root, 'apps/desktop/out/main/index.js'))
}
