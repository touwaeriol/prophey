/**
 * A message that has not reached the transcript yet must not look like it did.
 *
 * It used to be painted as an ordinary bubble inside the conversation, so scrolling moved it out of
 * sight and the only evidence that it was still on its way scrolled away with it. Both kinds of
 * "on its way in" now wait in the strip pinned above the composer — outside the transcript's scroll
 * box — as 「待发送」 (a steer the engine still holds, with 立即发送 / 撤回) or 「正在发送」 (already
 * accepted, only waiting to be written in). The strip clears the moment the engine's user message
 * event lands, and the message arrives in the transcript then.
 */
const assert = require('node:assert/strict')

module.exports = async function pendingSendSmoke(evaluate, until, window, setPromptFixture) {
  const idle = await evaluate('window.pi.getStatus()')
  const type = (value) => evaluate(`(() => {
    const area = document.querySelector('.composer textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, ${JSON.stringify(value)})
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const enter = () => evaluate(`(() => {
    const area = document.querySelector('.composer textarea')
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })()`)

  try {
    // The engine accepts the prompt but has not written it into the transcript yet.
    let resolvePrompt
    setPromptFixture(() => new Promise((resolve) => { resolvePrompt = () => resolve({ ok: true }) }))
    await until(() => evaluate('!!document.querySelector(".composer textarea")'), 'composer')
    await type('PENDING_SEND_SENTINEL')
    await enter()

    await until(() => evaluate('!!document.querySelector(".pending-send")'), 'the message waits in the strip')
    const shape = await evaluate(`(() => {
      const strip = document.querySelector('.pending-sends')
      const item = document.querySelector('.pending-send')
      const box = document.querySelector('.scroll')
      return {
        label: document.querySelector('.pending-send-state')?.textContent ?? '',
        text: document.querySelector('.pending-send-text')?.textContent ?? '',
        insideScroll: Boolean(strip && box && box.contains(strip)),
        inTranscript: document.body.textContent.includes('PENDING_SEND_SENTINEL') &&
          Boolean(document.querySelector('.conversation .message'))
      }
    })()`)
    assert.match(shape.label, /正在发送/, `a direct send says it is being sent (${shape.label})`)
    assert.equal(shape.text, 'PENDING_SEND_SENTINEL', 'the text is readable while it waits')
    assert.equal(shape.insideScroll, false, 'the strip is pinned outside the transcript scroll box')
    assert.equal(shape.inTranscript, false, 'and it is not painted in the transcript yet')
    // A direct send is already accepted: there is nothing to retract or to send now.
    assert.equal(await evaluate('!!document.querySelector(".pending-send-now")'), false)
    assert.equal(await evaluate('!!document.querySelector(".pending-send-cancel")'), false)
    assert.equal(await evaluate('document.querySelector(".composer textarea").value'), '', 'the box is empty')

    // The engine writes it into the transcript: the strip empties and the message becomes a bubble.
    resolvePrompt?.()
    window.webContents.send('pi:event', {
      type: 'message_end',
      message: { role: 'user', content: 'PENDING_SEND_SENTINEL' },
      sessionKey: idle.sessionKey
    })
    await until(() => evaluate('!document.querySelector(".pending-send")'), 'the strip clears when it lands')
    await until(
      () => evaluate('!!document.querySelector(".conversation .message")'),
      'and the message is in the transcript'
    )
  } finally {
    setPromptFixture(undefined)
    await type('')
    window.webContents.send('pi:status', idle)
  }
  console.log('Pending send passed: waiting messages stay pinned above the composer and say so')
}
