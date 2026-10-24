const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-usage-test-'))

let shared
let usage
let fetcherCalls = []

/** Real `GET /backend-api/wham/usage` shape (account-specific values redacted). */
const PRO_LIMIT_REACHED_AT_ZERO = {
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 8, limit_window_seconds: 604800, reset_after_seconds: 518419 },
    secondary_window: null
  },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 1 }
}

function payload(overrides = {}) {
  return {
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 8, limit_window_seconds: 18000, reset_at: 1793382125 },
      secondary_window: { used_percent: 16, limit_window_seconds: 604800, reset_at: 1793986925 }
    },
    ...overrides
  }
}

before(() => {
  for (const [name, source] of [
    ['shared', 'apps/desktop/src/shared/chatgpt-usage.ts'],
    ['main', 'apps/desktop/src/main/chatgpt-usage.ts']
  ]) {
    esbuild.buildSync({
      entryPoints: [path.join(root, source)],
      outfile: path.join(temp, name + '.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs'
    })
  }
  shared = require(path.join(temp, 'shared.cjs'))
})

after(() => {
  fs.rmSync(temp, { recursive: true, force: true })
})

beforeEach(() => {
  if (usage) usage.invalidateChatGptUsage()
  fetcherCalls = []
})

test('parses a real wham/usage payload into used / remaining windows', () => {
  const fetchedAt = 1792863622000
  const parsed = shared.parseChatGptUsage(PRO_LIMIT_REACHED_AT_ZERO, {
    source: 'codex-cli',
    fetchedAt
  })
  assert.equal(parsed.planType, 'pro')
  assert.equal(parsed.source, 'codex-cli')
  assert.equal(parsed.limitReached, false)
  assert.equal(parsed.fetchedAt, fetchedAt)
  assert.equal(parsed.windows.length, 1)
  const [window] = parsed.windows
  assert.equal(window.windowSeconds, 604800)
  assert.equal(window.usedPercent, 8)
  assert.equal(window.remainingPercent, 92)
  // `reset_after_seconds` is relative to the fetch, not absolute.
  assert.equal(window.resetsAt, fetchedAt + 518419 * 1000)
  assert.deepEqual(parsed.credits, { hasCredits: false, unlimited: false, balance: 0 })
  assert.equal(parsed.resetCredits, 2)
})

test('orders windows shortest first and floors the remaining percentage', () => {
  const parsed = shared.parseChatGptUsage(payload(), { source: 'openai-codex' })
  assert.deepEqual(
    parsed.windows.map((window) => window.windowSeconds),
    [18000, 604800]
  )
  assert.equal(parsed.windows[0].resetsAt, 1793382125000)
  assert.equal(shared.usageWindowsSummary(parsed), '剩余 92%（5 小时）｜84%（7 天）')

  const fractional = shared.parseChatGptUsage(
    {
      rate_limit: {
        primary_window: { used_percent: 8.6, limit_window_seconds: 18000 }
      }
    },
    { source: 'codex-cli' }
  )
  assert.equal(fractional.windows[0].remainingPercent, 91.4)
  // Summary floors so "0.4% 剩余" never shows up as a whole percent that is already gone.
  assert.equal(shared.usageWindowsSummary(fractional), '剩余 91%（5 小时）')
})

test('reports "limit reached" and tolerates missing windows or credits', () => {
  const reached = shared.parseChatGptUsage(
    { plan_type: 'plus', rate_limit: { allowed: false, limit_reached: true } },
    { source: 'codex-cli' }
  )
  assert.equal(reached.limitReached, true)
  assert.deepEqual(reached.windows, [])
  assert.equal(shared.usageWindowsSummary(reached), '')

  assert.equal(shared.parseChatGptUsage(null, { source: 'codex-cli' }), undefined)
  assert.equal(shared.parseChatGptUsage('nope', { source: 'codex-cli' }), undefined)
  assert.equal(shared.parseChatGptUsage({}, { source: 'codex-cli' }), undefined)
  // A window without a length is useless for "剩余多少" and is dropped instead of guessed.
  assert.deepEqual(
    shared.parseChatGptUsage(
      { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 40 } } },
      { source: 'codex-cli' }
    ).windows,
    []
  )
})

test('labels windows and explains the tooltip with reset, source and the OpenAI caveat', () => {
  assert.equal(shared.usageWindowLabel(18000), '5 小时')
  assert.equal(shared.usageWindowLabel(604800), '7 天')
  assert.equal(shared.usageWindowLabel(3600), '1 小时')
  assert.equal(shared.usageWindowLabel(90), '2 分钟')

  const parsed = shared.parseChatGptUsage(payload(), {
    source: 'codex-cli',
    fetchedAt: 1792863622000
  })
  const tooltip = shared.usageTooltip(parsed, 1792863622000)
  assert.match(tooltip, /ChatGPT PLUS/)
  assert.match(tooltip, /5 小时窗口已用 8%/)
  assert.match(tooltip, /7 天窗口已用 16%/)
  assert.match(tooltip, /天后重置/)
  assert.match(tooltip, /来源：本机 Codex CLI 登录/)
  assert.match(tooltip, /OpenAI 未向 “Sign in with ChatGPT” 凭据开放用量查询/)
  assert.equal(shared.CHATGPT_USAGE_URL, 'https://chatgpt.com/settings/usage')
})

/** A stub `fetch` that records the request and answers with `status` + JSON body. */
function stubFetcher(responses) {
  return async (url, init) => {
    fetcherCalls.push({ url, headers: init.headers })
    const next = responses.length > 1 ? responses.shift() : responses[0]
    const status = next.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next.body
    }
  }
}

const PI_DIR = path.join(temp, 'pi')
const CODEX_DIR = path.join(temp, 'codex')

function writeCredentials({ provider, cli }) {
  fs.mkdirSync(PI_DIR, { recursive: true })
  fs.mkdirSync(CODEX_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(PI_DIR, 'auth.json'),
    JSON.stringify(provider ? { 'openai-codex': provider } : {})
  )
  fs.writeFileSync(path.join(CODEX_DIR, 'auth.json'), JSON.stringify(cli ? { tokens: cli } : {}))
  if (!usage) {
    // `profile.ts` reads these at module load, so every test reuses the same directories.
    process.env.PI_CODING_AGENT_DIR = PI_DIR
    process.env.CODEX_HOME = CODEX_DIR
    usage = require(path.join(temp, 'main.cjs'))
  }
  usage.invalidateChatGptUsage()
}

test('fetches plan usage with the Codex credential and caches the answer', async () => {
  writeCredentials({
    provider: { type: 'oauth', access: 'provider-token', accountId: 'acct-1' },
    cli: { access_token: 'cli-token', account_id: 'acct-2' }
  })
  const fetcher = stubFetcher([{ body: PRO_LIMIT_REACHED_AT_ZERO }])

  const first = await usage.chatGptUsage({ fetcher })
  assert.equal(first.usage.source, 'openai-codex')
  assert.equal(first.usage.windows[0].remainingPercent, 92)
  assert.equal(fetcherCalls.length, 1)
  assert.equal(fetcherCalls[0].url, 'https://chatgpt.com/backend-api/wham/usage')
  // The account header is what lets the ChatGPT backend pick the right plan.
  assert.equal(fetcherCalls[0].headers['chatgpt-account-id'], 'acct-1')
  assert.equal(fetcherCalls[0].headers.authorization, 'Bearer provider-token')

  // Cached: opening settings again does not hit the network.
  await usage.chatGptUsage({ fetcher })
  assert.equal(fetcherCalls.length, 1)

  await usage.chatGptUsage({ force: true, fetcher })
  assert.equal(fetcherCalls.length, 2)
})

test('falls back to the Codex CLI login and explains a rejected credential', async () => {
  writeCredentials({ provider: undefined, cli: { access_token: 'cli-token', account_id: 'acct-2' } })
  const fetcher = stubFetcher([{ body: payload() }])
  const result = await usage.chatGptUsage({ fetcher })
  assert.equal(result.usage.source, 'codex-cli')
  assert.equal(fetcherCalls[0].headers['chatgpt-account-id'], 'acct-2')

  usage.invalidateChatGptUsage()
  const rejected = await usage.chatGptUsage({ fetcher: stubFetcher([{ status: 401, body: {} }]) })
  assert.equal(rejected.usage, undefined)
  assert.match(rejected.reason, /HTTP 401/)

  usage.invalidateChatGptUsage()
  const unparsable = await usage.chatGptUsage({ fetcher: stubFetcher([{ body: { nope: true } }]) })
  assert.match(unparsable.reason, /无法解析/)
})

test('tries the next credential when the first one is refused', async () => {
  writeCredentials({
    provider: { type: 'oauth', access: 'provider-token', accountId: 'acct-1' },
    cli: { access_token: 'cli-token', account_id: 'acct-2' }
  })
  const fetcher = stubFetcher([{ status: 403, body: {} }, { body: payload() }])
  const result = await usage.chatGptUsage({ fetcher })
  assert.equal(result.usage.source, 'codex-cli')
  assert.equal(fetcherCalls.length, 2)
})

test('says why a ChatGPT sign-in alone cannot show a number', async () => {
  writeCredentials({ provider: undefined, cli: undefined })
  const result = await usage.chatGptUsage({ fetcher: stubFetcher([{ body: payload() }]) })
  assert.equal(result.usage, undefined)
  assert.match(result.reason, /Codex/)
  assert.equal(fetcherCalls.length, 0)
})
