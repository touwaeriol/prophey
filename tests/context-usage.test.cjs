const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const sourceDir = path.join(root, 'apps/desktop/src/main')
const toolsPath = path.join(root, 'packages/mcp-core/tools/workspace.mjs')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-context-usage-'))

/** Bundle the engine against a fake provider, the way the other engine tests do. */
function engineWith(providerSource) {
  const stamp = Math.random().toString(16).slice(2, 8)
  const provider = path.join(temp, `providers-${stamp}.mjs`)
  fs.writeFileSync(provider, providerSource)
  const source = fs.readFileSync(path.join(sourceDir, 'agent/prophey-engine.ts'), 'utf8')
    .replace("from '../providers'", 'from ' + JSON.stringify(provider.replaceAll('\\', '/')))
  const outfile = path.join(temp, `engine-${stamp}.cjs`)
  esbuild.buildSync({
    stdin: { contents: source, loader: 'ts', resolveDir: path.join(sourceDir, 'agent') },
    outfile, bundle: true, platform: 'node', packages: 'external', format: 'cjs'
  })
  return require(outfile).PropheyEngine
}

const HEADER = `
const model = { id: 'metered', provider: 'mock', api: 'mock', contextWindow: 200000, maxTokens: 4000 };
const usage = (input, output, cacheRead) => ({
  input, output, cacheRead, cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
});
const reply = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
export async function listModelChoices() { return [{ id: 'metered', provider: 'mock', contextWindow: 200000 }] }
export async function thinkingLevelsFor() { return ['off'] }
export async function getRuntime() { return {
  getModel() { return model },
  async *streamSimple() {
`

// Reports usage the way a real provider does: the prompt count arrives with the first event
// (input 1000 + 200 cached), the output count grows while the reply streams.
const chatty = engineWith(HEADER + `
    const answer = 'x'.repeat(40000);
    const first = reply('');
    first.usage = usage(1000, 0, 200);
    yield { type: 'text_delta', delta: '', partial: first };
    if (globalThis.__meterMidRound) await globalThis.__meterMidRound('prompt');
    const grown = reply(answer);
    grown.usage = usage(1000, 10000, 200);
    yield { type: 'text_delta', delta: answer, partial: grown };
    if (globalThis.__meterMidRound) await globalThis.__meterMidRound('output');
    const done = reply(answer);
    done.usage = usage(1000, 10000, 200);
    yield { type: 'done', message: done };
  }
} }
`)

// Reports usage only at the end (OpenAI-style): mid-round the engine has to estimate, and that
// estimate must include the system prompt and the tool declarations.
const quiet = engineWith(HEADER + `
    const answer = 'y'.repeat(400);
    yield { type: 'text_delta', delta: answer, partial: reply(answer) };
    if (globalThis.__meterMidRound) await globalThis.__meterMidRound('text');
    const done = reply(answer);
    done.usage = usage(1000, 100, 200);
    yield { type: 'done', message: done };
  }
} }
`)

after(() => {
  delete globalThis.__meterMidRound
  fs.rmSync(temp, { recursive: true, force: true })
})

test('the meter reports the provider prompt size and moves while the round is still streaming', async () => {
  const statuses = []
  const engine = new chatty({ onStatus: next => statuses.push({ ...next }), onEvent() {}, onSettled() {} })
  try {
    await engine.start(temp, { model: { provider: 'mock', id: 'metered' } })
    assert.equal((await engine.stats()).contextUsage.tokens, 0, 'nothing sent yet')

    const midRound = []
    globalThis.__meterMidRound = async () => midRound.push((await engine.stats()).contextUsage)
    assert.equal((await engine.prompt('hello')).ok, true)
    globalThis.__meterMidRound = undefined

    // The provider already told us the prompt: 1000 input + 200 cached, no output yet.
    assert.equal(midRound[0].tokens, 1200, 'the prompt count is the provider own, not an estimate')
    // Same 1200 prompt plus the 10000 output tokens reported for the reply so far.
    assert.equal(midRound[1].tokens, 11200)

    // Those numbers reach the window mid-round instead of waiting for `agent_settled`.
    const live = statuses.filter(status => status.isStreaming && status.contextUsage?.tokens === 11200)
    assert.equal(live.length > 0, true, 'the meter publishes prompt+output while the reply streams')

    const settled = (await engine.stats()).contextUsage
    assert.equal(settled.tokens, 11200, 'prompt + reply, as the next request would send it')
    assert.equal(settled.contextWindow, 200000)
    assert.equal(Math.round(settled.percent * 10) / 10, 5.6)
    assert.equal(engine.state().contextUsage.tokens, 11200, 'the settled status carries the same number')

    // A new conversation cannot inherit the previous measurement.
    await engine.newSession()
    assert.equal((await engine.stats()).contextUsage.tokens, 0)
    assert.equal(engine.state().contextUsage, undefined)
  } finally { engine.dispose() }
})

test('without mid-round usage the meter estimates, and that estimate covers prompt and tools', async () => {
  const statuses = []
  const engine = new quiet({ onStatus: next => statuses.push({ ...next }), onEvent() {}, onSettled() {},
    toolModulePath: toolsPath })
  try {
    await engine.start(temp, { model: { provider: 'mock', id: 'metered' } })
    assert.equal((await engine.toolSet()).length > 0, true)
    const midRound = []
    globalThis.__meterMidRound = async () => midRound.push((await engine.stats()).contextUsage)
    assert.equal((await engine.prompt('hello')).ok, true)
    globalThis.__meterMidRound = undefined

    // "hello" is 2 tokens of transcript; the system prompt and the tool declarations are what the
    // old estimate left out entirely, so anything near 2 means the overhead is still missing.
    assert.equal(midRound[0].tokens > 1000, true, `estimated ${midRound[0].tokens} tokens mid-round`)
    const live = statuses.filter(status => status.isStreaming && (status.contextUsage?.tokens ?? 0) > 1000)
    assert.equal(live.length > 0, true, 'the estimate is published before the first response ends')

    // Once the provider answers, its count replaces the guess.
    assert.equal((await engine.stats()).contextUsage.tokens, 1300)
    const breakdown = (await engine.stats()).contextUsage.breakdown
    assert.equal(breakdown.systemTools.count > 0, true, 'the app tool declarations are counted')
    assert.equal(breakdown.systemTools.tokens > 0, true)
    assert.equal(breakdown.systemPrompt > 0, true, 'the system prompt is counted')
    assert.equal(breakdown.mcpTools.count, 0, 'no MCP server in this session')
    // The sections are the meter: the transcript is the remainder, so nothing is lost or invented.
    assert.equal(
      breakdown.messages + breakdown.systemPrompt + breakdown.systemTools.tokens + breakdown.mcpTools.tokens,
      1300
    )
  } finally { engine.dispose() }
})

test('the breakdown splits the prompt between the app tools and each MCP server', async () => {
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const call = JSON.parse(body || '{}')
      const result = call.method === 'tools/list'
        ? { result: { tools: [
            { name: 'search', description: 'search the graph', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
            { name: 'impact', description: 'what changing a symbol breaks', inputSchema: { type: 'object', properties: {} } }
          ] } }
        : { result: { protocolVersion: '2025-06-18' } }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...result }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const engine = new quiet({ onStatus() {}, onEvent() {}, onSettled() {},
    toolModulePath: toolsPath,
    mcpEndpoints: async () => [{ name: 'graph', url: `http://127.0.0.1:${address.port}/mcp/graph`, token: 'proof' }] })
  try {
    await engine.start(temp, { model: { provider: 'mock', id: 'metered' } })
    assert.equal((await engine.toolSet()).filter((tool) => tool.name.startsWith('graph__')).length, 2)
    assert.equal((await engine.prompt('hello')).ok, true)
    const usage = (await engine.stats()).contextUsage
    const breakdown = usage.breakdown
    assert.equal(breakdown.mcpTools.count, 2)
    assert.deepEqual(breakdown.mcpTools.servers.map((server) => server.name), ['graph'])
    assert.equal(breakdown.mcpTools.tokens > 0, true, 'the MCP declarations have a price')
    assert.equal(breakdown.systemTools.count > 0, true, 'the app tools are a separate section')
    assert.equal(
      breakdown.messages + breakdown.systemPrompt + breakdown.systemTools.tokens + breakdown.mcpTools.tokens,
      usage.tokens,
      'sections add up to the meter'
    )
  } finally {
    engine.dispose()
    server.close()
  }
})
