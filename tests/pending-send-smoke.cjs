/**
 * A message that has not reached the transcript yet must not look like it did.
 *
 * It waits at the user's own place — the end of the transcript, where it will land — instead of in a
 * panel floating over the chat area. Floating read as a toast and covered the run it was waiting for;
 * in place it can be read in order, with its 「待发送」/「正在发送」 state line saying it has not been
 * delivered. The one thing the transcript must not do is scroll to it: the reader stays where they
 * were while the step in flight finishes.
 *
 * A steer the engine still holds offers 立即发送 (the only hard interrupt) and 撤回; a message it has
 * already accepted offers neither, because it is about to appear on its own.
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
  const shape = () => evaluate(`(() => {
    const item = document.querySelector('.pending-send')
    const strip = document.querySelector('.pending-sends')
    const box = document.querySelector('.scroll')
    const conversation = document.querySelector('.conversation')
    const children = conversation ? [...conversation.children] : []
    return {
      label: document.querySelector('.pending-send-state')?.textContent ?? '',
      text: document.querySelector('.pending-send-text')?.textContent ?? '',
      insideScroll: Boolean(strip && box && box.contains(strip)),
      inConversation: Boolean(strip && conversation && conversation.contains(strip)),
      lastBlock: Boolean(strip && children[children.length - 1] === strip),
      afterTurns: !children.some((child) => child.classList.contains('message') &&
        child.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_PRECEDING),
      scrollTop: box ? box.scrollTop : -1,
      sendNow: !!document.querySelector('.pending-send-now'),
      cancel: !!document.querySelector('.pending-send-cancel')
    }
  })()`)

  try {
    // The engine accepts the prompt but has not written it into the transcript yet.
    let resolvePrompt
    setPromptFixture(() => new Promise((resolve) => { resolvePrompt = () => resolve({ ok: true }) }))
    await until(() => evaluate('!!document.querySelector(".composer textarea")'), 'composer')
    const before = await shape()
    await type('PENDING_SEND_SENTINEL')
    await enter()

    await until(() => evaluate('!!document.querySelector(".pending-send")'), 'the message waits')
    const direct = await shape()
    assert.match(direct.label, /正在发送/, `a direct send says it is being sent (${direct.label})`)
    assert.equal(direct.text, 'PENDING_SEND_SENTINEL', 'the text is readable while it waits')
    assert.equal(direct.insideScroll, true, 'it lives in the transcript, where the reader is')
    assert.equal(direct.inConversation, true, 'as part of the conversation, not an overlay')
    assert.equal(direct.afterTurns, true, 'at the user’s place: nothing of the transcript comes after it')
    assert.equal(direct.lastBlock, true, 'it is the last block of the conversation')
    assert.equal(direct.scrollTop, before.scrollTop, 'the pane does not scroll to a message still on its way')
    // A direct send is already accepted: there is nothing to retract or to send now.
    assert.equal(direct.sendNow, false)
    assert.equal(direct.cancel, false)
    assert.equal(await evaluate('document.querySelector(".composer textarea").value'), '', 'the box is empty')

    // The engine writes it into the transcript: the waiting block empties and the message is a bubble.
    resolvePrompt?.()
    window.webContents.send('pi:event', {
      type: 'message_end',
      message: { role: 'user', content: 'PENDING_SEND_SENTINEL' },
      sessionKey: idle.sessionKey
    })
    await until(() => evaluate('!document.querySelector(".pending-send")'), 'the waiting block clears when it lands')
    await until(
      () => evaluate('!!document.querySelector(".conversation .message")'),
      'and the message is in the transcript'
    )

    // A steer the engine still holds: same place, but it can be withdrawn or pushed through now.
    window.webContents.send('pi:status', { ...idle, isStreaming: true })
    setPromptFixture(() => new Promise((resolve) => {
      resolvePrompt = () => resolve({ ok: true, steerId: 'steer-1' })
    }))
    await type('PENDING_STEER_SENTINEL')
    await enter()
    await until(() => evaluate('!!document.querySelector(".pending-send")'), 'the steer waits too')
    const steer = await shape()
    assert.match(steer.label, /待发送/, `a steer waits for the boundary (${steer.label})`)
    assert.equal(steer.inConversation, true, 'it waits in the transcript as well')
    assert.equal(steer.sendNow, true, 'it can be sent now, interrupting the run')
    assert.equal(steer.cancel, true, 'and it can be taken back')
    resolvePrompt?.()
    await until(() => evaluate('!!document.querySelector(".pending-send-cancel")'), 'the steer id arrives')
    await evaluate('document.querySelector(".pending-send-cancel").click()')
    await until(() => evaluate('!document.querySelector(".pending-send")'), 'withdrawing removes it from the transcript')
  } finally {
    setPromptFixture(undefined)
    window.webContents.send('pi:status', idle)
    await type('')
  }
  console.log('Pending send passed: waiting messages sit at the user’s place and say so, without scrolling')
}
