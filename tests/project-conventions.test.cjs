/**
 * Other agents' rule files, read into one system-prompt section.
 *
 * These cases pin the parts that decide whether the model gets the right rules: which filenames
 * count, how Cursor `.mdc` frontmatter is unwrapped, that the nearest directory wins, and that a
 * runaway file cannot eat the prompt budget.
 */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-conventions-'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))

const outfile = path.join(temp, 'project-conventions.cjs')
esbuild.buildSync({
  entryPoints: [path.join(root, 'apps/desktop/src/main/agent/project-conventions.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent'
})
const conventions = require(outfile)

/** A directory in the workspace, resolved the same way the module resolves them. */
const BASE = path.resolve(path.sep, 'repo')

/** In-memory tree: absolute path → contents; directories are derived from the keys. */
function io(files) {
  const dirs = new Set()
  for (const key of Object.keys(files)) {
    let dir = path.dirname(key)
    while (dir && dir !== path.dirname(dir)) {
      dirs.add(dir)
      dir = path.dirname(dir)
    }
    dirs.add(dir)
  }
  return {
    isDirectory: (target) => dirs.has(target),
    listDirectory: (target) =>
      Object.keys(files)
        .filter((key) => path.dirname(key) === target)
        .map((key) => path.basename(key)),
    readFile: (target) => files[target]
  }
}

const at = (...parts) => path.join(BASE, ...parts)

test('a lone convention file becomes one labelled section', () => {
  const { files, text } = conventions.readProjectConventions(
    BASE,
    io({ [at('GEMINI.md')]: 'Always answer in Chinese.\n' })
  )
  assert.deepEqual(files.map((file) => [file.path, file.tool]), [['GEMINI.md', 'Gemini CLI']])
  assert.match(text, /### GEMINI\.md（Gemini CLI）/)
  assert.match(text, /Always answer in Chinese\./)
  // The framing tells the model these are not optional extras.
  assert.match(text, /和 AGENTS\.md 同等效力/)
})

test('AGENTS.md and CLAUDE.md are left to the engine', () => {
  const { files } = conventions.readProjectConventions(
    BASE,
    io({ [at('AGENTS.md')]: 'rules', [at('CLAUDE.md')]: 'rules' })
  )
  assert.deepEqual(files, [])
})

test('cursor rules: frontmatter is stripped and its description labels the file', () => {
  const body = `---\ndescription: 样式与命名\nglobs: ["**/*.tsx"]\n---\nPrefer function components.\n`
  const { files, text } = conventions.readProjectConventions(
    BASE,
    io({ [at('.cursor', 'rules', 'style.mdc')]: body, [at('.cursor', 'rules', 'notes.txt')]: 'readme only' })
  )
  assert.equal(files.length, 1)
  assert.equal(files[0].path, '.cursor/rules/style.mdc')
  assert.equal(files[0].tool, 'Cursor · 样式与命名')
  assert.equal(files[0].body, 'Prefer function components.')
  assert.ok(!text.includes('globs'))
})

test('.clinerules works as a file and as a directory', () => {
  const asFile = conventions.readProjectConventions(BASE, io({ [at('.clinerules')]: 'Use pnpm.' }))
  assert.deepEqual(asFile.files.map((file) => [file.path, file.body]), [['.clinerules', 'Use pnpm.']])

  const asDir = conventions.readProjectConventions(
    BASE,
    io({ [at('.clinerules', 'a.md')]: 'Rule A', [at('.clinerules', 'b.md')]: 'Rule B' })
  )
  assert.deepEqual(asDir.files.map((file) => file.path), ['.clinerules/a.md', '.clinerules/b.md'])
})

test('the nearest directory with rules wins; a parent set is not mixed in', () => {
  const packageDir = at('packages', 'web')
  const files = {
    [at('GEMINI.md')]: 'root rules',
    [at('packages', 'web', '.windsurfrules')]: 'package rules'
  }
  const ioTree = io(files)
  const nearest = conventions.readProjectConventions(packageDir, ioTree)
  assert.deepEqual(nearest.files.map((file) => [file.path, file.body]), [['.windsurfrules', 'package rules']])

  // A package without its own rules inherits the repository's (one level up).
  const inherited = conventions.readProjectConventions(at('packages', 'api'), ioTree)
  assert.deepEqual(inherited.files.map((file) => file.path), ['GEMINI.md'])
})

test('deep directories stop inheriting after two levels', () => {
  const deep = at('a', 'b', 'c')
  const { files } = conventions.readProjectConventions(deep, io({ [at('GEMINI.md')]: 'root rules' }))
  assert.equal(files.length, 0)
})

test('a huge rule file is clipped, not dropped', () => {
  const long = 'x'.repeat(conventions.MAX_FILE_CHARS + 500)
  const { files } = conventions.readProjectConventions(BASE, io({ [at('CONVENTIONS.md')]: long }))
  assert.equal(files.length, 1)
  assert.ok(files[0].body.length < long.length)
  assert.match(files[0].body, /已截断/)
})

test('the whole section stays inside the total budget', () => {
  const files = {}
  for (let index = 0; index < 6; index++) {
    files[at('.roo', 'rules', `rule-${index}.md`)] = 'y'.repeat(conventions.MAX_FILE_CHARS)
  }
  const { text } = conventions.readProjectConventions(BASE, io(files))
  assert.ok(text.length <= conventions.MAX_TOTAL_CHARS + 2_000, `section too large: ${text.length}`)
})

test('blank and unreadable candidates are skipped', () => {
  const { files } = conventions.readProjectConventions(
    BASE,
    io({ [at('.cursorrules')]: '   \n\n', [at('.junie', 'guidelines.md')]: 'Real rule' })
  )
  assert.deepEqual(files.map((file) => file.path), ['.junie/guidelines.md'])
})

test('an empty workspace renders nothing rather than an empty section', () => {
  const result = conventions.readProjectConventions(BASE, io({}))
  assert.deepEqual(result.files, [])
  assert.equal(result.text, '')
  assert.equal(conventions.render([]), '')
})
