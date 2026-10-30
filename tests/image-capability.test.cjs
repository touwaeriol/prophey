const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const { image } = require('./history-fixture.cjs')

// A screenshot only reaches the model when the model entry declares image input. pi's catalog
// defaults a missing `input` to ['text'] and then replaces every image block with
// "(image omitted: model does not support images)" before the request leaves the process — the
// exact reason a pasted screenshot produced "我看不到图" with no error anywhere.
test('images: a model without declared image input gets a text placeholder instead of the picture', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-image-capability-'))
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      requests.push({ url: new URL(req.url, 'http://localhost').pathname, body: JSON.parse(raw) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = data => res.write('event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n')
      event({ type: 'message_start', message: { id: 'msg_proof', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
      event({ type: 'content_block_stop', index: 0 })
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
      event({ type: 'message_stop' })
      res.end()
    })
  })
  let engine
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + server.address().port
    const providers = {
      'proof-vision': {
        apiKey: 'local-test', baseUrl: base + '/v1', api: 'anthropic-messages',
        models: [{ id: 'v', name: 'v', contextWindow: 32000, maxTokens: 256, input: ['text', 'image'], reasoning: false }]
      },
      'proof-blind': {
        apiKey: 'local-test', baseUrl: base + '/v1', api: 'anthropic-messages',
        models: [{ id: 'b', name: 'b', contextWindow: 32000, maxTokens: 256, reasoning: false }]
      }
    }
    const modelsPath = path.join(temp, 'models.json')
    const authPath = path.join(temp, 'auth.json')
    fs.writeFileSync(modelsPath, JSON.stringify({ providers }))
    fs.writeFileSync(authPath, '{}')
    const stub = path.join(temp, 'providers.mjs')
    fs.writeFileSync(stub, `
      let pending;
      export async function getRuntime() { return pending ??= (async () => {
        const { ModelRuntime } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href)});
        return ModelRuntime.create({ modelsPath: ${JSON.stringify(modelsPath)}, authPath: ${JSON.stringify(authPath)}, refreshOnCreate: false });
      })() }
      export async function listModelChoices() { return (await getRuntime()).getModels().filter(m => m.provider.startsWith('proof-')) }
      export async function thinkingLevelsFor(model) {
        const { getSupportedThinkingLevels } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-ai/dist/models.js')).href)});
        return getSupportedThinkingLevels(model)
      }
    `)
    const source = fs.readFileSync(path.join(root, 'apps/desktop/src/main/agent/prophey-engine.ts'), 'utf8')
      .replace("from '../providers'", 'from ' + JSON.stringify(stub.replaceAll('\\', '/')))
    esbuild.buildSync({
      stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'apps/desktop/src/main/agent') },
      outfile: path.join(temp, 'engine.cjs'), bundle: true, platform: 'node', packages: 'external'
    })
    esbuild.buildSync({ entryPoints: [path.join(root, 'apps/desktop/src/main/transcript-store.ts')], outfile: path.join(temp, 'store.cjs'), bundle: true, platform: 'node' })
    const { PropheyEngine } = require(path.join(temp, 'engine.cjs'))
    const { TranscriptStore } = require(path.join(temp, 'store.cjs'))

    const start = async (provider, id, storeDir) => {
      const engineInstance = new PropheyEngine({
        onStatus() {}, onEvent() {}, onSettled() {},
        transcripts: new TranscriptStore(storeDir), sessionId: () => 'image-' + id
      })
      await engineInstance.start(temp, { model: { provider, id } })
      return engineInstance
    }

    engine = await start('proof-vision', 'v', path.join(temp, 'vision'))
    const visionRun = engine.prompt('这张截图是什么？', { images: [image] })
    assert.equal((await visionRun).ok, true)
    const visionBody = requests.at(-1).body
    const visionBlock = visionBody.messages
      .flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'image')
    assert.equal(visionBlock.type, 'image')
    assert.deepEqual(visionBlock.source, { type: 'base64', media_type: image.mimeType, data: image.data })
    engine.dispose()

    engine = await start('proof-blind', 'b', path.join(temp, 'blind'))
    assert.equal((await engine.prompt('这张截图是什么？', { images: [image] })).ok, true)
    const blindText = JSON.stringify(requests.at(-1).body)
    assert(!blindText.includes(image.data), 'an undeclared model must not receive the base64 payload')
    assert.match(blindText, /image omitted: model does not support images/)
  } finally {
    engine?.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('images: the provider editor writes the modality it was given and nothing else', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-model-input-'))
  try {
    esbuild.buildSync({
      entryPoints: [path.join(root, 'apps/desktop/src/shared/model-input.ts')],
      outfile: path.join(temp, 'model-input.cjs'), bundle: true, platform: 'node', format: 'cjs'
    })
    const { declaresImageInput, modelInputModalities } = require(path.join(temp, 'model-input.cjs'))
    // A custom models.json entry that never declared modalities stays text-only for pi.
    assert.equal(declaresImageInput(undefined), false)
    assert.equal(declaresImageInput([]), false)
    assert.equal(declaresImageInput(['text']), false)
    assert.equal(declaresImageInput(['text', 'image']), true)
    assert.equal(declaresImageInput('image'), false)
    assert.deepEqual(modelInputModalities(true), ['text', 'image'])
    assert.deepEqual(modelInputModalities(false), ['text'])
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('images: saving the provider form records the vision switch and keeps unknown fields', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-provider-models-'))
  try {
    esbuild.buildSync({
      entryPoints: [path.join(root, 'apps/desktop/src/renderer/src/lib/provider-models.ts')],
      outfile: path.join(temp, 'provider-models.cjs'),
      bundle: true, platform: 'node', format: 'cjs',
      alias: { '@shared/model-input': path.join(root, 'apps/desktop/src/shared/model-input.ts') }
    })
    const { buildProviderModels, emptyModel } = require(path.join(temp, 'provider-models.cjs'))
    const row = (patch) => ({ ...emptyModel(), id: 'deepseek-flash', contextWindow: '1000000', ...patch })

    const [vision] = buildProviderModels([row({ images: true })])
    assert.deepEqual(vision.input, ['text', 'image'])
    assert.equal(vision.contextWindow, 1000000)

    // Unticking the box must write ['text'], not drop the field: a missing `input` is the silent-drop
    // case this whole path exists to avoid.
    const [blind] = buildProviderModels([row({ images: false })])
    assert.deepEqual(blind.input, ['text'])

    const [kept] = buildProviderModels([row({
      images: true,
      raw: { input: ['text'], compat: { thinking: 'openai' }, headers: { 'x-a': 'b' }, inputLimits: { image: 8 } }
    })])
    assert.deepEqual(kept.compat, { thinking: 'openai' })
    assert.deepEqual(kept.headers, { 'x-a': 'b' })
    assert.deepEqual(kept.inputLimits, { image: 8 })
    assert.deepEqual(kept.input, ['text', 'image'])
    assert.deepEqual(kept.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.equal(buildProviderModels([row({ id: '  ' })]).length, 0)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
