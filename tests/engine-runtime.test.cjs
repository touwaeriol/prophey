const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const esbuild = require('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-runtime-tests-'))
const root = path.resolve(__dirname, '..')
for (const name of ['json-lines', 'pi-rpc', 'agent/json-rpc-process', 'agent/pi-engine', 'agent/core-tools']) {
  esbuild.buildSync({ entryPoints: [path.join(root, 'apps/desktop/src/main', name + '.ts')], outfile: path.join(temp, path.basename(name) + '.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
}
after(() => fs.rmSync(temp, { recursive: true, force: true }))

function fakeProcess() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdout.setEncoding = child.stderr.setEncoding = () => {}
  child.stdin.write = value => { child.written.push(JSON.parse(value)); return true }
  child.stdin.end = () => {}
  child.written = []
  child.killed = true
  child.exitCode = null
  child.signalCode = null
  return child
}
function loadWithProcesses(name) {
  const children = [], killedPids = []
  const filename = path.join(temp, name + '.cjs')
  const module = new Module(filename, moduleParent)
  module.filename = filename
  module.paths = Module._nodeModulePaths(temp)
  module.require = specifier => specifier === 'node:child_process'
    ? { ...require(specifier), execFileSync: (command, args) => { assert.equal(command, 'taskkill'); killedPids.push(Number(args[1])) }, spawn: (command, args) => { if (command === 'taskkill') { killedPids.push(Number(args[1])); return new EventEmitter() }; const child = fakeProcess(); child.pid = 100 + children.length; children.push(child); return child } }
    : require(specifier)
  module._compile(fs.readFileSync(filename, 'utf8'), filename)
  return { ...module.exports, children, killedPids }
}
const moduleParent = module
const { createJsonLineDecoder } = require(path.join(temp, 'json-lines.cjs'))

test('JSONL framing accepts chunked objects and CRLF while ignoring malformed/non-object lines', () => {
  const records = [], decode = createJsonLineDecoder(record => records.push(record))
  decode('null\n[]\n42\ntrue\ninvalid\n{"type":')
  decode('"ready"}\r\n{"id":2}\n{"id":')
  assert.deepEqual(records, [{ type: 'ready' }, { id: 2 }])
  decode('3}\n')
  assert.equal(records[2].id, 3)
})

test('pi RPC isolates retired child output and preserves response/error protocol', async () => {
  const { PiRpcClient, children, killedPids } = loadWithProcesses('pi-rpc')
  const originalCli = process.env.PI_CLI_PATH
  process.env.PI_CLI_PATH = path.join(temp, 'unused-cli.js')
  const rpc = new PiRpcClient(), events = []
  rpc.on('event', event => events.push(event))
  try {
    rpc.start(temp)
    const old = children[0]
    old.stdout.emit('data', '{"type":')
    rpc.start(temp)
    const current = children[1]
    old.stdout.emit('data', '"stale"}\n')
    old.stderr.emit('data', 'stale stderr')
    old.emit('exit', 1)
    current.stdout.emit('data', 'null\n{"type":"ready"}\n')
    assert.deepEqual(events, [{ type: 'ready' }])
    assert.equal(rpc.stderrTail, '')
    const result = rpc.request('get_state')
    current.stdout.emit('data', JSON.stringify({ type: 'response', id: current.written[0].id, success: true, data: { ready: true } }) + '\n')
    assert.equal((await result).data.ready, true)
    const failure = rpc.request('invalid')
    current.stdout.emit('data', JSON.stringify({ type: 'response', id: current.written[1].id, success: false, error: 'refused' }) + '\n')
    await assert.rejects(failure, /refused/)
    const pending = rpc.request('pending')
    current.stdin.emit('error', new Error('broken input'))
    await assert.rejects(pending, /broken input/)
    assert.equal(rpc.running, false)
    assert(killedPids.includes(current.pid))
  } finally {
    rpc.killNow()
    if (originalCli === undefined) delete process.env.PI_CLI_PATH
    else process.env.PI_CLI_PATH = originalCli
  }
})

test('JSON-RPC keeps native requests, notifications and restarts separate', async () => {
  const { JsonRpcProcess, children, killedPids } = loadWithProcesses('json-rpc-process')
  const notifications = [], exits = []
  const rpc = new JsonRpcProcess((method, params) => notifications.push({ method, params }), async () => ({ decision: 'decline' }), error => exits.push(error))
  rpc.start('unused', [], temp)
  const old = children[0]
  const pending = rpc.request('pending')
  rpc.start('unused', [], temp)
  await assert.rejects(pending, /已停止/)
  const current = children[1]
  old.stdout.emit('data', '{"method":"stale"}\n')
  old.stderr.emit('data', 'stale stderr')
  old.emit('close', 1)
  current.stdout.emit('data', 'null\n{"method":"ready","params":{}}\n{"id":9,"method":"approval"}\n')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(notifications, [{ method: 'ready', params: {} }])
  assert.deepEqual(current.written, [{ id: 9, result: { decision: 'decline' } }])
  assert.equal(rpc.stderr, '')
  assert.deepEqual(exits, [])
  const response = rpc.request('model/list')
  current.stdout.emit('data', JSON.stringify({ id: current.written[1].id, result: { data: [] } }) + '\n')
  assert.deepEqual(await response, { data: [] })
  const failing = rpc.request('pending')
  current.stdin.emit('error', new Error('broken pipe'))
  await assert.rejects(failing, /broken pipe/)
  assert.deepEqual(exits, ['broken pipe'])
  assert(killedPids.includes(current.pid))
  rpc.stop()
})

test('pi settle waiters remove both timed-out and completed subscriptions', async () => {
  const { PiEngine } = require(path.join(temp, 'pi-engine.cjs'))
  const engine = new PiEngine({ onStatus() {}, onEvent() {}, onSettled() {}, onAssistantError() {} })
  assert.equal(await engine.waitForSettle(1), false)
  assert.equal(engine.settleWaiters.size, 0)
  const first = engine.waitForSettle(1000), second = engine.waitForSettle(1000)
  engine.resolveSettled()
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(engine.settleWaiters.size, 0)
})

test('shared tool adapters preserve schemas, context and cancellation for every loader', async () => {
  const { loadAskTool, loadWorkspaceTools, loadSubagentTools, toolDeclarations } = require(path.join(temp, 'core-tools.cjs'))
  const source = path.join(temp, 'tools.mjs')
  fs.writeFileSync(source, 'const tool = { name: "shared", call: async (args, context) => ({ args, context, content: [] }) }; export const workspaceTools = [tool]; export const subagentTools = [tool]; export const askUserQuestion = tool;')
  const signal = new AbortController().signal
  for (const [load, context] of [[loadWorkspaceTools, {}], [loadAskTool, { token: 'test' }], [loadSubagentTools, { token: 'test' }]]) {
    const [tool] = await load(source, context)
    assert.deepEqual(toolDeclarations([tool]), [{ name: 'shared', description: 'shared', parameters: { type: 'object', properties: {} } }])
    const result = await tool.call({ value: 1 }, signal)
    assert.deepEqual(result.args, { value: 1 })
    assert.equal(result.context.signal, signal)
    assert.equal(result.context.token, context.token)
    assert.equal(context.signal, undefined)
  }
})


test('native permission confirmation denies by default and requires an explicit selection', async () => {
  esbuild.buildSync({ entryPoints: [path.join(root, 'apps/desktop/src/main/agent/native-engine.ts')], outfile: path.join(temp, 'native-engine.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  const { NativeEngine } = require(path.join(temp, 'native-engine.cjs'))
  const callbacks = { onStatus() {}, onEvent() {}, onSettled() {} }
  assert.equal(await new NativeEngine(callbacks).requestApproval('execute?', 'tool'), false)
  for (const [answer, expected] of [
    [{ cancelled: true }, false],
    [{ cancelled: false, answers: [{ selected: ['拒绝'] }] }, false],
    [{ cancelled: false, answers: [{ selected: [], other: '允许本次' }] }, false],
    [{ cancelled: false, answers: [{ selected: ['允许本次'] }] }, true]
  ]) {
    const engine = new NativeEngine({ ...callbacks, ask: async (questions, tool) => {
      assert.equal(tool, 'tool')
      assert.deepEqual(questions[0].options.map(option => option.label), ['拒绝', '允许本次'])
      return answer
    } })
    assert.equal(await engine.requestApproval('execute?', 'tool'), expected)
  }
})


test('a restart inside an event handler discards the rest of the retired child chunk', () => {
  const { JsonRpcProcess, children } = loadWithProcesses('json-rpc-process')
  const events = []
  const rpc = new JsonRpcProcess(method => { events.push(method); rpc.start('unused', [], temp) }, async () => ({}), () => {})
  rpc.start('unused', [], temp)
  children[0].stdout.emit('data', '{"method":"restart"}\n{"method":"stale"}\n')
  assert.deepEqual(events, ['restart'])
  rpc.stop()
  const { PiRpcClient, children: piChildren } = loadWithProcesses('pi-rpc')
  const original = process.env.PI_CLI_PATH
  process.env.PI_CLI_PATH = path.join(temp, 'unused-cli.js')
  const pi = new PiRpcClient(), piEvents = []
  pi.on('event', record => { piEvents.push(record.type); pi.start(temp) })
  try {
    pi.start(temp)
    piChildren[0].stdout.emit('data', '{"type":"restart"}\n{"type":"stale"}\n')
    assert.deepEqual(piEvents, ['restart'])
  } finally {
    pi.killNow()
    if (original === undefined) delete process.env.PI_CLI_PATH
    else process.env.PI_CLI_PATH = original
  }
})


test('Prophey side chats propagate prompt errors and delete forks through transcript storage', async () => {
  const fakeProvider = path.join(temp, 'provider.mjs')
  fs.writeFileSync(fakeProvider, 'export async function getRuntime(){return {}}; export async function listModelChoices(){return []}')
  const source = fs.readFileSync(path.join(root, 'apps/desktop/src/main/agent/prophey-engine.ts'), 'utf8')
    .replace("from '../providers'", 'from ' + JSON.stringify(fakeProvider.replaceAll('\\', '/')))
  esbuild.buildSync({ stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'apps/desktop/src/main/agent') }, outfile: path.join(temp, 'prophey-engine.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  const { PropheyEngine } = require(path.join(temp, 'prophey-engine.cjs'))
  let release, removed
  const store = { pathFor: id => path.join(temp, id + '.jsonl'), remove: async id => { removed = id; await new Promise(resolve => { release = resolve }) } }
  const engine = new PropheyEngine({ onStatus() {}, onEvent() {}, onSettled() {}, transcripts: store })
  engine.options.autoCompact = () => ({ enabled: true, percent: 0.1 })
  engine.model = { contextWindow: 1_000_000 }
  const transcript = [{ role: 'user', content: '' }]
  // The estimator counts what a message sends (its text), not the JSON around it: ~4 characters a token.
  transcript[0].content = 'x'.repeat(3996)
  engine.transcript = transcript
  assert.equal(engine.shouldCompact(), false, '999 tokens must remain below the 1000-token threshold')
  transcript[0].content = 'x'.repeat(4000)
  assert.equal(engine.shouldCompact(), true, '0.1% of 1M must compact at 1000 tokens')
  engine.sessionId = 'original'
  engine.prompt = async () => ({ ok: false, error: 'provider unavailable' })
  await assert.rejects(engine.send('side question'), /provider unavailable/)
  await assert.rejects(engine.discardSession(store.pathFor('original')), /不能删除当前/)
  await assert.rejects(engine.discardSession(path.join(temp, 'outside', 'fork.jsonl')), /无法识别/)
  let completed = false
  const deleting = engine.discardSession(store.pathFor('fork')).then(() => { completed = true })
  assert.equal(removed, 'fork')
  assert.equal(completed, false)
  release()
  await deleting
})
