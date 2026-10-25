import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Project rules written for other AI agents.
 *
 * pi — the engine under this window — already loads `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`,
 * `CLAUDE.md` and `CLAUDE.MD` from the working directory and its parents. Everything below is a
 * convention pi knows nothing about, so a repository that documents itself for Cursor / Copilot /
 * Gemini / Cline / Aider currently starts every session without its own rules.
 *
 * The list is intentionally explicit: a probe that guesses filenames picks up unrelated notes.
 */
export interface ConventionFile {
  /** Path as the user would type it, relative to the directory it was found in. */
  path: string
  /** Which tool authored it, shown to the model so two rule sets stay distinguishable. */
  tool: string
  /** File body with YAML frontmatter removed. */
  body: string
}

export interface ConventionIo {
  isDirectory(path: string): boolean
  listDirectory(path: string): string[]
  readFile(path: string): string | undefined
}

/** Caps keep a 200 kB rules dump from crowding out the actual conversation. */
export const MAX_FILE_CHARS = 12_000
export const MAX_TOTAL_CHARS = 24_000
/** How far above the working directory to look: a monorepo package inherits its root's rules. */
export const MAX_PARENT_DEPTH = 2

type Kind = 'file' | 'dir' | 'either'

interface Source {
  path: string
  tool: string
  kind: Kind
}

const SOURCES: Source[] = [
  { path: 'GEMINI.md', tool: 'Gemini CLI', kind: 'file' },
  { path: 'CONVENTIONS.md', tool: 'Aider', kind: 'file' },
  { path: '.goosehints', tool: 'Goose', kind: 'file' },
  { path: '.cursorrules', tool: 'Cursor', kind: 'file' },
  { path: '.cursor/rules', tool: 'Cursor', kind: 'dir' },
  { path: '.github/copilot-instructions.md', tool: 'GitHub Copilot', kind: 'file' },
  { path: '.github/instructions', tool: 'GitHub Copilot', kind: 'dir' },
  { path: '.windsurfrules', tool: 'Windsurf', kind: 'file' },
  { path: '.windsurf/rules', tool: 'Windsurf', kind: 'dir' },
  { path: '.clinerules', tool: 'Cline', kind: 'either' },
  { path: '.roo/rules', tool: 'Roo Code', kind: 'dir' },
  { path: '.continue/rules', tool: 'Continue', kind: 'dir' },
  { path: '.kiro/steering', tool: 'Kiro', kind: 'dir' },
  { path: '.amazonq/rules', tool: 'Amazon Q', kind: 'dir' },
  { path: '.trae/rules', tool: 'Trae', kind: 'dir' },
  { path: '.junie/guidelines.md', tool: 'JetBrains Junie', kind: 'file' },
  { path: 'AGENT.md', tool: 'single-file AGENTS convention', kind: 'file' }
]

/** Directory-shaped rule sets are markdown by convention; a stray `.txt` is not a rule file. */
const RULE_FILE = /\.(md|mdc)$/i

const defaultIo: ConventionIo = {
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  listDirectory: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  readFile: (path) => {
    try {
      if (!existsSync(path)) return undefined
      const stats = statSync(path)
      if (!stats.isFile()) return undefined
      // A "rules" file of megabytes is almost always a data file someone named badly.
      if (stats.size > MAX_FILE_CHARS * 8) return undefined
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }
}

/** Cursor rule files carry `description:` / `globs:`; the body is what the model should read. */
function stripFrontmatter(raw: string): { body: string; description?: string } {
  if (!raw.startsWith('---')) return { body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { body: raw }
  const header = raw.slice(3, end)
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1)
  const description = header
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*description:\s*(.+?)\s*$/)?.[1])
    .find(Boolean)
  return { body, description: description?.replace(/^["']|["']$/g, '') }
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断）`
}

function candidates(dir: string, io: ConventionIo): ConventionFile[] {
  const found: ConventionFile[] = []
  for (const source of SOURCES) {
    const target = join(dir, source.path)
    const asDir = (source.kind === 'dir' || source.kind === 'either') && io.isDirectory(target)
    if (asDir) {
      for (const name of io.listDirectory(target).sort()) {
        if (!RULE_FILE.test(name)) continue
        const raw = io.readFile(join(target, name))
        if (raw === undefined) continue
        const { body, description } = stripFrontmatter(raw)
        if (!body.trim()) continue
        found.push({
          path: `${source.path}/${name}`,
          tool: description ? `${source.tool} · ${description}` : source.tool,
          body: clip(body.trim(), MAX_FILE_CHARS)
        })
      }
      continue
    }
    if (source.kind === 'either') continue // `.clinerules` handled as a directory above, a file below
    const raw = io.readFile(target)
    if (raw === undefined) continue
    const { body, description } = stripFrontmatter(raw)
    if (!body.trim()) continue
    found.push({
      path: source.path,
      tool: description ? `${source.tool} · ${description}` : source.tool,
      body: clip(body.trim(), MAX_FILE_CHARS)
    })
  }
  // `.clinerules` is a file in older Cline versions and a directory in newer ones.
  const clinerules = join(dir, '.clinerules')
  if (!io.isDirectory(clinerules)) {
    const raw = io.readFile(clinerules)
    if (raw !== undefined && raw.trim()) {
      found.push({ path: '.clinerules', tool: 'Cline', body: clip(stripFrontmatter(raw).body.trim(), MAX_FILE_CHARS) })
    }
  }
  return found
}

/**
 * Convention files for one working directory, closest directory first.
 *
 * Only the nearest directory that has any of them contributes: a package that documents its own
 * rules must not also inherit the monorepo root's different set.
 */
export function readProjectConventions(
  cwd: string,
  io: ConventionIo = defaultIo
): { files: ConventionFile[]; text: string } {
  if (!cwd) return { files: [], text: '' }
  let dir = resolve(cwd)
  for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth++) {
    const files = candidates(dir, io)
    if (files.length > 0) return { files, text: render(files) }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { files: [], text: '' }
}

/** The system-prompt section: the same framing AGENTS.md gets, so the model treats it alike. */
export function render(files: ConventionFile[]): string {
  if (files.length === 0) return ''
  const parts = [
    '以下是仓库作者写给 AI 助手的规范文件（大部分工具会自动加载它们；这里统一读出来，和 AGENTS.md 同等效力）。' +
      '与用户本次的明确要求冲突时，以用户为准。'
  ]
  let budget = MAX_TOTAL_CHARS
  for (const file of files) {
    if (budget <= 0) break
    const body = file.body.length > budget ? clip(file.body, budget) : file.body
    parts.push('', `### ${file.path}（${file.tool}）`, body)
    budget -= body.length
  }
  return parts.join('\n')
}
