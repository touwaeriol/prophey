/**
 * Scratch probe: does this Codex build accept the experimental prediction flags?
 * No model call is made: the fork is rejected or accepted on validation alone.
 */
import { spawn } from 'node:child_process'

const bin = process.env.CODEX_BIN || 'codex'
const [command, args] = bin.endsWith('.js')
  ? [process.execPath, [bin, 'app-server', '--listen', 'stdio://']]
  : [bin, ['app-server', '--listen', 'stdio://']]
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buffer = ''
const pending = new Map()
const notifications = []
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    } else if (message.method) notifications.push(message.method)
  }
})
child.stderr.on('data', () => {})
let nextId = 1
const call = (method, params, timeoutMs = 20000) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.delete(id)) resolve({ timeout: true, method })
    }, timeoutMs)
  })
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
const show = (label, reply) => {
  const error = reply.error
  console.log(label, '->', error ? `ERROR ${error.code}: ${error.message.slice(0, 300)}` : `OK ${JSON.stringify(reply.result).slice(0, 200)}`)
}

const main = async () => {
  await call('initialize', {
    clientInfo: { name: 'prophey-prediction-probe', version: '0.0.0' },
    capabilities: { experimentalApi: true }
  })
  notify('initialized', {})
  const started = await call('thread/start', {
    cwd: process.cwd(),
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'never'
  })
  const threadId = started.result?.thread?.id ?? started.result?.threadId
  console.log('thread/start ->', threadId ? 'thread ' + threadId : JSON.stringify(started).slice(0, 300))
  if (!threadId) return
  // 1. prediction flag on an ephemeral fork: accepted, or named as an unknown field.
  show('thread/fork ephemeral+prediction', await call('thread/fork', {
    threadId,
    ephemeral: true,
    experimentalPredictionMode: true
  }))
  // 2. the flag without `ephemeral`: the server validates the combination only if it reads the field.
  show('thread/fork prediction only', await call('thread/fork', {
    threadId,
    experimentalPredictionMode: true
  }))
  // 3. the composer prediction source, which the unload rule keys on.
  show('thread/start composer_predictions', await call('thread/start', {
    cwd: process.cwd(),
    ephemeral: true,
    threadSource: 'composer_predictions',
    sandbox: 'read-only',
    approvalPolicy: 'never'
  }))
  console.log('notifications seen:', [...new Set(notifications)].join(', '))
}
main().finally(() => {
  child.stdin.end()
  child.kill()
})
