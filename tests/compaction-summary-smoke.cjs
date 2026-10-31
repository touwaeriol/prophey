/**
 * Compaction rewrites the transcript into a single summary message. The window used to keep painting
 * the turns the model could no longer see, and the summary itself only appeared after a manual
 * reload. Now the `compaction_end` event replaces the conversation with the summary, painted as the
 * ordinary (editable) user message it is.
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
  // The transcript is the summary now; keeping the old turns on screen would show history the model
  // can no longer see.
  assert.equal(await shown('COMPACTED_TURN_SENTINEL'), false, 'compacted turns leave the window')
  assert.equal(await evaluate('document.querySelectorAll(".message.user").length'), 1, 'one user bubble: the summary')
  assert.equal(await evaluate('document.querySelectorAll(".message-images").length'), 0)
  assert.match(await evaluate('document.querySelector(".user-bubble-text").textContent'), /【此前对话摘要】[\s\S]*目标：修好登录界面/)

  // Same affordance as any other user turn: it can be rewritten, which resends from that point.
  assert.equal(
    await evaluate('!!document.querySelector(".message.user .user-edit-open")'),
    true,
    'the summary can be edited'
  )
  await evaluate('document.querySelector(".user-edit-open").click()')
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
  assert.equal(await evaluate('!!document.querySelector(".message.user")'), true, 'the summary survives the edit')

  // Engines that compact privately (Claude / Codex) send no message; their event must not empty the
  // window, because their transcript is not ours to rewrite.
  window.webContents.send('pi:event', { type: 'compaction_end', sessionKey: key })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await shown('目标：修好登录界面'), true, 'a summary-less compaction keeps the window')

  setSessionFixture(undefined)
  window.webContents.send('pi:status', idle)
  await until(async () => !(await shown('目标：修好登录界面')))
  console.log('Compaction summary passed: replaces the transcript, is editable, and a summary-less compaction changes nothing')
}
