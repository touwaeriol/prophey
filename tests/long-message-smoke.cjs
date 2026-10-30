/**
 * A pasted log or spec is a legitimate message, but a 60-line bubble buries the answer under it.
 * The bubble keeps its first 8 lines, says so, and expands on demand.
 *
 * Measured, not guessed: clipping is proven by comparing `scrollHeight` with `clientHeight`, so a
 * font or width change cannot make the test pass while the UI stops clipping. A short message in the
 * same transcript proves the clamp costs nothing when there is nothing to hide.
 */
const assert = require('node:assert/strict')

module.exports = async function longMessageSmoke(evaluate, until, window, setSessionFixture) {
  const idle = await evaluate('window.pi.getStatus()')
  const key = 'long-message-smoke-fixture'
  const long = Array.from({ length: 60 }, (_, index) => `LINE ${index + 1} 这是一段很长的内容`).join('\n')
  const short = 'SHORT_ONLY 一句话'
  const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })

  try {
    setSessionFixture({ sessionKey: key, messages: [userMessage(long + '\nTAIL_SENTINEL'), userMessage(short)] })
    window.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: undefined, sessionName: 'long message probe' })
    await until(() => evaluate('document.querySelectorAll(".message.user .user-bubble").length === 2'), 'both bubbles rendered')

    const box = (index) => `(() => { const node = document.querySelectorAll('.user-bubble-text')[${index}]; return { client: node.clientHeight, scroll: node.scrollHeight } })()`

    // 1. The long paste is clipped and offers the rest; the short one is untouched and has no toggle.
    assert.equal(await evaluate('document.querySelectorAll(".user-bubble.overflowing").length'), 1, 'only the long message is marked')
    assert.equal(await evaluate('document.querySelectorAll(".user-bubble-toggle").length'), 1, 'only the long message offers a toggle')
    assert.equal(await evaluate('document.querySelector(".user-bubble-toggle").textContent.trim()'), '展开全部')
    const clamped = await evaluate(box(0))
    assert(clamped.client + 2 < clamped.scroll, `clipped bubble must hide lines (client ${clamped.client} vs scroll ${clamped.scroll})`)
    const untouched = await evaluate(box(1))
    assert(untouched.client + 2 >= untouched.scroll, 'the short bubble must not be clipped')

    // 2. Expanding shows everything; collapsing clips again.
    await evaluate('document.querySelector(".user-bubble-toggle").click()')
    await until(() => evaluate('!!document.querySelector(".user-bubble.expanded")'), 'bubble expanded')
    const expanded = await evaluate(box(0))
    assert(expanded.client + 2 >= expanded.scroll, `expanded bubble must not clip (client ${expanded.client} vs scroll ${expanded.scroll})`)
    assert.equal(await evaluate('document.querySelector(".user-bubble-toggle").textContent.trim()'), '收起')
    await evaluate('document.querySelector(".user-bubble-toggle").click()')
    await until(() => evaluate('!document.querySelector(".user-bubble.expanded")'), 'bubble collapsed again')
    const reClamped = await evaluate(box(0))
    assert(reClamped.client + 2 < reClamped.scroll, 'collapsing clips again')
  } finally {
    setSessionFixture(undefined)
    window.webContents.send('pi:status', idle)
    await until(() => evaluate(`!document.body.textContent.includes("SHORT_ONLY")`), 'fixture cleared')
  }
  console.log('Long message passed: long user messages clamp to 8 lines and expand on demand')
}
