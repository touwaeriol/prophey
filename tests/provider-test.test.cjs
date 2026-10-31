/**
 * The provider row's 「测试」 button.
 *
 * A wrong Base URL or a model id the channel does not sell is invisible until a conversation fails:
 * an OpenAI-compatible adapter appends `/chat/completions` to whatever it is given, so a gateway
 * configured without `/v1` answers 200 with its web page. These tests drive the real runtime against
 * a local fake gateway and check that the answer says what to fix.
 */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-provider-test-'))
const agentDir = path.join(temp, 'profile')
fs.mkdirSync(agentDir)
const electron = path.join(temp, 'electron.cjs')
fs.writeFileSync(electron, 'exports.shell = {}')

esbuild.buildSync({
  stdin: {
    contents: `
      export * as providers from './providers';
      export * as profile from './profile';
      export * as url from '../shared/provider-url';
    `,
    loader: 'ts',
    resolveDir: path.join(root, 'apps/desktop/src/main')
  },
  outfile: path.join(temp, 'providers.cjs'),
  bundle: true,
  platform: 'node',
  packages: 'external',
  alias: {
    electron,
    '@earendil-works/pi-coding-agent': pathToFileURL(
      path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')
    ).href,
    '@earendil-works/pi-ai/models': pathToFileURL(
      path.join(root, 'node_modules/@earendil-works/pi-ai/dist/models.js')
    ).href
  }
})
const { providers, profile, url } = require(path.join(temp, 'providers.cjs'))
profile.setAgentDir(agentDir)

/** A gateway whose behaviour each test sets: it records what it was asked for. */
let handler = () => ({ status: 500, body: 'unset' })
const requests = []
const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    requests.push({ url: request.url, body })
    const answer = handler(request, body)
    response.writeHead(answer.status, { 'content-type': answer.type ?? 'application/json' })
    response.end(answer.body)
  })
})
let port
test('fake gateway', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})
after(() => {
  server.close()
  fs.rmSync(temp, { recursive: true, force: true })
})

/** A minimal OpenAI-compatible streaming reply: one chunk with text, then the stop. */
const SSE_OK = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"}}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
  ''
].join('\n')

/** Point one custom provider at the fake gateway, the way the editor writes models.json. */
function configure(basePath, modelId) {
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        local: {
          name: 'Local',
          api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${port}${basePath}`,
          apiKey: 'local-test-key',
          models: [{ id: modelId, contextWindow: 8000, maxTokens: 1024 }]
        }
      }
    })
  )
  providers.invalidateCache()
}

test('a Base URL without a path keeps its spelling and still works', async () => {
  // The address is stored exactly as the user typed it — that is the whole point.
  configure('', 'deepseek-flash')
  requests.length = 0
  handler = (request) => (request.url === '/v1/chat/completions'
    ? { status: 200, type: 'text/event-stream', body: SSE_OK }
    // The host root is a web page, which is what a gateway without a version segment answers.
    : { status: 200, type: 'text/html', body: '<!doctype html><html><body>gateway</body></html>' })
  const result = await providers.testProvider('local')
  assert.equal(result.ok, true, result.detail)
  // Two requests: the address as typed, then the same one under /v1. Nothing was rewritten.
  assert.deepEqual(requests.map((entry) => entry.url), ['/chat/completions', '/v1/chat/completions'])
  assert.match(result.detail ?? '', /地址保持原样/)
  assert.match(result.detail ?? '', /\/v1/)
  const written = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'))
  assert.equal(written.providers.local.baseUrl, 'http://127.0.0.1:' + port, 'the file keeps what was typed')
})

test('a gateway that really serves the bare path is not retried', async () => {
  configure('', 'deepseek-flash')
  requests.length = 0
  // Some gateways do answer /chat/completions at the root. That answer stands: no fallback, no note.
  handler = (request) => (request.url === '/chat/completions'
    ? { status: 200, type: 'text/event-stream', body: SSE_OK }
    : { status: 200, type: 'text/html', body: '<!doctype html><html><body>gateway</body></html>' })
  const result = await providers.testProvider('local')
  assert.equal(result.ok, true, result.detail)
  assert.deepEqual(requests.map((entry) => entry.url), ['/chat/completions'])
  assert.equal(result.detail, undefined, 'nothing to explain')
})

test('an answer the gateway really gave is never replaced by a retry', async () => {
  configure('', 'deepseek-flash')
  requests.length = 0
  // 401 is a real API answer: retrying under /v1 would hide the key problem behind a second failure.
  handler = () => ({ status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }) })
  const result = await providers.testProvider('local')
  assert.equal(result.ok, false)
  assert.match(result.detail ?? '', /401\/403/)
  // The 401 stands: no `/v1/chat/completions` was ever tried (the models probe may run, that is
  // the separate "which ids does this channel sell" question).
  assert.equal(requests.some((entry) => entry.url.includes('/v1/chat')), false)
})

test('a model the channel does not sell names the ids it does sell', async () => {
  configure('/v1', 'deepseek-flash-abliterated')
  requests.length = 0
  handler = (request) => {
    if (request.url === '/v1/models') {
      return { status: 200, body: JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-1-flash-261017' }] }) }
    }
    return {
      status: 503,
      body: JSON.stringify({
        error: {
          code: 'model_not_found',
          message: '分组 火山官转 下模型 deepseek-flash-abliterated 无可用渠道（distributor）'
        }
      })
    }
  }
  const result = await providers.testProvider('local')
  assert.equal(result.ok, false)
  assert.match(result.detail ?? '', /没有这个模型/)
  assert.deepEqual(result.available, ['deepseek-flash', 'deepseek-v4-1-flash-261017'])
})

test('a refused key, a 404 and a DNS failure each say what to fix', async () => {  assert.match(
    providers.describeProviderFailure('OpenAI API error (401): {"error":{"message":"Incorrect API key provided"}}'),
    /401\/403/
  )
  assert.match(providers.describeProviderFailure('404 page not found'), /404/)
  assert.match(providers.describeProviderFailure('getaddrinfo ENOTFOUND cdn.example.invalid'), /域名解析失败/)
  assert.match(providers.describeProviderFailure('<!doctype html><html></html>'), /少了 \/v1/)
  // A message nobody has a canned answer for is passed through, not replaced by "unknown error".
  assert.equal(providers.describeProviderFailure('some brand new failure'), 'some brand new failure')
})

test('both spellings are accepted and stored as typed', async () => {
  // Saving must not "helpfully" rewrite the address: the user typed it, the request layer copes.
  await providers.saveModelsJson(JSON.stringify({ providers: {
    bare: { api: 'openai-completions', baseUrl: 'https://host.example' },
    pathed: { api: 'openai-completions', baseUrl: 'https://host.example/openai' },
    versioned: { api: 'openai-completions', baseUrl: 'https://host.example/v1/' }
  } }))
  const written = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'))
  assert.equal(written.providers.bare.baseUrl, 'https://host.example')
  assert.equal(written.providers.pathed.baseUrl, 'https://host.example/openai')
  assert.equal(written.providers.versioned.baseUrl, 'https://host.example/v1/')
  // A bare OpenAI-compatible host is not an address problem any more; a pathed one still is not.
  assert.equal(providers.bareOpenAiBase('bare'), 'https://host.example')
  assert.equal(providers.bareOpenAiBase('pathed'), undefined)
  assert.equal(providers.bareOpenAiBase('versioned'), undefined)
  // The editor's hint is driven by the same question.
  assert.equal(url.needsVersionPath('https://host.example', 'openai-completions'), true)
  assert.equal(url.needsVersionPath('https://host.example/v1', 'openai-completions'), false)
  assert.equal(url.needsVersionPath('https://host.example', 'anthropic-messages'), false)
})
