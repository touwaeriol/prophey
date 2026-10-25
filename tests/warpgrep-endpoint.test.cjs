/**
 * Desktop WarpGrep with a custom endpoint: the same tool, two backends.
 *
 * `warpgrep.ts` keeps the fine-tuned Morph path untouched (no system prompt, `finish` only) and
 * routes a configured `warpgrep.baseUrl` through the shared loop in `packages/warpgrep-mcp`, which a
 * general chat model needs: system prompt, `finish` fallback, verified paths.
 */
const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-warpgrep-'))
const repo = path.join(temp, 'repo')
fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
fs.writeFileSync(path.join(repo, 'src', 'auth.ts'), ['export function login() {}', '// ROUTE_GUARD', ''].join('\n'))
fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 1\n')

let script = []
let requests = []
let status = 200
const api = http.createServer((request, response) => {
  let body = ''
  request.on('error', () => {})
  response.on('error', () => {})
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    requests.push({ url: request.url, ...JSON.parse(body) })
    if (status !== 200) {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'scripted' }))
      return
    }
    const next = script.shift() ?? { role: 'assistant', content: '' }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: next }] }))
  })
})

let baseUrl
let WarpGrep
let WarpGrepError
before(async () => {
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${api.address().port}`
  // The hosted path builds its URL at import time from this env var, exactly like the real app.
  process.env.AGENT_DESKTOP_MORPH_BASE = `${baseUrl}/v1`
  const bundle = path.join(temp, 'warpgrep.cjs')
  esbuild.buildSync({
    entryPoints: [path.join(root, 'apps/desktop/src/main/warpgrep.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external'
  })
  ;({ WarpGrep, WarpGrepError } = require(bundle))
})

after(() => {
  api.close()
  fs.rmSync(temp, { recursive: true, force: true })
})

beforeEach(() => {
  script = []
  requests = []
  status = 200
})

const toolCall = (name, args, id = 'call_1') => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
})

test('warpgrep: the default backend is still Morph — no system prompt, model unchanged', async () => {
  script = [toolCall('finish', { files: 'src/auth.ts:1-2' })]
  const result = await new WarpGrep(repo, { apiKey: 'morph-key' }).search('where is auth?')
  assert.equal(result.files, 'src/auth.ts:1-2')
  assert.equal(requests[0].model, 'morph-warp-grep-v2.1')
  assert.match(requests[0].url, /^\/v1\/chat\/completions$/)
  assert.deepEqual(requests[0].messages.map((message) => message.role), ['user'])
  assert.equal(requests[0].messages[0].content, 'where is auth?')
})

test('warpgrep: a custom endpoint gets the system prompt and DeepSeek as the default model', async () => {
  script = [toolCall('finish', { files: 'src/auth.ts:2', answer: '在 auth.ts 里' }, 'call_2')]
  const result = await new WarpGrep(repo, { apiKey: 'ds-key', baseUrl: baseUrl + '/v1' }).search('auth?')
  assert.equal(result.files, 'src/auth.ts:2')
  assert.equal(result.answer, '在 auth.ts 里')
  assert.equal(requests[0].model, 'deepseek-flash')
  assert.match(requests[0].messages[0].content, /code search agent/)
  assert.equal(requests[0].tools.length, 5)
  assert.equal(requests[0].messages[1].content, 'auth?')
})

test('warpgrep: a custom endpoint honours the configured model', async () => {
  script = [toolCall('finish', { files: 'src/other.ts' })]
  await new WarpGrep(repo, { apiKey: 'k', baseUrl: baseUrl + '/v1', model: 'deepseek-v4-pro' }).search('x')
  assert.equal(requests[0].model, 'deepseek-v4-pro')
})

test('warpgrep: paths the custom model invents never reach the tool result', async () => {
  script = [toolCall('finish', { files: 'src/ghost.ts:1-9\nsrc/other.ts:1' })]
  const result = await new WarpGrep(repo, { apiKey: 'k', baseUrl: baseUrl + '/v1' }).search('x')
  assert.equal(result.files, 'src/other.ts:1')
  assert.deepEqual(result.dropped, ['src/ghost.ts:1-9'])
})

test('warpgrep: a custom model that answers in prose is nudged into finish once', async () => {
  script = [
    { role: 'assistant', content: 'It is in src/auth.ts:2' },
    toolCall('finish', { files: 'src/auth.ts:2' }, 'call_2')
  ]
  const result = await new WarpGrep(repo, { apiKey: 'k', baseUrl: baseUrl + '/v1' }).search('auth?')
  assert.equal(result.files, 'src/auth.ts:2')
  assert.equal(requests[1].messages.at(-1).content, 'Call finish now with the files you found (files="" if none).')
})

test('warpgrep: Morph keeps its own behaviour — prose is returned as an answer, not retried', async () => {
  script = [{ role: 'assistant', content: 'no idea' }]
  const result = await new WarpGrep(repo, { apiKey: 'morph-key' }).search('auth?')
  assert.equal(result.files, '')
  assert.equal(result.answer, 'no idea')
  assert.equal(requests.length, 1, 'the hosted model is not nudged')
})

test('warpgrep: a missing key names the endpoint instead of failing at fetch time', async () => {
  await assert.rejects(
    () => new WarpGrep(repo, { baseUrl: 'https://api.deepseek.com/v1' }).search('auth?'),
    (error) => error instanceof WarpGrepError && error.code === 'WARP_NO_KEY' && /deepseek/.test(error.message)
  )
  await assert.rejects(
    () => new WarpGrep(repo, {}).search('auth?'),
    (error) => error instanceof WarpGrepError && /Morph API Key/.test(error.message)
  )
})

test('warpgrep: a custom endpoint that refuses the call surfaces as a typed error', async () => {
  status = 401
  await assert.rejects(
    () => new WarpGrep(repo, { apiKey: 'bad', baseUrl: baseUrl + '/v1' }).search('auth?'),
    (error) => error instanceof WarpGrepError && error.code === 'UNAUTHORIZED'
  )
})
