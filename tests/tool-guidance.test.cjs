const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const sourceDir = path.join(root, 'apps/desktop/src/main')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-tool-guidance-'))

/** Bundle one main-process module, the way the other engine tests do. */
function bundle(entry) {
  const outfile = path.join(temp, `${path.basename(entry, '.ts')}-${Date.now()}.cjs`)
  esbuild.buildSync({
    stdin: { contents: `export * from ${JSON.stringify(entry)}`, loader: 'ts', resolveDir: sourceDir },
    outfile, bundle: true, platform: 'node', packages: 'external', format: 'cjs'
  })
  return require(outfile)
}

const { toolGuidance } = bundle('./agent/tool-guidance')

/** A declaration stub: only name/source matter to the guidance. */
const tool = (name, source) => ({ name, source, description: '', parameters: {}, call: async () => ({ content: [] }) })

const text = (options) => toolGuidance(options)

test('rules mention the tools this engine really has', () => {
  const block = text({ tools: [tool('read_file'), tool('grep_files'), tool('list_files'), tool('run_bash')] })
  assert.match(block, /grep_files/)
  assert.match(block, /list_files/)
  assert.match(block, /同一条回复里一起发/)
  // Nothing that is not declared: a disabled server must leave no dangling instruction.
  for (const absent of ['ask_user_question', 'web__', 'codegraph', 'codebase_search', 'start_subagent']) {
    assert.equal(block.includes(absent), false, `unexpected ${absent}`)
  }
  // A subagent allowlist can leave the search tools out; the rule must go with them.
  const withoutGrep = text({ tools: [tool('read_file')] })
  assert.equal(withoutGrep.includes('grep_files'), false)
  assert.equal(withoutGrep.includes('grep -rn'), false)
  assert.match(withoutGrep, /同一条回复里一起发/)
})

test('the question tool gets its own guidance only while declared', () => {
  const without = text({ tools: [tool('read_file')] })
  assert.equal(without.includes('ask_user_question'), false)
  const withAsk = text({ tools: [tool('read_file'), tool('ask_user_question')] })
  assert.match(withAsk, /`ask_user_question`/)
  assert.match(withAsk, /不会超时/)
  assert.match(withAsk, /multiSelect/)
})

test('web guidance names the declared tools and needs both halves', () => {
  const both = text({ tools: [tool('web__web_search', 'web'), tool('web__web_fetch', 'web')] })
  assert.match(both, /`web__web_search`/)
  assert.match(both, /`web__web_fetch`/)
  assert.match(both, /摘要不是来源/)
  // Search without fetch: the instruction would point at a tool that is not there.
  const half = text({ tools: [tool('web__web_search', 'web')] })
  assert.equal(half.includes('web__web_search'), false)
})

test('code search guidance lists one tool set per repository', () => {
  const single = text({
    tools: [
      tool('grep_files'),
      tool('codegraph__codegraph_search', 'codegraph'),
      tool('codegraph__codegraph_status', 'codegraph')
    ]
  })
  assert.match(single, /`codegraph__\*`/)
  assert.match(single, /默认不返回源码/)
  assert.match(single, /`codegraph__codegraph_status`/)
  assert.equal(single.includes('codegraph__git'), false)

  const multi = text({
    tools: [
      tool('codegraph__codegraph_search', 'codegraph'),
      tool('codegraph__git__codegraph_search', 'codegraph__git'),
      tool('warpgrep__git__codebase_search', 'warpgrep__git')
    ]
  })
  assert.match(multi, /`codegraph__git__\*`/)
  assert.match(multi, /每个仓库一套工具/)
  assert.match(multi, /`warpgrep__git__codebase_search`/)
  assert.match(multi, /精确符号名用 CodeGraph/)
  // No grep tool declared: the advice falls back to reading, and naming grep would be a dead end.
  assert.equal(multi.includes('grep_files'), false)
  assert.match(multi, /全文和字符串搜索用 read_file/)
  // A tool the user hid is not named anywhere.
  assert.equal(multi.includes('codegraph_files'), false)
})

test('the subagent section needs the start tool, and comes from the app', () => {
  const section = 'AGENTS-SECTION'
  assert.equal(text({ tools: [tool('search_agents')], agentsSection: section }).includes(section), false)
  assert.equal(text({ tools: [tool('start_subagent')] }).includes(section), false)
  assert.match(text({ tools: [tool('start_subagent')], agentsSection: section }), /AGENTS-SECTION$/)
})

test('the prompt gives the model how to use every declared server', async () => {
  const listed = {
    codegraph: ['codegraph_search', 'codegraph_callers', 'codegraph_impact'],
    warpgrep: ['codebase_search'],
    web: ['web_search', 'web_fetch']
  }
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const call = JSON.parse(body || '{}')
      const name = String(call.params?.name ?? '')
      const result = call.method === 'tools/list'
        ? {
            result: {
              tools: (listed[path.basename(new URL(request.url, 'http://127.0.0.1').pathname)] ?? []).map((tool) => ({
                name: tool,
                description: `${tool} description`,
                inputSchema: { type: 'object', properties: {} }
              }))
            }
          }
        : { result: { protocolVersion: '2025-06-18', content: [{ type: 'text', text: name }] } }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...result }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  // A provider that only records the request, so the prompt under test is the real one.
  const provider = path.join(temp, 'providers.cjs')
  fs.writeFileSync(provider, `
    const model = { id: 'capture', provider: 'mock', api: 'mock', contextWindow: 200000, maxTokens: 4000 };
    export async function listModelChoices() { return [{ id: 'capture', provider: 'mock', contextWindow: 200000 }] }
    export async function thinkingLevelsFor() { return ['off'] }
    export async function getRuntime() { return {
      getModel() { return model },
      async *streamSimple(request_model, request) {
        globalThis.__capturedPrompt = request.systemPrompt
        const done = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] };
        yield { type: 'text_delta', delta: 'ok', partial: done };
        yield { type: 'done', message: done };
      }
    } }
  `)
  const source = fs.readFileSync(path.join(sourceDir, 'agent/prophey-engine.ts'), 'utf8')
    .replace("from '../providers'", 'from ' + JSON.stringify(provider.replaceAll('\\', '/')))
  const outfile = path.join(temp, 'engine.cjs')
  esbuild.buildSync({
    stdin: { contents: source, loader: 'ts', resolveDir: path.join(sourceDir, 'agent') },
    outfile, bundle: true, platform: 'node', packages: 'external', format: 'cjs'
  })
  const { PropheyEngine } = require(outfile)
  const engine = new PropheyEngine({
    onStatus() {}, onEvent() {}, onSettled() {},
    toolModulePath: path.join(root, 'packages/mcp-core/tools/workspace.mjs'),
    askModulePath: path.join(root, 'packages/mcp-core/tools/ask-user.mjs'),
    subagentModulePath: path.join(root, 'packages/mcp-core/tools/subagent.mjs'),
    bridge: () => ({ url: 'http://127.0.0.1:9', token: 'proof' }),
    agentsSection: () => 'SUBAGENTS-SECTION',
    mcpEndpoints: async () => ['codegraph', 'warpgrep', 'web'].map((name) => ({
      name, url: `http://127.0.0.1:${port}/mcp/${name}`, token: 'proof'
    }))
  })
  try {
    await engine.start(temp, { model: { provider: 'mock', id: 'capture' } })
    assert.equal((await engine.prompt('hello')).ok, true)
    const prompt = globalThis.__capturedPrompt
    // Rules, question tool, all three servers and the preset list: one prompt, no gaps.
    for (const expected of [
      '工作目录',
      'grep_files',
      '`ask_user_question`',
      '`web__web_search`',
      '`web__web_fetch`',
      '`codegraph__*`',
      '`warpgrep__codebase_search`',
      'SUBAGENTS-SECTION'
    ]) {
      assert.equal(prompt.includes(expected), true, `the prompt is missing ${expected}`)
    }
    // The pi namespacing is not how this engine names tools; mentioning it would mislead.
    assert.equal(prompt.includes('mcp__'), false)
  } finally {
    engine.dispose()
    server.close()
    delete globalThis.__capturedPrompt
  }
})

after(() => fs.rmSync(temp, { recursive: true, force: true }))
