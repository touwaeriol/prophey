const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-composer-test-'))

let composer

before(() => {
  esbuild.buildSync({
    entryPoints: [path.join(root, 'apps/desktop/src/renderer/src/lib/session-composer.ts')],
    outfile: path.join(temp, 'session-composer.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs'
  })
  composer = require(path.join(temp, 'session-composer.cjs'))
})

after(() => fs.rmSync(temp, { recursive: true, force: true }))

const queued = (id, text) => ({ id, text, images: [] })

test('composer: a draft typed in one session is not visible in another', () => {
  let map = composer.patchComposer({}, 'a.jsonl', { draft: 'half written' })
  assert.equal(composer.composerFor(map, 'a.jsonl').draft, 'half written')
  assert.equal(composer.composerFor(map, 'b.jsonl').draft, '')
})

test('composer: patches only touch the session they name, updaters included', () => {
  let map = composer.patchComposer({}, 'a.jsonl', { queued: [queued('q-1', 'first')] })
  map = composer.patchComposer(map, 'b.jsonl', (previous) => ({
    queued: [...previous.queued, queued('q-2', 'second')]
  }))
  assert.deepEqual(composer.composerFor(map, 'a.jsonl').queued.map((item) => item.id), ['q-1'])
  assert.deepEqual(composer.composerFor(map, 'b.jsonl').queued.map((item) => item.id), ['q-2'])
})

test('composer: images and queue are dropped per session, never window-wide', () => {
  const image = { id: 'i-1', data: 'base64', mimeType: 'image/png' }
  let map = composer.patchComposer({}, 'a.jsonl', { images: [image], queued: [queued('q-1', 'x')] })
  map = composer.patchComposer(map, 'a.jsonl', { images: [], queued: [] })
  assert.equal(composer.composerFor(map, 'a.jsonl').images.length, 0)
  assert.equal(composer.composerFor(map, 'a.jsonl').queued.length, 0)
})

test('composer: the pre-session draft moves onto the session that claims it', () => {
  let map = composer.patchComposer({}, composer.LOCAL_COMPOSER_KEY, { draft: 'typed before startup' })
  map = composer.adoptComposer(map, composer.LOCAL_COMPOSER_KEY, 'a.jsonl')
  assert.equal(composer.composerFor(map, 'a.jsonl').draft, 'typed before startup')
  assert.equal(map[composer.LOCAL_COMPOSER_KEY], undefined)
  // A session that already has its own draft keeps it.
  let kept = composer.patchComposer({}, 'b.jsonl', { draft: 'own' })
  kept = composer.adoptComposer(
    composer.patchComposer(kept, composer.LOCAL_COMPOSER_KEY, { draft: 'stray' }),
    composer.LOCAL_COMPOSER_KEY,
    'b.jsonl'
  )
  assert.equal(composer.composerFor(kept, 'b.jsonl').draft, 'own')
})

test('composer: persisted map round-trips and keeps empty entries out', () => {
  let map = composer.patchComposer({}, 'a.jsonl', { draft: 'keep me' })
  map = composer.patchComposer(map, 'b.jsonl', { draft: '' })
  const raw = composer.serializeComposers(map)
  assert.ok(!raw.includes('b.jsonl'))
  assert.equal(composer.parseComposers(raw)['a.jsonl'].draft, 'keep me')
})

test('composer: malformed storage is ignored instead of breaking the window', () => {
  assert.deepEqual(composer.parseComposers('not json'), {})
  assert.deepEqual(composer.parseComposers('[]'), {})
  assert.deepEqual(composer.parseComposers(null), {})
  assert.deepEqual(composer.parseComposers('{"a":{"queued":[{"text":"no id"}]}}')['a'].queued, [])
})

test('composer: pruning keeps the newest entries only', () => {
  let map = {}
  for (let index = 0; index < 5; index += 1) {
    map = composer.patchComposer(map, `s${index}.jsonl`, { draft: `d${index}` }, index)
  }
  const pruned = composer.pruneComposers(map, 2)
  assert.deepEqual(Object.keys(pruned).sort(), ['s3.jsonl', 's4.jsonl'])
})
