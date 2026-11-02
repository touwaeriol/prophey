const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-bash-test-'))
for (const [name, source] of [['tasks', 'agent/bash-tasks'], ['shell', 'shell']]) {
  esbuild.buildSync({ entryPoints: [path.join(root, 'apps/desktop/src/main', source + '.ts')], outfile: path.join(temp, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs' })
}
const { BashTasks } = require(path.join(temp, 'tasks.cjs'))
const shell = require(path.join(temp, 'shell.cjs')).realBashPath() || 'bash'
const managers = []
const body = result => result.content[0].text
const taskId = result => body(result).match(/^bash_[\w-]+/)[0]
function manager(notices = []) {
  const value = new BashTasks({ directory: temp, shell, notify: text => notices.push(text) })
  managers.push(value)
  return value
}
after(async () => {
  for (const value of managers) value.dispose()
  await Promise.all(managers.flatMap(value => [...value.tasks.values()].map(task => task.done)))
  fs.rmSync(temp, { recursive: true, force: true })
})

test('short commands return bounded text while preserving complete stdout/stderr on disk', async () => {
  const notices = [], value = manager(notices)
  const result = await value.run({ cwd: temp, command: "printf '%0100000d' 0; printf 'failure-proof' >&2; exit 7", yield_time_ms: 10000 })
  assert.equal(result.isError, true)
  assert(body(result).length < 4500)
  assert(body(result).includes('failure-proof'))
  const task = value.tasks.get(taskId(result))
  assert.equal(fs.statSync(task.file).size, 100013)
  assert.equal(notices.length, 0)
})

test('long commands yield, survive caller cancellation after detaching, and notify once', async () => {
  const notices = [], value = manager(notices), controller = new AbortController()
  const start = Date.now()
  const result = await value.run({ cwd: temp, command: 'printf first; sleep 0.5; printf second', yield_time_ms: 10 }, controller.signal)
  const id = taskId(result)
  assert(Date.now() - start < 450)
  assert(body(result).includes('running'))
  assert.equal(value.active().length, 1)
  assert.equal(value.active()[0].id, id)
  controller.abort()
  await value.tasks.get(id).done
  assert.equal(notices.length, 1)
  assert.equal(value.active().length, 0)
  const output = body(await value.read({ task_id: id }))
  assert(output.includes('firstsecond'))
  const cursor = Number(output.match(/offset=(\d+)/)[1])
  assert(body(await value.read({ task_id: id, offset: cursor })).includes('暂无输出'))
})

test('foreground cancellation kills the process tree and explicit background tasks can be stopped', async () => {
  const value = manager(), controller = new AbortController()
  const pending = value.run({ cwd: temp, command: 'sleep 2; printf leaked > abort-marker', yield_time_ms: 10000 }, controller.signal)
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending, /abort/i)
  const started = await value.run({ cwd: temp, command: 'sleep 2; printf leaked > stop-marker', run_in_background: true })
  const result = await value.stop(taskId(started))
  // The killer can lose a race with a process that is already exiting; the stop must still read as
  // a stop rather than turning into a failure (see `kill`).
  assert(body(result).includes('stopped'), body(result))
  assert.equal(value.tasks.get(taskId(started)).state, 'stopped')
  await new Promise(resolve => setTimeout(resolve, 2100))
  assert.equal(fs.existsSync(path.join(temp, 'abort-marker')), false)
  assert.equal(fs.existsSync(path.join(temp, 'stop-marker')), false)
})

test('timeouts and missing shells produce actionable failure status', async () => {
  const value = manager()
  const started = await value.run({ cwd: temp, command: 'sleep 5', timeout: 1, run_in_background: true })
  await value.tasks.get(taskId(started)).done
  const result = await value.read({ task_id: taskId(started), status_only: true })
  assert.equal(result.isError, true)
  assert(body(result).includes('超过运行时限'))
  const missing = new BashTasks({ directory: temp, shell: path.join(temp, 'missing-shell'), notify() {} })
  managers.push(missing)
  assert.equal((await missing.run({ cwd: temp, command: 'true' })).isError, true)
})

test('byte cursors preserve UTF-8 across output pages', async () => {
  const value = manager()
  const result = await value.run({ cwd: temp, command: "printf '中文%.0s' {1..200}", yield_time_ms: 10000 })
  const id = taskId(result)
  let offset = 0, recovered = ''
  while (offset < 1200) {
    const page = body(await value.read({ task_id: id, offset, max_bytes: 256 }))
    recovered += page.slice(page.indexOf('\n', page.indexOf('下一游标')) + 1)
    offset = Number(page.match(/offset=(\d+)/)[1])
  }
  assert.equal(recovered, '中文'.repeat(200))
})

test('subagent transcript pagination does not skip long messages and JSON stays bounded', async () => {
  const { getSubagent } = await import(pathToFileURL(path.join(root, 'packages/mcp-core/tools/subagent.mjs')).href)
  const content = 'a'.repeat(9000)
  const record = { id: 'sa_test', status: 'idle', messages: [{ role: 'assistant', text: content }], calls: [], finalText: content }
  const context = { request: async () => ({ ok: true, subagent: record }) }
  let since = 0, offset = 0, recovered = ''
  while (since === 0) {
    const page = JSON.parse(body(await getSubagent.call({ id: record.id, include: ['messages'], since, offset, format: 'json' }, context))).subagent
    recovered += page.messages[0].text
    since = page.next_since; offset = page.next_offset
  }
  assert.equal(recovered, content)
  assert(body(await getSubagent.call({ id: record.id, format: 'json' }, context)).length < 4500)
})
