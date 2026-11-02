const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-dsml-'))
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }))

function load(relative) {
  const outfile = path.join(temp, path.basename(relative) + '.cjs')
  esbuild.buildSync({ entryPoints: [path.join(root, relative)], outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  return require(outfile)
}
const { hasToolCallMarkup, repairToolCallText } = load('apps/desktop/src/shared/dsml-repair.ts')

/**
 * DeepSeek's tool-call markup arriving as reply text.
 *
 * The gateway (ccgateway in front of deepseek-flash) handed this back as the message's text in
 * session `s_99a5d7e6`: no tool ran, and the window painted the tags as prose. The samples here are
 * copied from that session and from the screenshot the user reported.
 */
test('dsml: a real gateway reply becomes calls, and its prose survives', () => {
  const text = [
    '我先了解项目结构和相关代码。',
    '',
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="run_bash">',
    '<｜｜DSML｜｜ parameter name="command" string="true">cd /d D:\\projects\\js\\adsclaude && dir /b && echo ---- && git status --short | head -50</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '<｜｜DSML｜｜ invoke name="run_bash">',
    '<｜｜DSML｜｜ parameter name="command" string="true">findstr /s /i /m "ccgateway" *.ts *.tsx</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="directory" string="true">D:\\projects\\js\\adsclaude</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '<｜｜DSML｜｜ calls>'
  ].join('\n')
  assert.equal(hasToolCallMarkup(text), true)
  const repaired = repairToolCallText(text)
  assert.equal(repaired.text, '我先了解项目结构和相关代码。', 'the prose is kept, the markup is not')
  assert.deepEqual(repaired.calls, [
    { name: 'run_bash', arguments: { command: 'cd /d D:\\projects\\js\\adsclaude && dir /b && echo ---- && git status --short | head -50' } },
    { name: 'run_bash', arguments: { command: 'findstr /s /i /m "ccgateway" *.ts *.tsx', directory: 'D:\\projects\\js\\adsclaude' } }
  ])
})

test('dsml: the marker is recognised in the shapes the gateways emit', () => {
  // Full-width bars, ASCII bars, and spaces around them have all been seen on the wire.
  for (const marker of ['<｜｜DSML｜｜ calls>', '<||DSML|| calls>', '< | | DSML | | calls>']) {
    assert.equal(hasToolCallMarkup(marker), true, marker)
  }
  // A mangled block name ("tool_calls" cut down to " calls") must not matter: only invoke/parameter
  // carry meaning.
  const repaired = repairToolCallText(
    '<||DSML|| tool_calls>\n<||DSML|| invoke name="grep_files">\n<||DSML|| parameter name="pattern" string="true">compact</||DSML|| parameter>\n</||DSML|| invoke>\n</||DSML|| tool_calls>'
  )
  assert.deepEqual(repaired.calls, [{ name: 'grep_files', arguments: { pattern: 'compact' } }])
  assert.equal(repaired.text, '')
})

test('dsml: ordinary prose is left untouched', () => {
  const text = '压缩完就把摘要放进对话，用户可以改。DeepSeek 会写 <tag> 这种，但不是工具调用。'
  assert.equal(hasToolCallMarkup(text), false)
  assert.deepEqual(repairToolCallText(text), { text, calls: [] })
})

test('dsml: a parameter that is not a string is JSON, as the model wrote it', () => {
  const repaired = repairToolCallText(
    '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="ask_user_question">\n<｜｜DSML｜｜ parameter name="questions">[{"question":"继续吗？","options":[{"label":"继续"}]}]</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="count">3</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
  )
  assert.deepEqual(repaired.calls, [{
    name: 'ask_user_question',
    arguments: { questions: [{ question: '继续吗？', options: [{ label: '继续' }] }], count: 3 }
  }])
})

test('dsml: markup with nothing parseable still never reaches the window as prose', () => {
  // A stream cut in the middle of the block: there is no call to run, but the user must not read tags.
  const repaired = repairToolCallText('先看一下。\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="run_')
  assert.deepEqual(repaired.calls, [])
  assert.equal(repaired.text, '先看一下。')
})
