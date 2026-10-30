/**
 * Composer behaviour while a turn is streaming:
 * - Enter steers (the message joins the run), Ctrl+Enter queues it for afterwards
 * - queued messages render above the composer box, not inside it, with a 「引导」 button
 */
const assert = require('node:assert/strict')

module.exports = async function queueSmoke(evaluate, until, window) {
  const idle = await evaluate('window.pi.getStatus()')
  window.webContents.send('pi:status', { ...idle, isStreaming: true })
  await until(() => evaluate('!!document.querySelector(".composer textarea")'), 'composer')
  await new Promise((resolve) => setTimeout(resolve, 300))

  const placeholder = await evaluate('document.querySelector(".composer textarea").placeholder')
  assert.equal(placeholder, '继续输入，Enter 引导（等当前步骤结束）', 'streaming placeholder stays concise')
  assert.equal(await evaluate('!!document.querySelector(".composer-hint")'), false,
    'no duplicate keyboard-help row below the composer')

  // Measure the removed row in the real DOM, with its former styles, then remove the fixture.
  const space = await evaluate(`(() => {
    const composer = document.querySelector('.composer')
    const wrap = composer.parentElement
    const after = wrap.getBoundingClientRect().height
    const hint = document.createElement('div')
    hint.style.cssText = 'max-width:860px;margin:6px auto 0;text-align:center;font-size:10.6px;color:var(--text-faint);user-select:none'
    hint.textContent = 'Enter 引导（立即插入当前回合） · Shift+Enter 换行 · Ctrl+Enter 排队 · 粘贴或拖入图片'
    composer.after(hint)
    try {
      return { before: wrap.getBoundingClientRect().height, after }
    } finally {
      hint.remove()
    }
  })()`)
  assert.ok(space.before - space.after > 6, 'removing the help row saves its line height plus margin')
  console.log('Composer footer space (px):', { ...space, saved: space.before - space.after })

  await evaluate(`
    (() => {
      const area = document.querySelector('.composer textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, '队列里的这条')
      area.dispatchEvent(new Event('input', { bubbles: true }))
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    })()
  `)
  await until(() => evaluate('!!document.querySelector(".queue-panel")'), 'queue panel')
  assert.equal(
    await evaluate('!!document.querySelector(".composer .queue-panel")'),
    false,
    'the queue lives outside the composer box'
  )
  assert.equal(await evaluate('!!document.querySelector(".composer-wrap > .queue-panel")'), true)
  assert.equal(
    await evaluate('document.querySelector(".queue-text").textContent'),
    '队列里的这条'
  )
  const steer = await evaluate(`(() => {
    const button = document.querySelector('.queue-now')
    return button ? button.textContent.trim() : null
  })()`)
  assert.equal(steer, '立即发送', 'a queued message can be sent now, interrupting the run')

  // Leave no queued message behind for the steps that follow.
  await evaluate('document.querySelector(".queue-item .queue-btn:last-child").click()')
  await until(() => evaluate('!document.querySelector(".queue-panel")'), 'queue cleared')
  window.webContents.send('pi:status', idle)
  assert.equal(await evaluate('!!document.querySelector(".composer-hint")'), false)
  console.log('Composer passed: concise placeholder, no duplicate footer, Ctrl+Enter queues above the composer')
}
