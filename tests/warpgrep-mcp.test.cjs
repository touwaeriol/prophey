/**
 * `@prophey/warpgrep-mcp` — the standalone DeepSeek-backed WarpGrep MCP server.
 *
 * Every test drives the real server over stdio and a scripted OpenAI-compatible endpoint (no network,
 * no key), so the JSON-RPC surface, the loop, the sandbox and the failure codes are all covered.
 */
const { test, before, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const server = path.join(root, 'packages/warpgrep-mcp/server.mjs')
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'warpgrep-mcp-'))
fs.mkdirSync(path.join(repo, 'src'))
fs.mkdirSync(path.join(repo, 'node_modules', 'junk'), { recursive: true })
fs.writeFileSync(
  path.join(repo, 'src', 'session.ts'),
  ['export const sessionKeys = new Map()', 'export function saveSession() {}', '// SIDEBAR_STATE_KEY', ''].join('\n')
)
fs.writeFileSync(path.join(repo, 'src', 'layout.ts'), ['export const LAYOUT_KEY = "pi-sidebar-open"', ''].join('\n'))
fs.writeFileSync(path.join(repo, 'node_modules', 'junk', 'hidden.ts'), 'SIDEBAR_STATE_KEY\n')

/** Scripted endpoint: each request pops the next turn; `requests` keeps what the model saw. */
let script = []
let requests = []
let status = 200
let delayMs = 0
const api = http.createServer((request, response) => {
  let body = ''
  request.on('error', () => {})
  response.on('error', () => {})
  request.on('data', (chunk) => (body += chunk))
  request.on('end', async () => {
    requests.push(JSON.parse(body))
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (status !== 200) {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'scripted failure' }))
      return
    }
    const next = script.shift() ?? { role: 'assistant', content: 'nothing left' }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: next }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))
  })
})

let baseUrl
/** Every test starts from a clean script and request log; leftovers must not leak between cases. */
beforeEach(() => {
  script = []
  requests = []
})
before(async () => {
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${api.address().port}/v1`
})
after(() => {
  api.close()
  fs.rmSync(repo, { recursive: true, force: true })
})

/** Start the server, run `body` against it, always kill it. */
async function withServer(env, body) {
  const child = spawn(process.execPath, [server, '--path', repo], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WARPGREP_BASE_URL: baseUrl,
      WARPGREP_API_KEY: 'test-key',
      WARPGREP_MODEL: 'deepseek-flash',
      PI_CODING_AGENT_DIR: path.join(repo, 'no-auth'),
      ...env
    }
  })
  let out = ''
  const waiting = new Map()
  let nextId = 1
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    out += chunk
    let index
    while ((index = out.indexOf('\n')) !== -1) {
      const line = out.slice(0, index).trim()
      out = out.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const resolve = waiting.get(message.id)
      if (resolve) {
        waiting.delete(message.id)
        resolve(message)
      }
    }
  })
  const stderr = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const send = (method, params) => {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`timeout waiting for ${method}`)), 15_000)
      waiting.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }
  try {
    return await body({ send, child, stderr })
  } finally {
    child.kill()
  }
}

const call = (send, args) => send('tools/call', { name: 'codebase_search', arguments: args })
const textOf = (message) => message.result.content.map((part) => part.text).join('\n')
const toolCall = (name, args, id = 'call_1') => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
})

test('warpgrep: the server lists one tool and describes the configured backend', async () => {
  await withServer({}, async ({ send }) => {
    const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    assert.equal(init.result.serverInfo.name, 'warpgrep-mcp')
    assert.match(init.result.instructions, /deepseek-flash/)
    const listed = await send('tools/list', {})
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['codebase_search'])
    assert.deepEqual(listed.result.tools[0].inputSchema.required, ['search_string'])
    assert.equal((await send('method/unknown', {})).error.code, -32601)
  })
})

test('warpgrep: grep then finish returns verified files and a one-sentence answer', async () => {
  script = [
    toolCall('grep_search', { pattern: 'SIDEBAR_STATE_KEY' }),
    toolCall('finish', { files: 'src/session.ts:3', answer: '侧栏状态在 session.ts 里' }, 'call_2')
  ]
  requests = []
  await withServer({}, async ({ send }) => {
    const message = await call(send, { search_string: '侧栏状态存在哪里？' })
    assert.equal(message.result.isError, undefined)
    const text = textOf(message)
    assert.match(text, /侧栏状态在 session\.ts 里/)
    assert.match(text, /src\/session\.ts:3/)
    assert.deepEqual(message.result.structuredContent.files, 'src/session.ts:3')
    assert.equal(message.result.structuredContent.turns, 2)
    // The loop sent the system prompt and the tool specs, and never leaks node_modules hits.
    assert.match(requests[0].messages[0].content, /code search agent/)
    assert.equal(requests[0].tools.length, 5)
    assert.equal(requests[0].model, 'deepseek-flash')
    assert.match(requests[1].messages.at(-1).content, /^src\/session\.ts:3/)
  })
})

test('warpgrep: includeSource returns code for the listed ranges only', async () => {
  script = [toolCall('finish', { files: 'src/layout.ts:1-1', answer: '见 layout.ts' })]
  await withServer({}, async ({ send }) => {
    const message = await call(send, { search_string: 'layout key', includeSource: true })
    const text = textOf(message)
    assert.match(text, /<file path="src\/layout\.ts">/)
    assert.match(text, /1: export const LAYOUT_KEY = "pi-sidebar-open"/)
    assert.equal(text.includes('saveSession'), false, 'only the requested range is sent')
  })
})

test('warpgrep: invented paths are dropped instead of reported', async () => {
  script = [toolCall('finish', { files: 'src/ghost.ts:1-9\nsrc/layout.ts:1', answer: 'found' })]
  await withServer({}, async ({ send }) => {
    const message = await call(send, { search_string: 'layout key' })
    const result = message.result.structuredContent
    assert.equal(result.files, 'src/layout.ts:1')
    assert.deepEqual(result.dropped, ['src/ghost.ts:1-9'])
  })
})

test('warpgrep: a model that forgets finish still yields files, parsed from prose', async () => {
  script = [
    toolCall('grep_search', { pattern: 'LAYOUT_KEY' }),
    { role: 'assistant', content: 'The key lives in:\nsrc/layout.ts:1\n- src/session.ts' }
  ]
  await withServer({}, async ({ send }) => {
    const message = await call(send, { search_string: 'layout key' })
    assert.equal(message.result.structuredContent.files, 'src/layout.ts:1\nsrc/session.ts')
    assert.equal(message.result.isError, undefined)
  })
})

test('warpgrep: a tool call outside the repository is refused and the loop continues', async () => {
  script = [
    toolCall('read', { path: '../../../etc/passwd' }),
    toolCall('finish', { files: 'src/layout.ts:1', answer: 'done' }, 'call_2')
  ]
  await withServer({}, async ({ send }) => {
    const message = await call(send, { search_string: 'anything' })
    assert.equal(message.result.isError, undefined)
    const refusal = requests[1].messages.at(-1)
    assert.equal(refusal.role, 'tool')
    assert.match(refusal.content, /outside the workspace/)
  })
})

test('warpgrep: a 401 is reported as a tool error carrying the code, not a crash', async () => {
  status = 401
  try {
    await withServer({}, async ({ send }) => {
      const message = await call(send, { search_string: 'anything' })
      assert.equal(message.result.isError, true)
      assert.match(textOf(message), /UNAUTHORIZED/)
      assert.equal((await send('ping', {})).result === undefined, false, 'server survives a failed call')
    })
  } finally {
    status = 200
  }
})

test('warpgrep: the total deadline turns a slow model into a TIMEOUT instead of hanging', async () => {
  delayMs = 800
  script = [toolCall('grep_search', { pattern: 'a' }), toolCall('grep_search', { pattern: 'b' }), toolCall('grep_search', { pattern: 'c' })]
  try {
    await withServer({ WARPGREP_TOTAL_TIMEOUT_MS: '1200', WARPGREP_TURN_TIMEOUT_MS: '700' }, async ({ send }) => {
      const message = await call(send, { search_string: 'slow' })
      assert.equal(message.result.isError, true)
      assert.match(textOf(message), /TIMEOUT/)
    })
  } finally {
    delayMs = 0
  }
})

test('warpgrep: no key means every call explains itself instead of failing silently', async () => {
  await withServer({ WARPGREP_API_KEY: '', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '' }, async ({ send }) => {
    assert.equal((await send('tools/list', {})).result.tools.length, 1, 'listing still works')
    const message = await call(send, { search_string: 'anything' })
    assert.equal(message.result.isError, true)
    assert.match(textOf(message), /NO_KEY/)
  })
})

test('warpgrep: bare line ranges continue the previous file instead of being dropped', async () => {
  // Observed live: DeepSeek listed `App.tsx:1184` then `1233` on its own line for the same file.
  script = [toolCall('finish', { files: 'src/layout.ts:1\n3\nsrc/ghost.ts:9', answer: 'ok' })]
  await withServer({}, async ({ send }) => {
    const result = (await call(send, { search_string: 'layout' })).result.structuredContent
    assert.equal(result.files, 'src/layout.ts:1\nsrc/layout.ts:3')
    assert.deepEqual(result.dropped, ['src/ghost.ts:9'])
  })
})

test('warpgrep: an exhausted tool budget never leaves a tool_call unanswered', async () => {
  // Regression: breaking out of a parallel tool-call message produced a 400 from DeepSeek
  // ("tool_calls must be followed by tool messages"). The budget must apply between turns.
  script = [
    {
      role: 'assistant',
      content: '',
      tool_calls: ['a', 'b', 'c'].map((letter) => ({
        id: 'call_' + letter,
        type: 'function',
        function: { name: 'grep_search', arguments: JSON.stringify({ pattern: letter }) }
      }))
    },
    toolCall('finish', { files: 'src/layout.ts:1', answer: 'ok' }, 'call_finish')
  ]
  await withServer({ WARPGREP_MAX_TURNS: '2' }, async ({ send }) => {
    const message = await call(send, { search_string: 'budget' })
    assert.equal(message.result.isError, undefined, textOf(message))
    const asked = requests[1].messages.flatMap((entry) => (entry.tool_calls ?? []).map((call) => call.id))
    const answered = requests[1].messages.filter((entry) => entry.role === 'tool').map((entry) => entry.tool_call_id)
    assert.equal(asked.length, 3, 'all three parallel calls were executed')
    for (const id of asked) assert.ok(answered.includes(id), 'unanswered tool_call ' + id)
  })
})

test('warpgrep: an empty search_string is rejected before any model call', async () => {
  requests = []
  await withServer({}, async ({ send }) => {
    const message = await call(send, { search_string: '   ' })
    assert.equal(message.result.isError, true)
    assert.match(textOf(message), /INPUT/)
    assert.equal(requests.length, 0)
  })
})
