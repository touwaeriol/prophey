/**
 * Raw /v1/messages check for a custom endpoint. The token comes from the environment so it is never
 * written into a file or printed: it only exists in the shell invocation.
 *
 *   ANTHROPIC_BASE_URL=https://cdn.api.codingplus.ai ANTHROPIC_AUTH_TOKEN=sk-... \
 *     node artifacts/cc-camel-probe/ping.mjs [model]
 */
import https from 'node:https'

const base = (process.env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '')
const token = process.env.ANTHROPIC_AUTH_TOKEN ?? ''
const model = process.argv[2] ?? 'claude-opus-5-5'

if (!base || !token) {
  console.error('set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN')
  process.exit(2)
}

const body = JSON.stringify({
  model,
  max_tokens: 64,
  messages: [{ role: 'user', content: '只回复两个字：收到' }]
})

const url = new URL(base + '/v1/messages')
const request = https.request(
  {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'anthropic-version': '2023-06-01',
      authorization: `Bearer ${token}`,
      'x-api-key': token
    },
    timeout: 60_000
  },
  (response) => {
    let raw = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => (raw += chunk))
    response.on('end', () => {
      console.log('status:', response.statusCode)
      console.log('body:', raw.slice(0, 600))
    })
  }
)
request.on('timeout', () => request.destroy(new Error('timeout')))
request.on('error', (error) => {
  console.error('request failed:', error.message)
  process.exitCode = 1
})
request.end(body)
