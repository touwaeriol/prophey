/* OS-level click proof with cursor-landing verification (retries when the live user moves the mouse). */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const os = require('node:os')
  const { spawn, spawnSync } = require('node:child_process')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-osretry-'))
  const data = path.join(temp, 'data')
  const workspace = path.join(temp, 'workspace')
  fs.mkdirSync(path.join(data, 'transcripts'), { recursive: true })
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify({ sessions: [] }))
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ engine: 'prophey', cwd: workspace, mcp: { enabled: false } }))
  fs.writeFileSync(path.join(data, 'updates.json'), JSON.stringify({ autoCheck: false }))
  const env = { ...process.env, PROPHEY_OSRETRY_TEMP: temp, PI_CODING_AGENT_DIR: path.join(temp, 'agent-config') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGKILL')
  }, 90000)
  child.on('exit', code => { clearTimeout(timer); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow, screen } = require('electron')
  const { execFileSync } = require('node:child_process')
  const temp = process.env.PROPHEY_OSRETRY_TEMP
  app.setPath('userData', path.join(temp, 'data'))
  app.setAppPath(path.join(root, 'apps/desktop'))
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const ps = (script) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim()

  const MOVE = (x, y) => ps(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public struct P{public int X;public int Y;}[StructLayout(LayoutKind.Sequential)]public class W{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern bool GetCursorPos(out P p);}';
[W]::SetCursorPos(${x}, ${y}) | Out-Null; Start-Sleep -Milliseconds 120; $p = New-Object P; [W]::GetCursorPos([ref]$p) | Out-Null; Write-Output "$($p.X),$($p.Y)"`)

  const clickNow = () =>
    ps(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class C{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);}';
[C]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 70; [C]::mouse_event(4,0,0,0,0); Start-Sleep -Milliseconds 450; Write-Output ok`)

  app.on('browser-window-created', (_event, win) => {
    if (win.constructor.name !== 'BrowserWindow') return
    win.webContents.setBackgroundThrottling(false)
    win.webContents.on('did-finish-load', async () => {
      const evaluate = source => win.webContents.executeJavaScript(source)
      const until = async source => {
        for (let i = 0; i < 120; i++) { if (await evaluate(source)) return; await pause(100) }
        throw Error('Timed out: ' + source)
      }
      const open = () => evaluate('!!document.querySelector(".sidebar")')
      try {
        win.setPosition(40, 40)
        win.show()
        win.setAlwaysOnTop(true)
        await until('!!document.querySelector(".tabbar .sidebar-toggle")')
        await pause(1200)

        const measure = async (selector) => {
          const dip = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
          const bounds = win.getContentBounds()
          const scale = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).scaleFactor
          return { x: Math.round((bounds.x + dip.x) * scale), y: Math.round((bounds.y + dip.y) * scale), region: await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).webkitAppRegion`) }
        }

        /* Click until the cursor verifiably stayed on target (the live user may move it). */
        const reliableClick = async (point) => {
          for (let attempt = 1; attempt <= 6; attempt++) {
            const landed = MOVE(point.x, point.y)
            if (landed !== `${point.x},${point.y}`) { await pause(150); continue }
            await pause(80)
            clickNow()
            if (await open() !== point.before) return { ok: true, attempt }
          }
          return { ok: false, attempt: 6 }
        }

        const report = { startOpen: await open(), steps: [] }
        for (const [label, selector] of [
          ['tabbar', '.tabbar .sidebar-toggle'],
          ['rail', '.rail-btn.sidebar-toggle']
        ]) {
          for (let round = 0; round < 2; round++) {
            const before = await open()
            const point = await measure(selector)
            const result = await reliableClick({ ...point, before })
            report.steps.push({ label, round, region: point.region, changed: (await open()) !== before, ...result })
          }
        }
        console.log(JSON.stringify(report, null, 2))
        app.quit()
      } catch (error) { console.error(error); process.exitCode = 1; app.quit() }
    })
  })
  require(path.join(root, 'apps/desktop/out/main/index.js'))
}
