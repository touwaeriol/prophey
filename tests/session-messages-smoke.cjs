/**
 * The answer to `getMessages` names its session. A transcript from another session (the engine still
 * holding the previous one while a switch is in flight) must never be painted under the session on
 * screen — that was the "conversation crosses directories" bug.
 */
const assert = require('node:assert/strict')

module.exports = async function sessionMessagesSmoke(evaluate, until, window, setSessionFixture) {
  const idle = await evaluate('window.pi.getStatus()')
  const key = 'session-messages-smoke-fixture'
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  // The message carries a picture, so the editor can be checked for the composer's attachment rules.
  const message = (text) => [{
    role: 'user',
    content: [{ type: 'text', text }, { type: 'image', data: PNG, mimeType: 'image/png' }],
    timestamp: Date.now()
  }]
  const shown = (text) => evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`)

  // A foreign transcript (another session's key) must be ignored, even across retries.
  setSessionFixture({ sessionKey: 'some-other-session', messages: message('FOREIGN_SESSION_SENTINEL') })
  window.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: undefined, sessionName: 'foreign probe' })
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(await shown('FOREIGN_SESSION_SENTINEL'), false, 'a foreign transcript must not be shown')

  // The same fixture with the right key is accepted — picked up by the retry, not a new broadcast.
  setSessionFixture({ sessionKey: key, messages: message('OWN_SESSION_SENTINEL') })
  await until(() => shown('OWN_SESSION_SENTINEL'))

  // Rewriting history: a settled user bubble offers the entry point, and the editor is explicit
  // about what it costs.
  assert.equal(
    await evaluate('!!document.querySelector(".message.user .user-edit-open")'),
    true,
    'a settled user message can be edited'
  )
  await evaluate('document.querySelector(".user-edit-open").click()')
  await until(() => evaluate('!!document.querySelector(".user-edit-input")'), 'editor opens')
  assert.equal(
    await evaluate('document.querySelector(".user-edit-hint").textContent.trim()'),
    '发送后，这条之后的对话会被丢弃'
  )
  assert.equal(await evaluate('document.querySelector(".user-edit-input").value'), 'OWN_SESSION_SENTINEL')
  // Attachments behave like the composer's: the message's own picture is there, removable, and a new
  // one can be attached from the same place.
  assert.equal(await evaluate('document.querySelectorAll(".user-edit .draft-image").length'), 1, 'its picture is in the editor')
  assert.equal(await evaluate('!!document.querySelector(".user-edit-attach")'), true, 'and another can be added')
  await evaluate('document.querySelector(".user-edit .draft-image-remove").click()')
  await until(() => evaluate('document.querySelectorAll(".user-edit .draft-image").length === 0'), 'the picture can be removed')
  await evaluate(`(() => {
    const area = document.querySelector('.user-edit-input')
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })()`)
  await until(() => evaluate('!document.querySelector(".user-edit-input")'), 'escape cancels the edit')

  setSessionFixture(undefined)
  window.webContents.send('pi:status', idle)
  await until(async () => !(await shown('OWN_SESSION_SENTINEL')))
  console.log('Session messages passed: foreign transcripts are ignored, the own one arrives, and a user message can be rewritten with its attachments')
}
