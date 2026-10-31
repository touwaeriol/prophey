/**
 * Opening a long conversation has to paint quickly.
 *
 * The window mounted every message in one commit: a session with 140 heavy turns spent ~450ms
 * parsing markdown before the first line appeared, then everything arrived at once. The transcript
 * now mounts a window around where the reader was (the tail for a fresh open) and grows when they
 * scroll back, so the first screen is on glass in a fraction of that while the rest stays reachable.
 */
const assert = require('node:assert/strict')

const COUNT = 140
const WINDOW = 20

/**
 * One turn the size real sessions have: the largest transcript in the user's profile is 142 turns
 * for 0.85 MB, so ~6 KB of prose and code per message is the honest weight to measure.
 */
function heavyMessage(index) {
  const role = index % 2 === 0 ? 'user' : 'assistant'
  const body = [
    `第 ${index} 条消息，用于测量渲染耗时。`,
    '',
    '```ts',
    Array.from({ length: 60 }, (_, line) => `export const value${line} = (input: number) => input * ${line}`).join('\n'),
    '```',
    '',
    Array.from({ length: 20 }, (_, line) =>
      `- 列表项 ${index}-${line}，带一点文字让排版有活干，顺便把一行填满到接近真实长度。`
    ).join('\n')
  ].join('\n')
  return {
    role,
    content: role === 'user' ? body : [{ type: 'text', text: body }],
    timestamp: Date.now() - (COUNT - index) * 1000
  }
}

module.exports = async function conversationPerfSmoke(evaluate, until, window, setSessionFixture) {
  const idle = await evaluate('window.pi.getStatus()')
  const key = 'conversation-perf-fixture'
  const painted = 'document.querySelectorAll(".conversation .message").length'
  setSessionFixture({
    sessionKey: key,
    messages: Array.from({ length: COUNT }, (_, index) => heavyMessage(index))
  })
  try {
    // Measure inside the renderer: a polling loop from node is far too coarse for a first paint.
    const measurement = evaluate(`new Promise((resolve) => {
      const started = performance.now()
      let first = null
      const finish = () => {
        observer.disconnect()
        clearTimeout(guard)
        resolve({ first, mounted: ${painted}, phase: window.pi.getStatus ? 'ok' : 'no-api' })
      }
      const probe = () => {
        const count = ${painted}
        if (first === null && count > 0) first = performance.now() - started
        if (count > 0 && performance.now() - started > 250) finish()
      }
      const observer = new MutationObserver(probe)
      observer.observe(document.body, { childList: true, subtree: true })
      // Never hang the suite: report what is on screen instead.
      const guard = setTimeout(finish, 5000)
      probe()
    })`)
    window.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: undefined, sessionName: 'perf probe' })
    const result = await measurement
    console.log(
      `Conversation perf: first paint ${Math.round(result.first)}ms, ${result.mounted}/${COUNT} mounted on open`
    )
    assert.ok(result.first < 300, `the first screen paints quickly (${Math.round(result.first)}ms)`)
    assert.ok(
      result.mounted <= COUNT && result.mounted < COUNT,
      `only a window is mounted on open (${result.mounted} of ${COUNT})`
    )
    assert.ok(
      result.mounted >= WINDOW - 2,
      `the window still covers a screenful (${result.mounted})`
    )

    // Scrolling back has to keep revealing earlier turns until the transcript is whole again.
    const grown = await evaluate(`new Promise((resolve) => {
      const box = document.querySelector('.scroll')
      // The transcript scroll box is smooth-scrolling: an animated scrollTop is still far from the
      // top on the next frame, so the window would never see the reader arrive. A drag is instant.
      const smooth = box ? box.style.scrollBehavior : ''
      if (box) box.style.scrollBehavior = 'auto'
      let rounds = 0
      const step = () => {
        const count = ${painted}
        const start = document.querySelector('.conversation')?.dataset.windowStart
        if (count >= ${COUNT} || rounds > 40) {
          if (box) box.style.scrollBehavior = smooth
          resolve({ count, rounds, start, scrollTop: box ? box.scrollTop : -1, scrollable: box ? box.scrollHeight > box.clientHeight : false })
          return
        }
        rounds += 1
        if (box) {
          box.scrollTop = 0
          box.dispatchEvent(new Event('scroll'))
        }
        setTimeout(step, 40)
      }
      step()
    })`)
    console.log(
      `Conversation perf: ${grown.count}/${COUNT} mounted after ${grown.rounds} scrolls (start=${grown.start}, scrollTop=${grown.scrollTop}, scrollable=${grown.scrollable})`
    )
    assert.equal(grown.count, COUNT, 'scrolling back reaches every earlier message')
  } finally {
    setSessionFixture(undefined)
    window.webContents.send('pi:status', idle)
    await until(() => evaluate('!document.querySelector(".conversation .message")'), 'fixture cleared').catch(() => undefined)
  }
  console.log('Conversation perf passed: the tail paints first, the rest loads on scroll')
}
