const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function sessionIsolationSmoke(evaluate, until, window, fixture) {
  const idle = await evaluate('window.pi.getStatus()')
  const show = async key => {
    fixture({ sessionKey: key, messages: [{ role: 'user', content: key + ' transcript' }] })
    window.webContents.send('pi:status', { ...idle, sessionKey: key, sessionFile: key, isStreaming: true })
    await until(() => evaluate(`document.querySelector('.conversation')?.textContent.includes(${JSON.stringify(key + ' transcript')})`), key + ' transcript')
  }
  const type = async text => {
    await evaluate(`(() => { const area = document.querySelector('.composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(text)});
      area.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  }
  const shown = text => evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`)
  try {
    await show('isolation-A')
    await type('A queued only')
    await evaluate(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', ctrlKey:true, bubbles:true, cancelable:true }))`)
    await until(() => shown('A queued only'), 'A queue')
    await type('A draft only')
    // A paste starts decoding on A; switch to B before FileReader completes.
    await evaluate(`(() => {
      const original = FileReader.prototype.readAsDataURL;
      window.restoreIsolationReader = () => FileReader.prototype.readAsDataURL = original;
      FileReader.prototype.readAsDataURL = function(blob) { setTimeout(() => original.call(this, blob), 800) };
      const data = new DataTransfer(); data.items.add(new File([new Uint8Array([1,2,3])], 'a.png', {type:'image/png'}));
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData:data, bubbles:true, cancelable:true }));
    })()`)
    window.webContents.send('ask:request', { id: 'isolation-ask-a', sessionKey: 'isolation-A', questions: [{ question: 'A question only' }], createdAt: Date.now() })
    await until(() => shown('A question only'), 'A question')
    await show('isolation-B')
    window.webContents.send('pi:event', { sessionKey: 'isolation-A', type: 'message_end', message: { role: 'assistant', content: 'FOREIGN_LATE_EVENT' } })
    window.webContents.send('pi:event', { type: 'message_end', message: { role: 'assistant', content: 'UNOWNED_LATE_EVENT' } })
    window.webContents.send('subagents:update', { id: 'sa_a', parentSession: 'isolation-A', label: 'A worker only', status: 'streaming', createdAt: Date.now(), calls: [], messages: [] })
    window.webContents.send('subagents:update', { id: 'sa_b', parentSession: 'isolation-B', label: 'B worker only', status: 'streaming', createdAt: Date.now(), calls: [], messages: [] })
    await until(() => shown('B worker only'), 'B worker')
    await new Promise(resolve => setTimeout(resolve, 1000))
    for (const text of ['A queued only', 'A question only', 'A worker only', 'FOREIGN_LATE_EVENT', 'UNOWNED_LATE_EVENT']) assert.equal(await shown(text), false, text + ' must stay on A')
    assert.equal(await evaluate(`document.querySelector('.composer textarea').value`), '')
    assert.equal(await evaluate(`document.querySelectorAll('.draft-image').length`), 0)
    await type('B draft only')
    await show('isolation-A')
    assert.equal(await evaluate(`document.querySelector('.composer textarea').value`), 'A draft only')
    assert.equal(await shown('A queued only'), true)
    assert.equal(await shown('A question only'), true)
    assert.equal(await shown('B worker only'), false)
    assert.equal(await evaluate(`document.querySelectorAll('.draft-image').length`), 1)
    await show('isolation-B')
    assert.equal(await evaluate(`document.querySelector('.composer textarea').value`), 'B draft only')
    const rejected = await evaluate(`window.pi.prompt('MUST_NOT_SEND', undefined, [], 'isolation-A')`)
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /原会话不存在/)
    // Capture the real UI with its own worker visible for layout review.
    await evaluate(`(() => { if (!document.querySelector('.session-panel')) document.querySelector('.tabbar .icon-btn[title^="显示/隐藏会话概览"]').click() })()`)
    await until(() => evaluate(`!!document.querySelector('.session-panel')`), 'panel')
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`)
    const dir = path.join(process.env.PROPHEY_SMOKE_ROOT, 'artifacts/session-isolation')
    fs.mkdirSync(dir, { recursive:true })
    fs.writeFileSync(path.join(dir, 'panel.png'), (await window.webContents.capturePage()).toPNG())
    console.log('Session isolation passed: drafts, delayed images, queues, transcripts, events, questions, workers and IPC ownership')
  } finally {
    await evaluate(`void window.restoreIsolationReader?.()`)
    window.webContents.send('ask:cleared')
    fixture(undefined)
    window.webContents.send('pi:status', idle)
    await until(() => shown('isolation-B transcript').then(value => !value), 'restored real session')
  }
}
