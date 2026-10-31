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

test('a Base URL without a path is reported as a web page, not a protocol problem', async () => {
  configure('', 'deepseek-flash')
  handler = () => ({ status: 200, type: 'text/html', body: '<!doctype html><html><body>gateway</body></html>' })
  const result = await providers.testProvider('local')
  assert.equal(result.ok, false)
  assert.match(result.detail ?? '', /少了 \/v1/)
  // The adapter really did ask the host root for a completion: that is the bug being reported.
  assert(requests.some((entry) => entry.url === '/chat/completions'), JSON.stringify(requests.map(r => r.url)))
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

test('both spellings of an OpenAI Base URL mean the same thing', async () => {
  const file = {
    providers: {
      bare: { api: 'openai-completions', baseUrl: 'https://host.example' },
      pathed: { api: 'openai-completions', baseUrl: 'https://host.example/openai' },
      versioned: { api: 'openai-completions', baseUrl: 'https://host.example/v1/' },
      // The anthropic adapter adds `/v1/messages` itself, so a bare host is correct there.
      claude: { api: 'anthropic-messages', baseUrl: 'https://host.example' }
    }
  }
  providers.normalizeBaseUrls(file)
  assert.equal(file.providers.bare.baseUrl, 'https://host.example/v1')
  assert.equal(file.providers.pathed.baseUrl, 'https://host.example/openai')
  assert.equal(file.providers.versioned.baseUrl, 'https://host.example/v1/')
  assert.equal(file.providers.claude.baseUrl, 'https://host.example')
  assert.equal(url.withVersionPath('not a url'), 'not a url')
  // Saving is the choke point: the file on disk is what pi reads.
  await providers.saveModelsJson(
    JSON.stringify({ providers: { bare: { api: 'openai-responses', baseUrl: 'https://host.example' } } })
  )
  const written = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'))
  assert.equal(written.providers.bare.baseUrl, 'https://host.example/v1')
})
