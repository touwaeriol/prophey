/**
 * Consecutive tool calls read as one block of work.
 *
 * They used to be separate cards with a 2px gap and two 1px borders facing each other, so a run of
 * ten calls looked like ten unrelated objects and ate vertical space the transcript needs. The cards
 * now share one border and have no gap: a stack of calls looks like what it is — one step after
 * another in the same turn.
 */
const assert = require('node:assert/strict')

module.exports = async function toolSpacingSmoke(evaluate, until, window) {
  const idle = await evaluate('window.pi.getStatus()')
  const key = idle.sessionKey ?? idle.sessionFile ?? 'tool-spacing-fixture'
  const COUNT = 3
  try {
    // A run has to have an assistant turn for tool calls to belong to: events alone do not create
    // one, and a real run always starts the message before its first call.
    window.webContents.send('pi:event', {
      type: 'message_start',
      message: { role: 'assistant', content: [] },
      sessionKey: key
    })
    await until(() => evaluate("!!document.querySelector('.message.assistant')"), 'the assistant turn')
    for (let index = 0; index < COUNT; index += 1) {
      window.webContents.send('pi:event', {
        type: 'tool_execution_start',
        toolCallId: `spacing-${index}`,
        toolName: 'run_bash',
        args: { command: `echo ${index}` },
        sessionKey: key
      })
    }
    await until(
      () => evaluate(`document.querySelectorAll('.tool-list .tool-card').length === ${COUNT}`),
      'the stack of tool cards'
    )

    const measured = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.tool-list .tool-card')]
      const gaps = cards.slice(1).map((card, index) => {
        const previous = cards[index].getBoundingClientRect()
        return Math.round((card.getBoundingClientRect().top - previous.bottom) * 100) / 100
      })
      const list = cards[0]?.parentElement
      return { gaps, gap: getComputedStyle(list).rowGap, radiusFirst: getComputedStyle(cards[0]).borderTopLeftRadius, radiusLast: getComputedStyle(cards[cards.length - 1]).borderBottomLeftRadius }
    })()`)
    // -1 is the shared border: the two 1px borders overlap instead of adding up.
    for (const gap of measured.gaps) {
      assert.equal(gap, -1, `cards share one border line (${measured.gaps.join(', ')})`)
    }
    assert.equal(measured.gap, '0px', 'the list itself adds no gap')
    assert.notEqual(measured.radiusFirst, '0px', 'the block keeps rounded outer corners')
    assert.notEqual(measured.radiusLast, '0px', 'top and bottom are both rounded')
  } finally {
    window.webContents.send('pi:status', idle)
  }
  console.log('Tool spacing passed: consecutive calls stack into one block with a single shared border')
}
