const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-services-tests-'))
const electron = path.join(temp, 'electron.cjs')
fs.writeFileSync(electron, 'exports.shell = {}; exports.app = { getPath(){return ""}, getAppPath(){return ""} }')
const sources = ['storage', 'session-store', 'transcript-store', 'projects', 'agents', 'mcp', 'providers', 'profile', 'bridge', 'web', 'sessions', 'gateway', 'api']
esbuild.buildSync({ stdin: { contents: sources.map((name, i) => `export * as m${i} from './${name}'`).join('\n'), resolveDir: path.join(root, 'apps/desktop/src/main'), loader: 'ts' }, outfile: path.join(temp, 'services.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { electron } })
const { m0: storage, m1: { SessionStore }, m2: { TranscriptStore }, m3: { ProjectStore }, m4: agents, m5: mcp, m6: providers, m7: profile, m8: bridge, m9: web } = require(path.join(temp, 'services.cjs'))
after(() => { bridge.stopBridge(); fs.rmSync(temp, { recursive: true, force: true }) })
const read = async file => JSON.parse(await fsp.readFile(file, 'utf8'))

test('built-in transcripts use the first user prompt instead of their UUID as a fallback title', async () => {
  const file = path.join(temp, 'own-title.jsonl')
  await fsp.writeFile(file, [
    { type: 'header', workspace: { primary: temp, additional: [] } },
    { message: { role: 'user', customType: 'subagent_notice', content: 'ignore background notice' } },
    { message: { role: 'user', content: '修复登录界面\n和错误提示' } }
  ].map(item => JSON.stringify(item)).join('\n'))
  const summary = await require(path.join(temp, 'services.cjs')).m10.readSummary(file)
  assert.equal(summary.title, '修复登录界面 和错误提示')
  assert.equal(summary.cwd, temp)
})

test('generated titles survive future updates and cannot overwrite manually renamed sessions', async () => {
  const store = new SessionStore(path.join(temp, 'title-sessions.json'))
  const record = await store.upsert({ path: 'title-session', cwd: temp, title: 'First prompt', titleSource: 'prompt', updatedAt: 10 })
  assert.equal(await store.setGeneratedTitle(record.id, 'Generated title'), true)
  assert.equal(store.get(record.id).updatedAt, 10)
  await store.upsert({ id: record.id, updatedAt: 20 })
  assert.equal(store.get(record.id).titleSource, 'generated')
  await store.rename(record.id, 'My title')
  assert.equal(await store.setGeneratedTitle(record.id, 'Late title'), false)
  const restored = new SessionStore(path.join(temp, 'title-sessions.json'))
  await restored.load()
  assert.equal(restored.get(record.id).title, 'My title')
  assert.equal(restored.get(record.id).titleSource, 'manual')
})

test('atomic storage preserves call order, snapshots and cleans temporary files', async () => {
  const file = path.join(temp, 'atomic', 'state.json')
  const value = { revision: 0 }
  const first = storage.writeJsonAtomic(file, value)
  value.revision = -1
  await first
  assert.deepEqual(await read(file), { revision: 0 })
  await Promise.all(Array.from({ length: 25 }, (_, revision) => storage.writeJsonAtomic(file, { revision, body: 'x'.repeat(10000) })))
  assert.equal((await read(file)).revision, 24)
  assert.deepEqual(await fsp.readdir(path.dirname(file)), ['state.json'])
})

test('atomic storage recovers after failed replace and never truncates previous data', async () => {
  const file = path.join(temp, 'failure', 'state.json')
  await fsp.mkdir(file, { recursive: true })
  await assert.rejects(storage.writeJsonAtomic(file, { failed: true }))
  assert.deepEqual(await fsp.readdir(path.dirname(file)), ['state.json'])
  await fsp.rmdir(file)
  await storage.writeJsonAtomic(file, { retained: true })
  await assert.rejects(storage.updateJsonFile(file, {}, () => { throw new Error('mutation rejected') }))
  assert.deepEqual(await read(file), { retained: true })
  await storage.updateJsonFile(file, {}, current => ({ ...current, recovered: true }))
  assert.deepEqual(await read(file), { retained: true, recovered: true })
})

test('concurrent JSON read-modify-write keeps every update and unknown fields', async () => {
  const file = path.join(temp, 'transactions.json')
  await storage.writeJsonAtomic(file, { custom: 'keep' })
  await Promise.all(Array.from({ length: 25 }, (_, index) => storage.updateJsonFile(file, {}, current => ({ ...current, [index]: true }))))
  assert.equal(Object.keys(await read(file)).length, 26)
})

test('cold session loads and concurrent upserts retain every session', async () => {
  const file = path.join(temp, 'sessions.json'), store = new SessionStore(file)
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.upsert({ id: `s_${i}`, path: `codex:${i}`, cwd: temp })))
  assert.equal(store.list().length, 20)
  assert.equal((await new SessionStore(file).load()).length, 20)
})

test('project mutations serialize whole transactions, and failure does not poison the store', async () => {
  const file = path.join(temp, 'projects.json'), store = new ProjectStore(file)
  const projects = await Promise.all(Array.from({ length: 15 }, (_, i) => store.create({ name: `p${i}`, roots: [path.join(temp, `repo${i}`)] })))
  await assert.rejects(store.create({ name: 'invalid', roots: [] }))
  await Promise.all(projects.map(p => store.update(p.id, { name: p.name + '-updated' })))
  const reloaded = await new ProjectStore(file).load()
  assert.equal(reloaded.length, 15)
  assert(reloaded.every(p => p.name.endsWith('-updated')))
})

test('transcript reads and removals wait for earlier saves', async () => {
  const dir = path.join(temp, 'transcripts'), store = new TranscriptStore(dir), workspace = { primary: temp, additional: [] }
  const saving = store.save('s_one', workspace, [{ text: 'saved' }])
  const loaded = await store.load('s_one')
  assert.equal(loaded.messages[0].text, 'saved')
  await saving
  const more = store.save('s_one', workspace, [{ text: 'later' }])
  await store.remove('s_one')
  await more
  assert.equal(await store.load('s_one'), undefined)
  assert.deepEqual(await fsp.readdir(dir), [])
})

test('agent preset/exposure updates and MCP additions preserve concurrent changes', async () => {
  const dir = path.join(temp, 'profile'); profile.setAgentDir(dir)
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => agents.savePreset(dir, { id: `custom${i}`, name: `Custom ${i}` })),
    agents.saveExposure(dir, 'lazy'),
    ...Array.from({ length: 10 }, (_, i) => mcp.addServer(`test${i}`, JSON.stringify({ command: 'node' })))
  ])
  assert.equal((await agents.loadAgents(dir)).exposure, 'lazy')
  assert.equal((await agents.loadAgents(dir)).presets.filter(p => p.source === 'user').length, 10)
  assert.equal((await mcp.listUserServers()).length, 10)
})

test('provider settings and model endpoint updates merge independently', async () => {
  profile.setAgentDir(path.join(temp, 'settings-profile'))
  await Promise.all([
    providers.saveAppSettings({ defaultProvider: 'openai', defaultModel: 'example' }),
    providers.setCompactionSettings({ enabled: false, reserveTokens: 1234 }),
    providers.setProviderBaseUrl('openai', 'https://example.com/openai'),
    providers.setProviderBaseUrl('anthropic', 'https://example.com/anthropic')
  ])
  const settings = await providers.getAppSettings()
  assert.equal(settings.defaultModel, 'example'); assert.equal(settings.compaction.enabled, false)
  assert.equal(settings.compaction.reserveTokens, 1234)
  assert.deepEqual(await providers.getBaseUrlOverrides(), { openai: 'https://example.com/openai', anthropic: 'https://example.com/anthropic' })
})

function post(url, body, token, onResponse) {
  const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-desktop-token': token } }, onResponse)
  request.on('error', () => {})
  request.end(JSON.stringify(body)); return request
}
async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert(check(), 'condition did not settle')
}
test('bridge rejects bad credentials and removes a pending question on client disconnect', async () => {
  const { url } = await bridge.startBridge({ token: 'test-secret' })
  let ask
  bridge.setAskListener(value => { ask = value })
  const denied = await fetch(url + '/ask', { method: 'POST', headers: { 'x-agent-desktop-token': 'wrong' }, body: '{}' })
  assert.equal(denied.status, 401)
  const invalid = await fetch(url + '/ask', { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: 'null' })
  assert.equal(invalid.status, 400)
  const request = post(url + '/ask', { questions: [{ question: 'Continue?' }] }, 'test-secret')
  await eventually(() => !!ask)
  assert.equal(bridge.getBridgeInfo().pending, 1)
  request.destroy()
  await eventually(() => bridge.getBridgeInfo().pending === 0)
  bridge.setAskListener(value => bridge.answerAsk(value.id, [{ question: 'Continue?', selected: ['Yes'] }]))
  const answered = await fetch(url + '/ask', { method: 'POST', headers: { 'x-agent-desktop-token': 'test-secret' }, body: JSON.stringify({ questions: [{ question: 'Continue?' }] }) })
  assert.equal((await answered.json()).answers[0].selected[0], 'Yes')
  bridge.stopBridge()
})

test('subagent tools forward MCP cancellation to the bridge transport', async () => {
  const { subagentTools } = await import(require('node:url').pathToFileURL(path.join(root, 'packages/mcp-core/tools/subagent.mjs')).href)
  const controller = new AbortController(); let forwarded
  const tool = subagentTools.find(t => t.name === 'list_subagents')
  await tool.call({}, { signal: controller.signal, request: async (_method, _path, _body, signal) => { forwarded = signal; return { ok: true, records: [] } } })
  assert.equal(forwarded, controller.signal)
})

test('bridge: questions and completion events belong to their calling engine', async () => {
  const { url } = await bridge.startBridge({ token: 'test-secret' })
  const a = bridge.registerClient(() => ({ sessionKey: 'A', engine: 'prophey', workspace: { primary: '/a', additional: [] } }))
  const b = bridge.registerClient(() => ({ sessionKey: 'B', engine: 'prophey', workspace: { primary: '/b', additional: [] } }))
  try {
    bridge.setAskListener(() => {})
    const ask = credential => fetch(url + '/ask', { method: 'POST', headers: { authorization: 'Bearer ' + credential }, body: JSON.stringify({ questions: [{ question: 'Continue?' }] }) }).then(r => r.json())
    const first = ask(a), second = ask(b)
    await eventually(() => bridge.pendingAsks().length === 2)
    bridge.cancelAllAsks('stop A', 'A')
    assert.equal((await first).cancelled, true)
    assert.equal(bridge.pendingAsks()[0].sessionKey, 'B')
    bridge.answerAsk(bridge.pendingAsks()[0].id, [{ question: 'Continue?', selected: ['B only'] }])
    assert.equal((await second).answers[0].selected[0], 'B only')
    bridge.publishEvent({ type: 'notice', text: 'for A', session: 'A' })
    bridge.publishEvent({ type: 'notice', text: 'for B', session: 'B' })
    const events = credential => fetch(url + '/events?wait=0', { headers: { authorization: 'Bearer ' + credential } }).then(r => r.json())
    assert.deepEqual((await events(b)).events.map(e => e.text), ['for B'])
    assert.deepEqual((await events(a)).events.map(e => e.text), ['for A'])
    bridge.removeClient(a)
    assert.equal((await fetch(url + '/events?wait=0', { headers: { authorization: 'Bearer ' + a } })).status, 401)
  } finally { bridge.removeClient(a); bridge.removeClient(b); bridge.stopBridge() }
})

test('gateway: configuring another workspace cannot replace a live engine endpoint', async () => {
  const gateway = require(path.join(temp, 'services.cjs')).m11
  const target = cwd => ({ id: 'warpgrep', key: 'warpgrep', kind: 'warpgrep', cwd, allowlist: ['codebase_search'], timeoutMs: 1000 })
  try {
    gateway.configure([target('/a')], 'engine-a')
    gateway.configure([target('/b')], 'engine-b')
    assert.deepEqual(gateway.configuredKeys().sort(), ['engine-a/warpgrep', 'engine-b/warpgrep'])
    for (const owner of ['engine-a', 'engine-b']) assert((await gateway.handleMessage(owner + '/warpgrep', { id: 1, method: 'initialize' })).result)
    gateway.releaseScope('engine-b')
    assert.equal(gateway.isConfigured('engine-a/warpgrep'), true)
  } finally { gateway.stopAll() }
})

test('subagent API: delayed model resolution retains the caller workspace, model and parent', async () => {
  const { createApiHandler } = require(path.join(temp, 'services.cjs')).m12
  let resolveModel, launched
  const api = createApiHandler({ agentSettings: () => ({ presets: [] }), subagents: () => ({ start: async options => { launched = options; return { record: options } }, get: () => ({ parentSession: 'B' }), list: () => [{ parentSession: 'B' }] }),
    defaultMode: () => 'background', desktopTools: () => false,
    parentSession: () => 'B', parentWorkspace: () => ({ primary: '/b', additional: [] }),
    resolveModel: () => new Promise(resolve => { resolveModel = resolve }) })
  const context = { sessionKey: 'A', engine: 'prophey', workspace: { primary: '/a', additional: ['/extra-a'] }, model: { provider: 'a', id: 'a-model' } }
  const result = api({ method: 'POST', path: '/subagents', query: new URLSearchParams(), body: { task: 'task', model: 'custom' }, context })
  resolveModel({ model: { provider: 'a', id: 'custom' } })
  assert.equal((await result).status, 200)
  assert.equal(launched.parentSession, 'A'); assert.equal(launched.cwd, '/a'); assert.deepEqual(launched.additional, ['/extra-a'])
  assert.equal((await api({ method: 'GET', path: '/subagents/other', query: new URLSearchParams(), body: {}, context })).status, 404)
  assert.deepEqual((await api({ method: 'GET', path: '/subagents', query: new URLSearchParams(), body: {}, context })).body.subagents, [])
})

test('web fetch validates redirects before requesting local addresses and limits loops', async () => {
  const original = global.fetch, calls = []
  try {
    global.fetch = async (url, options) => { calls.push({ url: String(url), options }); return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }
    await assert.rejects(web.callWebTool('web_fetch', { url: 'https://example.com' }), /拒绝抓取/)
    assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, 'manual')
    calls.length = 0
    global.fetch = async url => { calls.push(String(url)); return new Response('', { status: 302, headers: { location: '/again' } }) }
    await assert.rejects(web.callWebTool('web_fetch', { url: 'https://example.com' }), /重定向次数/)
    assert.equal(calls.length, 6)
    global.fetch = async () => new Response('<html><title>Example</title><p>Body</p></html>', { headers: { 'content-type': 'text/html' } })
    assert.match((await web.callWebTool('web_fetch', { url: 'https://example.com' })).text, /Body/)
  } finally { global.fetch = original }
})


test('gateway ignores output and exits from old children after restarting', async () => {
  const { EventEmitter } = require('node:events')
  const children = []
  function spawn() {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.stdout.setEncoding = child.stderr.setEncoding = () => {}
    child.stdin = new EventEmitter()
    child.stdin.write = function(line) {
      const request = JSON.parse(line)
      if (request.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: request.id, result: {} }) + '\n'))
    }
    children.push(child); return child
  }
  global.__propheyTestSpawn = spawn
  global.__propheyTestKill = child => { child.killed = true }
  const sourcePath = path.join(root, 'apps/desktop/src/main/gateway.ts')
  const source = fs.readFileSync(sourcePath, 'utf8')
    .replace("import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'", "import type { ChildProcessWithoutNullStreams } from 'node:child_process'; const spawn = globalThis.__propheyTestSpawn")
    .replace("import { killTree } from './proc'", "const killTree = globalThis.__propheyTestKill") + '\nexport { Upstream }'
  esbuild.buildSync({ stdin: { contents: source, resolveDir: path.dirname(sourcePath), loader: 'ts' }, outfile: path.join(temp, 'gateway.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { electron } })
  const { Upstream } = require(path.join(temp, 'gateway.cjs'))
  const upstream = new Upstream({ id: 'codegraph', command: 'fake', cwd: temp, timeoutMs: 1000 })
  try {
    await upstream.start(); const old = children[0]
    upstream.stop(); await upstream.start(); const current = children[1]
    let complete = false
    const pending = upstream.request('probe', {}).then(value => { complete = true; return value })
    const id = upstream.seq
    old.stdout.emit('data', JSON.stringify({ id, result: 'stale' }) + '\n')
    old.stderr.emit('data', 'stale stderr')
    old.emit('exit', 1); old.emit('error', new Error('stale error'))
    await Promise.resolve()
    assert.equal(complete, false); assert.equal(upstream.child, current)
    current.stdout.emit('data', 'null\n' + JSON.stringify({ id, result: 'fresh' }) + '\n')
    assert.equal(await pending, 'fresh'); assert.equal(upstream.error, undefined)
    const write = current.stdin.write
    current.stdin.write = () => { throw new Error('write failed') }
    await assert.rejects(upstream.request('write-failure', {}), /write failed/)
    assert.equal(upstream.pending.size, 0)
    current.stdin.write = write
    const failure = upstream.request('failure', {})
    current.stdin.emit('error', new Error('real error'))
    await assert.rejects(failure, /real error/); assert.equal(current.killed, true)
  } finally {
    upstream.stop(); delete global.__propheyTestSpawn; delete global.__propheyTestKill
  }
})


test('project write failures leave the published cache unchanged and allow retry', async () => {
  const dir = path.join(temp, 'project-write-failure'), file = path.join(dir, 'projects.json')
  const store = new ProjectStore(file)
  const project = await store.create({ name: 'original', roots: [temp] })
  await fsp.unlink(file); await fsp.mkdir(file)
  await assert.rejects(store.update(project.id, { name: 'must-not-appear' }))
  assert.equal(store.get(project.id).name, 'original')
  assert.deepEqual(await fsp.readdir(dir), ['projects.json'])
  await fsp.rmdir(file)
  await store.update(project.id, { name: 'recovered' })
  assert.equal((await new ProjectStore(file).load())[0].name, 'recovered')
})
