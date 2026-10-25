const assert = require('node:assert/strict')

/**
 * The WarpGrep settings card.
 *
 * The endpoint is the place a wrong value must be caught — the search appends `/chat/completions`
 * itself, so an Anthropic base URL only fails later, as a 404 in the middle of a search. The card
 * also has to show what is configured and which key a search would use, instead of asking the user
 * to type the value again to replace it.
 */
module.exports = async function checkWarpgrepCard(evaluate, until) {
  const setInput = async (selector, value) =>
    evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  const save = async (baseUrl) => {
    await evaluate(`document.querySelector('.mcp-endpoint-row button').click()`)
    await until(
      () => evaluate(`window.pi.getMcpState().then(s => s.warpgrep.baseUrl === ${JSON.stringify(baseUrl)})`),
      'endpoint saved'
    )
  }

  await evaluate('document.querySelector("button[title=设置]").click()')
  await until(() => evaluate('!!document.querySelector(".settings")'), 'settings dialog')
  await evaluate(
    `Array.from(document.querySelectorAll('.settings-nav button')).find(b => b.textContent.trim() === 'MCP').click()`
  )
  await until(
    () => evaluate(`Array.from(document.querySelectorAll('.mcp-service')).some(r => /WarpGrep/.test(r.textContent))`),
    'WarpGrep row'
  )
  try {
    await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.mcp-service')).find(r => /WarpGrep/.test(r.textContent));
      if (!row) throw Error('no WarpGrep row');
      row.querySelector('button[aria-label$="配置"]').click();
    })()`)
    await until(() => evaluate('!!document.querySelector(".mcp-endpoint-row")'), 'warpgrep config panel')

    const before = await evaluate('window.pi.getMcpState().then(s => s.warpgrep)')
    const shown = await evaluate(`(() => {
      const row = document.querySelector('.mcp-endpoint-row');
      const inputs = Array.from(row.querySelectorAll('input'));
      return {
        endpoint: inputs[0].value,
        model: inputs[1].value,
        hints: Array.from(document.querySelectorAll('.mcp-service-detail .field-hint'), h => h.textContent.replace(/\\s+/g, ' ').trim()),
        hint: document.querySelector('.mcp-service-detail .field-hint').textContent.replace(/\\s+/g, ' ').trim(),
        summary: document.querySelector('.mcp-warpgrep-summary').textContent.replace(/\\s+/g, ' ').trim(),
        saveDisabled: row.querySelector('button').disabled,
        keyPlaceholder: document.querySelector('.mcp-key-row input[type=password]').placeholder,
      };
    })()`)
    // The fields show what is in use — an empty field means the value really is unset.
    assert.equal(shown.endpoint, before.baseUrl ?? '', 'the endpoint field shows the saved value')
    assert.equal(shown.model, before.model ?? '', 'the model field shows the saved value')
    assert.match(shown.hint, /chat completions/, 'the card says which protocol the endpoint speaks')
    assert.match(shown.hint, /\/anthropic/, 'and names the address people paste by mistake')
    assert.match(shown.summary, /^当前：/, 'the card states the backend in use')
    assert.equal(shown.saveDisabled, true, 'nothing changed, so saving is a no-op')
    if (before.activeKey) assert.match(shown.keyPlaceholder, /覆盖当前 /, 'the current key is named in the field')

    await setInput('.mcp-endpoint-row input', 'https://api.deepseek.com/anthropic')
    await until(() => evaluate('!!document.querySelector(".mcp-field-error")'), 'protocol error')
    const refused = await evaluate(`({
      error: document.querySelector('.mcp-field-error').textContent,
      saveDisabled: document.querySelector('.mcp-endpoint-row button').disabled,
    })`)
    assert.match(refused.error, /Anthropic/)
    assert.equal(refused.saveDisabled, true, 'an Anthropic endpoint cannot be saved')
    assert.equal(
      await evaluate('window.pi.getMcpState().then(s => s.warpgrep.baseUrl)'),
      before.baseUrl,
      'a refused value never reaches the config'
    )

    // A pasted completion URL is trimmed to the base instead of failing a search later.
    await setInput('.mcp-endpoint-row input', 'https://api.deepseek.com/chat/completions')
    await until(() => evaluate(`!document.querySelector('.mcp-field-error')`), 'error cleared')
    assert(
      (await evaluate(`Array.from(document.querySelectorAll('.mcp-service-detail .field-hint'), h => h.textContent.replace(/\\s+/g, ' ').trim())`))
        .some((hint) => /保存时记为 https:\/\/api\.deepseek\.com$/.test(hint)),
      'the trimmed value is announced before saving'
    )

    // Saving writes it, and the fields follow the saved value (no "type it again" round trip).
    await setInput('.mcp-endpoint-row input', 'https://api.deepseek.com/v1')
    await setInput('.mcp-endpoint-row input + input', 'deepseek-chat')
    await save('https://api.deepseek.com/v1')
    const saved = await until(
      () => evaluate(`window.pi.getMcpState().then(s =>
        s.warpgrep.baseUrl === 'https://api.deepseek.com/v1' && s.warpgrep.model === 'deepseek-chat' ? s.warpgrep : null)`),
      'endpoint persisted'
    )
    assert.equal(saved.baseUrl, 'https://api.deepseek.com/v1')
    const after = await until(
      () => evaluate(`(() => {
        const row = document.querySelector('.mcp-endpoint-row');
        const inputs = row ? Array.from(row.querySelectorAll('input')) : [];
        return inputs.length === 2 && inputs[1].value === 'deepseek-chat'
          ? { endpoint: inputs[0].value, model: inputs[1].value, saveDisabled: row.querySelector('button').disabled }
          : null;
      })()`),
      'fields follow the saved value'
    )
    assert.equal(after.endpoint, 'https://api.deepseek.com/v1')
    assert.equal(after.saveDisabled, true, 'the saved value is the new baseline')

    // Leave the profile as it was found: later smoke steps run against Morph again.
    await until(
      () =>
        evaluate(
          `Array.from(document.querySelectorAll('.mcp-endpoint-row button'), b => b.textContent.trim()).includes('用回 Morph')`
        ),
      'Morph reset button'
    )
    await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.mcp-endpoint-row button')).find(b => b.textContent.trim() === '用回 Morph');
      button.click();
    })()`)
    await until(() => evaluate('window.pi.getMcpState().then(s => !s.warpgrep.baseUrl)'), 'back to Morph')
    assert.equal(
      await until(() => evaluate(`document.querySelector('.mcp-endpoint-row input').value === ''`), 'endpoint field cleared'),
      true
    )
  } finally {
    await evaluate('document.querySelector(".modal-backdrop")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))')
    await until(() => evaluate('!document.querySelector(".settings")'), 'settings dismissed')
  }
}
