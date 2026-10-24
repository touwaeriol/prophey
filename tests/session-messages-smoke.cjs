/**
 * The answer to `getMessages` names its session. A transcript from another session (the engine still
 * holding the previous one while a switch is in flight) must never be painted under the session on
 * screen — that was the "conversation crosses directories" bug.
 */
const assert = require('node:assert/strict')

module.exports = async function sessionMessagesSmoke(evaluate, until, window, setSessionFixture) {
  const idle = await evaluate('window.pi.getStatus()')
  const key = 'session-messages-smoke-fixture'
  const message = (text) => [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }]
  const shown = (text) => evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`)

  // A foreign transcript (another session's key) must be ignored, even across retries.
  setSessionFixture({ sessionKey: 'some-other-session', messages: message('FOREIGN_SESSION_SENTINEL') })
  window.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: undefined, sessionName: 'foreign probe' })
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(await shown('FOREIGN_SESSION_SENTINEL'), false, 'a foreign transcript must not be shown')

  // The same fixture with the right key is accepted — picked up by the retry, not a new broadcast.
  setSessionFixture({ sessionKey: key, messages: message('OWN_SESSION_SENTINEL') })
  await until(() => shown('OWN_SESSION_SENTINEL'))

  setSessionFixture(undefined)
  window.webContents.send('pi:status', idle)
  await until(async () => !(await shown('OWN_SESSION_SENTINEL')))
  console.log('Session messages passed: foreign transcripts are ignored, the own one arrives')
}
