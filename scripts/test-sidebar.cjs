/* Real Electron sidebar proof with isolated records and folder-picker responses. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const os = require('node:os')
  const { spawn, spawnSync } = require('node:child_process')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-sidebar-'))
  const data = path.join(temp, 'data')
  fs.mkdirSync(path.join(data, 'transcripts'), { recursive: true })
  const dirs = ['frontend', 'backend', 'tools'].map(name => path.join(temp, name))
  dirs.forEach(dir => fs.mkdirSync(dir))
  const projects = [{ id: 'fullstack', name: '工作台重构', roots: dirs.slice(0, 2).map((dir, i) => ({ path: dir, name: path.basename(dir), primary: !i })), createdAt: 1, updatedAt: 1 }]
  const titles = ['调整模型选择与会话列表', '优化登录流程与错误提示', '检查消息队列并发处理', '补充项目目录管理', '整理文档和配置说明', '修复图片粘贴', '改善小窗口体验', '验证暗色主题', '统一服务商设置', '检查本地构建', '更新说明', '处理测试反馈']
  const sessions = titles.map((title, i) => {
    const id = 'proof_' + i, cwd = dirs[0], file = path.join(data, 'transcripts', id + '.jsonl')
    const multi = i < 3, additional = multi ? [dirs[1]] : []
    fs.writeFileSync(file, JSON.stringify({ type: 'header', sessionId: id, workspace: { primary: cwd, additional } }) + '\n')
    return { id, key: id, path: file, engine: ['prophey', 'pi', 'claude'][i % 3], title, cwd, additional, ...(multi ? { projectId: 'fullstack' } : {}), createdAt: 1, updatedAt: Date.now() - i * 1000 }
  })
  fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify({ sessions }))
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ projects }))
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ engine: 'prophey', cwd: dirs[0], mcp: { enabled: false }, defaultEngine: 'prophey', activeSession: 'proof_0', propheySessionId: 'proof_0', activeProject: 'fullstack', engineSessions: { prophey: sessions[0].path } }))
  fs.writeFileSync(path.join(data, 'updates.json'), JSON.stringify({ autoCheck: false }))
  const env = { ...process.env, PROPHEY_SIDEBAR_TEMP: temp, PI_CODING_AGENT_DIR: path.join(temp, 'agent-config') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGKILL')
  }, 60000)
  child.on('exit', code => { clearTimeout(timer); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow, dialog } = require('electron')
  const assert = require('node:assert/strict')
  const temp = process.env.PROPHEY_SIDEBAR_TEMP
  app.setPath('userData', path.join(temp, 'data'))
  app.setAppPath(path.join(root, 'apps/desktop'))
  BrowserWindow.prototype.show = function () {}
  let selection = []
  let dialogCount = 0
  dialog.showOpenDialog = async () => { dialogCount++; return { canceled: selection.length === 0, filePaths: selection } }
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  app.on('browser-window-created', (_event, win) => {
    win.webContents.setBackgroundThrottling(false)
    win.webContents.once('did-finish-load', async () => {
      const evaluate = source => win.webContents.executeJavaScript(source)
      const until = async source => {
        for (let i = 0; i < 100; i++) { if (await evaluate(source)) return; await pause(100) }
        throw Error('Timed out: ' + source)
      }
      try {
        await until('document.querySelectorAll(".session-item").length === 12')
        assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".sidebar-section-label"), e => e.textContent)'), ['项目', '会话'])
        assert.equal(await evaluate('document.querySelector(".multi-directory-project").querySelectorAll(".session-item").length'), 3)
        assert.equal(await evaluate('document.querySelector(".session-item").getBoundingClientRect().height'), 30)
        assert.equal(await evaluate('document.querySelectorAll(".session-item .session-meta").length'), 0)
        await evaluate('document.querySelector(".multi-directory-project .project-toggle").click()')
        assert.equal(await evaluate('document.querySelector(".multi-directory-project .project-sessions") === null'), true)
        await evaluate('document.querySelector(".multi-directory-project .project-toggle").click()')
        await evaluate('document.querySelectorAll(".session-item")[3].querySelector(".session-menu-btn").click()')
        await evaluate('document.querySelector(".session-menu-item").click()')
        await until('document.querySelectorAll(".pinned-item").length === 1')
        assert.equal(await evaluate('document.querySelectorAll(".session-item").length'), 11)
        const state = await evaluate('window.pi.getStatus()')
        assert.equal(await evaluate('document.querySelectorAll(".session-item[aria-current=page] .session-dot.current").length'), 1)
        win.webContents.send('pi:status', { ...state, isStreaming: true, runningSessionKeys: ['proof_1'] })
        await until('document.querySelectorAll(".session-item.running").length === 2')
        win.webContents.send('pi:status', state)
        await until('document.querySelectorAll(".session-item.running").length === 0')
        await evaluate('document.querySelector(".session-item[aria-current=page] .session-menu-btn").click()')
        await evaluate('document.querySelector(".session-menu-item").click()')
        await until('document.querySelectorAll(".pinned-item[aria-current=page] .session-dot.current").length === 1')
        const output = path.join(root, 'artifacts', 'sidebar')
        fs.mkdirSync(output, { recursive: true })
        for (const theme of ['light', 'dark']) {
          await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
          await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
          await pause(500)
          const rectangle = await evaluate('(() => { const r = document.querySelector(".sidebar").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } })()')
          await win.webContents.capturePage(rectangle)
          await pause(200)
          fs.writeFileSync(path.join(output, theme + '.png'), (await win.webContents.capturePage(rectangle)).toPNG())
        }
        selection = [path.join(temp, 'tools')]
        await evaluate('Array.from(document.querySelectorAll(".nav-row")).find(e => e.textContent === "新项目").click()')
        await until(`window.pi.getStatus().then(s => s.cwd === ${JSON.stringify(selection[0])})`)
        assert.equal((await evaluate('window.pi.getDesktopConfig()')).activeProject, undefined)
        assert.equal((await evaluate('window.pi.listProjects()')).length, 1)
        selection = [path.join(temp, 'tools'), path.join(temp, 'backend')]
        await evaluate('Array.from(document.querySelectorAll(".nav-row")).find(e => e.textContent === "新项目").click()')
        await until('window.pi.listProjects().then(p => p.length === 2)')
        await until('window.pi.getDesktopConfig().then(c => !!c.activeProject)')
        const first = await evaluate('window.pi.getDesktopConfig().then(c => c.activeProject)')
        await evaluate('document.querySelector("[data-group-key=" + JSON.stringify("project:" + ' + JSON.stringify(first) + ') + "] .project-action").click()')
        await pause(200)
        assert.equal((await evaluate('window.pi.getDesktopConfig()')).activeProject, first)
        await until('window.pi.recentRepos().then(dirs => dirs.some(dir => dir.endsWith("tools")))')
        const beforeDialogs = dialogCount
        await evaluate('Array.from(document.querySelectorAll(".nav-row")).find(e => e.textContent === "新会话").click()')
        await until('!!document.querySelector(".workspace-picker")')
        assert.equal(dialogCount, beforeDialogs, 'new session must offer recents before opening a native picker')
        assert.equal(await evaluate('document.querySelector(".workspace-choice-path").textContent'), path.join(temp, 'tools'))
        await evaluate(`(() => { const input = document.querySelector('.workspace-picker-search input');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'backend');
          input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
        await until('document.querySelectorAll(".workspace-choice").length === 1')
        await evaluate('document.querySelector(".workspace-choice").click()')
        await until('!document.querySelector(".workspace-picker")')
        assert.equal(dialogCount, beforeDialogs)
        assert.equal((await evaluate('window.pi.getStatus()')).cwd, path.join(temp, 'backend'))
        assert.equal((await evaluate('window.pi.getDesktopConfig()')).activeProject, undefined)
        assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'data/config.json'))).recentRepos[0], path.join(temp, 'backend'))
        await evaluate('document.querySelector(".tab-new").click()')
        await until('!!document.querySelector(".workspace-picker")')
        selection = []
        await evaluate('document.querySelector(".workspace-picker-foot button").click()')
        await until('document.querySelector(".workspace-picker-foot button")?.disabled === false')
        assert.equal(dialogCount, beforeDialogs + 1)
        assert.equal(await evaluate('!!document.querySelector(".workspace-picker")'), true, 'canceling the native picker keeps recent choices')
        for (const theme of ['light', 'dark']) {
          await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
          await pause(250)
          const rectangle = await evaluate('(() => { const r = document.querySelector(".workspace-picker").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } })()')
          await win.webContents.capturePage(rectangle)
          await pause(100)
          fs.writeFileSync(path.join(output, 'directories-' + theme + '.png'), (await win.webContents.capturePage(rectangle)).toPNG())
        }
        await evaluate('document.querySelector(".workspace-picker-search input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
        await until('!document.querySelector(".workspace-picker")')

        // Switching sessions moves the open one to the front of its directory; directory order never moves.
        const keysBefore = await evaluate('Array.from(document.querySelectorAll(".project-group"), g => g.dataset.groupKey)')
        assert(keysBefore.length > 1, 'sidebar has several directory groups')
        const fixture = JSON.parse(fs.readFileSync(path.join(temp, 'data', 'sessions.json'), 'utf8')).sessions
        const pinnedTitles = await evaluate('Array.from(document.querySelectorAll(".pinned-item"), i => i.textContent.trim())')
        const target = fixture.find((session) =>
          session.engine === 'prophey' && !pinnedTitles.some((title) => title.includes(session.title)))
        assert(target, 'an unpinned Prophey session exists to switch to')
        assert.equal(
          (await evaluate(`window.pi.switchSession(${JSON.stringify(target.path)})`)).ok,
          true,
          'switching to ' + target.title
        )
        await until(`(() => {
          const active = document.querySelector('.project-group .session-item.active');
          if (!active || !active.textContent.includes(${JSON.stringify(target.title)})) return false;
          return active === active.closest('.project-group').querySelector('.session-item');
        })()`, 'open session leads its directory')
        assert.deepEqual(
          await evaluate('Array.from(document.querySelectorAll(".project-group"), g => g.dataset.groupKey)'),
          keysBefore,
          'directory groups keep their order when switching'
        )

        win.webContents.reload()
        await until('!!document.querySelector(".nav-row")')
        await evaluate('Array.from(document.querySelectorAll(".nav-row")).find(e => e.textContent === "新会话").click()')
        await until('!!document.querySelector(".workspace-picker")')
        await until('Array.from(document.querySelectorAll(".workspace-choice-path")).some(e => e.textContent.endsWith("tools"))')
        assert.equal(dialogCount, beforeDialogs + 1, 'saved recent directories remain available after reloading')
        console.log('Sidebar proof passed: grouping, compact rows, pinning, themes, single-directory sessions and multi-directory projects')
        app.quit()
      } catch (error) { console.error(error); process.exitCode = 1; app.quit() }
    })
  })
  require(path.join(root, 'apps/desktop/out/main/index.js'))
}
