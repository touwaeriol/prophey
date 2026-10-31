/**
 * A message that is waiting is a message the user wrote, so it sits at their place in the transcript.
 *
 * It used to float over the chat area, pinned to the lower right: it read as a toast rather than as a
 * message on its way in, and it covered the run it was waiting for. `Conversation` now renders it
 * inline, right after the last turn, with the same actions (立即发送 / 撤回) — and the transcript is
 * deliberately not scrolled to it.
 */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
// Written inside the repo so `require('react')` resolves against the app's node_modules.
const temp = fs.mkdtempSync(path.join(root, 'tests', '.tmp-pending-'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))

function load(relative) {
  const outfile = path.join(temp, path.basename(relative) + '.cjs')
  esbuild.buildSync({
    entryPoints: [path.join(root, relative)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    packages: 'external'
  })
  return require(outfile)
}

const { PendingSends } = load('apps/desktop/src/renderer/src/components/PendingSends.tsx')
const { createElement } = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const steer = {
  id: 'p1',
  key: 'session-1',
  text: '完成后更新本地 app',
  images: [],
  promptText: '完成后更新本地 app',
  steerId: 's1',
  mode: 'steer'
}

const render = (props) => renderToStaticMarkup(createElement(PendingSends, {
  items: [steer],
  onSendNow: () => {},
  onCancel: () => {},
  ...props
}))

test('pending: the inline shape is a block in the transcript, not a floating overlay', () => {
  const html = render({ inline: true })
  assert.match(html, /class="pending-sends inline"/, 'it asks for the inline layout')
  assert.match(html, /待发送 · 等当前步骤结束/, 'it still says it has not been delivered')
  assert.match(html, /立即发送/, 'the hard interrupt stays available')
  assert.match(html, /撤回/, 'and it can still be taken back')
  assert.match(html, /完成后更新本地 app/, 'the text the user wrote is readable in place')
})

test('pending: the floating shape is still available for callers that want the overlay', () => {
  const html = render({})
  assert.match(html, /class="pending-sends "/, 'no inline class unless asked')
})

test('pending: nothing renders when nothing is waiting', () => {
  assert.equal(renderToStaticMarkup(createElement(PendingSends, {
    items: [], onSendNow: () => {}, onCancel: () => {}
  })), '')
})

test('pending: a message the engine already took offers no actions, only the state', () => {
  const html = renderToStaticMarkup(createElement(PendingSends, {
    items: [{ ...steer, mode: 'direct', steerId: undefined }],
    onSendNow: () => {},
    onCancel: () => {},
    inline: true
  }))
  assert.match(html, /正在发送 · 等引擎写入对话/)
  assert.doesNotMatch(html, /立即发送/, 'already accepted: interrupting would send it twice')
  assert.doesNotMatch(html, /撤回/)
})

test('pending: it lands at the end of the transcript, after the last turn', () => {
  const { Conversation } = load('apps/desktop/src/renderer/src/components/Conversation.tsx')
  const html = renderToStaticMarkup(createElement(Conversation, {
    items: [
      { id: 'm1', role: 'user', text: '跑一下测试', toolCalls: [], timestamp: 1 },
      { id: 'm2', role: 'assistant', text: '好的', toolCalls: [], timestamp: 2 }
    ],
    workspace: 'C:\\repo',
    connected: true,
    loggedIn: true,
    subagents: [],
    onOpenSubagent: () => {},
    onSuggestion: () => {},
    onEditTurn: () => {},
    sessionKey: 'session-1',
    pending: [steer],
    onSendNow: () => {},
    onCancel: () => {}
  }))
  assert.match(html, /class="conversation"/)
  const conversation = html.indexOf('class="conversation"')
  const lastTurn = html.lastIndexOf('好的')
  const pending = html.indexOf('pending-sends inline')
  assert.ok(conversation >= 0 && lastTurn > conversation, 'the transcript is there')
  assert.ok(pending > lastTurn, 'the waiting message sits after the last turn, not over the pane')
})

test('pending: an otherwise empty conversation still shows the waiting message', () => {
  const { Conversation } = load('apps/desktop/src/renderer/src/components/Conversation.tsx')
  const html = renderToStaticMarkup(createElement(Conversation, {
    items: [],
    workspace: 'C:\\repo',
    connected: true,
    loggedIn: true,
    subagents: [],
    onOpenSubagent: () => {},
    onSuggestion: () => {},
    onEditTurn: () => {},
    sessionKey: 'session-1',
    pending: [steer],
    onSendNow: () => {},
    onCancel: () => {}
  }))
  assert.doesNotMatch(html, /开始一段对话/, 'a message on its way in is not an empty conversation')
  assert.match(html, /完成后更新本地 app/)
})
