const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-own-workers-'))
const root = path.resolve(__dirname, '..')
const sourceDir = path.join(root, 'apps/desktop/src/main')
const provider = path.join(temp, 'providers.mjs')
fs.writeFileSync(provider, `
const model = { id: 'test', provider: 'mock', contextWindow: 32000, api: 'mock', reasoning: true };
export async function listModelChoices() { return [{ id: 'test', provider: 'mock' }, { id: 'plain', provider: 'mock' }, { id: 'deepseek-flash', provider: 'deepseek' }] }
export async function thinkingLevelsFor(model) { return model.reasoning ? ['off', 'low', 'high'] : ['off'] }
export async function getRuntime() { return {
  getModel(_provider, id) { return id === 'deepseek-flash' ? { ...model, id, provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' } : id === 'plain' ? { ...model, id, reasoning: false } : model },
  async *streamSimple(_model, context, options) {
    globalThis.__propheyTestReasoning = options.reasoning;
    await new Promise(resolve => setTimeout(resolve, 80));
    options.signal?.throwIfAborted();
    const last = context.messages.at(-1);
    let content;
    if (last.role === 'toolResult') content = [{ type: 'text', text: last.content.map(c => c.text || '').join('') }];
    else if (last.customType) content = [{ type: 'text', text: 'notice received' }];
    else content = [{ type: 'toolCall', id: 'read-1', name: 'read_file', arguments: { path: 'proof.txt' } }];
    yield { type: 'done', message: { role: 'assistant', content } };
  }
} }
`)
const engineSource = fs.readFileSync(path.join(sourceDir, 'agent/prophey-engine.ts'), 'utf8')
  .replace("from '../providers'", 'from ' + JSON.stringify(provider.replaceAll('\\', '/')))
esbuild.buildSync({ stdin: { contents: engineSource, loader: 'ts', resolveDir: path.join(sourceDir, 'agent') }, outfile: path.join(temp, 'engine.cjs'), bundle: true, platform: 'node', packages: 'external', format: 'cjs' })
for (const name of ['subagents', 'api', 'transcript-store']) esbuild.buildSync({ entryPoints: [path.join(sourceDir, name + '.ts')], outfile: path.join(temp, name + '.cjs'), bundle: true, platform: 'node', packages: 'external', format: 'cjs' })
const { PropheyEngine } = require(path.join(temp, 'engine.cjs'))
const { SubagentManager } = require(path.join(temp, 'subagents.cjs'))
const { createApiHandler } = require(path.join(temp, 'api.cjs'))
const managers = []
after(async () => {
  for (const manager of managers) manager.stopAll(true)
  await new Promise(resolve => setTimeout(resolve, 900))
  fs.rmSync(temp, { recursive: true, force: true })
})

function managerWithOwnWorker(notices = []) {
  const manager = new SubagentManager({
    userData: path.join(temp, 'data-' + managers.length),
    onSettle: record => notices.push(record.id),
    createOwnEngine: ({ tools, appendSystemPrompt, onEvent, onStatus }) => new PropheyEngine({
      onStatus: onStatus ?? (() => {}), onEvent, onSettled() {}, allowedTools: tools, appendSystemPrompt,
      toolModulePath: path.join(root, 'packages/mcp-core/tools/workspace.mjs')
    })
  })
  managers.push(manager)
  return manager
}

test('Prophey workers use independent native loops and root contexts, without pi processes', async () => {
  const notices = [], manager = managerWithOwnWorker(notices)
  const dirs = ['alpha', 'beta'].map(name => {
    const dir = path.join(temp, name)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'proof.txt'), name + ' only')
    return dir
  })
  const before = process.env.AGENT_DESKTOP_ROOTS
  const started = await Promise.all(dirs.map(cwd => manager.start({ engine: 'prophey', cwd, task: 'read the proof', provider: 'mock', model: 'test', tools: ['read'], mode: 'background' })))
  for (const [index, result] of started.entries()) {
    assert.equal(result.record.engine, 'prophey')
    assert.equal(manager.items.get(result.record.id).rpc, undefined)
    const done = await manager.wait(result.record.id, 3000)
    assert.equal(done.timedOut, false)
    assert.equal(done.record.status, 'idle')
    assert(done.record.finalText.includes(index === 0 ? 'alpha only' : 'beta only'))
    // The worker writes its own request, so it can measure its own context: the panel shows it.
    assert.equal(done.record.contextUsage?.contextWindow, 32000)
    assert((done.record.contextUsage?.tokens ?? 0) > 0, 'the worker reports how full its request is')
    assert(typeof done.record.contextUsage?.percent === 'number')
    assert.equal(notices.filter(id => id === result.record.id).length, 1)
  }
  assert.equal(process.env.AGENT_DESKTOP_ROOTS, before)
})

test('unsupported Prophey worker options fail explicitly rather than falling back to pi', async () => {
  const manager = managerWithOwnWorker()
  await assert.rejects(manager.start({ engine: 'prophey', task: 'task', desktopTools: true }), /暂不接入桌面 MCP/)
  await assert.rejects(manager.start({ engine: 'prophey', task: 'task', thinking: 'unsupported' }), /不支持思考等级/)
  await assert.rejects(manager.start({ engine: 'prophey', task: 'task', preset: { model: { provider: 'mock', id: 'test', thinking: 'max' } } }), /不支持思考等级/)
})

test('Prophey tool allowlists expose background controls only with bash and reject unsupported tools on every turn', async () => {
  const engine = new PropheyEngine({ onStatus() {}, onEvent() {}, onSettled() {},
    allowedTools: ['bash'], toolModulePath: path.join(root, 'packages/mcp-core/tools/workspace.mjs') })
  await engine.start(temp)
  const tools = await engine.toolSet()
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['read_bash_task', 'run_bash', 'stop_bash_task', 'workspace_roots'])
  assert(tools.find(tool => tool.name === 'run_bash').parameters.properties.run_in_background)
  engine.dispose()
  const bad = new PropheyEngine({ onStatus() {}, onEvent() {}, onSettled() {},
    allowedTools: ['unsupported_tool'], toolModulePath: path.join(root, 'packages/mcp-core/tools/workspace.mjs') })
  await bad.start(temp)
  for (let i = 0; i < 2; i++) assert.equal((await bad.prompt('test')).ok, false)
  bad.dispose()
})

test('stopping an own worker cancels its engine and releases waiters', async () => {
  const manager = managerWithOwnWorker()
  const { record } = await manager.start({ engine: 'prophey', task: 'read', cwd: temp, mode: 'background' })
  const waiting = manager.wait(record.id, 3000)
  await manager.stop(record.id)
  assert.equal((await waiting).record.status, 'stopped')
  assert.equal(manager.items.get(record.id).own.state().phase, 'stopped')
})

test('interrupting an own worker only notifies for the replacement turn', async () => {
  const notices = [], manager = managerWithOwnWorker(notices)
  fs.writeFileSync(path.join(temp, 'proof.txt'), 'replacement turn proof')
  const { record } = await manager.start({ engine: 'prophey', task: 'old', cwd: temp, mode: 'background' })
  await manager.prompt(record.id, 'replacement', 'interrupt')
  const finished = await manager.wait(record.id, 3000)
  assert.equal(finished.record.status, 'idle')
  assert(finished.record.finalText.includes('replacement turn proof'))
  assert.equal(notices.length, 1)
})

test('native engine subagent calls are rejected; managed calls preserve the parent engine and workspace', async () => {
  let selected = 'claude', options
  const api = createApiHandler({
    engine: () => selected,
    agentSettings: () => ({ presets: [] }),
    subagents: () => ({ async start(value) { options = value; return { record: { id: 'test' }, resolved: {}, timedOut: false } } }),
    listModels: async () => [], defaultMode: () => 'background', desktopTools: () => false,
    parentSession: () => 'parent', parentWorkspace: () => ({ primary: temp, additional: [root] }),
    parentModel: () => ({ provider: 'mock', id: 'test' })
  })
  const request = { method: 'POST', path: '/subagents', query: new URLSearchParams(), body: { task: 'proof' } }
  for (const engine of ['claude', 'codex']) {
    selected = engine
    assert.equal((await api(request)).body.code, 'NATIVE_SUBAGENTS')
  }
  for (const engine of ['prophey', 'pi']) {
    selected = engine
    assert.equal((await api(request)).body.ok, true)
    assert.equal(options.engine, engine)
    assert.equal(options.cwd, temp)
    assert.deepEqual(options.additional, [root])
    assert.equal(options.model, 'test')
  }
})

test('a Prophey background notice can wake the parent without becoming a user request in the UI', async () => {
  const events = []
  const engine = new PropheyEngine({ onStatus() {}, onEvent: event => events.push(event), onSettled() {} })
  await engine.start(temp)
  engine.notify('Child task finished.', true)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert((await engine.messages()).some(message => message.customType === 'subagent_notice'))
  assert(events.some(event => event.type === 'message_end' && event.message?.role === 'custom'))
  assert(events.some(event => event.type === 'agent_settled'))
  engine.dispose()
})

test('Prophey continues beyond 16 tool rounds until a final response', async () => {
  const events = []
  const engine = new PropheyEngine({ onStatus() {}, onEvent: event => events.push(event), onSettled() {} })
  await engine.start(temp)
  let count = 0
  engine.streamRoundWithRetry = async () => ({ ok: true, message: { role: 'assistant', content:
    ++count <= 24 ? [{ type: 'toolCall', id: String(count), name: 'probe', arguments: {} }] : [{ type: 'text', text: 'finished' }] } })
  const result = await engine.prompt('complete all steps')
  assert.equal(result.ok, true)
  assert.equal(count, 25)
  assert.equal(events.filter(event => event.type === 'agent_settled').length, 1)
  assert.equal(engine.busy(), false)
  engine.dispose()
})

test('model choices and thinking levels are validated, sent to the SDK, and restored', async () => {
  const { TranscriptStore } = require(path.join(temp, 'transcript-store.cjs'))
  const transcripts = new TranscriptStore(path.join(temp, 'thinking-transcripts'))
  const options = { onStatus() {}, onEvent() {}, onSettled() {}, transcripts, sessionId: () => 'thinking' }
  const engine = new PropheyEngine(options)
  await engine.start(temp)
  await assert.rejects(engine.setModel('random', 'unknown'), /未在服务商/)
  assert.deepEqual(await engine.thinkingLevels(), ['off', 'low', 'high'])
  await assert.rejects(engine.setThinkingLevel('max'), /不支持/)
  await engine.setThinkingLevel('high')
  // The mock model asks for a tool then answers; no real model is contacted.
  await engine.prompt('test reasoning')
  assert.equal(globalThis.__propheyTestReasoning, 'high')
  await transcripts.load('thinking')
  engine.dispose()
  const restored = new PropheyEngine(options)
  await restored.start(temp)
  assert.equal(restored.state().thinkingLevel, 'high')
  await restored.setModel('mock', 'plain')
  assert.deepEqual(await restored.thinkingLevels(), ['off'])
  assert.equal(restored.state().thinkingLevel, 'off')
  restored.dispose()
})

test('official DeepSeek defaults to high and preserves a saved explicit choice', async () => {
  const { TranscriptStore } = require(path.join(temp, 'transcript-store.cjs'))
  const transcripts = new TranscriptStore(path.join(temp, 'deepseek-default'))
  const options = { onStatus() {}, onEvent() {}, onSettled() {}, transcripts, sessionId: () => 'deepseek' }
  const engine = new PropheyEngine(options)
  await engine.start(temp)
  await engine.setModel('deepseek', 'deepseek-flash')
  assert.equal(engine.state().thinkingLevel, 'high')
  await engine.setThinkingLevel('low')
  await engine.setModel('deepseek', 'deepseek-flash')
  assert.equal(engine.state().thinkingLevel, 'low')
  await transcripts.load('deepseek')
  engine.dispose()
  const restored = new PropheyEngine(options)
  await restored.start(temp)
  assert.equal(restored.state().thinkingLevel, 'low')
  restored.dispose()
  const fresh = new PropheyEngine({ onStatus() {}, onEvent() {}, onSettled() {} })
  await fresh.start(temp, { model: { provider: 'deepseek', id: 'deepseek-flash' } })
  assert.equal(fresh.state().thinkingLevel, 'high')
  fresh.dispose()
})
