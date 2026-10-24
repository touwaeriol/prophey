const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-renderer-tests-'))
for (const name of ['conversation-events', 'composer', 'messages', 'session-groups', 'actions', 'subagents']) {
  esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../apps/desktop/src/renderer/src/lib', name + '.ts')], outfile: path.join(temp, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs' })
}
after(() => fs.rmSync(temp, { recursive: true, force: true }))
const { applyConversationEvent: apply } = require(path.join(temp, 'conversation-events.cjs'))
const { toChatItems } = require(path.join(temp, 'messages.cjs'))
const { insertFileMention } = require(path.join(temp, 'composer.cjs'))
const event = (items, type, fields = {}) => apply(items, { type, ...fields }, 123)

test('renderer: native string messages survive both streaming and session restore', () => {
  const message = { role: 'assistant', content: 'native response' }
  let items = event([], 'message_start', { message })
  items = event(items, 'message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'native ' } })
  items = event(items, 'message_end', { message })
  assert.equal(items[0].text, 'native response')
  assert.equal(items[0].streaming, false)
  assert.equal(toChatItems([message])[0].text, items[0].text)
})

test('renderer: tool completion preserves arguments and survives final assistant snapshot', () => {
  let items = event([], 'message_start', { message: { role: 'assistant' } })
  items = event(items, 'tool_execution_start', { toolCallId: 'tool-1', toolName: 'Read', args: { path: 'file.ts' } })
  items = event(items, 'tool_execution_update', { toolCallId: 'tool-1', partialResult: { content: [{ type: 'text', text: 'partial' }] } })
  assert.equal(items[0].toolCalls[0].result, 'partial')
  items = event(items, 'tool_execution_end', { toolCallId: 'tool-1', result: { content: [{ type: 'text', text: 'denied' }] }, isError: true, durationMs: 25 })
  items = event(items, 'message_end', { message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'Read', arguments: { path: 'file.ts' } }] } })
  assert.deepEqual(items[0].toolCalls[0], { id: 'tool-1', name: 'Read', args: JSON.stringify({ path: 'file.ts' }, null, 2), status: 'error', result: 'denied', durationMs: 25 })
})

test('renderer: tool ids update their original turn without mutating past snapshots', () => {
  let items = event([], 'message_start', { message: { role: 'assistant' } })
  items = event(items, 'tool_execution_start', { toolCallId: 'old', toolName: 'Bash' })
  const previous = items
  items = event(items, 'message_start', { message: { role: 'assistant' } })
  items = event(items, 'tool_execution_end', { toolCallId: 'old', result: 'done' })
  assert.equal(items[0].toolCalls[0].status, 'done')
  assert.equal(items[1].toolCalls.length, 0)
  assert.equal(previous[0].toolCalls[0].status, 'running')
})

test('renderer: user images and system notices retain their role', () => {
  let items = [{ id: 'u', role: 'user', text: '', toolCalls: [], pending: true }]
  items = event(items, 'message_end', { message: { role: 'user', content: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }] } })
  assert.equal(items[0].pending, false)
  assert.deepEqual(items[0].images, [{ data: 'YWJj', mimeType: 'image/png' }])
  items = event(items, 'message_end', { message: { role: 'custom', customType: 'subagent_notice', content: '<system-reminder>finished</system-reminder>' } })
  assert.equal(items[1].role, 'system')
  assert.equal(items[1].text, 'finished')
  assert.equal(event(items, 'unknown'), items)
})

test('renderer: file mentions replace paths containing s and preserve surrounding words', () => {
  assert.deepEqual(insertFileMention('read @src', 9, 'src/main.ts'), { text: 'read @src/main.ts ', caret: 18 })
  assert.equal(insertFileMention('read @src after', 9, 'src/main.ts').text, 'read @src/main.ts  after')
  assert.equal(insertFileMention('read @old next', 14, 'new.ts').text, 'read @old next@new.ts ')
  assert.equal(insertFileMention('@src\\test', 9, 'file.ts').text, '@file.ts ')
})

const { buildSessionGroups } = require(path.join(temp, 'session-groups.cjs'))
const { runAction } = require(path.join(temp, 'actions.cjs'))
const { isSubagentRunning } = require(path.join(temp, 'subagents.cjs'))
const session = (id, cwd) => ({ id, path: id, title: id, cwd, createdAt: 1, updatedAt: Date.now() })
function groupOptions(group) {
  return {
    sessions: [{ ...session('inside', 'C:/repo'), projectId: 'p' }, session('outside', 'C:/elsewhere'), { ...session('pinned', 'C:/repo'), projectId: 'p' }],
    pinned: ['pinned'], archived: new Set(), projectStatus: {}, projectQueries: {}, cwd: 'C:/repo',
    activeProject: { id: 'p', name: 'Project', roots: [{ path: 'c:/REPO', primary: true }, { path: 'C:/second' }] },
    prefs: { environment: 'all', group, sort: 'activity', showEmptyGroups: true, onlyActiveProject: true }
  }
}
for (const mode of ['folder', 'date', 'none']) test('renderer: project and pinned filters apply to ' + mode + ' grouping', () => {
  const groups = buildSessionGroups(groupOptions(mode))
  assert.deepEqual(groups.flatMap(g => g.sessions).map(s => s.id), ['inside'])
  if (mode === 'folder') assert.deepEqual(groups.map(g => g.key), ['project:p'])
})
test('renderer: empty groups respect the active project and do not duplicate merged roots', () => {
  const options = groupOptions('folder')
  options.sessions = []
  assert.deepEqual(buildSessionGroups(options).map(g => g.key), ['project:p'])
  options.cwd = 'C:/elsewhere'
  assert.deepEqual(buildSessionGroups(options).map(g => g.key), ['project:p'])
  options.prefs.onlyActiveProject = false
  assert.deepEqual(buildSessionGroups(options).map(g => g.key), ['project:p', 'folder:c:/elsewhere'])
})
test('renderer: archive and text filters preserve total counts and do not mutate input', () => {
  const options = groupOptions('folder')
  options.sessions.push({ ...session('archived', 'C:/repo'), projectId: 'p' })
  options.archived.add('archived')
  options.projectStatus['project:p'] = 'archived'
  options.projectQueries['project:p'] = 'arch'
  const groups = buildSessionGroups(options)
  assert.deepEqual(groups[0].sessions.map(s => s.id), ['archived'])
  assert.equal(groups[0].total, 2)
  assert.equal(options.sessions.length, 4)
})

test('renderer: project ownership does not absorb standalone sessions or another project sharing the same directory', () => {
  const options = groupOptions('folder')
  options.prefs.onlyActiveProject = false
  options.prefs.showEmptyGroups = false
  options.projects = [options.activeProject, { id: 'q', name: 'Second', roots: [{ path: 'C:/repo' }, { path: 'C:/other' }] }]
  options.sessions = [
    { ...session('one', 'C:/repo'), projectId: 'p' },
    { ...session('two', 'C:/repo'), projectId: 'q' },
    session('standalone', 'C:/repo')
  ]
  const groups = buildSessionGroups(options)
  assert.deepEqual(groups.find(g => g.key === 'project:p').sessions.map(s => s.id), ['one'])
  assert.deepEqual(groups.find(g => g.key === 'project:q').sessions.map(s => s.id), ['two'])
  assert.deepEqual(groups.find(g => g.key === 'folder:c:/repo').sessions.map(s => s.id), ['standalone'])
})

test('renderer: legacy single-directory projects stay under sessions and Windows path aliases merge', () => {
  const options = groupOptions('folder')
  options.prefs.onlyActiveProject = false
  options.prefs.showEmptyGroups = false
  options.activeProject = undefined
  options.projects = [{ id: 'legacy', name: 'Old', roots: [{ path: 'C:/repo' }] }]
  options.sessions = [{ ...session('one', 'C:/repo'), projectId: 'legacy' }, session('two', 'c:\\REPO\\')]
  const groups = buildSessionGroups(options)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].rootCount, undefined)
  assert.equal(groups[0].sessions.length, 2)
})
const plainSession = (id, cwd, created, updated) => ({
  id, path: id, title: id, cwd, createdAt: created, updatedAt: updated
})
function plainOptions(sessions, prefs = {}) {
  return {
    sessions, pinned: [], archived: new Set(), projectStatus: {}, projectQueries: {}, cwd: 'C:/alpha',
    prefs: {
      environment: 'all', group: 'folder', sort: 'activity', showEmptyGroups: false, onlyActiveProject: false,
      ...prefs
    }
  }
}

test('renderer: switching sessions never reorders directories', () => {
  const sessions = [
    plainSession('a1', 'C:/alpha', 100, 900),
    plainSession('b1', 'C:/beta', 300, 800),
    plainSession('c1', 'C:/gamma', 200, 700)
  ]
  const before = buildSessionGroups(plainOptions(sessions)).map((group) => group.key)
  // Newest directory first: the group order comes from `born` (oldest createdAt), not from activity.
  assert.deepEqual(before, ['folder:c:/beta', 'folder:c:/gamma', 'folder:c:/alpha'])
  // Opening a session touches updatedAt; the directory it lives in must keep its slot.
  const touched = sessions.map((session) =>
    session.id === 'a1' ? { ...session, updatedAt: 5_000 } : session
  )
  const after = buildSessionGroups({ ...plainOptions(touched), activePath: 'a1' }).map((group) => group.key)
  assert.deepEqual(after, before)
  // ...and the open session now leads its own group.
  const group = buildSessionGroups({ ...plainOptions(touched), activePath: 'a1' })
    .find((entry) => entry.key === 'folder:c:/alpha')
  assert.deepEqual(group.sessions.map((session) => session.id), ['a1'])
})

test('renderer: the open session leads its directory, name sort keeps its own order', () => {
  const sessions = [
    plainSession('a1', 'C:/alpha', 100, 900),
    plainSession('a2', 'C:/alpha', 110, 1000),
    plainSession('a3', 'C:/alpha', 120, 800)
  ]
  const activity = buildSessionGroups({ ...plainOptions(sessions), activePath: 'a3' })[0]
  assert.deepEqual(activity.sessions.map((session) => session.id), ['a3', 'a2', 'a1'])

  const byName = buildSessionGroups({ ...plainOptions(sessions, { sort: 'name' }), activePath: 'a3' })[0]
  assert.deepEqual(byName.sessions.map((session) => session.id), ['a1', 'a2', 'a3'])
})

test('renderer: a brand-new directory sorts in without shifting the others', () => {
  const sessions = [
    plainSession('a1', 'C:/alpha', 100, 900),
    plainSession('b1', 'C:/beta', 300, 800)
  ]
  const before = buildSessionGroups(plainOptions(sessions)).map((group) => group.key)
  assert.deepEqual(before, ['folder:c:/beta', 'folder:c:/alpha'])
  const withNewDirectory = buildSessionGroups(
    plainOptions([...sessions, plainSession('d1', 'C:/delta', 400, 400)])
  ).map((group) => group.key)
  assert.deepEqual(withNewDirectory, ['folder:c:/delta', ...before])
  // A new session inside an existing directory does not move that directory either.
  const withNewSession = buildSessionGroups(
    plainOptions([...sessions, plainSession('a2', 'C:/alpha', 500, 500)])
  ).map((group) => group.key)
  assert.deepEqual(withNewSession, before)
})

test('renderer: pinning or archiving the oldest session does not make its directory look new', () => {
  const sessions = [
    plainSession('a1', 'C:/alpha', 100, 900),
    plainSession('a2', 'C:/alpha', 110, 950),
    plainSession('b1', 'C:/beta', 300, 800)
  ]
  const before = buildSessionGroups(plainOptions(sessions)).map((group) => group.key)
  assert.deepEqual(before, ['folder:c:/beta', 'folder:c:/alpha'])

  const pinned = buildSessionGroups({ ...plainOptions(sessions), pinned: ['a1'] })
  assert.deepEqual(pinned.map((group) => group.key), before)
  assert.deepEqual(pinned.find((group) => group.key === 'folder:c:/alpha').sessions.map((s) => s.id), ['a2'])

  const archived = { ...plainOptions(sessions), archived: new Set(['a1']) }
  assert.deepEqual(buildSessionGroups(archived).map((group) => group.key), before)
})

test('renderer: failed saves preserve draft, release busy and report result or transport error', async () => {
  for (const task of [async () => ({ ok: false, error: 'rejected' }), async () => { throw new Error('offline') }]) {
    let draft = 'unsaved configuration'
    const busy = [], errors = []
    const ok = await runAction(task, { setBusy: value => busy.push(value), onError: error => errors.push(error), onSuccess: () => assert.fail('failed saves must not run success effects') })
    if (ok) draft = undefined
    assert.equal(draft, 'unsaved configuration')
    assert.deepEqual(busy, [true, false])
    assert.equal(errors.length, 1)
  }
  let draft = 'saved configuration'
  const ok = await runAction(async () => ({ ok: true }), { setBusy() {}, onError: assert.fail, onSuccess() {} })
  if (ok) draft = undefined
  assert.equal(draft, undefined)
})
test('renderer: shared subagent state excludes settled and restored stopped runs', () => {
  for (const status of ['starting', 'streaming']) assert.equal(isSubagentRunning({ status }), true)
  for (const status of ['idle', 'error', 'stopped']) assert.equal(isSubagentRunning({ status }), false)
})
