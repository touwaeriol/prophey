/**
 * Next-message suggestions in the real window.
 *
 * The prediction itself is one provider request; this checks the contract around it: the event
 * belongs to one session, an empty composer shows it as ghost text and a chip, Tab fills the box
 * without sending, Esc dismisses, and a draft that diverges hides it instead of being overwritten.
 */
module.exports = async function checkSuggestions(evaluate, until, window) {
  const assert = require('node:assert/strict')
  const sessionKey = await evaluate(
    'window.pi.getStatus().then(s => s.sessionKey ?? s.sessionFile).then(key => key || "")'
  )
  assert.ok(sessionKey, 'a session key to address the suggestion to')
  const send = (text, key = sessionKey) =>
    window.webContents.send('pi:event', { type: 'suggestion', text, sessionKey: key })
  const ghost = () =>
    evaluate(`(() => {
      const rest = document.querySelector('.composer-ghost-rest');
      const chip = document.querySelector('.composer-suggestion');
      const textarea = document.querySelector('.composer textarea');
      return {
        rest: rest ? rest.textContent : null,
        typed: document.querySelector('.composer-ghost-typed')?.textContent ?? null,
        chip: chip ? chip.querySelector('.suggestion-text').textContent : null,
        placeholder: textarea ? textarea.placeholder : null,
        value: textarea ? textarea.value : null,
      };
    })()`)
  const type = async (value) =>
    evaluate(`(() => {
      const element = document.querySelector('.composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  const key = async (name) =>
    evaluate(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true }))`)
  const messages = () => evaluate('window.pi.getMessages().then(list => list.length)')

  try {
    // The setting is off by default and is what makes the main process ask at all.
    assert.equal((await evaluate('window.pi.setSuggestions(true)')).ok, true)
    assert.equal((await evaluate('window.pi.getDesktopConfig().then(c => c.suggestions)')), true)
    await until(() => evaluate('!!document.querySelector(".composer textarea")'), 'composer')

    const before = await messages()
    send('跑一下测试')
    await until(() => evaluate('!!document.querySelector(".composer-suggestion")'), 'suggestion chip')
    const shown = await ghost()
    assert.equal(shown.rest, '跑一下测试', 'the empty composer shows the prediction as ghost text')
    assert.equal(shown.chip, '跑一下测试', 'and as a chip above it')
    assert.equal(shown.placeholder, '', 'the ghost replaces the placeholder instead of stacking on it')
    // The ghost has to sit exactly on the textarea, or the prediction would not start at the caret.
    const boxes = await evaluate(`(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) };
      };
      const chip = document.querySelector('.composer-suggestion').getBoundingClientRect();
      const input = document.querySelector('.composer-input textarea').getBoundingClientRect();
      return { textarea: rect('.composer-input textarea'), ghost: rect('.composer-ghost'), chipAbove: chip.bottom <= input.top + 1 };
    })()`)
    assert.deepEqual(boxes.ghost, boxes.textarea, 'the ghost is laid out on the textarea itself')
    assert.equal(boxes.chipAbove, true, 'the chip sits above the input, not on top of it')

    // A suggestion made for another conversation is ignored, not shown here and not applied to the
    // one on screen.
    send('别的会话的建议', sessionKey + '.other.jsonl')
    assert.equal(await ghost().then((state) => state.chip), '跑一下测试', 'another session\'s prediction is ignored')

    // Tab accepts: the box is filled, nothing is sent.
    await until(() => evaluate('document.querySelector(".composer-ghost-rest")?.textContent === "跑一下测试"'), 'ghost restored')
    await key('Tab')
    await until(() => evaluate('document.querySelector(".composer textarea").value === "跑一下测试"'), 'Tab filled the box')
    assert.equal(await messages(), before, 'Tab never sends the message')
    assert.equal(await evaluate('window.pi.getStatus().then(s => Boolean(s.isStreaming))'), false, 'and starts no turn')

    // Typing something else hides the prediction rather than replacing or appending it.
    await type('先跑一下 unit')
    await until(() => evaluate('!document.querySelector(".composer-ghost")'), 'ghost hidden by a diverging draft')
    assert.equal(await ghost().then((state) => state.chip), null, 'chip follows the ghost')
    assert.equal(await ghost().then((state) => state.value), '先跑一下 unit', 'the draft is left alone')

    // A prefix still completes (the user started typing the prediction itself).
    await type('')
    send('跑一下测试')
    await until(() => evaluate('!!document.querySelector(".composer-suggestion")'), 'chip for the prefix case')
    await type('跑一')
    const prefixed = await until(() => ghost().then((state) => (state.rest ? state : null)), 'prefix ghost')
    assert.equal(prefixed.typed, '跑一', 'the typed part keeps its space, the rest is the prediction')
    assert.equal(prefixed.rest, '下测试', 'the ghost completes the prefix')
    await type('')

    // Esc dismisses without touching the draft.
    await until(() => evaluate('!!document.querySelector(".composer-suggestion")'), 'chip back for Esc')
    await key('Escape')
    await until(() => evaluate('!document.querySelector(".composer-suggestion") && !document.querySelector(".composer-ghost")'), 'Esc dismisses')

    // The main process clears it too (`text: null`), which is how a new turn hides a stale guess.
    send('提交这些改动')
    await until(() => evaluate('!!document.querySelector(".composer-suggestion")'), 'chip for clear')
    send(null)
    await until(() => evaluate('!document.querySelector(".composer-suggestion")'), 'null clears the suggestion')

    assert.equal((await evaluate('window.pi.setSuggestions(false)')).suggestions, false, 'the setting turns off again')
    assert.equal(await evaluate('window.pi.getDesktopConfig().then(c => c.suggestions)'), false)
  } finally {
    await evaluate('window.pi.setSuggestions(false)').catch(() => undefined)
    // Leave no draft behind for the next smoke step.
    await type('')
  }
}
