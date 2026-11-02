/**
 * Compaction folds what the model reads into a summary message; it does not take the conversation away.
 *
 * The user asked for exactly that after a session lost its history to a summary bubble: the window
 * keeps every turn, the summary is inserted where the compaction happened (painted as the ordinary,
 * editable user message it is), and only what the model receives starts at that summary.
 */
const assert = require('node:assert/strict')

module.exports = async function compactionSummarySmoke(evaluate, until, window, setSessionFixture) {
  const idle = await evaluate('window.pi.getStatus()')
  const key = 'compaction-summary-smoke-fixture'
  const shown = (text) => evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`)
  const summary = '【此前对话摘要】\n目标：修好登录界面。\n未完成：错误提示的文案。'
  setSessionFixture({
    sessionKey: key,
    messages: [
      { role: 'user', content: '先把登录界面改了', timestamp: Date.now() - 2000 },
      { role: 'assistant', content: [{ type: 'text', text: 'COMPACTED_TURN_SENTINEL' }], timestamp: Date.now() - 1000 }
    ]
  })
  window.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: undefined, sessionName: 'compaction probe' })
  await until(() => shown('COMPACTED_TURN_SENTINEL'), 'seeded conversation')
  assert.equal(await evaluate('document.querySelectorAll(".message.user").length'), 1)

  window.webContents.send('pi:event', {
    type: 'compaction_end',
    summary: '目标：修好登录界面。',
    message: { role: 'user', content: summary, timestamp: Date.now() },
    sessionKey: key
  })
  await until(() => shown('目标：修好登录界面'), 'summary painted')
  // The turns stay: the user still sees the conversation they had, the model just stops reading all
  // of it. Replacing the window with the summary is what lost a real session's history.
  assert.equal(await shown('COMPACTED_TURN_SENTINEL'), true, 'the conversation stays in the window')
  assert.equal(await shown('先把登录界面改了'), true, 'the earlier user turn stays too')
  assert.equal(await evaluate('document.querySelectorAll(".message.user").length'), 2, 'the summary is added after it')
  assert.equal(await evaluate('document.querySelectorAll(".message-images").length'), 0)
  // The summary is the last user bubble, in the same style as any other user turn.
  assert.match(
    await evaluate('[...document.querySelectorAll(".user-bubble-text")].at(-1).textContent'),
    /【此前对话摘要】[\s\S]*目标：修好登录界面/
  )

  // Same affordance as any other user turn: it can be rewritten, which resends from that point.
  assert.equal(
    await evaluate('!![...document.querySelectorAll(".message.user")].at(-1).querySelector(".user-edit-open")'),
    true,
    'the summary can be edited'
  )
  await evaluate('[...document.querySelectorAll(".message.user")].at(-1).querySelector(".user-edit-open").click()')
  await until(() => evaluate('!!document.querySelector(".user-edit-input")'), 'editor opens on the summary')
  assert.equal(await evaluate('document.querySelector(".user-edit-input").value'), summary)
  assert.equal(
    await evaluate('document.querySelector(".user-edit-hint").textContent.trim()'),
    '发送后，这条之后的对话会被丢弃'
  )
  await evaluate(`(() => {
    const area = document.querySelector('.user-edit-input')
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })()`)
  await until(() => evaluate('!document.querySelector(".user-edit-input")'), 'escape cancels the edit')
  assert.equal(
    await evaluate('[...document.querySelectorAll(".message.user")].at(-1).textContent.includes("【此前对话摘要】")'),
    true,
    'the summary survives the edit'
  )

  // Engines that compact privately (Claude / Codex) send no message; their event must not touch the
  // window, because their transcript is not ours to rewrite.
  const before = await evaluate('document.querySelectorAll(".message").length')
  window.webContents.send('pi:event', { type: 'compaction_end', sessionKey: key })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await evaluate('document.querySelectorAll(".message").length'), before, 'a summary-less event adds nothing')
  assert.equal(await shown('目标：修好登录界面'), true, 'a summary-less compaction keeps the window')

  // A failed compaction says so and changes nothing: the conversation continues as it was.
  window.webContents.send('pi:event', {
    type: 'compaction_failed',
    error: '压缩被中断（模型只回了「[Request interrupted by user]」），原对话保持不变',
    sessionKey: key
  })
  await until(() => shown('压缩没有完成'), 'the failure is named')
  assert.equal(await evaluate('document.querySelectorAll(".message").length'), before, 'a failed compaction leaves the window alone')
  assert.equal(await shown('COMPACTED_TURN_SENTINEL'), true)

  setSessionFixture(undefined)
  window.webContents.send('pi:status', idle)
  await until(async () => !(await shown('目标：修好登录界面')))
  console.log('Compaction summary passed: the history stays, the summary is inserted and editable, and a failed compaction changes nothing')
}
