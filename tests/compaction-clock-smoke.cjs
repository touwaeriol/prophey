/**
 * Compaction has a clock.
 *
 * `/compact` while nothing else is running emits `compaction_start` without an `agent_start`, so the
 * status bar had no start time and sat on 「0s · 正在压缩上下文」 for the whole summary — it looked
 * hung even though the model was working. The bar now starts at `compaction_start` and stops at
 * `compaction_end`.
 *
 * The second case is the same clock across a session switch: the engine keeps compacting while the
 * window looks at another conversation (that is what parking is for), so coming back has to show the
 * elapsed time since the summary began. It rebuilt the pending run only for `isStreaming`, which left
 * a parked compaction with no start time — a dead `0s` strip, or none at all.
 */
const assert = require('node:assert/strict')

module.exports = async function compactionClockSmoke(evaluate, until, window) {
  const idle = await evaluate('window.pi.getStatus()')
  const key = 'compaction-clock-fixture'
  const away = 'compaction-clock-other'
  const elapsed = 'document.querySelector(".run-elapsed")?.textContent ?? ""'
  const strip = 'document.querySelector(".run-status")?.textContent ?? ""'
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

    // Leave for another conversation in the middle of the summary.
    window.webContents.send('pi:status', {
      ...idle,
      sessionKey: away,
      sessionFile: undefined,
      isStreaming: false,
      compacting: false
    })
    await until(() => evaluate('!document.querySelector(".run-status")'), 'the strip belongs to its session')

    // Back on the compacting session: the parked engine has been summarizing the whole time.
    const started = Date.now() - 6000
    window.webContents.send('pi:status', {
      ...idle,
      sessionKey: key,
      sessionFile: undefined,
      isStreaming: false,
      compacting: true,
      activity: { label: '正在压缩上下文', since: started }
    })
    await until(() => evaluate('!!document.querySelector(".run-elapsed")'), 'the clock comes back')
    assert.match(await evaluate(strip), /正在压缩上下文/, 'the label comes back with it')
    const back = await evaluate(elapsed)
    assert.notEqual(back, '0s', 'it counts from when the summary began, not from the switch')
    await until(() => evaluate(`${elapsed} !== ${JSON.stringify(back)}`), 'and it keeps ticking')

    window.webContents.send('pi:event', { type: 'compaction_end', summary: '摘要', sessionKey: key })
    // The engine clears `compacting` right after the event; the whole strip then goes away, exactly
    // like it does after a normal turn.
    window.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: undefined, compacting: false })
    await until(() => evaluate('!document.querySelector(".run-status")'), 'the strip goes away at compaction_end')
  } finally {
    window.webContents.send('pi:status', idle)
  }
}
