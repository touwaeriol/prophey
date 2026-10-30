const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-subagent-progress-'))
const sourceDir = path.resolve(__dirname, '../apps/desktop/src/main')
esbuild.buildSync({
  entryPoints: [path.join(sourceDir, 'subagents.ts')],
  outfile: path.join(temp, 'subagents.cjs'),
  bundle: true,
  platform: 'node',
  packages: 'external',
  format: 'cjs'
})
const { SubagentManager } = require(path.join(temp, 'subagents.cjs'))
const managers = []
after(async () => {
  for (const manager of managers) manager.stopAll(true)
  await new Promise(resolve => setTimeout(resolve, 300))
  fs.rmSync(temp, { recursive: true, force: true })
})

/** A stand-in own engine: the test drives its events by hand. */
function fakeEngine() {
  return {
    state: () => ({
      phase: 'ready',
      model: { provider: 'mock', id: 'test' },
      sessionFile: path.join(temp, 'fake.jsonl')
    }),
    async start() {},
    async setThinkingLevel() {},
    busy: () => false,
    prompt: () => new Promise(() => {}),
    messages: async () => [],
    stats: async () => ({ tokens: { total: 0 } }),
    async abort() {},
    dispose() {}
  }
}

async function startedManager() {
  const updates = []
  let emit
  let status
  const manager = new SubagentManager({
    userData: path.join(temp, 'data-' + managers.length),
    onUpdate: record => updates.push(record),
    createOwnEngine: ({ onEvent, onStatus }) => {
      emit = onEvent
      status = onStatus
      return fakeEngine()
    }
  })
  managers.push(manager)
  const { record } = await manager.start({
    engine: 'prophey',
    task: 'inspect the drawer',
    cwd: temp,
    mode: 'background'
  })
  return {
    manager,
    record,
    updates,
    emit: event => emit(event),
    status: patch => status?.({ phase: 'ready', cwd: temp, ...patch })
  }
}

test('streaming deltas and in-flight tool calls are visible before the turn settles', async () => {
  const { record, emit, updates } = await startedManager()
  emit({ type: 'agent_start' })
  emit({ type: 'message_start', message: { role: 'assistant' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '先看结构' } })
  const beforeDeltas = updates.length
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '读取 ' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'AGENTS.md' } })
  assert.equal(record.draft.text, '读取 AGENTS.md')
  assert.equal(record.draft.thinking, '先看结构')
  // Three deltas must not produce three IPC updates: the trailing emit is coalesced.
  assert(updates.length - beforeDeltas <= 2)

  emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read_file', args: { path: 'AGENTS.md' } })
  assert.equal(record.activeCalls.length, 1)
  assert.deepEqual(
    { tool: record.activeCalls[0].tool, target: record.activeCalls[0].target },
    { tool: 'read_file', target: 'AGENTS.md' }
  )
  assert(updates[updates.length - 1].activeCalls.length === 1)

  emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read_file', durationMs: 42, result: { isError: false } })
  assert.equal(record.activeCalls.length, 0)
  assert.equal(record.calls.length, 1)
  assert.equal(record.calls[0].summary, 'AGENTS.md')
  assert.equal(record.calls[0].durationMs, 42)
  assert.equal(record.calls[0].ok, true)

  emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '读取 AGENTS.md' }], timestamp: Date.now() }
  })
  assert.equal(record.draft, undefined)
  assert.equal(record.messages.length, 1)
  assert.equal(record.messages[0].text, '读取 AGENTS.md')
})

test('the run\'s own context meter reaches the record while the turn is still streaming', async () => {
  const { record, status, updates } = await startedManager()
  const before = updates.length
  status({ contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 } })
  assert.deepEqual(record.contextUsage, { tokens: 12000, contextWindow: 200000, percent: 6 })
  assert.equal(updates.length, before + 1, 'a meter change has to reach the window')
  // The engine republishes on every status patch; an unchanged meter must not repaint.
  status({ isStreaming: true })
  status({ contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 } })
  assert.equal(updates.length, before + 1)
  status({ contextUsage: { tokens: 34000, contextWindow: 200000, percent: 17 } })
  assert.equal(record.contextUsage.tokens, 34000)
  assert.equal(updates.length, before + 2)
})

test('a settled turn clears the live draft and keeps the transcript', async () => {
  const { record, emit, manager } = await startedManager()
  emit({ type: 'agent_start' })
  emit({ type: 'message_start', message: { role: 'assistant' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } })
  emit({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'npm test' } })
  emit({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', durationMs: 1200 })
  emit({ type: 'agent_settled' })
  await manager.wait(record.id, 3000)
  assert.equal(record.status, 'idle')
  assert.equal(record.draft, undefined)
  assert.equal(record.activeCalls.length, 0)
  assert.equal(record.calls.length, 1)
  assert.equal(record.calls[0].summary, 'npm test')
  // Collecting the transcript must not drop the meter the engine published during the turn.
  assert.equal(record.contextUsage?.tokens ?? 0, 0)
})

test('stopping a run drops its live progress instead of leaving it streaming', async () => {
  const { record, emit, manager } = await startedManager()
  emit({ type: 'agent_start' })
  emit({ type: 'message_start', message: { role: 'assistant' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'half a sentence' } })
  emit({ type: 'tool_execution_start', toolCallId: 't3', toolName: 'read_file', args: { path: 'b.md' } })
  await manager.stop(record.id)
  assert.equal(record.status, 'stopped')
  assert.equal(record.draft, undefined)
  assert.equal(record.activeCalls.length, 0)
})

test('restored records carry no live progress', async () => {
  const userData = path.join(temp, 'restore')
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(userData, 'subagents.json'), JSON.stringify({
    version: 1,
    records: [{
      id: 'sa_restored',
      engine: 'prophey',
      mode: 'background',
      cwd: temp,
      status: 'streaming',
      createdAt: Date.now(),
      notify: 'none',
      timeoutMs: 1000,
      messages: [],
      calls: [],
      draft: { text: 'stale', thinking: '', ts: Date.now() },
      activeCalls: [{ id: 'x', tool: 'read_file', startedAt: Date.now() }]
    }]
  }))
  const manager = new SubagentManager({ userData })
  managers.push(manager)
  const record = manager.get('sa_restored')
  assert.equal(record.status, 'stopped')
  assert.equal(record.restored, true)
  assert.equal(record.draft, undefined)
  assert.deepEqual(record.activeCalls, [])
})
