const assert = require('node:assert/strict')

// Exercises the real renderer and IPC with the smoke runner's isolated profile.
module.exports = async function checkProviderSettings(evaluate, until) {
  const click = async (selector, text) => {
    await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find(b => b.textContent.trim() === ${JSON.stringify(text)});
      if (!button) throw Error('Missing button: ' + ${JSON.stringify(text)});
      button.click();
    })()`)
  }
  const input = async (selector, value) => {
    await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  }
  const saved = async () => JSON.parse((await evaluate('window.pi.getModelsJson()')).content)
  const editor = () => until(() => evaluate('!!document.querySelector(".provider-editor")'), 'provider editor')
  const save = async () => {
    await click('.provider-editor button', '保存并应用')
    try {
      await until(() => evaluate('!document.querySelector(".provider-editor")'), 'provider save')
    } catch (error) {
      throw Error(error.message + ': ' + await evaluate('document.querySelector(".provider-editor")?.textContent'))
    }
  }
  const openRow = async id => {
    await input('.providers-toolbar input', id)
    await until(() => evaluate(`Array.from(document.querySelectorAll('.provider-row code')).some(c => c.textContent === ${JSON.stringify(id)})`), 'provider row ' + id)
    await click('.provider-row button', '编辑')
    await editor()
  }
  const nav = await evaluate('document.querySelector(".settings-nav").textContent')
  assert(!nav.includes('自定义服务商'))
  await until(() => evaluate('document.querySelectorAll(".provider-row").length > 0'), 'providers loaded')

  // The real IPC and settings list must expose the corrected window, not just a relabelled 272K.
  await input('.providers-toolbar input', 'openai')
  await until(() => evaluate('Array.from(document.querySelectorAll(".provider-row code")).some(c => c.textContent === "openai")'), 'OpenAI provider')
  await evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.provider-row code'))
      .find(c => c.textContent === 'openai').closest('.provider-row');
    Array.from(row.querySelectorAll('button')).find(b => b.textContent.trim() === '模型').click();
  })()`)
  await until(() => evaluate('Array.from(document.querySelectorAll(".model-config-meta")).some(e => e.textContent.includes("gpt-6.1-sol"))'), 'OpenAI models')
  const openaiModels = await evaluate('window.pi.listProviderModels("openai")')
  const labels = await evaluate('Array.from(document.querySelectorAll(".model-config-meta"), e => e.textContent.trim())')
  for (const id of ['gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol']) {
    assert.equal(openaiModels.find(m => m.modelId === id).contextWindow, 1050000)
    assert(labels.includes(id + ' · 1.05M'), 'exact million-token display for ' + id)
  }
  await click('.model-config-dialog button', '取消')
  await input('.providers-toolbar input', '')

  // JSON failures must keep the editor and draft available to repair.
  await click('.providers-toolbar button', '高级 JSON')
  await editor()
  await input('.models-editor', '{broken')
  await click('.provider-editor button', '保存并应用')
  await until(() => evaluate('document.querySelector(".provider-editor .error")?.textContent'), 'JSON error')
  assert.equal(await evaluate('document.querySelector(".models-editor").value'), '{broken')
  const initial = {
    providers: {
      'smoke-provider': {
        name: 'Smoke Provider', baseUrl: 'https://example.invalid/v1', api: 'openai-completions',
        apiKey: 'smoke-placeholder', headers: { 'X-Smoke': 'preserve' },
        models: [{ id: 'smoke-model', name: 'Smoke Model', contextWindow: 32000, maxTokens: 2048,
          input: ['text'], reasoning: false, compat: { supportsStore: false },
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }]
      },
      deepseek: { headers: { 'X-Preset': 'preserve' } }
    }
  }
  await input('.models-editor', JSON.stringify(initial))
  await save()
  await openRow('smoke-provider')
  assert.equal(await evaluate('document.querySelector(".provider-editor input[type=password]").type'), 'password')
  // An OpenAI adapter appends /chat/completions, so a bare host is pointed at a web page: saving fills
  // the version segment in instead of letting the first conversation fail.
  await input('input[placeholder="https://api.example.com/v1"]', 'https://example.invalid')
  await until(() => evaluate('!!document.querySelector(".field-hint.warn")'), 'bare host warning')
  assert.match(
    await evaluate('document.querySelector(".field-hint.warn").textContent'),
    /自动补成/,
    'the warning says what saving will do'
  )
  assert.match(
    await evaluate('document.querySelector(".field-hint.warn code:last-of-type").textContent'),
    /^https:\/\/example\.invalid\/v1$/,
    'and shows the address it becomes'
  )
  await input('input[placeholder="https://api.example.com/v1"]', 'https://example.invalid/edited')
  await save()
  const edited = (await saved()).providers['smoke-provider']
  assert.equal(edited.baseUrl, 'https://example.invalid/edited')
  assert.deepEqual(edited.headers, initial.providers['smoke-provider'].headers)
  assert.deepEqual(edited.models, initial.providers['smoke-provider'].models)
  await click('.provider-row button', '模型')
  await until(() => evaluate('document.querySelector(".model-config-row")?.textContent.includes("smoke-model")'), 'model controls')
  await click('.model-config-dialog button', '取消')

  // A preset uses the same editor; URL edits must not replace its model catalog.
  await openRow('deepseek')
  await input('input[placeholder="https://api.example.com/v1"]', 'https://example.invalid/deepseek')
  await save()
  assert.deepEqual((await saved()).providers.deepseek, {
    headers: { 'X-Preset': 'preserve' }, baseUrl: 'https://example.invalid/deepseek'
  })
  assert((await evaluate('window.pi.listProviderModels("deepseek")')).length > 0)
  await openRow('deepseek')
  await click('.provider-editor button', '恢复预置配置')
  await click('.provider-editor button', '确认恢复预置配置')
  await until(() => evaluate('!document.querySelector(".provider-editor")'), 'preset restore')
  assert.equal((await saved()).providers.deepseek, undefined)

  await click('.providers-toolbar button', '添加服务商')
  await editor()
  await input('input[placeholder="my-gateway"]', 'smoke-provider')
  await click('.provider-editor button', '保存并应用')
  await until(() => evaluate('document.querySelector(".provider-editor .error")?.textContent.includes("已存在")'), 'duplicate ID rejected')
  await input('input[placeholder="my-gateway"]', 'smoke-new')
  await input('input[placeholder="https://api.example.com/v1"]', 'https://example.invalid/new')
  await input('input[placeholder="模型 ID"]', 'new-model')
  await click('.provider-editor button', '保存并应用')
  await until(() => evaluate('document.querySelector(".provider-editor .error")?.textContent.includes("上下文窗口")'), 'context window required')
  await input('input[placeholder="上下文（必填）"]', '64000')
  await save()
  assert.equal((await saved()).providers['smoke-new'].models[0].contextWindow, 64000)
  await openRow('smoke-new')
  await click('.provider-editor button', '删除服务商')
  await click('.provider-editor button', '确认删除服务商')
  await until(() => evaluate('!document.querySelector(".provider-editor")'), 'provider delete')
  assert.equal((await saved()).providers['smoke-new'], undefined)
  assert((await saved()).providers['smoke-provider'])
  await input('.providers-toolbar input', '')
  console.log('Provider settings passed: unified list, JSON recovery, editing, field preservation, preset restore, add/delete, model controls')
}
