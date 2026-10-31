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
 * Compaction rewrites the transcript into one summary message. The window can only show that summary
 * if the `compaction_end` event carries the exact message that was stored — otherwise it keeps
 * painting turns the model can no longer see, which is what it did before.
 */
test('compaction: the stored summary and the event agree, and the old turns are gone', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-compaction-'))
  const requests = []
  let reply = '好的，我来改。'
  let failing = false
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      requests.push({ url: new URL(req.url, 'http://localhost').pathname, body: JSON.parse(raw) })
      if (failing) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'model_not_found', message: '分组下模型无可用渠道（distributor）' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (data) => res.write('event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n')
      // A compaction request answers like a reasoning model: thinking streams first, then the summary
      // as a text block. Building the summary from "the first text block only" would now be wrong on
      // purpose — the point is that the answer is read from the finished message, not reassembled
      // from whichever event happened to carry it.
      const compacting = raw.includes('你在压缩一段编码会话的上下文')
      event({ type: 'message_start', message: { id: 'msg_proof', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
      if (compacting) {
        event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
        event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想一下要点…' } })
        event({ type: 'content_block_stop', index: 0 })
        event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
        event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: reply } })
        event({ type: 'content_block_stop', index: 1 })
      } else {
        event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } })
        event({ type: 'content_block_stop', index: 0 })
      }
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
      event({ type: 'message_stop' })
      res.end()
    })
  })
  let engine
  try {
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
    engine = new PropheyEngine({
      onStatus() {}, onEvent: (record) => events.push(record), onSettled() {},
      transcripts: new TranscriptStore(path.join(temp, 'transcripts')), sessionId: () => 'compaction-proof'
    })
    await engine.start(temp, { model: { provider: 'proof-compact', id: 'c' } })

    assert.equal((await engine.prompt('帮我改一下登录界面的错误提示')).ok, true)
    assert.equal((await engine.messages()).length, 2, 'a user turn and its answer')

    reply = '目标：修好登录界面的错误提示。'
    const result = await engine.compact()
    assert.equal(result.summary, '目标：修好登录界面的错误提示。')

    const stored = await engine.messages()
    assert.equal(stored.length, 1, 'the compacted turns are gone from the transcript')
    assert.equal(stored[0].role, 'user', 'the summary is an ordinary user message, so the window can edit it')
    assert.equal(stored[0].content, '【此前对话摘要】\n目标：修好登录界面的错误提示。')

    const end = events.find((event) => event.type === 'compaction_end')
    assert.ok(end, 'the window is told the context was rewritten')
    assert.equal(end.summary, '目标：修好登录界面的错误提示。')
    assert.deepEqual(end.message, stored[0], 'the event carries exactly what was stored')

    // The summary request saw the conversation that is being replaced.
    assert.match(JSON.stringify(requests.at(-1).body), /帮我改一下登录界面的错误提示/)
    assert.match(JSON.stringify(requests.at(-1).body), /你在压缩一段编码会话的上下文/)

    // A provider that refuses (no key, no channel, bad model) must say so: 「压缩没有返回内容」 hid a
    // real 503 once already, and an empty summary is exactly where it can happen again.
    reply = ''
    failing = true
    await assert.rejects(() => engine.compact(), /model_not_found|503|无可用渠道/, 'the provider reason survives')
    failing = false

  } finally {
    engine?.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
