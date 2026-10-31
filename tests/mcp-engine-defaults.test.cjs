/**
 * The built-in MCP servers follow the master switch.
 *
 * A per-engine entry that was never written used to mean "off", while 「MCP 已启用」 defaults to on:
 * a profile with no `mcp.engines` showed every built-in server closed, connected nothing, and gave
 * the user no way to tell whether it was broken or just unconfigured. Missing now means on (the same
 * default as the master switch); an explicit `enabled: false` still means off.
 */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-engine-defaults-'))
esbuild.buildSync({
  stdin: {
    contents: `export * as engines from './engines'`,
    loader: 'ts',
    resolveDir: path.join(root, 'apps/desktop/src/main')
  },
  outfile: path.join(temp, 'engines.cjs'),
  bundle: true,
  platform: 'node',
  packages: 'external'
})
const { engines } = require(path.join(temp, 'engines.cjs'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))

const roots = [{ path: temp, name: 'root', primary: true }]
const base = { roots, morphApiKey: undefined, toggles: {}, tools: {}, indexStatus: {}, web: { braveKey: 'key' } }

test('a missing per-engine entry means on, exactly like the master switch', async () => {
  const states = await engines.engineStates({ ...base, config: {}, warpgrep: { baseUrl: 'https://gw.example' } })
  const byId = Object.fromEntries(states.map((state) => [state.id, state]))
  for (const id of ['codegraph', 'warpgrep', 'web']) {
    assert.equal(byId[id].enabled, true, `${id} is on when nothing says otherwise`)
  }
  // Nothing was written for codegraph, so it falls back to detection. Whether the binary is on this
  // machine is not the point of the test, only that the missing entry did not close the engine.
  assert.equal(byId.codegraph.enabled, true)
  // WarpGrep has a custom endpoint and web has a Brave key: both are usable without any config entry.
  assert.equal(byId.warpgrep.available, true)
  assert.equal(byId.web.available, true)
})

test('an explicit false still closes it', async () => {
  const states = await engines.engineStates({
    ...base,
    config: { codegraph: { enabled: false }, warpgrep: { enabled: false }, web: { enabled: false } },
    warpgrep: { baseUrl: 'https://gw.example' }
  })
  for (const state of states) assert.equal(state.enabled, false, `${state.id} stays off when told to`)
})

test('the gateway gets the same reading: targets exist unless the entry says false', async () => {
  const opened = await engines.buildEngineTargets({
    roots, config: {}, morphApiKey: undefined, warpgrep: { baseUrl: 'https://gw.example' }, webAvailable: true
  })
  // warpgrep and web need no installed binary, so both are there without any config entry.
  assert.deepEqual(opened.map((target) => target.id).sort().filter((id) => id !== 'codegraph'), ['warpgrep', 'web'])

  const closed = await engines.buildEngineTargets({
    roots,
    config: { warpgrep: { enabled: false }, web: { enabled: false } },
    morphApiKey: undefined,
    warpgrep: { baseUrl: 'https://gw.example' },
    webAvailable: true
  })
  // Only the two that were explicitly closed are missing; codegraph keeps its own default (on).
  assert.equal(closed.some((target) => target.id === 'warpgrep'), false)
  assert.equal(closed.some((target) => target.id === 'web'), false)
})
