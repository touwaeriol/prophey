const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-engine-tests-'))
const root = path.resolve(__dirname, '..')
const sources = ['shared/engine', 'main/session-store', 'main/agent/codex-engine', 'main/agent/claude-engine', 'main/agent/json-rpc-process', 'main/agent/switch-guard']
for (const file of sources) esbuild.buildSync({ entryPoints: [path.join(root, 'apps/desktop/src', file + '.ts')], outfile: path.join(temp, path.basename(file) + '.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const fakeProvider=path.join(temp,'provider.mjs')
fs.writeFileSync(fakeProvider,'export async function getRuntime(){return {}}; export async function listModelChoices(){return []}')
const propheySource=fs.readFileSync(path.join(root,'apps/desktop/src/main/agent/prophey-engine.ts'),'utf8').replace("from '../providers'", "from " + JSON.stringify(fakeProvider.replaceAll('\\','/')))
esbuild.buildSync({ stdin: { contents: propheySource, loader: 'ts', resolveDir: path.join(root,'apps/desktop/src/main/agent') }, outfile: path.join(temp,'prophey-engine.cjs'), bundle:true, platform:'node', format:'cjs', packages:'external' })

const { engineCapabilities, engineCommands, isNativeSessionReference } = require(path.join(temp, 'engine.cjs'))
const { CodexEngine } = require(path.join(temp, 'codex-engine.cjs'))
const { ClaudeCodeEngine } = require(path.join(temp, 'claude-engine.cjs'))
const { SessionStore, toSummary } = require(path.join(temp, 'session-store.cjs'))
const { JsonRpcProcess } = require(path.join(temp, 'json-rpc-process.cjs'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))
const callbacks = (events = []) => ({ onStatus() {}, onEvent(e) { events.push(e) }, onSettled() {} })
function codex(events = []) {
  const engine = new CodexEngine({ ...callbacks(events), binary: process.execPath })
  engine.connected = true; engine.threadId = 'test-thread'; engine.setStatus({ phase: 'ready' })
  return engine
}
for (const id of ['pi', 'prophey', 'claude', 'codex']) test(id + ': command catalogue matches capability ownership', () => {
  const caps = engineCapabilities(id), commands = engineCommands(caps)
  assert.equal(commands.some(c => c.name === '/compact'), caps.compact)
  assert.equal(commands.some(c => c.name === '/autocompact'), caps.autoCompaction === 'configurable')
  assert.equal(commands.some(c => c.name === '/mcp'), caps.mcp === 'managed')
  assert.equal(commands.some(c => c.name === '/thinking'), caps.thinking)
  assert.equal(new Set(commands.map(c => c.name)).size, commands.length)
  const native = engineCommands(caps, [{ name: '/model', action: 'native' }, { name: '/review', action: 'native' }])
  assert.equal(native.filter(c => c.name === '/model').length, 1)
  assert.equal(native.find(c => c.name === '/model').action, 'model')
  assert.equal(native.find(c => c.name === '/review').action, 'native')
})
test('Codex: images are sent on the wire and turns wait for completion', async () => {
  const e = codex(), calls = []
  e.rpc.request = async (method, params) => { calls.push({ method, params }); return { turn: { id: 'turn-1' } } }
  let finished = false
  const prompt = e.prompt('image', { images: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] }).then(r => { finished = true; return r })
  await new Promise(r => setImmediate(r))
  assert.equal(e.busy(), true); assert.equal(finished, false)
  assert.deepEqual(calls[0].params.input[1], { type: 'image', url: 'data:image/png;base64,aGVsbG8=' })
  e.handle('turn/completed', { threadId: 'another-thread', turn: {} }); assert.equal(e.busy(), true)
  e.handle('turn/completed', { threadId: 'test-thread', turn: { status: 'completed' } })
  assert.equal((await prompt).ok, true); assert.equal(e.busy(), false)
})
test('Codex: compaction acknowledgement does not mean compaction finished', async () => {
  const events = [], e = codex(events)
  e.rpc.request = async () => ({})
  e.readHistory = async () => {}
  const compact = e.compact()
  await new Promise(r => setImmediate(r))
  assert.equal(e.compacting(), true)
  e.handle('item/completed', { threadId: 'test-thread', item: { type: 'contextCompaction', id: 'compact' } })
  assert.equal(e.busy(), true)
  e.handle('turn/completed', { threadId: 'test-thread', turn: { status: 'completed' } })
  await compact
  assert.equal(e.busy(), false)
  assert(events.some(e => e.type === 'agent_settled'))
  await assert.rejects(e.compact('unsupported instructions'), /不接受/)
})
test('Codex: failure and stop settle the pending caller', async () => {
  for (const stop of [false, true]) {
    const e = codex(); e.rpc.request = async () => ({ turn: { id: 'turn-1' } }); e.rpc.stop = () => {}
    const pending = e.prompt('hello')
    await new Promise(r => setImmediate(r))
    if (stop) e.stop(); else e.handle('error', { threadId: 'test-thread', willRetry: false, error: { message: 'test failure' } })
    assert.equal((await pending).ok, false); assert.equal(e.busy(), false)
  }
})
test('Codex: steering has an active-turn precondition', async () => {
  const e = codex(); e.active = true; e.turnId = 'active'; let call
  e.rpc.request = async (method, params) => { call = { method, params }; return {} }
  assert.equal((await e.prompt('steer', { behavior: 'steer' })).ok, true)
  assert.equal(call.method, 'turn/steer'); assert.equal(call.params.expectedTurnId, 'active')
  assert.equal((await e.prompt('normal')).ok, false)
})
test('Codex: older servers restore history without pagination', async () => {
  const e = codex()
  e.rpc.request = async (method) => {
    if (method === 'thread/items/list') throw new Error('thread/items/list is not supported yet')
    assert.equal(method, 'thread/read')
    return { thread: { turns: [{ items: [{ type: 'agentMessage', id: 'a', text: 'restored' }] }] } }
  }
  await e.readHistory(); assert.equal(await e.lastAssistantText(), 'restored')
})
test('Claude: tool start and end share the real tool-use ID', async () => {
  const events = [], e = new ClaudeCodeEngine({ ...callbacks(events), binary: 'unused' })
  e.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'real-id', name: 'Read', input: { file_path: 'a' } }] } })
  e.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'real-id', content: 'ok' }] } })
  const tools = events.filter(e => e.type.startsWith('tool_execution_'))
  assert.deepEqual(tools.map(e => e.toolCallId), ['real-id', 'real-id'])
  assert.deepEqual(tools.map(e => e.toolName), ['Read', 'Read'])
})
test('native auto-compaction cannot report a fake configurable success', async () => {
  for (const e of [codex(), new ClaudeCodeEngine({ ...callbacks(), binary: 'unused' })]) await assert.rejects(e.setAutoCompaction({ enabled: false }), /原生管理/)
})
test('session store retains engine identity and opaque native references', async () => {
  const file = path.join(temp, 'sessions.json'), store = new SessionStore(file)
  await store.upsert({ engine: 'claude', path: 'claude:abc-123', cwd: root })
  await store.upsert({ engine: 'codex', path: 'codex:def-456', cwd: root })
  await store.upsert({ engine: 'pi', path: path.join(temp, 'missing.jsonl'), cwd: root })
  await store.prune(ref => !isNativeSessionReference(ref) && !fs.existsSync(ref))
  const restored = new SessionStore(file); await restored.load()
  assert.deepEqual(restored.list().map(r => r.engine).sort(), ['claude', 'codex'])
})

test('session engine changes preserve sidebar identity and do not change neighboring sessions', async () => {
  const file = path.join(temp, 'session-engine-identity.json'), store = new SessionStore(file)
  const first = await store.upsert({ engine: 'prophey', path: path.join(temp, 'first.jsonl'), cwd: root, title: 'First' })
  const second = await store.upsert({ engine: 'pi', path: path.join(temp, 'second.jsonl'), cwd: root, title: 'Second' })
  const key = toSummary(first).path
  await store.upsert({ id: first.id, engine: 'claude', path: 'claude:switched' }, true)
  const restored = new SessionStore(file)
  await restored.load()
  assert.equal(restored.list().length, 2)
  assert.equal(toSummary(restored.get(first.id)).path, key)
  assert.equal(restored.byPath(key).path, 'claude:switched')
  assert.equal(restored.byPath('claude:switched').id, first.id)
  assert.equal(toSummary(restored.get(first.id)).engine, 'claude')
  assert.equal(restored.get(first.id).title, 'First')
  assert.deepEqual(restored.get(second.id), second)
})
test('JSON-RPC requests fail promptly when a process exits', async () => {
  const rpc = new JsonRpcProcess(() => {}, async () => ({}), () => {})
  rpc.start(process.execPath, ['-e', 'process.exit(0)'], temp)
  await assert.rejects(rpc.request('pending', {}, 5000), /连接关闭/)
  rpc.stop()
})

test('Claude: images use the native content format', async () => {
  const e = new ClaudeCodeEngine({ ...callbacks(), binary: 'unused' }); let wire
  e.query = {}; e.input = { push(m) { wire = m; setImmediate(() => e.handle({ type: 'result', subtype: 'success', result: 'ok' })) } }
  const result = await e.prompt('image', { images: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] })
  assert.equal(result.ok, true)
  assert.deepEqual(wire.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } })
})
test('Claude: compact is a native command, and success requires the compact boundary', async () => {
  for (const boundary of [true, false]) {
    const e = new ClaudeCodeEngine({ ...callbacks(), binary: 'unused' }); let wire
    e.sessionId = 'test'; e.query = {}; e.readHistory = async () => {}
    e.input = { push(m) { wire = m; setImmediate(() => {
      if (boundary) e.handle({ type: 'system', subtype: 'compact_boundary' })
      e.handle({ type: 'result', subtype: 'success', result: boundary ? 'compacted' : 'Not enough messages' })
    }) } }
    if (boundary) await e.compact('retain decisions')
    else await assert.rejects(e.compact('retain decisions'), /Not enough/)
    assert.equal(wire.message.content[0].text, '/compact retain decisions')
    assert.equal(e.busy(), false)
  }
})
test('Claude: native compaction failure releases busy state', async () => {
  const e = new ClaudeCodeEngine({ ...callbacks(), binary: 'unused' })
  const waiting = e.begin(true)
  e.handle({ type: 'system', subtype: 'status', compact_result: 'failed', compact_error: 'server refused' })
  await assert.rejects(waiting, /server refused/); assert.equal(e.busy(), false)
})

test('native restored histories preserve tool calls and results', async () => {
 const {normalizeClaudeHistory}=require(path.join(temp,'claude-engine.cjs'))
 const history=normalizeClaudeHistory([
  {type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Read',input:{file_path:'a'}}]}},
  {type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'result'}]}}
 ])
 assert.equal(history[0].content[0].type,'toolCall')
 assert.equal(history[1].role,'toolResult'); assert.equal(history[1].toolCallId,'t1')
 const e=codex();e.applyItem({type:'commandExecution',id:'t2',command:'echo ok',aggregatedOutput:'ok',status:'completed'},false)
 const restored=await e.messages();assert.equal(restored[0].content[0].id,'t2');assert.equal(restored[1].toolCallId,'t2')
})

test('Prophey: stopping cancels the current request before accepting another turn', async () => {
 const {PropheyEngine}=require(path.join(temp,'prophey-engine.cjs'))
 const e=new PropheyEngine(callbacks());e.model={id:'mock',provider:'mock',api:'mock',contextWindow:1000};e.tools=[];e.setStatus({phase:'ready'})
 e.streamRoundWithRetry=async()=>new Promise(resolve=>e.controller.signal.addEventListener('abort',()=>resolve({ok:false,error:'cancelled'}),{once:true}))
 const pending=e.prompt('hello');await new Promise(r=>setImmediate(r));assert(e.busy())
 await assert.rejects(e.setModel('mock','other'), /当前回合结束/)
 await e.abort();assert.equal((await pending).ok,false);assert.equal(e.busy(),false)
 e.streamRoundWithRetry=async()=>({ok:true,message:{role:'assistant',content:[]}})
 assert.equal((await e.prompt('next')).ok,true)
})

test('Prophey: provider reload preserves an unsaved empty session and refreshes its model', async () => {
  const { PropheyEngine } = require(path.join(temp, 'prophey-engine.cjs'))
  const store = { pathFor: id => path.join(temp, id + '.jsonl'), load: async () => undefined }
  const engine = new PropheyEngine({ ...callbacks(), transcripts: store, sessionId: () => 'empty' })
  await engine.start(temp)
  const session = engine.state().sessionFile
  const oldModel = { id: 'model', provider: 'provider', baseUrl: 'https://old.invalid' }
  engine.model = oldModel
  engine.setModel = async (provider, id) => {
    assert.equal(provider, 'provider')
    assert.equal(id, 'model')
    engine.model = { ...oldModel, baseUrl: 'https://new.invalid' }
  }
  await engine.start(temp, { session })
  assert.equal(engine.state().sessionFile, session)
  assert.deepEqual(await engine.messages(), [])
  assert.equal(engine.model.baseUrl, 'https://new.invalid')
  await assert.rejects(engine.start(temp, { session: store.pathFor('missing') }), /会话不存在/)
})

test('Claude: native tools and configured MCPs survive retired desktop tool settings', async () => {
  const sdk = path.join(temp, 'claude-tool-policy-sdk.mjs')
  fs.writeFileSync(sdk, `
    export function query({ options }) {
      globalThis.__claudeToolPolicyOptions = options;
      let close;
      const closed = new Promise(resolve => { close = resolve });
      return {
        supportedModels: async () => [], supportedCommands: async () => [], close,
        async *[Symbol.asyncIterator]() { await closed }
      };
    }
  `)
  const source = fs.readFileSync(path.join(root, 'apps/desktop/src/main/agent/claude-engine.ts'), 'utf8')
    .replaceAll("await import('@anthropic-ai/claude-agent-sdk')", 'await import(' + JSON.stringify(sdk.replaceAll('\\', '/')) + ')')
  const output = path.join(temp, 'claude-tool-policy.cjs')
  esbuild.buildSync({ stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'apps/desktop/src/main/agent') }, outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  const { ClaudeCodeEngine } = require(output)
  let readRetiredSettings = false
  const engine = new ClaudeCodeEngine({
    ...callbacks(), binary: 'unused',
    disabledTools: () => {
      readRetiredSettings = true
      return ['Bash', 'Read', 'Write', 'Edit', 'Task', 'WebSearch', 'WebFetch']
    }
  })
  try {
    await engine.start(temp)
    const options = globalThis.__claudeToolPolicyOptions
    assert.equal(readRetiredSettings, false)
    assert.equal(options.tools, undefined)
    assert.equal(options.disallowedTools, undefined)
    assert.equal(options.mcpServers, undefined, 'do not inject desktop MCP tools')
    assert.equal(options.strictMcpConfig, undefined, 'do not suppress the user’s MCP configuration')
    assert.deepEqual(options.settingSources, ['user', 'project', 'local'])
    assert.equal(typeof options.canUseTool, 'function', 'native approval handling remains intact')
    assert.equal(engine.capabilities().toolPolicy, 'native')
    assert.equal(engine.capabilities().mcp, 'native')
  } finally {
    engine.stop()
    delete globalThis.__claudeToolPolicyOptions
  }
})

test('Codex: the native question tool is switched on per launch, not in the user config', async () => {
  const { codexQuestionArgs } = require(path.join(temp, 'codex-engine.cjs'))
  assert.deepEqual(codexQuestionArgs(false), [])
  assert.deepEqual(codexQuestionArgs(true), [
    '-c', 'tools.experimental_request_user_input.enabled=true',
    '-c', 'features.default_mode_request_user_input=true'
  ])
  for (const [enabled, extra] of [[true, 4], [false, 0]]) {
    const start = [], requests = []
    const engine = new CodexEngine({ ...callbacks(), binary: 'unused', questions: () => enabled })
    engine.rpc.start = (command, args) => start.push(args)
    engine.rpc.request = async (method, params) => {
      requests.push({ method, params })
      if (method === 'model/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread' }, model: 'gpt-test' }
      if (method === 'thread/items/list') return { data: [] }
      return {}
    }
    try {
      await engine.start(temp)
      assert.deepEqual(start[0].slice(0, 3), ['app-server', '--listen', 'stdio://'])
      assert.equal(start[0].length - 3, extra, enabled ? 'flags reach the spawned server' : 'no flags when disabled')
      const initialize = requests.find((entry) => entry.method === 'initialize')
      assert.equal(initialize.params.capabilities.experimentalApi, false, 'no blanket experimental opt-in')
      assert.equal(initialize.params.clientInfo.name, 'prophey')
    } finally {
      engine.stop()
    }
  }
})

test('Codex: request_user_input answers come back keyed by Codex question id', async () => {
  const asked = []
  const engine = new CodexEngine({
    ...callbacks(),
    binary: 'unused',
    ask: async (questions, tool) => {
      asked.push({ questions, tool })
      return {
        cancelled: false,
        answers: [
          { question: '用哪种语言？', selected: ['中文'], other: '' },
          { question: '访问令牌？', selected: [], other: 'sk-test' }
        ]
      }
    }
  })
  engine.threadId = 'thread'
  const params = {
    threadId: 'thread',
    turnId: 'turn',
    itemId: 'item',
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      {
        id: 'output_language', header: '输出语言', question: '用哪种语言？', isOther: true, isSecret: false,
        options: [{ label: '中文', description: '用中文' }, { label: '英文' }]
      },
      { id: 'token', header: '令牌', question: '访问令牌？', isOther: false, isSecret: true, options: null }
    ]
  }
  const result = await engine.rpc.requested('item/tool/requestUserInput', params)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].tool, 'Codex')
  assert.deepEqual(asked[0].questions[0], {
    question: '用哪种语言？',
    header: '输出语言',
    options: [{ label: '中文', description: '用中文' }, { label: '英文', description: undefined }],
    secret: false
  })
  assert.equal(asked[0].questions[1].secret, true, 'isSecret keeps the answer out of the UI summary')
  assert.equal(asked[0].questions[1].options, undefined)
  assert.deepEqual(result, {
    answers: { output_language: { answers: ['中文'] }, token: { answers: ['sk-test'] } }
  })

  const cancelled = new CodexEngine({ ...callbacks(), binary: 'unused', ask: async () => ({ cancelled: true }) })
  cancelled.threadId = 'thread'
  assert.deepEqual(
    await cancelled.rpc.requested('item/tool/requestUserInput', { threadId: 'thread', questions: [{ id: 'q', question: 'q' }] }),
    { answers: { q: { answers: [] } } }
  )
  await assert.rejects(
    cancelled.rpc.requested('item/tool/requestUserInput', { threadId: 'other', questions: [{ id: 'q', question: 'q' }] }),
    /不属于当前会话/
  )
  await assert.rejects(
    cancelled.rpc.requested('item/tool/requestUserInput', { threadId: 'thread', questions: [] }),
    /没有内容/
  )
})

test('Codex: permission requests and unknown methods keep their schema shapes', async () => {
  const allow = new CodexEngine({
    ...callbacks(), binary: 'unused',
    ask: async () => ({ cancelled: false, answers: [{ question: 'x', selected: ['允许本次'] }] })
  })
  allow.threadId = 'thread'
  assert.deepEqual(
    await allow.rpc.requested('item/permissions/requestApproval', {
      threadId: 'thread', permissions: { network: { enabled: true } }
    }),
    { permissions: { network: { enabled: true } }, scope: 'turn' }
  )
  const deny = new CodexEngine({ ...callbacks(), binary: 'unused', ask: async () => ({ cancelled: true }) })
  deny.threadId = 'thread'
  assert.deepEqual(
    await deny.rpc.requested('item/permissions/requestApproval', { threadId: 'thread', permissions: {} }),
    { permissions: {}, scope: 'turn' }
  )
  const command = new CodexEngine({ ...callbacks(), binary: 'unused' })
  command.threadId = 'thread'
  assert.deepEqual(
    await command.rpc.requested('item/commandExecution/requestApproval', { threadId: 'thread', command: 'ls' }),
    { decision: 'decline' },
    'no interactive surface means no approval'
  )
  assert.deepEqual(
    await deny.rpc.requested('item/tool/call', { threadId: 'thread', tool: 'desktop_echo' }),
    { success: false, contentItems: [{ type: 'inputText', text: '桌面端没有注册动态工具 desktop_echo' }] }
  )
  await assert.rejects(deny.rpc.requested('elicitation/create', { threadId: 'thread' }), /尚不支持/)
})

test('Claude: AskUserQuestion is answered through the desktop queue', async () => {
  const sdk = path.join(temp, 'claude-ask-sdk.mjs')
  fs.writeFileSync(sdk, `
    export function query({ options }) {
      globalThis.__claudeAskOptions = options;
      let close;
      const closed = new Promise(resolve => { close = resolve });
      return {
        supportedModels: async () => [], supportedCommands: async () => [], close,
        async *[Symbol.asyncIterator]() { await closed }
      };
    }
  `)
  const source = fs.readFileSync(path.join(root, 'apps/desktop/src/main/agent/claude-engine.ts'), 'utf8')
    .replaceAll("await import('@anthropic-ai/claude-agent-sdk')", 'await import(' + JSON.stringify(sdk.replaceAll('\\', '/')) + ')')
  const output = path.join(temp, 'claude-ask.cjs')
  esbuild.buildSync({ stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'apps/desktop/src/main/agent') }, outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  const { ClaudeCodeEngine } = require(output)
  const asked = []
  const engine = new ClaudeCodeEngine({
    ...callbacks(),
    binary: 'unused',
    ask: async (questions, tool) => {
      asked.push({ questions, tool })
      return { cancelled: false, answers: [{ question: '用哪种语言？', selected: ['中文'], other: '并附英文' }] }
    }
  })
  try {
    await engine.start(temp)
    const canUseTool = globalThis.__claudeAskOptions.canUseTool
    const input = {
      questions: [{ question: '用哪种语言？', header: '语言', options: [{ label: '中文' }, { label: '英文' }], multiSelect: false }]
    }
    assert.deepEqual(await canUseTool('AskUserQuestion', input), {
      behavior: 'allow',
      updatedInput: { ...input, answers: { '用哪种语言？': '中文, 并附英文' } }
    })
    assert.equal(asked[0].tool, 'AskUserQuestion')
    assert.deepEqual(asked[0].questions, input.questions, 'Claude questions go to the panel unchanged')
    assert.deepEqual(await canUseTool('Bash', { command: 'ls' }), { behavior: 'deny', message: '用户拒绝或取消' })
    assert.deepEqual(asked[1].questions, [{
      question: '允许 Claude Code 执行 Bash？\n{"command":"ls"}',
      options: [{ label: '拒绝' }, { label: '允许本次' }]
    }])
  } finally {
    engine.stop()
    delete globalThis.__claudeAskOptions
  }
  const cancelling = new ClaudeCodeEngine({ ...callbacks(), binary: 'unused', ask: async () => ({ cancelled: true, reason: '窗口已关闭' }) })
  try {
    await cancelling.start(temp)
    assert.deepEqual(
      await globalThis.__claudeAskOptions.canUseTool('AskUserQuestion', { questions: [{ question: 'q' }] }),
      { behavior: 'deny', message: '用户已取消' }
    )
  } finally {
    cancelling.stop()
    delete globalThis.__claudeAskOptions
  }
})

test('the no-session-file fallback stops a running turn before switching', async () => {
  const { idleBeforeSwitch } = require(path.join(temp, 'switch-guard.cjs'))
  const calls = []
  const engine = (busy, abortFails = false) => ({
    busy: () => busy,
    abort: async () => {
      calls.push('abort')
      if (abortFails) throw new Error('abort failed')
    },
    stop: () => calls.push('stop'),
    waitForSettle: async (ms) => {
      calls.push('settle:' + ms)
      return true
    }
  })
  // Idle: a switch needs no engine call.
  await idleBeforeSwitch(engine(false), false)
  assert.deepEqual(calls, [])
  // A caller that did not ask to stop is refused, and the run is untouched.
  await assert.rejects(idleBeforeSwitch(engine(true), false), /停止它才能切换会话/)
  assert.deepEqual(calls, [])
  // Stopping: abort, then wait for the turn to settle.
  await idleBeforeSwitch(engine(true), true)
  assert.deepEqual(calls, ['abort', 'settle:3000'])
  // An engine that refuses to abort is stopped so the switch cannot hang.
  calls.length = 0
  await idleBeforeSwitch(engine(true, true), true)
  assert.deepEqual(calls, ['abort', 'stop'])
})

test('Prophey: Enter mid-run steers into the running turn instead of queueing', async () => {
  const { PropheyEngine } = require(path.join(temp, 'prophey-engine.cjs'))
  const events = []
  const engine = new PropheyEngine(callbacks(events))
  engine.model = { id: 'mock', provider: 'mock', api: 'mock', contextWindow: 1000 }
  engine.tools = []
  engine.setStatus({ phase: 'ready' })
  let rounds = 0
  engine.streamRoundWithRetry = async () => {
    rounds += 1
    if (rounds === 1) {
      // The user hits Enter while the model is answering.
      const steered = await engine.prompt('改成中文回答', { behavior: 'steer' })
      assert.equal(steered.ok, true)
      assert.equal(steered.disposition, 'started')
      assert.match(steered.steerId, /^steer-/, 'the window gets a ticket for retracting it')
      assert.equal(engine.steerPending, true, 'the loop is asked for one more round')
      return { ok: true, message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }
    }
    return { ok: true, message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] } }
  }
  assert.equal((await engine.prompt('开始')).ok, true)
  assert.equal(rounds, 2, 'the steered message gets its own round')
  assert.equal(engine.steerPending, false)
  assert.equal(engine.busy(), false)
  const users = (await engine.messages()).filter((message) => message.role === 'user')
  assert.deepEqual(users.map((message) => message.content), ['开始', '改成中文回答'])
  assert.equal(
    events.filter((event) => event.type === 'message_end' && event.message?.role === 'user').length,
    1,
    'the window gets the steered message as a user message'
  )
  // Without the steer behaviour a busy engine still refuses, so nothing is silently dropped.
  engine.isBusy = true
  assert.match((await engine.prompt('普通发送')).error, /上一轮还没结束/)
  engine.isBusy = false
})

test('Prophey: a steer waits for the tool batch and can be taken back before it goes in', async () => {
  const { PropheyEngine } = require(path.join(temp, 'prophey-engine.cjs'))
  const events = []
  const engine = new PropheyEngine(callbacks(events))
  engine.setStatus({ phase: 'ready' })
  engine.isBusy = true
  engine.toolBatchOpen = true
  const userStarts = () => events.filter((event) => event.type === 'message_start' && event.message?.role === 'user')

  const held = await engine.prompt('先别打断', { behavior: 'steer' })
  assert.equal(held.ok, true)
  assert.match(held.steerId, /^steer-/)
  // The message is not in the transcript, so the window must not paint it as sent.
  assert.equal(userStarts().length, 0, 'a held steer reaches the window only when it lands')
  assert.equal((await engine.messages()).filter((message) => message.role === 'user').length, 0)

  // 立即发送 replaces it: the held copy is dropped instead of going out a second time.
  assert.deepEqual(engine.cancelSteer(held.steerId), { ok: true })
  assert.equal(engine.steerPending, false, 'nothing is left for the loop to answer')
  assert.equal(engine.cancelSteer('steer-missing').ok, false, 'an unknown ticket is refused, not ignored')

  const kept = await engine.prompt('这句要发', { behavior: 'steer' })
  engine.toolBatchOpen = false
  engine.flushSteers()
  const delivered = events.filter((event) => event.type === 'message_end' && event.message?.role === 'user')
  assert.deepEqual(delivered.map((event) => event.message.content), ['这句要发'])
  assert.equal((await engine.messages()).at(-1).content, '这句要发')
  assert.equal(engine.cancelSteer(kept.steerId).ok, false, 'once it is in the transcript there is no retracting')
})
