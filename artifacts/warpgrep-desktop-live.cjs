/**
 * Live proof of the desktop path: config → buildEngineTargets → gateway → WarpGrep → DeepSeek.
 * Uses the real key already stored for pi (~/.pi/agent/auth.json). Read-only.
 * Run: node artifacts/warpgrep-desktop-live.cjs [question]
 */
const esbuild = require('esbuild')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = path.join(root, 'apps/desktop/src/main')
const question = process.argv[2] ?? '侧栏折叠/展开的状态存在哪里，读写它的函数叫什么？'
const key = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8')).deepseek.key

const out = path.join(os.tmpdir(), 'prophey-desktop-warpgrep.cjs')
// engines/gateway only touch electron for the CodeGraph entry; a stub keeps this a plain node run.
const electronStub = path.join(os.tmpdir(), 'prophey-electron-stub.cjs')
fs.writeFileSync(electronStub, 'exports.app = { getPath: () => "", getAppPath: () => "", isPackaged: false }; exports.shell = {}')
esbuild.buildSync({
  stdin: {
    contents: "export * as engines from './engines'\nexport * as gateway from './gateway'",
    resolveDir: main,
    loader: 'ts'
  },
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  alias: { electron: electronStub }
})
const { engines, gateway } = require(out)

;(async () => {
  const targets = await engines.buildEngineTargets({
    roots: [{ path: root, name: 'pi-mcps', primary: true }],
    config: { warpgrep: { enabled: true } },
    morpApiKey: undefined,
    warpgrep: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: key }
  })
  const target = targets.find((entry) => entry.kind === 'warpgrep')
  console.log('target:', { key: target.key, cwd: target.cwd, backend: { ...target.warpgrep, apiKey: '***' } })

  gateway.configure(targets)
  const started = Date.now()
  const response = await gateway.handleMessage('warpgrep', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'codebase_search',
      arguments: { search_string: question, includeSource: true, maxChars: 4000 }
    }
  })
  const elapsed = Date.now() - started
  if (response.error) {
    console.error('gateway error:', response.error)
    process.exitCode = 1
    return
  }
  console.log('\n--- text ---\n' + response.result.content[0].text)
  console.log('\n--- structured ---')
  console.log({ ms: elapsed, ...(response.result.structuredContent ?? {}) })
  const found = response.result.structuredContent?.files ?? ''
  if (!/layout-prefs/.test(found)) {
    console.error('\nEXPECTED layout-prefs.ts in the file list')
    process.exitCode = 1
  }
  gateway.stopAll()
})()
