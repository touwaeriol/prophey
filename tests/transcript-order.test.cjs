const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-transcript-order-'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))

const outfile = path.join(temp, 'order.cjs')
esbuild.buildSync({
  entryPoints: [path.join(root, 'apps/desktop/src/main/agent/transcript-order.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const { orderToolResults } = require(outfile)

const user = (text) => ({ role: 'user', content: text, timestamp: 1 })
const call = (id, name = 'read_file') => ({ type: 'toolCall', id, name, arguments: { path: 'a.ts' } })
const assistant = (...content) => ({ role: 'assistant', content, stopReason: 'toolUse', timestamp: 2 })
const result = (id, text = 'ok', name = 'read_file') => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: name,
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: 3
})
const roles = (messages) => messages.map((message) => message.role)
const ids = (messages) =>
  messages.filter((message) => message.role === 'toolResult').map((message) => message.toolCallId)

/** The invariant every OpenAI-compatible endpoint enforces on the wire. */
function assertLegal(messages) {
  const open = new Set()
  for (const message of messages) {
    if (message.role === 'assistant') {
      assert.equal(open.size, 0, 'a tool call batch must be answered before the model speaks again')
      for (const block of message.content) if (block.type === 'toolCall') open.add(block.id)
      continue
    }
    if (message.role === 'toolResult') {
      assert.ok(open.has(message.toolCallId), `tool result ${message.toolCallId} answers no call`)
      open.delete(message.toolCallId)
      continue
    }
    assert.equal(open.size, 0, `a ${message.role} message interrupts a tool call batch`)
  }
  assert.equal(open.size, 0, 'every tool call needs a result')
}

test('a valid transcript comes back untouched', () => {
  const transcript = [
    user('go'),
    assistant({ type: 'text', text: 'reading' }, call('a'), call('b')),
    result('a'),
    result('b'),
    assistant({ type: 'text', text: 'done' })
  ]
  const ordered = orderToolResults(transcript)
  assert.deepEqual(roles(ordered), roles(transcript))
  assert.deepEqual(ids(ordered), ['a', 'b'])
  for (const [index, message] of ordered.entries()) assert.equal(message, transcript[index])
  assertLegal(ordered)
})

test('a steer that landed inside a tool batch is moved after its results', () => {
  // How it looked in the broken session: assistant(toolCall) → user → toolResult.
  const transcript = [user('go'), assistant(call('call_00')), user('改成 api.deepseek.com'), result('call_00')]
  const ordered = orderToolResults(transcript)
  assert.deepEqual(roles(ordered), ['user', 'assistant', 'toolResult', 'user'])
  assert.deepEqual(ids(ordered), ['call_00'])
  assert.equal(ordered[3].content, '改成 api.deepseek.com')
  assertLegal(ordered)
})

test('results are gathered in call order even when a notice splits them', () => {
  const transcript = [
    assistant(call('a'), call('b'), call('c')),
    result('a'),
    { role: 'user', content: '<system-reminder>task done</system-reminder>', timestamp: 4 },
    result('c'),
    result('b')
  ]
  const ordered = orderToolResults(transcript)
  assert.deepEqual(roles(ordered), ['assistant', 'toolResult', 'toolResult', 'toolResult', 'user'])
  assert.deepEqual(ids(ordered), ['a', 'c', 'b'])
  assertLegal(ordered)
})

test('a call interrupted before it returned gets a placeholder result', () => {
  const transcript = [assistant(call('a'), call('b')), result('a'), user('stop'), assistant({ type: 'text', text: '已停止' })]
  const ordered = orderToolResults(transcript)
  assert.deepEqual(roles(ordered), ['assistant', 'toolResult', 'toolResult', 'user', 'assistant'])
  const placeholder = ordered[2]
  assert.equal(placeholder.toolCallId, 'b')
  assert.equal(placeholder.toolName, 'read_file')
  assert.equal(placeholder.isError, true)
  assert.match(placeholder.content[0].text, /no result/)
  assertLegal(ordered)
})

test('a result whose call is gone becomes a user message instead of an orphan tool turn', () => {
  const transcript = [
    result('lost', 'file contents'),
    user('continue'),
    assistant({ type: 'text', text: 'ok' })
  ]
  const ordered = orderToolResults(transcript)
  assert.deepEqual(roles(ordered), ['user', 'user', 'assistant'])
  assert.match(ordered[0].content[0].text, /tool result lost \(read_file\)/)
  assert.equal(ordered[0].content[1].text, 'file contents')
  assertLegal(ordered)
})

test('a duplicated result line cannot produce two tool turns for one call', () => {
  const transcript = [assistant(call('a')), result('a'), result('a')]
  const ordered = orderToolResults(transcript)
  assert.deepEqual(roles(ordered), ['assistant', 'toolResult', 'user'])
  assertLegal(ordered)
})

test('consecutive batches each keep their own results', () => {
  const transcript = [
    assistant(call('a')),
    result('a'),
    user('next'),
    assistant(call('b')),
    user('steer'),
    result('b')
  ]
  const ordered = orderToolResults(transcript)
  assert.deepEqual(roles(ordered), ['assistant', 'toolResult', 'user', 'assistant', 'toolResult', 'user'])
  assertLegal(ordered)
})

test('a result that arrives after the model spoke again becomes a user turn', () => {
  // A resumed file can hold the answer to a call that a later batch already replaced.
  const transcript = [assistant(call('a')), assistant({ type: 'text', text: 'sorry' }), result('a', 'late output')]
  const ordered = orderToolResults(transcript)
  assert.deepEqual(roles(ordered), ['assistant', 'toolResult', 'assistant', 'user'])
  assert.match(ordered[3].content[1].text, /late output/)
  assertLegal(ordered)
})

test('the transcript itself is never mutated', () => {
  const transcript = [assistant(call('a')), user('steer'), result('a')]
  const snapshot = JSON.stringify(transcript)
  orderToolResults(transcript)
  assert.equal(JSON.stringify(transcript), snapshot)
})
