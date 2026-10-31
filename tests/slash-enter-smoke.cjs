/**
 * Enter on a slash command runs it when it takes no arguments.
 *
 * Picking `/clear` in the menu only filled the box, so executing anything meant pressing Enter a
 * second time — the menu had already done what Enter usually means. A command that carries arguments
 * (`/compact [提示词]`) still fills the box, because the argument has to be typed before it can run.
 */
const assert = require('node:assert/strict')

module.exports = async function slashEnterSmoke(evaluate, until, window) {
  const idle = await evaluate('window.pi.getStatus()')
  const text = 'document.querySelector(".composer textarea").value'
  /** Type into the composer the way a keystroke does, so React sees a real change. */
  const type = (value) => evaluate(`(() => {
    const area = document.querySelector('.composer textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, ${JSON.stringify(value)})
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const enter = () => evaluate(`(() => {
    const area = document.querySelector('.composer textarea')
    area.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true
    }))
  })()`)

  await until(() => evaluate('!!document.querySelector(".composer textarea")'), 'composer')
  try {
    // A command with no arguments runs on Enter: the box is cleared, not completed.
    await type('/stat')
    await until(() => evaluate('!!document.querySelector(".slash-menu")'), 'menu opens on a slash')
    assert.match(
      await evaluate('document.querySelector(".slash-item.active .slash-name").textContent'),
      /^\/status/,
      'the first match is the active one'
    )
    await enter()
    await until(() => evaluate('!document.querySelector(".slash-menu")'), 'the menu closes')
    assert.equal(await evaluate(text), '', 'Enter ran /status instead of pasting it into the box')

    // A command that takes arguments still waits for them, otherwise the argument is unreachable.
    await type('/compact')
    await until(() => evaluate('!!document.querySelector(".slash-menu")'), 'menu opens again')
    assert.match(
      await evaluate('document.querySelector(".slash-item.active .slash-name").textContent'),
      /^\/compact/,
      'the match carries its argument hint'
    )
    await enter()
    await until(() => evaluate('!document.querySelector(".slash-menu")'), 'the menu closes on completion')
    assert.equal(await evaluate(text), '/compact ', 'a command with arguments is completed, not run')
  } finally {
    await type('')
    window.webContents.send('pi:status', idle)
  }
  console.log('Slash Enter passed: a command without arguments runs, one with arguments completes')
}
