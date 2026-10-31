/**
 * A Base URL without `/v1` must work **without being rewritten**.
 *
 * The adapter appends `/chat/completions` to whatever it is given, so a gateway that serves its API
 * under `/v1` answers the bare form with its web page. The request is sent as typed and retried once
 * with `/v1` — only when the answer is clearly not the API. These tests pin the rules of that retry;
 * `provider-test.test.cjs` drives the real runtime end to end.
 */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-provider-fetch-'))
esbuild.buildSync({
  entryPoints: [path.join(root, 'apps/desktop/src/main/provider-fetch.ts')],
  outfile: path.join(temp, 'provider-fetch.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const {
  createCompatFetch,
  looksLikeWrongBase,
  withVersionSegment
} = require(path.join(temp, 'provider-fetch.cjs'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))

const response = (status, type = 'application/json') => new Response('{}', { status, headers: { 'content-type': type } })

/** A fake fetch that answers from a table keyed by URL and records what it was asked. */
function fakeFetch(table) {
  const seen = []
  const impl = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push(url)
    const answer = table[url]
    if (!answer) throw new Error('unexpected request: ' + url)
    return typeof answer === 'function' ? answer() : answer
  }
  return { impl, seen }
}

test('only a web page or a missing route counts as "wrong address"', () => {
  assert.equal(looksLikeWrongBase(response(200, 'text/html; charset=utf-8')), true)
  assert.equal(looksLikeWrongBase(response(404)), true)
  assert.equal(looksLikeWrongBase(response(405)), true)
  // A real API answer keeps its meaning: a wrong key is not an address problem.
  assert.equal(looksLikeWrongBase(response(401)), false)
  assert.equal(looksLikeWrongBase(response(400)), false)
  assert.equal(looksLikeWrongBase(response(429)), false)
  assert.equal(looksLikeWrongBase(response(200, 'text/event-stream')), false)
})

test('the version segment is only inserted where it belongs', () => {
  assert.equal(withVersionSegment('https://host.example', 'https://host.example/chat/completions'), 'https://host.example/v1/chat/completions')
  // Already versioned, another host, or a path the user chose: never touched.
  assert.equal(withVersionSegment('https://host.example', 'https://host.example/v1/chat/completions'), undefined)
  assert.equal(withVersionSegment('https://host.example', 'https://other.example/chat/completions'), undefined)
  assert.equal(withVersionSegment('https://host.example/v1', 'https://host.example/v1/chat/completions'), undefined)
})

test('the address as typed is tried first, and the /v1 answer is what comes back', async () => {
  const { impl, seen } = fakeFetch({
    'https://host.example/chat/completions': () => response(200, 'text/html'),
    'https://host.example/v1/chat/completions': () => response(200, 'text/event-stream')
  })
  const fallbacks = []
  const fetch = createCompatFetch(
    { bareBase: 'https://host.example' },
    { base: impl, onFallback: (from, to) => fallbacks.push([from, to]) }
  )
  const answer = await fetch('https://host.example/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'm' })
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.headers.get('content-type'), 'text/event-stream')
  assert.deepEqual(seen, ['https://host.example/chat/completions', 'https://host.example/v1/chat/completions'])
  assert.deepEqual(fallbacks, [['https://host.example/chat/completions', 'https://host.example/v1/chat/completions']])
})

test('a working bare address is not retried, and nothing is reported', async () => {
  const { impl, seen } = fakeFetch({
    'https://host.example/chat/completions': () => response(200, 'text/event-stream')
  })
  const fallbacks = []
  const fetch = createCompatFetch(
    { bareBase: 'https://host.example' },
    { base: impl, onFallback: (from, to) => fallbacks.push([from, to]) }
  )
  const answer = await fetch('https://host.example/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(answer.headers.get('content-type'), 'text/event-stream')
  assert.deepEqual(seen, ['https://host.example/chat/completions'])
  assert.deepEqual(fallbacks, [])
})

test('a body that cannot be sent twice gets one attempt only', async () => {
  const { impl, seen } = fakeFetch({
    'https://host.example/chat/completions': () => response(200, 'text/html')
  })
  const fetch = createCompatFetch({ bareBase: 'https://host.example' }, { base: impl })
  // A ReadableStream body has already been consumed by the first attempt.
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close() } })
  const answer = await fetch('https://host.example/chat/completions', { method: 'POST', body, duplex: 'half' })
  assert.equal(answer.status, 200)
  assert.deepEqual(seen, ['https://host.example/chat/completions'])
})

test('a pathed address is left completely alone', async () => {
  const { impl, seen } = fakeFetch({
    'https://host.example/openai/chat/completions': () => response(200, 'text/html')
  })
  const fetch = createCompatFetch({ bareBase: undefined }, { base: impl })
  const answer = await fetch('https://host.example/openai/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(answer.status, 200)
  assert.deepEqual(seen, ['https://host.example/openai/chat/completions'])
})
