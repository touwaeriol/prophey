const assert = require('node:assert/strict')
const http = require('node:http')

module.exports = async function checkSessionTitles(evaluate, until) {
  const requests = []
  let releaseFirst
  let releaseParked
  let heldParked = false
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw)
      requests.push(body)
      const metadata = body.messages.some(m => m.role === 'system' && JSON.stringify(m.content).includes('会话标题'))
      const first = JSON.stringify(body.messages).includes('FIRST_TITLE_TEST')
      const reply = () => {
        const text = metadata ? first ? '第一个会话标题' : '第二个会话标题' : '普通工作回复'
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ id: 'title-proof', object: 'chat.completion.chunk', created: 1, model: 'title-proof', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ id: 'title-proof', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } }) + '\n\n')
        res.end('data: [DONE]\n\n')
      }
      if (!metadata && !heldParked && JSON.stringify(body.messages).includes('PARK_A_DELAY')) {
        heldParked = true
        releaseParked = reply
      } else if (metadata && first) releaseFirst = reply
      else reply()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const models = { providers: { 'title-proof': {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture',
      models: [{ id: 'title-proof', contextWindow: 32000, maxTokens: 2048, reasoning: false }]
    } } }
    assert.equal((await evaluate('window.pi.saveModelsJson(' + JSON.stringify(JSON.stringify(models)) + ')')).ok, true)
    await evaluate('window.pi.newSession()')
    assert.equal((await evaluate('window.pi.prompt("FIRST_TITLE_TEST 优化列表")')).ok, true)
    await until(() => !!releaseFirst, 'independent title request')
    const first = await evaluate('window.pi.getStatus()')
    const otherDirectory = require('node:path').join(require('node:path').dirname(first.cwd), 'other-workspace')
    require('node:fs').mkdirSync(otherDirectory, { recursive: true })
    await evaluate('window.pi.newProjectSession(' + JSON.stringify(otherDirectory) + ')')
    assert.equal((await evaluate('window.pi.prompt("SECOND_TITLE_TEST 处理登录")')).ok, true)
    const second = await evaluate('window.pi.getStatus()')
    await until(() => evaluate('window.pi.listSessions().then(rows => rows.some(r => r.title === "第二个会话标题"))'), 'second title')
    releaseFirst()
    await until(() => evaluate('window.pi.listSessions().then(rows => rows.some(r => r.title === "第一个会话标题"))'), 'late first title')
    const rows = await evaluate('window.pi.listSessions()')
    assert.equal(rows.find(r => r.path === first.sessionKey).title, '第一个会话标题')
    assert.equal(rows.find(r => r.path === second.sessionKey).title, '第二个会话标题')
    assert.equal((await evaluate('window.pi.getStatus()')).sessionName, '第二个会话标题')
    await evaluate('window.pi.prompt("FOLLOWUP 继续")')
    const titleRequests = requests.filter(r => r.messages.some(m => m.role === 'system' && JSON.stringify(m.content).includes('会话标题')))
    assert.equal(titleRequests.length, 2, 'one title request per session, never on follow-ups')
    for (const request of titleRequests) {
      assert.equal(request.messages.length, 2)
      assert(!request.tools?.length)
    }
    assert(!JSON.stringify(await evaluate('window.pi.getMessages()')).includes('第二个会话标题'))
    // A is idle and already disposed. Sending from its old UI must restore A off screen, not reject
    // the send or place it into B. This exercises the real IPC and engine, with a local model only.
    const sendA = text => 'window.pi.prompt(' + JSON.stringify(text) + ', undefined, [], ' + JSON.stringify(first.sessionKey) + ')'
    assert.equal((await evaluate(sendA('LATE_A_ROUTED'))).ok, true)
    assert.equal((await evaluate('window.pi.getStatus()')).sessionKey, second.sessionKey)
    assert(!JSON.stringify(await evaluate('window.pi.getMessages()')).includes('LATE_A_ROUTED'))
    await evaluate('window.pi.openSession(' + JSON.stringify(first.sessionKey) + ', ' + JSON.stringify(first.cwd) + ')')
    assert(JSON.stringify(await evaluate('window.pi.getMessages()')).includes('LATE_A_ROUTED'))
    // Start a real A turn, switch to B while it waits, then steer A by its owner key.
    await evaluate('void (window.parkedPrompt = ' + sendA('PARK_A_DELAY') + ')')
    await until(() => !!releaseParked, 'A waiting for model')
    await evaluate('window.pi.openSession(' + JSON.stringify(second.sessionKey) + ', ' + JSON.stringify(second.cwd) + ')')
    const steer = await evaluate('window.pi.prompt("STEER_A_ONLY", "steer", [], ' + JSON.stringify(first.sessionKey) + ')')
    assert.equal(steer.ok, true)
    assert.equal((await evaluate('window.pi.getStatus()')).sessionKey, second.sessionKey)
    assert(!JSON.stringify(await evaluate('window.pi.getMessages()')).includes('STEER_A_ONLY'))
    releaseParked()
    assert.equal((await evaluate('window.parkedPrompt')).ok, true)
    await evaluate('window.pi.openSession(' + JSON.stringify(first.sessionKey) + ', ' + JSON.stringify(first.cwd) + ')')
    const restored = JSON.stringify(await evaluate('window.pi.getMessages()'))
    for (const text of ['LATE_A_ROUTED', 'PARK_A_DELAY', 'STEER_A_ONLY']) assert(restored.includes(text))
    console.log('Session routing passed: disposed and running sessions receive their own late prompts and steering while B stays unchanged')
    // A cold pi restore must not cancel a question owned by the visible Prophey session.
    await evaluate('window.pi.newSession()')
    await evaluate('window.pi.setEngine("pi")')
    assert.equal((await evaluate('window.pi.setModel("title-proof", "title-proof")')).ok, true)
    assert.equal((await evaluate('window.pi.prompt("PI_ORIGIN_TEST")')).ok, true)
    await until(() => evaluate('window.pi.getStatus().then(s => !s.isStreaming)'), 'pi origin settled')
    const piOrigin = await evaluate('window.pi.getStatus()')
    await evaluate('window.pi.openSession(' + JSON.stringify(second.sessionKey) + ', ' + JSON.stringify(second.cwd) + ')')
    const config = JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.PROPHEY_SMOKE_DATA, 'config.json'), 'utf8'))
    const answer = new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: config.mcp.bridgePort, method: 'POST', path: '/ask', headers: { 'x-agent-desktop-token': config.mcp.bridgeToken } }, response => {
        let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => resolve(JSON.parse(body)))
      })
      request.on('error', reject)
      request.end(JSON.stringify({ questions: [{ question: 'Keep B question while A restores' }] }))
    })
    await until(() => evaluate('window.pi.listAsks().then(rows => rows.some(r => r.questions[0].question === "Keep B question while A restores"))'), 'B pending question')
    const question = (await evaluate('window.pi.listAsks()'))[0]
    assert.equal((await evaluate('window.pi.prompt("PI_LATE_ROUTED", undefined, [], ' + JSON.stringify(piOrigin.sessionKey) + ')')).ok, true)
    assert.equal((await evaluate('window.pi.getStatus()')).sessionKey, second.sessionKey)
    assert((await evaluate('window.pi.listAsks()')).some(r => r.id === question.id))
    await evaluate('window.pi.cancelQuestion(' + JSON.stringify(question.id) + ', "test complete")')
    assert.equal((await answer).cancelled, true)
    console.log('Pi routing passed: restoring another engine preserves the visible session question')
    console.log('Session titles passed: isolated requests, once per first prompt, late results stay with their session')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
