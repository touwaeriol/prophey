/**
 * A session that is still loading is not an empty session.
 *
 * Two holes made a real session look like an empty one while its run was visibly going:
 * `pi:get-messages` answered `{messages: []}` whenever the engine was not ready yet, and the window
 * dropped an answer that arrived mid-switch (`switchingEngine`) *without asking again* — the switch
 * flag clearing never changed a dependency, so nothing retried and the pane stayed blank.
 *
 * Now the engine marks those answers `pending`, the window keeps asking, and while it asks it says
 * 「正在载入会话…」 instead of claiming the conversation is empty.
 */
const assert = require('node:assert/strict')

module.exports = async function sessionLoadingSmoke(evaluate, until, window, setSessionFixture) {
  const idle = await evaluate('window.pi.getStatus()')
  const key = 'session-loading-fixture'
  const shown = (text) => evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`)
  try {
    // Mid-switch, and the engine is not ready to answer yet.
    setSessionFixture({ sessionKey: key, messages: [], pending: true })
    window.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: undefined, switchingEngine: 'prophey' })
    await until(() => shown('正在载入会话'), 'the window says the transcript is on its way')
    assert.equal(await shown('开始一段对话'), false, 'a session that is loading never claims to be empty')

    // The switch flag clears and the engine is still busy: it must keep waiting, not settle on "empty".
    window.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: undefined })
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(await shown('开始一段对话'), false, 'and it stays honest while it waits')
    assert.equal(await shown('正在载入会话'), true, 'the loading line is still there')

    // The engine answers: the transcript replaces the loading state.
    setSessionFixture({
      sessionKey: key,
      messages: [{ role: 'user', content: 'LOADED_TURN_SENTINEL', timestamp: Date.now() }]
    })
    await until(() => shown('LOADED_TURN_SENTINEL'), 'the transcript arrives on a retry')
    assert.equal(await shown('正在载入会话'), false, 'the loading line goes away with the data')
  } finally {
    setSessionFixture(undefined)
    window.webContents.send('pi:status', idle)
    await until(() => evaluate('!document.body.textContent.includes("LOADED_TURN_SENTINEL")'), 'fixture cleared')
      .catch(() => undefined)
  }
  console.log('Session loading passed: a pending answer waits and fills in instead of claiming empty')
}
