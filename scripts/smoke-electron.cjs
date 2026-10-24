/** Run against built bundles with an isolated profile. No model request or user file is needed. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-smoke-'))
const workspace = path.join(temporary, 'workspace')
const userData = path.join(temporary, 'user-data')
fs.mkdirSync(workspace)
fs.mkdirSync(userData)
fs.writeFileSync(path.join(workspace, 'sample.ts'), 'export const sample = true\n')
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ engine: 'prophey', profile: 'desktop', cwd: workspace, autoCompact: { enabled: true, ratio: 0.001 }, mcp: { enabled: false, subagents: { enabled: false } } }))
fs.writeFileSync(path.join(userData, 'updates.json'), JSON.stringify({ autoCheck: false }))
const env = { ...process.env, PROPHEY_SMOKE_ROOT: root, PROPHEY_SMOKE_DATA: userData, PI_CODING_AGENT_DIR: path.join(temporary, 'agent-config') }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.PI_DEBUG_PORT
const child = spawn(require('electron'), [path.join(root, 'tests/electron-smoke.cjs')], { env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
let output = ''
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
const timer = setTimeout(() => {
  if (process.platform === 'win32') require('node:child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGKILL')
}, 90000)
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('close', code => {
  clearTimeout(timer)
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  const passed = code === 0 && output.includes('Electron smoke passed:')
  if (!passed) {
    // CI logs need a token to read; an annotation and the step summary are visible on the public run.
    const tail = output.trim().split(/\r?\n/).slice(-25).join('\n')
    const escaped = tail.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')
    console.log(`::error title=Electron smoke failed::${escaped}`)
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### Electron smoke failed (exit ${code})\n\n\`\`\`\n${tail}\n\`\`\`\n`)
    }
  }
  process.exitCode = passed ? 0 : 1
})
