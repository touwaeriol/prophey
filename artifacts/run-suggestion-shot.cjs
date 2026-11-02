/** Isolated profile for artifacts/suggestion-shot.cjs: one screenshot of the suggestion UI. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-shot-'))
const workspace = path.join(temporary, 'workspace')
const userData = path.join(temporary, 'user-data')
const agentDir = path.join(temporary, 'agent-config')
fs.mkdirSync(workspace)
fs.mkdirSync(userData)
fs.mkdirSync(agentDir)
fs.writeFileSync(path.join(workspace, 'sample.ts'), 'export const sample = true\n')
fs.writeFileSync(
  path.join(userData, 'config.json'),
  JSON.stringify({ engine: 'prophey', cwd: workspace, autoCompact: { enabled: false }, mcp: { enabled: false } })
)
fs.writeFileSync(path.join(userData, 'updates.json'), JSON.stringify({ autoCheck: false }))
const env = { ...process.env, PROPHEY_SMOKE_ROOT: root, PROPHEY_SMOKE_DATA: userData, PI_CODING_AGENT_DIR: agentDir }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const child = spawn(require('electron'), [path.join(__dirname, 'suggestion-shot.cjs')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
child.stdout.on('data', (chunk) => process.stdout.write(chunk))
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
const timer = setTimeout(() => {
  if (process.platform === 'win32') {
    require('node:child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
  } else child.kill('SIGKILL')
}, 60000)
child.on('close', (code) => {
  clearTimeout(timer)
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  process.exitCode = code
})
