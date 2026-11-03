const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-compaction-prompt-'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))

const outfile = path.join(temp, 'compaction-prompt.cjs')
esbuild.buildSync({
  entryPoints: [path.join(root, 'apps/desktop/src/main/agent/compaction-prompt.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const prompt = require(outfile)

/**
 * The summary is the only thing that survives a compaction, so these tests pin the three decisions
 * that make it usable afterwards: the conversation arrives as a document (not as history the model
 * would answer), the summary has fixed sections, and the file lists are extracted rather than
 * remembered.
 */

const user = (text) => ({ role: 'user', content: text, timestamp: 1 })
const assistant = (...content) => ({ role: 'assistant', content, timestamp: 2 })
const result = (text, name = 'read_file', isError = false) => ({
  role: 'toolResult',
  toolCallId: 'c1',
  toolName: name,
  content: [{ type: 'text', text }],
  isError,
  timestamp: 3
})
const call = (name, args) => ({ type: 'toolCall', id: 'c1', name, arguments: args })

test('the conversation becomes a document, not a replay of the messages', () => {
  const text = prompt.serializeConversation([
    user('修一下登录'),
    assistant({ type: 'text', text: '先读文件' }),
    result('文件内容'),
    result('工具报错', 'run_bash', true)
  ])
  assert.match(text, /### 用户\n修一下登录/)
  assert.match(text, /### 助手\n先读文件/)
  assert.match(text, /### 工具结果 · read_file\n文件内容/, 'a result says which tool produced it')
  assert.match(text, /### 工具结果 · run_bash（失败）\n工具报错/, 'a failed call is marked')
})

test('the request is one user message carrying the instruction after the conversation', () => {
  const request = prompt.summaryRequest({ conversation: [user('修一下登录')] })
  assert.match(request.prompt, /^<conversation>/, 'the document comes first')
  assert.match(request.prompt, /<\/conversation>[\s\S]*## 目标/, 'the format comes after the document')
  for (const section of [
    '## 目标',
    '## 用户的约束与偏好',
    '## 当前请求',
    '## 进展',
    '### 已完成',
    '### 正在进行',
    '### 受阻',
    '## 关键决定',
    '## 下一步',
    '## 继续工作所需的事实'
  ]) {
    assert.ok(request.prompt.includes(section), `missing section ${section}`)
  }
  assert.match(request.prompt, /原文照抄/, 'the newest request must be quoted, not paraphrased')
  assert.match(request.prompt, /逐字/, 'facts must be copied, not rewritten')
  assert.match(request.systemPrompt, /不要继续这段对话/, 'the system prompt forbids continuing the conversation')
  assert.match(request.systemPrompt, /你在压缩一段编码会话的上下文/, 'stable marker used by the request filter')
})

test('the newest turn is quoted rather than summarised away', () => {
  const conversation = prompt.serializeConversation([
    user('项目在 D:\\work\\adsclaude'),
    assistant({ type: 'text', text: '好' }),
    user('把 packages/api/src/auth.ts 的 401 改成重试一次（错误是 TOKEN_EXPIRED）')
  ])
  // The instruction to quote it verbatim only works if the text itself survives serialisation.
  assert.match(conversation, /把 packages\/api\/src\/auth\.ts 的 401 改成重试一次（错误是 TOKEN_EXPIRED）/)
})

test('tool results are clipped so one huge log cannot crowd out the conversation', () => {
  const huge = 'x'.repeat(50000)
  const conversation = prompt.serializeConversation([user('看看日志'), result(huge)])
  assert.ok(conversation.length < 12000, `conversation stayed bounded (${conversation.length})`)
  assert.match(conversation, /此处省略 48000 字符/)
})

test('thinking blocks and images are not carried into the summary request', () => {
  const conversation = prompt.serializeConversation([
    user([{ type: 'text', text: '看图' }, { type: 'image', source: { data: 'BASE64PAYLOAD' } }]),
    assistant({ type: 'thinking', thinking: 'PRIVATE_THOUGHT', signature: 'SIG' }, { type: 'text', text: '收到' })
  ])
  assert.doesNotMatch(conversation, /PRIVATE_THOUGHT/)
  assert.doesNotMatch(conversation, /BASE64PAYLOAD/)
  assert.match(conversation, /\[图片\]/)
  assert.match(conversation, /收到/)
})

test('over budget: the newest messages and the opening goal survive, the middle is dropped by name', () => {
  const messages = [user('最初的目的一二三')]
  for (let index = 0; index < 60; index += 1) messages.push(user(`普通消息 ${index} ${'y'.repeat(400)}`))
  messages.push(user('最新的一条'))
  const conversation = prompt.serializeConversation(messages, 20000)
  assert.match(conversation, /最初的目的一二三/, 'the goal is always kept')
  assert.match(conversation, /最新的一条/, 'the tail is always kept')
  assert.match(conversation, /此处省略了更早的 \d+ 条消息/)
  assert.ok(conversation.length < 30000, `budget respected (${conversation.length})`)
})

test('a second pass merges into the previous summary instead of rewriting it', () => {
  const request = prompt.summaryRequest({
    conversation: [user('继续，把测试补上')],
    previousSummary: '## 目标\n修登录\n\n## 进展\n- [ ] 改 auth.ts'
  })
  assert.match(request.prompt, /<previous-summary>\n## 目标\n修登录/)
  assert.match(request.prompt, /只增不减/, 'the merge rule that keeps earlier facts')
  assert.match(request.prompt, /从「正在进行」移到「已完成」/)
  assert.ok(request.prompt.indexOf('<previous-summary>') < request.prompt.indexOf('## 目标\n用户要实现什么'))
})

test('`/compact <提示词>` becomes an extra instruction, not a rewrite of the format', () => {
  const request = prompt.summaryRequest({ conversation: [user('随便')], instructions: '重点保留数据库迁移的步骤' })
  assert.match(request.prompt, /用户对这次压缩的额外要求：重点保留数据库迁移的步骤/)
  assert.match(request.prompt, /## 目标/, 'the sections are still required')
})

test('file lists come from the tool calls, with MCP prefixes stripped', () => {
  const operations = prompt.fileOperations([
    assistant(call('read_file', { path: 'src/a.ts' })),
    assistant(call('codegraph__codegraph_search', { query: 'x' })),
    assistant(call('read', { file_path: 'C:\\repo\\src\\b.ts' })),
    assistant(call('edit_file', { path: 'src/a.ts' })),
    assistant(call('write', { file_path: 'docs/readme.md' })),
    assistant(call('read_file', { path: 'SRC/A.TS' })),
    assistant(call('edit_file', {})),
    assistant(call('grep_files', { pattern: 'x' }))
  ])
  assert.deepEqual(operations.read, ['src/a.ts', 'C:\\repo\\src\\b.ts'], 'deduped case-insensitively, in order')
  assert.deepEqual(operations.modified, ['src/a.ts', 'docs/readme.md'])
})

test('the formatted lists round-trip, so a second pass can rebuild instead of re-guess', () => {
  const operations = { read: ['src/a.ts'], modified: ['src/b.ts'] }
  const text = `## 目标\n修登录\n\n${prompt.formatFileOperations(operations)}`
  assert.match(text, /<read-files>\n- src\/a\.ts\n<\/read-files>/)
  const parsed = prompt.stripFileOperations(text)
  assert.equal(parsed.body, '## 目标\n修登录', 'the lists are not left in the body the model rewrites')
  assert.deepEqual(parsed.operations, operations)
  assert.deepEqual(prompt.mergeOperations(parsed.operations, { read: ['src/c.ts'], modified: [] }), {
    read: ['src/a.ts', 'src/c.ts'],
    modified: ['src/b.ts']
  })
})

test('summaryBody strips the marker the window paints', () => {
  assert.equal(prompt.summaryBody({ role: 'user', content: '【此前对话摘要】\n## 目标\n修' }), '## 目标\n修')
  assert.equal(prompt.summaryBody({ role: 'user', content: '没有标记的正文' }), '没有标记的正文')
})
