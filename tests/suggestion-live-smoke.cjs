/**
 * End-to-end: one finished turn, one prediction request, one chip.
 *
 * The other suggestion smoke test injects the event to pin the window's behaviour; this one drives
 * the real path — a local OpenAI-compatible endpoint answers the turn, the app notices it settled,
 * sends the metadata request, and the window shows what came back.
 */
module.exports = async function checkSuggestionRequest(evaluate, until) {
  const assert = require('node:assert/strict')
  const http = require('node:http')
  const requests = []
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('error', () => {})
    response.on('error', () => {})
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        // keep going: an unparsable body still needs an answer
      }
      const system = JSON.stringify(body.messages?.find((message) => message.role === 'system') ?? '')
      const prediction = system.includes('预测')
      requests.push({ prediction, system: system.slice(0, 120) })
      const text = prediction ? '建议：跑一下测试' : '好的。'
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'suggest-proof',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'suggest-proof',
            choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
          }) +
          '\n\n'
      )
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'suggest-proof',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 }
          }) +
          '\n\n'
      )
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const models = {
      providers: {
        'suggest-proof': {
          api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'local-fixture',
          models: [{ id: 'suggest-proof', contextWindow: 32000, maxTokens: 2048, reasoning: false }]
        }
      }
    }
    assert.equal(
      (await evaluate('window.pi.saveModelsJson(' + JSON.stringify(JSON.stringify(models)) + ')')).ok,
      true
    )
    assert.equal((await evaluate('window.pi.setSuggestions(true)')).ok, true)
    assert.equal((await evaluate('window.pi.setModel("suggest-proof", "suggest-proof")')).ok, true)
    await evaluate('window.pi.newSession()')
    assert.equal((await evaluate('window.pi.prompt("改一下输入框的提示")')).ok, true)

    // The prediction is asked for only after the turn settles, and only once.
    const chip = await until(
      () => evaluate(`document.querySelector('.composer-suggestion .suggestion-text')?.textContent ?? ''`),
      'suggestion from the live request'
    )
    assert.equal(chip, '跑一下测试', 'the provider answer was cleaned into a next message')
    const asked = requests.filter((entry) => entry.prediction)
    assert.equal(asked.length, 1, 'exactly one prediction request per settled turn')
    // The context reads like a conversation, which is what makes the guess useful.
    assert.match(asked[0].system, /预测/)

    // A second settle with nothing new must not buy a second prediction.
    await evaluate('window.pi.setSuggestions(false)')
    await evaluate('window.pi.setSuggestions(true)')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(requests.filter((entry) => entry.prediction).length, 1, 'no extra request after a replay')
  } finally {
    await evaluate('window.pi.setSuggestions(false)').catch(() => undefined)
    server.close()
  }
}
