const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const sourceDir = path.join(root, 'apps/desktop/src/main')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-provider-errors-'))

/**
 * The engine against a fake provider, the way `context-usage.test.cjs` does it.
 *
 * These cases come from a real failing session: the provider answered 503 `model_not_found` and
 * the window showed 「模型返回了空回复，请检查模型配置后重试」 with a page of raw JSON underneath.
 */
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
const model = { id: 'flaky', provider: 'mock', api: 'openai-completions', contextWindow: 200000, maxTokens: 4000 };
export async function listModelChoices() { return [{ id: 'flaky', provider: 'mock', contextWindow: 200000 }] }
export async function thinkingLevelsFor() { return ['off'] }
export async function getRuntime() { return {
  getModel() { return model },
  async *streamSimple() {
    globalThis.__calls = (globalThis.__calls ?? 0) + 1;
`

/** The provider's own failure message, as this aggregator really writes it. */
const MODEL_NOT_FOUND =
  '503: {"code":"model_not_found","message":"分组 火山官转 下模型 deepseek-flash-abliterated 无可用渠道（distributor） (request id: 202610301057074195781688268d9d6aoQJ)"}'

/** An ended stream that carries a provider error instead of an answer: what the SDK delivers. */
const failedStream = engineWith(HEADER + `
    yield { type: 'done', message: {
      role: 'assistant', content: [], api: 'openai-completions', provider: 'mock', model: 'flaky',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
      stopReason: 'error', timestamp: Date.now(),
      errorMessage: ${JSON.stringify(MODEL_NOT_FOUND)}
    } };
  }
} }
`)

/** A thrown provider error, as the stream adapter does when the request never starts. */
const thrownError = engineWith(HEADER + `
    throw Object.assign(new Error('请求未开始'), {});
  }
} }
`)

const retryThenSucceed = engineWith(HEADER + `
    if (globalThis.__calls === 1) throw new Error('socket hang up');
    yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
  }
} }
`)

after(() => {
  delete globalThis.__calls
  fs.rmSync(temp, { recursive: true, force: true })
})

function collect() {
  const events = []
  return { events, onEvent: event => events.push(event) }
}

test('a stream that ends in a provider error reports that error, not an empty reply', async () => {
  globalThis.__calls = 0
  const { events, onEvent } = collect()
  const engine = new failedStream({ onStatus() {}, onEvent, onSettled() {} })
  try {
    await engine.start(temp, { model: { provider: 'mock', id: 'flaky' } })
    const result = await engine.prompt('帮我做一个人机验证')
    assert.equal(result.ok, false)
    // The provider's reason, not a hint about the configuration.
    assert.match(result.error, /model_not_found/)
    assert.match(result.error, /deepseek-flash-abliterated/)
    assert.doesNotMatch(result.error, /空回复/)
    // And it stays readable: the raw message object carried usage/cost/timestamp nobody can use.
    assert.doesNotMatch(result.error, /"usage"/)
    assert.doesNotMatch(result.error, /"stopReason"/)

    // The transcript holds the same one line, so reloading the session does not show JSON.
    const messages = await engine.messages()
    const last = messages.at(-1)
    assert.equal(last.role, 'assistant')
    assert.equal(last.stopReason, 'error')
    const text = last.content.map(block => block.text ?? '').join('')
    assert.equal(text, result.error)
    assert.doesNotMatch(text, /"usage"/)

    // A model the account cannot reach is not going to appear on the second try.
    assert.equal(globalThis.__calls, 1, 'a missing model is not retried')
    assert.equal(events.filter(event => event.type === 'auto_retry_start').length, 0)    // The round still closes cleanly, so the composer is usable again.
    assert.equal(engine.state().isStreaming, false)
  } finally { engine.dispose() }
})

test('a provider failure object without a readable field still says something useful', async () => {
  globalThis.__calls = 0
  const engine = new thrownError({ onStatus() {}, onEvent() {}, onSettled() {} })
  try {
    await engine.start(temp, { model: { provider: 'mock', id: 'flaky' } })
    const result = await engine.prompt('hi')
    assert.equal(result.ok, false)
    // Never the bare `[object Object]` or a JSON dump.
    assert.doesNotMatch(result.error, /^\s*\{/)
    assert.equal(result.error.length > 0, true)
  } finally { engine.dispose() }
})

test('a transient failure is still retried, and the retry can succeed', async () => {
  globalThis.__calls = 0
  const { events, onEvent } = collect()
  const engine = new retryThenSucceed({ onStatus() {}, onEvent, onSettled() {} })
  try {
    await engine.start(temp, { model: { provider: 'mock', id: 'flaky' } })
    const result = await engine.prompt('hi')
    assert.equal(result.ok, true, 'one dropped connection must not end the turn')
    assert.equal(globalThis.__calls, 2)
    assert.equal(events.filter(event => event.type === 'auto_retry_start').length, 1)
    // The reason travels with the retry, so the window never shows a bare 「重试失败」.
    const ended = events.filter(event => event.type === 'auto_retry_end')
    assert.equal(ended.length, 1)
    assert.match(String(ended[0].finalError), /socket hang up/)
  } finally { engine.dispose() }
})
