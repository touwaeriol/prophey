const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-renderer-tests-'))
for (const name of ['conversation-events', 'composer', 'messages', 'session-groups', 'session-messages', 'session-scroll', 'actions', 'subagents', 'layout-prefs', 'video', 'context-usage']) {
  esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../apps/desktop/src/renderer/src/lib', name + '.ts')], outfile: path.join(temp, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs' })
}
after(() => fs.rmSync(temp, { recursive: true, force: true }))
const { applyConversationEvent: apply } = require(path.join(temp, 'conversation-events.cjs'))
const { toChatItems } = require(path.join(temp, 'messages.cjs'))
const { insertFileMention } = require(path.join(temp, 'composer.cjs'))
const { SIDEBAR_OPEN_KEY, PANEL_OPEN_KEY, readLayoutFlag, writeLayoutFlag } = require(path.join(temp, 'layout-prefs.cjs'))
const { rememberScroll, recallScroll, restoreScroll, STICK_DISTANCE } = require(path.join(temp, 'session-scroll.cjs'))
const event = (items, type, fields = {}) => apply(items, { type, ...fields }, 123)
const { isVideo, videoTimes, videoFramePrompt } = require(path.join(temp, 'video.cjs'))
const { contextLabel, usageMeter, usagePair, usageTone } = require(path.join(temp, 'context-usage.cjs'))

test('renderer: the context meter reads the same in the composer, the panel and a subagent row', () => {
  // Subagent rows and cards show the one-liner; 0 and missing values must not print "0K".
  assert.equal(usageMeter({ tokens: 34000, contextWindow: 1000000, percent: 3.4 }), '3% 34K / 1M')
  assert.equal(usageMeter({ tokens: 120, contextWindow: 32000, percent: 0.375 }), '0% 120 / 32K')
  assert.equal(usageMeter({ tokens: 900000, contextWindow: 1000000, percent: 90 }), '90% 900K / 1M')
  assert.equal(usageMeter({ tokens: 1500 }), '2K', 'a window-less engine still shows what it used')
  assert.equal(usageMeter({ contextWindow: 128000 }), '— / 128K')
  assert.equal(usageMeter(undefined), '')
  assert.equal(usageMeter({ percent: null, tokens: null }), '')
  assert.equal(contextLabel(0), '')
  assert.equal(contextLabel(120), '120')
  assert.equal(contextLabel(1050000), '1.05M')
  assert.equal(usagePair(34000, 1000000), '34K / 1M')
  assert.equal(usagePair(undefined, undefined), '')
  // The tone follows the fold of the same number the meter shows.
  assert.equal(usageTone({ percent: 12 }), '')
  assert.equal(usageTone({ percent: 85 }), 'warn')
  assert.equal(usageTone({ percent: 140 }), 'danger')
  assert.equal(usageTone({ percent: null }), '')
})

test('renderer: video input samples its timeline and tells the model the frames have no audio', () => {
  assert.equal(isVideo({ name: 'demo.mp4', type: '' }), true)
  assert.equal(isVideo({ name: 'clip', type: 'video/webm' }), true)
  assert.equal(isVideo({ name: 'photo.png', type: 'image/png' }), false)
  assert.deepEqual(videoTimes(12), [0, 2.39, 4.78, 7.17, 9.56, 11.95])
  assert.deepEqual(videoTimes(0), [0])
  const frames = videoTimes(12).map((time, index) => ({
    id: `frame-${index}`, data: 'jpeg', mimeType: 'image/jpeg',
    video: { name: 'demo.mp4', duration: 12, index, count: 6, time }
  }))
  const prompt = videoFramePrompt([{ id: 'photo', data: 'png', mimeType: 'image/png' }, ...frames])
  assert.match(prompt, /用户上传的是视频/)
  assert.match(prompt, /不包含音轨/)
  assert.match(prompt, /第 6 帧：11\.9 秒/)
  assert.equal(videoFramePrompt([{ id: 'photo', data: 'png', mimeType: 'image/png' }]), '')
})

test('renderer: native string messages survive both streaming and session restore', () => {
  const message = { role: 'assistant', content: 'native response' }
  let items = event([], 'message_start', { message })
  items = event(items, 'message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'native ' } })
  items = event(items, 'message_end', { message })
  assert.equal(items[0].text, 'native response')
  assert.equal(items[0].streaming, false)
  assert.equal(toChatItems([message])[0].text, items[0].text)
})

test('renderer: a steered message that only now lands gets its own bubble, once', () => {
  let items = event([], 'message_start', { message: { role: 'assistant' } })
  items = event(items, 'message_end', { message: { role: 'assistant', content: [{ type: 'text', text: '先做完这一步' }] } })
  // The engine let the steer into the transcript: there is no optimistic bubble to patch.
  items = event(items, 'message_start', { message: { role: 'user', content: '顺便改一下' } })
  assert.equal(items.length, 2)
  assert.equal(items[1].role, 'user')
  assert.equal(items[1].text, '顺便改一下')
  assert.equal(items[1].pending, true, 'its message_end completes it instead of adding a second copy')
  items = event(items, 'message_end', { message: { role: 'user', content: '顺便改一下' } })
  assert.equal(items.length, 2, 'one bubble per turn')
  assert.equal(items[1].pending, false)
  // A start without content still ends up whole rather than as an empty bubble.
  let bare = event([], 'message_start', { message: { role: 'user' } })
  assert.equal(bare[0].pending, true)
  bare = event(bare, 'message_end', { message: { role: 'user', content: [{ type: 'text', text: '后补的文字' }] } })
  assert.equal(bare.length, 1)
  assert.equal(bare[0].text, '后补的文字')
  assert.equal(bare[0].pending, false)
  // Settling without a message_end must not leave a half-painted bubble behind.
  const settled = event(bare, 'agent_settled', {})
  assert.equal(settled[0].pending, false)
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
const { messagesBelong } = require(path.join(temp, 'session-messages.cjs'))
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
  const after = buildSessionGroups(plainOptions(touched)).map((group) => group.key)
  assert.deepEqual(after, before)
})

test('renderer: opening a session never lifts it to the top of its directory', () => {
  const sessions = [
    plainSession('a1', 'C:/alpha', 100, 900),
    plainSession('a2', 'C:/alpha', 110, 1000),
    plainSession('a3', 'C:/alpha', 120, 800)
  ]
  // Rows stay on their own sort key: clicking `a3` must not move it under the cursor.
  const activity = buildSessionGroups(plainOptions(sessions))[0]
  assert.deepEqual(activity.sessions.map((session) => session.id), ['a2', 'a1', 'a3'])

  const byName = buildSessionGroups(plainOptions(sessions, { sort: 'name' }))[0]
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

test('renderer: a transcript that names another session is never accepted', () => {
  const owner = {
    sessionKey: 'C:\\Users\\me\\AppData\\Roaming\\app\\transcripts\\s_a.jsonl',
    sessionFile: 'C:\\Users\\me\\AppData\\Roaming\\app\\transcripts\\s_a.jsonl'
  }
  assert.equal(messagesBelong(owner.sessionKey, owner), true)
  // Windows path aliases (slashes, casing) still belong to the same session.
  assert.equal(messagesBelong('c:/users/ME/appdata/roaming/app/transcripts/s_a.jsonl', owner), true)
  // The engine still holding the previous transcript while a switch is in flight.
  assert.equal(
    messagesBelong('C:\\Users\\me\\AppData\\Roaming\\app\\transcripts\\s_b.jsonl', owner),
    false
  )
  // A session id and a path of the same session are both accepted via sessionKey/sessionFile.
  assert.equal(messagesBelong('s_a', { sessionKey: 's_a' }), true)
  // Engines without a session identity keep the old behaviour.
  assert.equal(messagesBelong(undefined, owner), false)
  assert.equal(messagesBelong('anything', {}), false)
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

test('renderer: sidebar and panel layout flags round-trip and fall back to their defaults', () => {
  const memory = new Map()
  const store = { getItem: key => (memory.has(key) ? memory.get(key) : null), setItem: (key, value) => memory.set(key, value) }
  // Nothing stored yet: each switch starts from its own default (sidebar open, inspector closed).
  assert.equal(readLayoutFlag(SIDEBAR_OPEN_KEY, true, store), true)
  assert.equal(readLayoutFlag(PANEL_OPEN_KEY, false, store), false)
  // A collapsed sidebar is remembered as "0" and read back as closed. Only "1"/"0" count.
  writeLayoutFlag(SIDEBAR_OPEN_KEY, false, store)
  assert.equal(memory.get(SIDEBAR_OPEN_KEY), '0')
  assert.equal(readLayoutFlag(SIDEBAR_OPEN_KEY, true, store), false)
  writeLayoutFlag(PANEL_OPEN_KEY, true, store)
  assert.equal(readLayoutFlag(PANEL_OPEN_KEY, false, store), true)
  memory.set(SIDEBAR_OPEN_KEY, 'garbage')
  assert.equal(readLayoutFlag(SIDEBAR_OPEN_KEY, true, store), true, 'unknown values fall back to the default')
  // A disabled store (private mode) must never break the layout code path.
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.equal(readLayoutFlag(SIDEBAR_OPEN_KEY, true, broken), true)
  writeLayoutFlag(SIDEBAR_OPEN_KEY, false, broken)
})

 test('renderer: each conversation keeps its own scroll anchor, the tail stays the tail', () => {
  const memory = new Map()
  // Reading in the middle of a long transcript: the offset and the message at the top are kept.
  rememberScroll(memory, 'session-a', { scrollTop: 640, scrollHeight: 4000, clientHeight: 800 }, { id: 'm12', offset: 40 })
  assert.deepEqual(recallScroll(memory, 'session-a'), { top: 640, stuck: false, anchorId: 'm12', anchorOffset: 40 })
  // A different session has no anchor yet: it opens at the bottom like a fresh session.
  assert.equal(recallScroll(memory, 'session-b'), undefined)
  // Following the tail is remembered as such, so reopening it lands on the newest message again.
  rememberScroll(memory, 'session-b', { scrollTop: 3150, scrollHeight: 4000, clientHeight: 800 })
  assert.deepEqual(recallScroll(memory, 'session-b'), { top: 3150, stuck: true })
  // The threshold is the same one the on-scroll handler uses.
  rememberScroll(memory, 'session-c', { scrollTop: 4000 - 800 - STICK_DISTANCE + 1, scrollHeight: 4000, clientHeight: 800 })
  assert.equal(recallScroll(memory, 'session-c').stuck, true)
  rememberScroll(memory, 'session-d', { scrollTop: 4000 - 800 - STICK_DISTANCE, scrollHeight: 4000, clientHeight: 800 })
  assert.equal(recallScroll(memory, 'session-d').stuck, false)

  // The anchor wins over the pixel offset, so a transcript that lays out a little differently
  // still shows the line the reader was on.
  const calls = []
  const element = { scrollTop: 0, scrollHeight: 4000, scrollTo: (options) => calls.push(options) }
  restoreScroll(element, { top: 640, stuck: false, anchorId: 'm12', anchorOffset: 40 }, () => 900)
  assert.deepEqual(calls.pop(), { top: 860, behavior: 'instant' }, 'an anchor lands in one frame, not with a glide')
  // A message that is no longer rendered falls back to the remembered pixel offset.
  restoreScroll(element, { top: 640, stuck: false, anchorId: 'gone', anchorOffset: 40 }, () => null)
  assert.deepEqual(calls.pop(), { top: 640, behavior: 'instant' })
  // A session left at the tail goes to the end whatever the anchor says.
  restoreScroll(element, { top: 640, stuck: true, anchorId: 'm12', anchorOffset: 40 }, () => 900)
  assert.deepEqual(calls.pop(), { top: 4000, behavior: 'instant' })
  const withoutScrollTo = { scrollTop: 0, scrollHeight: 4000 }
  restoreScroll(withoutScrollTo, { top: 640, stuck: false })
  assert.equal(withoutScrollTo.scrollTop, 640)
  // An empty key (no session yet) must not write anything.
  rememberScroll(memory, undefined, { scrollTop: 10, scrollHeight: 20, clientHeight: 10 })
  assert.equal(memory.size, 4)
})
