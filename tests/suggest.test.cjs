/**
 * Next-message predictions: what gets sent, and which answers are worth showing.
 *
 * The provider call itself is exercised end to end by the suggestion smoke test; these cases pin the
 * rules that decide whether a guess is cheap (the context) and whether it is a next prompt or noise.
 */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-suggest-'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))

const outfile = path.join(temp, 'suggestion-text.cjs')
esbuild.buildSync({
  entryPoints: [path.join(root, 'apps/desktop/src/main/suggestion-text.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const {
  NO_SUGGESTION,
  MAX_SUGGESTION_CHARS,
  suggestionContext,
  renderSuggestionContext,
  cleanSuggestion,
  lastUserText
} = require(outfile)

const user = (text) => ({ role: 'user', content: text, timestamp: 1 })
const assistant = (blocks, extra = {}) => ({ role: 'assistant', content: blocks, timestamp: 2, ...extra })
const text = (value) => ({ type: 'text', text: value })
const toolCall = (name) => ({ type: 'toolCall', id: 'call_' + name, name, arguments: {} })

test('context: only the readable turns, with the tools each reply called', () => {
  const turns = suggestionContext([
    user('修一下登录的报错'),
    assistant([text('先看测试'), toolCall('run_bash'), toolCall('grep_files')]),
    { role: 'toolResult', toolCallId: 'call_run_bash', content: [text('FAILED auth.spec.ts')], timestamp: 3 },
    assistant([text('原因是 token 过期')])
  ])
  assert.deepEqual(turns, [
    { role: 'user', text: '修一下登录的报错' },
    { role: 'assistant', text: '先看测试', tools: ['run_bash', 'grep_files'] },
    { role: 'assistant', text: '原因是 token 过期' }
  ])
  assert.match(renderSuggestionContext(turns), /^用户：修一下登录的报错\n助手：先看测试（调用了 run_bash、grep_files）/)
})

test('context: a failed reply is dropped instead of analysed', () => {
  const turns = suggestionContext([
    user('跑测试'),
    assistant([text('400 Messages with role tool ...')], { stopReason: 'error' })
  ])
  assert.deepEqual(turns, [{ role: 'user', text: '跑测试' }])
  assert.equal(lastUserText(turns), '跑测试')
})

test('context: back-to-back user turns (a steer) read as one message', () => {
  const turns = suggestionContext([user('改成 v1'), user('再试一次'), assistant([text('好')])])
  assert.deepEqual(turns[0], { role: 'user', text: '改成 v1 再试一次' })
})

test('context: stays cheap — a tail of the session, clipped messages', () => {
  const messages = []
  for (let index = 0; index < 30; index += 1) {
    messages.push(user('问题 ' + index))
    messages.push(assistant([text('y'.repeat(5000))]))
  }
  const turns = suggestionContext(messages)
  assert(turns.length <= 8, 'keeps only the tail')
  for (const turn of turns) assert(turn.text.length <= 600, 'clips one long reply')
  // The newest exchange survives; the oldest does not.
  assert.equal(turns[turns.length - 2].text, '问题 29')
})

test('clean: the marker, an empty answer and rambling are all rejected', () => {
  assert.equal(cleanSuggestion(NO_SUGGESTION), undefined)
  assert.equal(cleanSuggestion(' no_suggestion '), undefined)
  assert.equal(cleanSuggestion(''), undefined)
  assert.equal(cleanSuggestion('   '), undefined)
  assert.equal(cleanSuggestion('x'.repeat(MAX_SUGGESTION_CHARS + 1)), undefined)
  assert.equal(cleanSuggestion('先把测试跑一遍。然后再提交。'), undefined)
})

test('clean: labels, quotes and trailing punctuation are stripped', () => {
  assert.equal(cleanSuggestion('建议：跑一下测试'), '跑一下测试')
  assert.equal(cleanSuggestion('"提交这个改动"'), '提交这个改动')
  assert.equal(cleanSuggestion('「再跑一次测试。」'), '再跑一次测试')
  assert.equal(cleanSuggestion('- next: run the tests'), 'run the tests')
  assert.equal(cleanSuggestion('```\n继续修复\n```'), '继续修复')
  assert.equal(cleanSuggestion('  把  日志\n贴出来 '), '把 日志 贴出来')
})

test('clean: a guess that only echoes the last prompt is not a suggestion', () => {
  assert.equal(cleanSuggestion('跑一下测试', '跑一下测试'), undefined)
  assert.equal(cleanSuggestion('跑一下测试', '修一下登录'), '跑一下测试')
})
