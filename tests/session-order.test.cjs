/**
 * The sidebar order is the user's, not the activity log's.
 *
 * Rows used to sort by `updatedAt`, so opening a session lifted it to the top of its directory and
 * the rest slid down under the cursor. Displacing a row is now only something a drag can do; a
 * session seen for the first time sorts in at the place the sort key gives it, and stays there.
 */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-order-tests-'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))

function load(relative) {
  const outfile = path.join(temp, path.basename(relative) + '.cjs')
  esbuild.buildSync({
    entryPoints: [path.join(root, relative)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external'
  })
  return require(outfile)
}

const { reconcileOrder, rankOrder, moveSession } = load('apps/desktop/src/renderer/src/lib/session-order.ts')
const { sortSessions } = load('apps/desktop/src/renderer/src/lib/session-groups.ts')

function session(id, updatedAt, title = id) {
  return { path: id, title, cwd: 'C:\\repo', additional: [], createdAt: 1, updatedAt }
}

test('order: a session seen for the first time sorts in at its activity position', () => {
  const arranged = ['a', 'b']
  // `c` is newer than everything, so it belongs on top; `a` and `b` keep their relative order.
  assert.deepEqual(reconcileOrder(arranged, ['c', 'a', 'b']), ['c', 'a', 'b'])
  // A session that only exists in the middle still lands in the middle.
  assert.deepEqual(reconcileOrder(['a', 'c'], ['a', 'b', 'c']), ['a', 'b', 'c'])
})

test('order: opening a session never moves it', () => {
  const arranged = ['a', 'b', 'c']
  // The same list, but `c` just became the most recent — this is what activation used to do.
  const sorted = sortSessions([session('c', 300), session('a', 200), session('b', 100)], 'activity')
    .map((entry) => entry.path)
  assert.deepEqual(sorted, ['c', 'a', 'b'], 'the sort key does see the new activity')
  assert.deepEqual(reconcileOrder(arranged, sorted), ['a', 'b', 'c'], 'the arranged order wins')
})

test('order: a deleted session leaves no hole and keeps the rest in place', () => {
  assert.deepEqual(reconcileOrder(['a', 'b', 'c'], ['a', 'c']), ['a', 'c'])
})

test('order: reconcile is stable, so it never re-renders the list for nothing', () => {
  const arranged = ['a', 'b', 'c']
  const once = reconcileOrder(arranged, ['a', 'b', 'c'])
  assert.deepEqual(once, arranged)
  assert.deepEqual(reconcileOrder(once, ['a', 'b', 'c']), once)
})

test('order: dropping a row below another lands after it', () => {
  assert.deepEqual(moveSession(['a', 'b', 'c'], 'a', 'c', 'after'), ['b', 'c', 'a'])
  assert.deepEqual(moveSession(['a', 'b', 'c'], 'a', 'c', 'before'), ['b', 'a', 'c'])
  // Downwards drops are measured after the dragged row is removed, which is what the user sees.
  assert.deepEqual(moveSession(['a', 'b', 'c'], 'c', 'a', 'before'), ['c', 'a', 'b'])
  assert.deepEqual(moveSession(['a', 'b'], 'a', 'b', 'after'), ['b', 'a'])
})

test('order: a drop onto itself or onto an unknown row changes nothing', () => {
  const order = ['a', 'b']
  assert.deepEqual(moveSession(order, 'a', 'a', 'after'), order)
  assert.deepEqual(moveSession(order, 'a', 'zzz', 'before'), order)
})

test('order: ranks match the arranged positions', () => {
  const rank = rankOrder(['b', 'a'])
  assert.equal(rank.get('b'), 0)
  assert.equal(rank.get('a'), 1)
  assert.equal(rank.get('unknown'), undefined, 'unknown rows fall back to the sort key')
})
