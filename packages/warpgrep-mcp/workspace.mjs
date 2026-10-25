/**
 * Read-only filesystem tools for the search loop, all confined to one repository root.
 *
 * Nothing here runs a shell: the model gets grep / glob / list / read, so "delete the repo" is not
 * a tool call it can make even if it hallucinates one. Every path is resolved through
 * `resolveInside`, which returns `undefined` for anything that escapes the root (absolute paths
 * outside it, `..` chains, symlinked parents).
 */
import fs from 'node:fs'
import path from 'node:path'

export const MAX_OUTPUT_LINES = 200
export const MAX_LIST_RESULTS = 500
export const MAX_GLOB_RESULTS = 100
export const MAX_READ_LINES = 800
export const MAX_FILE_BYTES = 2_000_000
export const MAX_GREP_SCAN_LINES = 20_000
export const TRUNCATED_MARKER = '[truncated for context limit]'

const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'bower_components', '.pnpm', '.yarn', 'vendor', 'Pods',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', '.tox', '.nox',
  'dist', 'build', 'out', 'target', '_build', '.next', '.nuxt', '.cache', '.turbo', '.nx',
  '.codegraph', '.serena', 'release'
])

const toPosix = (value) => value.split(path.sep).join('/')

/** Resolve `relative` under `root`, or `undefined` when it points outside the root. */
export function resolveInside(root, relative) {
  const target = path.resolve(root, relative || '.')
  const base = path.resolve(root)
  if (target === base) return target
  return target.startsWith(base + path.sep) ? target : undefined
}

/** Depth-first walk, newest-agnostic; `visit` returning false stops the walk. */
export function walk(root, visit) {
  const queue = [root]
  while (queue.length > 0) {
    const dir = queue.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        queue.push(full)
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (visit(full, { mtimeMs: stat.mtimeMs, size: stat.size }) === false) return
    }
  }
}

/** Glob → anchored regex. `*` stays inside a segment, `**` crosses them, `{a,b}` expands. */
export function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
        if (pattern[index + 1] === '/') index += 1
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '{') {
      const end = pattern.indexOf('}', index)
      if (end !== -1) {
        source += `(?:${pattern
          .slice(index + 1, end)
          .split(',')
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, (c) => `\\${c}`))
          .join('|')})`
        index = end
        continue
      }
    }
    source += '.+^$()|[]\\'.includes(char) ? `\\${char}` : char
  }
  return new RegExp(`^${source}$`, 'i')
}

function parseRanges(text) {
  if (!text) return []
  const ranges = []
  for (const part of String(text).split(',')) {
    const [startRaw, endRaw] = part.trim().split('-')
    const start = Number(startRaw)
    const end = endRaw === undefined ? start : Number(endRaw)
    if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) {
      ranges.push([start, end])
    }
  }
  return ranges
}

export function readLines(file, ranges = []) {
  const stat = fs.statSync(file)
  if (stat.size > MAX_FILE_BYTES) return { text: '', truncated: true }
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  if (ranges.length === 0) {
    const kept = lines.slice(0, MAX_READ_LINES)
    return {
      text: kept.map((line, index) => `${index + 1}: ${line}`).join('\n'),
      truncated: lines.length > kept.length
    }
  }
  const out = []
  for (const [start, end] of ranges) {
    for (let line = start; line <= Math.min(end, lines.length); line += 1) {
      if (out.length >= MAX_READ_LINES) return { text: out.join('\n'), truncated: true }
      out.push(`${line}: ${lines[line - 1] ?? ''}`)
    }
  }
  return { text: out.join('\n'), truncated: false }
}

/** File count per skipped directory name, so a search can say why it saw nothing. */
export function grep(root, { pattern, path: scope, glob, limit }) {
  let regex
  try {
    regex = new RegExp(String(pattern ?? ''), 'i')
  } catch (error) {
    return `error: invalid regex (${error.message})`
  }
  if (!String(pattern ?? '').trim()) return 'error: pattern is required'
  const base = scope ? resolveInside(root, String(scope)) : root
  if (!base) return 'error: path outside the workspace'
  const matcher = glob ? globToRegExp(String(glob)) : undefined
  const cap = Math.min(Math.max(Number(limit) || MAX_OUTPUT_LINES, 1), MAX_OUTPUT_LINES)
  const matches = []
  let scanned = 0
  const searchFile = (file) => {
    let content
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch {
      return
    }
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      scanned += 1
      if (regex.test(lines[index])) {
        const relative = toPosix(path.relative(root, file))
        matches.push(`${relative}:${index + 1}: ${lines[index].trim().slice(0, 300)}`)
        if (matches.length >= cap) return
      }
      if (scanned >= MAX_GREP_SCAN_LINES) return
    }
  }
  const stat = fs.statSync(base, { throwIfNoEntry: false })
  if (stat?.isFile()) searchFile(base)
  else {
    walk(base, (file) => {
      if (matcher && !matcher.test(toPosix(path.relative(root, file)))) return
      searchFile(file)
      return matches.length < cap && scanned < MAX_GREP_SCAN_LINES
    })
  }
  const header = scanned >= MAX_GREP_SCAN_LINES ? `scanned ${scanned} lines (scan cap reached)\n` : ''
  return `${header}${matches.join('\n') || 'No matches found.'}`
}

export function glob(root, { pattern, path: scope }) {
  const matcher = globToRegExp(String(pattern ?? '*'))
  const base = scope ? resolveInside(root, String(scope)) : root
  if (!base) return 'error: path outside the workspace'
  const found = []
  walk(base, (file, info) => {
    if (matcher.test(toPosix(path.relative(root, file)))) found.push({ file, mtimeMs: info.mtimeMs })
    return found.length < MAX_GLOB_RESULTS * 4
  })
  return (
    found
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_GLOB_RESULTS)
      .map((entry) => toPosix(path.relative(root, entry.file)))
      .join('\n') || 'No files found.'
  )
}

export function listDirectory(root, { path: scope, depth }) {
  const base = scope ? resolveInside(root, String(scope)) : root
  if (!base) return 'error: path outside the workspace'
  const levels = Math.min(Math.max(Number(depth) || 1, 1), 3)
  const out = []
  const queue = [{ dir: base, level: 1 }]
  while (queue.length > 0) {
    const { dir, level } = queue.shift()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      out.push(`${toPosix(path.relative(root, full))}${entry.isDirectory() ? '/' : ''}`)
      if (out.length >= MAX_LIST_RESULTS) return out.join('\n')
      if (entry.isDirectory() && level < levels) queue.push({ dir: full, level: level + 1 })
    }
  }
  return out.join('\n') || 'Empty directory.'
}

export function read(root, { path: scope, lines }) {
  const target = resolveInside(root, String(scope ?? ''))
  if (!target) return 'error: path outside the workspace'
  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    return `error: no such file: ${scope}`
  }
  if (stat.isDirectory()) return listDirectory(root, { path: scope, depth: 1 })
  const { text, truncated } = readLines(target, parseRanges(lines))
  return `${text}${truncated ? `\n${TRUNCATED_MARKER}` : ''}`
}

/** `<path>:<ranges>` lines → verified, workspace-relative entries. Invented paths are dropped. */
export function verifyFiles(root, files) {
  const kept = []
  const dropped = []
  let lastFile
  for (const rawLine of String(files ?? '').split(/[\n,]/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '')
    if (!line) continue
    // Models often continue the previous file with a bare line range ("1233" after "a.ts:1184").
    if (lastFile && /^\d+(?:-\d+)?$/.test(line)) {
      kept.push(`${lastFile}:${line}`)
      continue
    }
    const match = /^([^\s:]+?)(?::(\d+(?:-\d+)?))?$/.exec(line)
    if (!match) {
      dropped.push(line)
      continue
    }
    const target = resolveInside(root, match[1])
    let stat
    try {
      stat = target ? fs.statSync(target) : undefined
    } catch {
      stat = undefined
    }
    if (!stat?.isFile()) {
      dropped.push(line)
      continue
    }
    const relative = toPosix(path.relative(root, target))
    lastFile = relative
    kept.push(match[2] ? `${relative}:${match[2]}` : relative)
  }
  return { files: kept.join('\n'), dropped }
}

/** Read what `verifyFiles` produced into `<file path="…">…</file>` blocks within `budget`. */
export function sources(root, files, budget) {
  const blocks = []
  let used = 0
  for (const line of String(files ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(.+?)(?::(.+))?$/.exec(trimmed)
    if (!match) continue
    const target = resolveInside(root, match[1].replace(/:\d.*$/, ''))
    if (!target) continue
    let text
    try {
      text = readLines(target, parseRanges(match[2])).text
    } catch {
      continue
    }
    const block = `<file path="${toPosix(path.relative(root, target))}">\n${text}\n</file>`
    if (used + block.length > budget) break
    used += block.length
    blocks.push(block)
  }
  return blocks.join('\n\n')
}
