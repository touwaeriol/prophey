const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-outputs-test-'))

let outputs

before(() => {
  esbuild.buildSync({
    entryPoints: [path.join(root, 'apps/desktop/src/renderer/src/lib/session-outputs.ts')],
    outfile: path.join(temp, 'outputs.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs'
  })
  outputs = require(path.join(temp, 'outputs.cjs'))
})

after(() => fs.rmSync(temp, { recursive: true, force: true }))

/** Minimal ChatItem factory: only the fields the extractor reads. */
function item(calls) {
  return {
    id: 'item',
    role: 'assistant',
    text: '',
    toolCalls: calls.map((call, index) => ({
      id: `call-${index}`,
      name: call.name,
      args: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
      status: call.status ?? 'done'
    }))
  }
}

test('collects write/edit tool paths per engine and resolves them against the workspace', () => {
  const workspace = 'D:\\repo'
  const list = outputs.sessionOutputs(
    [
      item([{ name: 'write_file', args: { path: 'src/a.ts', content: 'x' } }]),
      item([{ name: 'write', args: { file_path: 'docs/readme.md' } }]),
      item([{ name: 'Edit', args: { file_path: 'D:\\elsewhere\\b.ts' } }])
    ],
    workspace
  )
  assert.deepEqual(
    list.map((entry) => entry.path),
    ['D:\\elsewhere\\b.ts', 'D:\\repo/docs/readme.md', 'D:\\repo/src/a.ts']
  )
  assert.deepEqual(
    list.map((entry) => entry.name),
    ['b.ts', 'readme.md', 'a.ts']
  )
  // An absolute path stays absolute; write vs edit is kept for the row badge.
  assert.equal(list[1].kind, 'write')
  assert.equal(list[0].kind, 'edit')
})

test('a file touched twice appears once, newest first, keeping the first kind', () => {
  const list = outputs.sessionOutputs(
    [
      item([{ name: 'write_file', args: { path: 'src/a.ts' } }]),
      item([{ name: 'edit_file', args: { path: './src/a.ts' } }]),
      item([{ name: 'write_file', args: { path: 'src/z.ts' } }])
    ],
    '/repo'
  )
  assert.deepEqual(
    list.map((entry) => entry.path),
    ['/repo/src/z.ts', '/repo/src/a.ts']
  )
  assert.equal(list[1].kind, 'write')
  assert.equal(list[1].order, 1)
})

test('reads Codex apply_patch blocks for every touched file', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@',
    '-old',
    '+new',
    '*** Add File: src/new.ts',
    '+hello',
    '*** Delete File: src/gone.ts',
    '*** End Patch'
  ].join('\n')
  const list = outputs.sessionOutputs([item([{ name: 'apply_patch', args: { input: patch } }])], '/repo')
  assert.deepEqual(
    list.map((entry) => entry.path).sort(),
    ['/repo/src/a.ts', '/repo/src/gone.ts', '/repo/src/new.ts']
  )
  assert(list.every((entry) => entry.kind === 'patch'))
})

test('ignores failed calls, other tools and unusable arguments', () => {
  const list = outputs.sessionOutputs(
    [
      item([{ name: 'write_file', args: { path: 'src/failed.ts' }, status: 'error' }]),
      item([{ name: 'run_bash', args: { command: 'echo hi > src/shell.ts' } }]),
      item([{ name: 'write_file', args: 'not json' }]),
      item([{ name: 'write_file', args: {} }]),
      item([{ name: 'write_file', args: { path: 'src/ok.ts' } }])
    ],
    '/repo'
  )
  assert.deepEqual(
    list.map((entry) => entry.path),
    ['/repo/src/ok.ts']
  )
})

test('resolveOutputPath keeps absolute paths and drops relative ones without a workspace', () => {
  assert.equal(outputs.resolveOutputPath('C:\\x\\y.ts', '/repo'), 'C:\\x\\y.ts')
  assert.equal(outputs.resolveOutputPath('/abs/y.ts', '/repo'), '/abs/y.ts')
  assert.equal(outputs.resolveOutputPath('y.ts', ''), undefined)
  assert.equal(outputs.resolveOutputPath('   ', '/repo'), undefined)
  assert.equal(outputs.resolveOutputPath('y.ts', '/repo/'), '/repo/y.ts')
})
