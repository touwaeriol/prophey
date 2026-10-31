/**
 * Compaction has a clock.
 *
 * `/compact` while nothing else is running emits `compaction_start` without an `agent_start`, so the
 * status bar had no start time and sat on 「0s · 正在压缩上下文」 for the whole summary — it looked
 * hung even though the model was working. The bar now starts at `compaction_start` and stops at
 * `compaction_end`.
 */
const assert = require('node:assert/strict')

module.exports = async function compactionClockSmoke(evaluate, until, window) {
  const idle = await evaluate('window.pi.getStatus()')
  const key = 'compaction-clock-fixture'
  const elapsed = 'document.querySelector(".run-elapsed")?.textContent ?? ""'
  try {
    window.webContents.send('pi:status', {
      ...idle,
      sessionKey: key,
      sessionFile: undefined,
      isStreaming: false,
      compacting: true,
      activity: { label: '正在压缩上下文', since: Date.now() }
    })
    // `/compact`: no agent_start, only the compaction events.
    window.webContents.send('pi:event', { type: 'compaction_start', reason: 'manual', sessionKey: key })
    await until(() => evaluate('!!document.querySelector(".run-elapsed")'), 'the clock appears')
    assert.equal(await evaluate(`${elapsed}`), '0s', 'it starts at zero')
    // It has to move on its own: a frozen 0s is the bug.
    await until(() => evaluate(`${elapsed} !== "0s"`), 'the clock ticks')

    window.webContents.send('pi:event', { type: 'compaction_end', summary: '摘要', sessionKey: key })
    // The engine clears `compacting` right after the event; the whole strip then goes away, exactly
    // like it does after a normal turn.
    window.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: undefined, compacting: false })
    await until(() => evaluate('!document.querySelector(".run-status")'), 'the strip goes away at compaction_end')
  } finally {
    window.webContents.send('pi:status', idle)
  }
}
