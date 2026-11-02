const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')

/**
 * Compaction folds what the model reads into a summary message.
 *
 * Two rules carry the weight here, both from a real session (`s_99a5d7e6`):
 *   1. the conversation stays in the transcript — the window still shows it, only the request is
 *      narrowed to the newest summary; and
 *   2. a compaction that did not produce a summary never rewrites anything. That session stored the
 *      abort sentinel "[Request interrupted by user]" as its whole history.
 */
async function harness(t, respond) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-compaction-'))
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw)
      requests.push({ url: new URL(req.url, 'http://localhost').pathname, body, raw })
      const answer = respond({ body, raw })
      if (answer.failure) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'model_not_found', message: '分组下模型无可用渠道（distributor）' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (data) => res.write('event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n')
      event({ type: 'message_start', message: { id: 'msg_proof', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
      // A compaction request answers like a reasoning model: thinking streams first, then the answer
      // as a text block. Reading the answer from the finished message (not from whichever event
      // carried it) is what makes that work.
      if (answer.thinking) {
        event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
        event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: answer.thinking } })
        event({ type: 'content_block_stop', index: 0 })
      }
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer.text ?? '' } })
      event({ type: 'content_block_stop', index: 1 })
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
      event({ type: 'message_stop' })
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const modelsPath = path.join(temp, 'models.json')
  const authPath = path.join(temp, 'auth.json')
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: {
    'proof-compact': {
      apiKey: 'local-test', baseUrl: base + '/v1', api: 'anthropic-messages',
      models: [{ id: 'c', name: 'c', contextWindow: 32000, maxTokens: 256, reasoning: false }]
    }
  } }))
  fs.writeFileSync(authPath, '{}')
  const stub = path.join(temp, 'providers.mjs')
  fs.writeFileSync(stub, `
    let pending;
    export async function getRuntime() { return pending ??= (async () => {
      const { ModelRuntime } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href)});
      return ModelRuntime.create({ modelsPath: ${JSON.stringify(modelsPath)}, authPath: ${JSON.stringify(authPath)}, refreshOnCreate: false });
    })() }
    export async function listModelChoices() { return (await getRuntime()).getModels().filter(m => m.provider.startsWith('proof-')) }
    export async function thinkingLevelsFor(model) {
      const { getSupportedThinkingLevels } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-ai/dist/models.js')).href)});
      return getSupportedThinkingLevels(model)
    }
  `)
  const source = fs.readFileSync(path.join(root, 'apps/desktop/src/main/agent/prophey-engine.ts'), 'utf8')
    .replace("from '../providers'", 'from ' + JSON.stringify(stub.replaceAll('\\', '/')))
  esbuild.buildSync({
    stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'apps/desktop/src/main/agent') },
    outfile: path.join(temp, 'engine.cjs'), bundle: true, platform: 'node', packages: 'external'
  })
  esbuild.buildSync({ entryPoints: [path.join(root, 'apps/desktop/src/main/transcript-store.ts')], outfile: path.join(temp, 'store.cjs'), bundle: true, platform: 'node' })
  const { PropheyEngine } = require(path.join(temp, 'engine.cjs'))
  const { TranscriptStore } = require(path.join(temp, 'store.cjs'))

  const events = []
  const engine = new PropheyEngine({
    onStatus() {}, onEvent: (record) => events.push(record), onSettled() {},
    transcripts: new TranscriptStore(path.join(temp, 'transcripts')), sessionId: () => 'compaction-proof'
  })
  await engine.start(temp, { model: { provider: 'proof-compact', id: 'c' } })
  t.after(async () => {
    engine.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(temp, { recursive: true, force: true })
  })
  const compactRequests = () => requests.filter((entry) => entry.raw.includes('你在压缩一段编码会话的上下文'))
  const turnRequests = () => requests.filter((entry) => !entry.raw.includes('你在压缩一段编码会话的上下文'))
  return { engine, events, requests, compactRequests, turnRequests }
}

const COMPACTING = (body) => JSON.stringify(body).includes('你在压缩一段编码会话的上下文')

test('compaction: the history stays, the request starts at the summary, and the event agrees', async (t) => {
  let reply = '好的，我来改。'
  let replyCompaction = '目标：修好登录界面的错误提示。'
  const { engine, events, turnRequests, compactRequests } = await harness(t, ({ body }) =>
    COMPACTING(body) ? { text: replyCompaction, thinking: '先想一下要点…' } : { text: reply })

  assert.equal((await engine.prompt('帮我改一下登录界面的错误提示')).ok, true)
  assert.equal((await engine.messages()).length, 2, 'a user turn and its answer')

  reply = '目标：修好登录界面的错误提示。'
  const result = await engine.compact()
  assert.equal(result.summary, '目标：修好登录界面的错误提示。')

  const stored = await engine.messages()
  assert.equal(stored.length, 3, 'the compacted turns stay in the transcript the window paints')
  const summary = stored[2]
  assert.equal(summary.role, 'user', 'the summary is an ordinary user message, so the window can edit it')
  assert.equal(summary.content, '【此前对话摘要】\n目标：修好登录界面的错误提示。')
  assert.equal(summary.compaction, true, 'the marker is what the next request starts from')

  const end = events.find((event) => event.type === 'compaction_end')
  assert.ok(end, 'the window is told the context was folded')
  assert.equal(end.summary, '目标：修好登录界面的错误提示。')
  assert.deepEqual(end.message, summary, 'the event carries exactly what was stored')

  // The compaction request saw the conversation it was summarizing.
  assert.match(JSON.stringify(compactRequests().at(-1).body), /帮我改一下登录界面的错误提示/)
  assert.match(JSON.stringify(compactRequests().at(-1).body), /你在压缩一段编码会话的上下文/)

  // The next turn reads the summary and what comes after it — not the turns it already replaced.
  assert.equal((await engine.prompt('继续完成')).ok, true)
  const turn = JSON.stringify(turnRequests().at(-1).body)
  assert.match(turn, /【此前对话摘要】/)
  assert.match(turn, /继续完成/)
  assert.doesNotMatch(turn, /帮我改一下登录界面的错误提示/, 'the summarized turn is no longer sent')
  assert.equal((await engine.messages()).length, 5, 'the window keeps every turn it had')
})

test('compaction: a provider failure changes nothing, and the turn still gets its answer', async (t) => {
  let failCompaction = false
  const { engine, events } = await harness(t, ({ body }) =>
    COMPACTING(body) && failCompaction
      ? { failure: true }
      : { text: COMPACTING(body) ? '目标：修好登录界面的错误提示。' : '好的，我来改。' })

  await engine.prompt('帮我改一下登录界面的错误提示')
  const before = await engine.messages()
  failCompaction = true
  await assert.rejects(() => engine.compact(), /model_not_found|503|无可用渠道/, 'the provider reason survives')
  assert.deepEqual(await engine.messages(), before, 'a failed compaction leaves the conversation alone')
  assert.equal(events.some((event) => event.type === 'compaction_end'), false)

  // Auto-compaction failing at the top of a turn must not cost the turn: the model answers with the
  // conversation it already had, and the window is told why the context did not shrink.
  engine.options.autoCompact = () => ({ enabled: true, percent: 0.0001 })
  const answer = await engine.prompt('换个思路再试')
  assert.equal(answer.ok, true, 'the turn runs on the conversation it had')
  const failed = events.find((event) => event.type === 'compaction_failed')
  assert.ok(failed, 'the window hears that compaction did not finish')
  assert.match(String(failed.error), /model_not_found|503|无可用渠道/)
  const messages = await engine.messages()
  assert.equal(messages.at(-1).role, 'assistant', 'the answer is in the transcript')
  assert.equal(messages.at(-1).content[0].text, '好的，我来改。')
})

test('compaction: the abort sentinel is not a summary', async (t) => {
  // Exactly what the gateway returned when the request was interrupted, and exactly what got stored
  // as the whole conversation before this rule existed.
  const { engine, events } = await harness(t, ({ body }) =>
    COMPACTING(body)
      ? { text: '[Request interrupted by user]', thinking: '被打断了' }
      : { text: '好的，我来改。' })

  await engine.prompt('帮我改一下登录界面的错误提示')
  const before = await engine.messages()
  await assert.rejects(() => engine.compact(), /压缩被中断/, 'an interruption is not a summary')
  assert.deepEqual(await engine.messages(), before, 'the conversation is still there')
  assert.equal(events.some((event) => event.type === 'compaction_end'), false)
})

/**
 * A gateway that does not translate the model's tool-call markup leaves it in the reply text. The
 * fix has to be visible at both ends: the call really runs, and the markup never reaches the
 * transcript or the window.
 */
test('tool calls written as text: the call runs and the markup stays out of the transcript', async (t) => {
  let turns = 0
  const markup = [
    '我先了解项目结构和相关代码。',
    '',
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="run_bash">',
    '<｜｜DSML｜｜ parameter name="command" string="true">echo hello</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '<｜｜DSML｜｜ calls>'
  ].join('\n')
  const { engine, events } = await harness(t, ({ body }) => {
    turns = COMPACTING(body) ? 0 : turns + 1
    // Round one hands back the markup; round two (which only happens because a tool result was sent)
    // answers plainly, so the turn ends.
    return turns > 1 ? { text: '完成。' } : { text: markup }
  })

  assert.equal((await engine.prompt('看看项目结构')).ok, true)
  const messages = await engine.messages()
  const assistant = messages.find((message) => message.role === 'assistant')
  assert.equal(assistant.content[0].text, '我先了解项目结构和相关代码。', 'the prose survives without the markup')
  assert.equal(assistant.content[1].type, 'toolCall')
  assert.equal(assistant.content[1].name, 'run_bash')
  assert.deepEqual(assistant.content[1].arguments, { command: 'echo hello' })
  assert.equal(assistant.stopReason, 'toolUse', 'the loop sees a turn that asked for a tool')
  assert.equal(messages.at(-1).role, 'assistant', 'the turn ended with the answer that followed the tool')
  assert.equal(messages.at(-1).content[0].text, '完成。')
  const toolResult = messages.find((message) => message.role === 'toolResult')
  assert.ok(toolResult, 'the call was executed')
  assert.equal(toolResult.toolName, 'run_bash')
  assert.doesNotMatch(JSON.stringify(messages), /DSML/, 'no markup in the transcript')
  assert.ok(events.some((event) => event.type === 'tool_calls_repaired' && event.count === 1))
  assert.ok(events.some((event) => event.type === 'tool_execution_start' && event.toolName === 'run_bash'))
})
