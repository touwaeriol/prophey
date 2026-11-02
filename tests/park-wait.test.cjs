/**
 * Parking instead of blocking.
 *
 * A wait that blocks inside the tool call keeps the round open, so nothing but the timeout can
 * reach the model again. These tests pin the replacement: the tool returns a `deferred` marker, the
 * round settles with the tool result still adjacent to its call, the status says "waiting", and the
 * completion notice is what opens the next turn.
 */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-park-'))
const shell = process.platform === 'win32' ? 'bash' : 'bash'

/** A provider that parks once and then answers; every call is counted. */
const provider = path.join(temp, 'providers.mjs')
fs.writeFileSync(
  provider,
  `
const model = { id: 'test', provider: 'mock', contextWindow: 32000, api: 'mock' }
export async function listModelChoices() { return [{ id: 'test', provider: 'mock' }] }
export async function thinkingLevelsFor() { return ['off'] }
export async function getRuntime() { return {
  getModel() { return model },
  async *streamSimple(_model, context) {
    globalThis.__calls = (globalThis.__calls ?? 0) + 1
    const last = context.messages.at(-1)
    const content = last.role === 'toolResult' || last.customType
      ? [{ type: 'text', text: last.customType ? 'notice received' : 'done' }]
      : [{ type: 'toolCall', id: 'wait-1', name: 'wait_tool', arguments: {} }]
    yield { type: 'done', message: { role: 'assistant', content } }
  }
} }
`
)

/** Workspace module with one tool that always parks. */
const tools = path.join(temp, 'tools.mjs')
fs.writeFileSync(
  tools,
  `
const read = { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} },
  call: async () => ({ content: [{ type: 'text', text: 'file' }] }) }
const wait = { name: 'wait_tool', description: 'park', inputSchema: { type: 'object', properties: {} },
  call: async () => ({
    content: [{ type: 'text', text: '已转入后台' }],
    deferred: { kind: 'subagent', keys: ['sa_1'], label: '等待子代理 sa_1' }
  }) }
export const workspaceTools = [read, wait]
`
)

const engineSource = fs
  .readFileSync(path.join(root, 'apps/desktop/src/main/agent/prophey-engine.ts'), 'utf8')
  .replace("from '../providers'", 'from ' + JSON.stringify(provider.replaceAll('\\', '/')))
esbuild.buildSync({
  stdin: { contents: engineSource, loader: 'ts', resolveDir: path.join(root, 'apps/desktop/src/main/agent') },
  outfile: path.join(temp, 'engine.cjs'), bundle: true, platform: 'node', packages: 'external', format: 'cjs'
})
esbuild.buildSync({
  entryPoints: [path.join(root, 'apps/desktop/src/main/agent/bash-tasks.ts')],
  outfile: path.join(temp, 'tasks.cjs'), bundle: true, platform: 'node', format: 'cjs'
})
const { PropheyEngine } = require(path.join(temp, 'engine.cjs'))
const { BashTasks } = require(path.join(temp, 'tasks.cjs'))
const engines = []
after(async () => {
  for (const engine of engines) engine.dispose()
  await new Promise((resolve) => setTimeout(resolve, 300))
  fs.rmSync(temp, { recursive: true, force: true })
})

const until = async (check, label, timeout = 4000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('超时：' + label)
}

function makeEngine() {
  const events = []
  const statuses = []
  const engine = new PropheyEngine({
    onStatus: (status) => statuses.push(status),
    onEvent: (event) => events.push(event),
    onSettled() {},
    toolModulePath: tools,
    bashLogDirectory: path.join(temp, 'logs')
  })
  engines.push(engine)
  return { engine, events, statuses }
}

test('a deferred tool result settles the round and the notice opens the next one', async () => {
  globalThis.__calls = 0
  const { engine, events, statuses } = makeEngine()
  await engine.start(temp)
  await engine.prompt('go')
  await until(() => !engine.busy(), '回合结束')

  // The tool result arrived, the round is over, and no extra model call was spent on it.
  assert.equal(globalThis.__calls, 1)
  assert(events.some((event) => event.type === 'agent_settled'))
  assert.equal(statuses.at(-1).waiting.kind, 'subagent')
  assert.equal(statuses.at(-1).isStreaming, false)

  // The result still sits directly after its call, which is the order providers require.
  const messages = await engine.messages()
  const call = messages.findIndex((message) => message.role === 'assistant')
  assert.equal(messages[call + 1].role, 'toolResult')
  assert.equal(messages[call + 1].toolCallId, 'wait-1')
  assert.equal(messages.at(-1).role, 'toolResult')

  // The completion wakes a fresh turn, which clears `waiting` and appends after the result.
  engine.notify('子代理 sa_1 idle', true)
  await until(() => globalThis.__calls === 2, '唤醒新回合')
  await until(() => !engine.busy(), '唤醒回合结束')
  assert.equal(statuses.at(-1).waiting, undefined)
  const after = await engine.messages()
  assert.equal(after.at(-2).customType, 'subagent_notice')
  assert.match(String(after.at(-1).content[0].text), /notice received/)
})

test('abort keeps the park alive so the completion can still wake the session', async () => {
  globalThis.__calls = 0
  const { engine, statuses } = makeEngine()
  await engine.start(temp)
  await engine.prompt('go')
  await until(() => statuses.at(-1).waiting !== undefined, '进入等待')
  // Stopping the round is not stopping the work: the park and its timer survive.
  await engine.abort()
  assert.equal(statuses.at(-1).waiting.kind, 'subagent')
  engine.notify('子代理 sa_1 idle', true)
  await until(() => globalThis.__calls === 2, '停过之后仍然被唤醒')
  await until(() => statuses.at(-1).waiting === undefined, '等待清掉')
})

test('reading a running command with wait_ms parks instead of blocking', async () => {
  const notices = []
  const tasks = new BashTasks({ directory: temp, shell, notify: (text) => notices.push(text) })
  try {
    const started = await tasks.run({ cwd: temp, command: 'sleep 0.4; printf late', yield_time_ms: 10 })
    const id = started.content[0].text.match(/^bash_[\w-]+/)[0]
    assert.ok(started.deferred, '跑着的命令立刻返回挂起标记')
    assert.deepEqual(started.deferred.keys, [id])

    // A second read parks again rather than waiting out the command.
    const started2 = Date.now()
    const again = await tasks.read({ task_id: id, wait_ms: 60000 })
    assert.ok(Date.now() - started2 < 300)
    assert.ok(again.deferred)
    assert.match(again.content.at(-1).text, /仍在运行/)

    await tasks.tasks.get(id).done
    // Once finished, a wait read answers inline and has no deferred marker.
    const finished = await tasks.read({ task_id: id, wait_ms: 60000 })
    assert.equal(finished.deferred, undefined)
    assert.match(finished.content[0].text, /completed/)
  } finally {
    tasks.dispose()
  }
})

test('stopping a parked command notifies, so the parked turn is not left hanging', async () => {
  const notices = []
  const tasks = new BashTasks({ directory: temp, shell, notify: (text) => notices.push(text) })
  try {
    const started = await tasks.run({ cwd: temp, command: 'sleep 5', yield_time_ms: 10 })
    const id = started.content[0].text.match(/^bash_[\w-]+/)[0]
    await tasks.read({ task_id: id, wait_ms: 60000 })
    await tasks.stop(id)
    assert.equal(notices.length, 1)
    assert.match(notices[0], /手动停止/)
  } finally {
    tasks.dispose()
  }
})

test('wait_subagent parks on a running subagent and answers inline on a finished one', async () => {
  const { waitSubagent } = await import(pathToFileURL(path.join(root, 'packages/mcp-core/tools/subagent.mjs')).href)
  const calls = []
  const running = { id: 'sa_1', status: 'streaming', calls: [], messages: [] }
  const context = {
    async request(method, pathname) {
      calls.push(`${method} ${pathname}`)
      const subagent = pathname.includes('sa_1') ? { ...running } : { ...running, status: 'idle', finalText: '结论' }
      return { ok: true, subagent }
    }
  }
  const parked = await waitSubagent.call({ id: 'sa_1' }, context)
  assert.equal(parked.deferred.kind, 'subagent')
  assert.deepEqual(parked.deferred.keys, ['sa_1'])
  assert.match(parked.content[0].text, /仍在运行/)
  // No blocking endpoint is hit any more.
  assert(!calls.some((call) => call.endsWith('/wait')))

  const finished = await waitSubagent.call({ id: 'sa_done' }, context)
  assert.equal(finished.deferred, undefined)
  assert.match(finished.content[0].text, /结论/)
})
