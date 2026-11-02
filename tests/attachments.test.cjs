/**
 * Pasted attachments: the text block the composer carries, and the absolute paths under it.
 *
 * A file copied in WeChat or Explorer has no bytes the provider could receive — the path is the
 * payload. These tests pin both halves: the block format (so chips, the bubble, removal and the
 * model prompt cannot drift apart) and the tool change that makes an absolute path readable at all.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-attach-'))

const load = (file) => import(pathToFileURL(path.join(root, 'apps/desktop/src/renderer/src/lib', file)).href)

test('a pasted path becomes one block that is also the chip list', async () => {
  const { insertAttachments, attachmentsOf, attachmentPrompt } = await load('attachments.ts')
  const out = insertAttachments('', [{ path: 'D:\\wx\\报告 v2.pdf', size: '2.4 MB' }])
  assert.equal(out.added, 1)
  assert.match(out.text, /【附件】/)
  assert.deepEqual(attachmentsOf(out.text), [{ path: 'D:\\wx\\报告 v2.pdf', size: '2.4 MB' }])
  // A file-only message still tells the model to open them.
  assert.match(attachmentPrompt(out.text), /^看一下我粘贴的附件。/)
  // Prose is left alone once there is some.
  assert.match(attachmentPrompt(`看这个\n\n${out.text}`), /^看这个/)
})

test('pasting again merges into the same block and never repeats a path', async () => {
  const { insertAttachments, attachmentsOf } = await load('attachments.ts')
  const one = insertAttachments('说明', [{ path: '/tmp/a.txt', size: '1 B' }])
  const two = insertAttachments(one.text, [
    { path: '/tmp/a.txt', size: '1 B' },
    { path: '/tmp/b · c.md', size: '2 KB' }
  ])
  assert.equal(two.added, 1)
  assert.equal(two.text.split('【附件】').length - 1, 1, '一个块，不是两个')
  // The separator lives inside the path; parsing must still keep it whole.
  assert.deepEqual(attachmentsOf(two.text).map((entry) => entry.path), ['/tmp/a.txt', '/tmp/b · c.md'])
})

test('removal takes the path out and drops the block once it is empty', async () => {
  const { insertAttachments, removeAttachment, attachmentsOf } = await load('attachments.ts')
  const single = insertAttachments('正文', [{ path: '/tmp/a.txt', size: '' }]).text
  assert.equal(removeAttachment(single, '/tmp/a.txt').trim(), '正文')

  const two = insertAttachments('正文', [
    { path: '/tmp/a.txt', size: '' },
    { path: '/tmp/b.txt', size: '' }
  ]).text
  const left = removeAttachment(two, '/tmp/a.txt')
  assert.match(left, /【附件】/)
  assert.deepEqual(attachmentsOf(left).map((entry) => entry.path), ['/tmp/b.txt'])
})

test('the cap refuses the extra files instead of growing forever', async () => {
  const { insertAttachments, MAX_ATTACHMENTS, attachmentsOf } = await load('attachments.ts')
  const many = Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, at) => ({ path: `/tmp/${at}.txt`, size: '' }))
  const out = insertAttachments('', many)
  assert.equal(out.added, MAX_ATTACHMENTS)
  assert.equal(out.skipped, 3)
  assert.equal(attachmentsOf(out.text).length, MAX_ATTACHMENTS)
})

test('the bubble shows files as rows, not as the transport block', async () => {
  const { insertAttachments, stripAttachments, baseName } = await load('attachments.ts')
  const text = insertAttachments('看一下', [{ path: 'D:\\wx\\a.pdf', size: '12 KB' }]).text
  const { prose, files } = stripAttachments(text)
  assert.equal(prose, '看一下')
  assert.deepEqual(files.map((file) => baseName(file.path)), ['a.pdf'])
})

test('the workspace tools read an absolute path outside every root', async () => {
  const tools = await import(pathToFileURL(path.join(root, 'packages/mcp-core/tools/workspace.mjs')).href)
  const outside = path.join(temp, 'outside.txt')
  fs.writeFileSync(outside, 'pasted elsewhere')
  const context = { roots: [{ name: 'project', path: path.join(temp, 'project'), primary: true }] }
  fs.mkdirSync(path.join(temp, 'project'), { recursive: true })

  const read = tools.workspaceTools.find((tool) => tool.name === 'read_file')
  const body = (await read.call({ path: outside }, context)).content[0].text
  assert.match(body, /pasted elsewhere/)

  // A relative escape is still refused: the root list stays a boundary for relative paths.
  const escaped = await read.call({ path: '../outside.txt' }, context)
  assert.equal(escaped.isError, true)
  assert.match(escaped.content[0].text, /超出目录/)

  // Writing to an absolute path works too, and the label in the result is the primary root's name.
  const write = tools.workspaceTools.find((tool) => tool.name === 'write_file')
  const target = path.join(temp, 'written.txt')
  const wrote = await write.call({ path: target, content: 'ok' }, context)
  assert.match(wrote.content[0].text, /project/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'ok')
})

test('a pasted file can be revealed from outside the workspace, a folder cannot', async () => {
  const { revealTarget } = await import(
    pathToFileURL(path.join(root, 'apps/desktop/src/main/reveal-policy.ts')).href
  )
  const workspace = path.join(temp, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const outside = path.join(temp, 'outside.pdf')
  fs.writeFileSync(outside, 'x')
  fs.writeFileSync(path.join(workspace, 'in.txt'), 'x')
  const roots = [workspace]

  // The attachment case: a file somewhere else entirely still opens.
  assert.equal((await revealTarget(outside, roots)).ok, true)
  assert.equal((await revealTarget(path.join(workspace, 'in.txt'), roots)).ok, true)

  // Directories stay bounded: `C:\` is not a useful "open the folder".
  assert.equal((await revealTarget(temp, roots)).ok, false)
  assert.equal((await revealTarget(workspace, roots)).ok, true)
  assert.equal((await revealTarget(path.join(temp, 'gone.txt'), roots)).ok, false)
})
