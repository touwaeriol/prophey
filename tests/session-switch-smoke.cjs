/**
 * Starting another session while a turn is streaming must switch immediately: the running turn is
 * parked in the background, so the window never asks the user to stop it.
 */
const assert = require('node:assert/strict')

module.exports = async function sessionSwitchSmoke(evaluate, until, window) {
  const idle = await evaluate('window.pi.getStatus()')
  // The renderer decides from the status it has, so a streaming status is enough to exercise it.
  window.webContents.send('pi:status', { ...idle, isStreaming: true })
  await until(() => evaluate('window.pi.getStatus()'), 'status broadcast')

  const newInRepo =
    'Array.from(document.querySelectorAll(".sidebar button")).find((b) => /^在 .+ 新建会话$/.test(b.title))'
  assert.equal(await evaluate(newInRepo + ' !== undefined'), true, 'the sidebar has a per-repository + button')

  await evaluate(newInRepo + '.click()')
  await until(
    () =>
      evaluate(
        'window.pi.getStatus().then((s) => s.phase === "ready" && s.sessionFile !== ' +
          JSON.stringify(idle.sessionFile) +
          ')'
      ),
    'new session while the previous turn is streaming'
  )
  assert.equal(
    await evaluate('document.querySelectorAll(".confirm-dialog").length'),
    0,
    'a streaming turn must not block (or be stopped by) switching sessions'
  )

  console.log('Session switch passed: a new session opens without stopping the previous turn')
}
