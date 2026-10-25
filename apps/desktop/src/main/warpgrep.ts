/**
 * WarpGrep code search, served as a project-scoped read-only MCP tool by the gateway.
 *
 * The model asks a natural-language question; a search subagent plans grep/list/glob/read calls, this
 * module executes them inside the session directory and returns the relevant files and line ranges.
 * File excerpts read during the search are sent to the configured endpoint, which is why the engine
 * is opt-in.
 *
 * Two backends share one tool contract:
 * - **Morph** (default): the hosted `morph-warp-grep-v2.1` model, which was trained on the tool names
 *   below and needs no system prompt.
 * - **Custom endpoint** (`warpgrep.baseUrl`): any OpenAI-compatible chat model with tool calling
 *   (DeepSeek, OpenAI, a local vLLM). That path runs the shared loop in
 *   `packages/warpgrep-mcp/search.mjs` — the same code the standalone MCP server runs — because a
 *   general model needs the system prompt, the `finish` fallback and path verification.
 */
import { SearchError, searchCodebase } from '../../../../packages/warpgrep-mcp/search.mjs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MODEL = 'morph-warp-grep-v2.1'
/** Used when a custom endpoint is configured without a model. */
export const CUSTOM_DEFAULT_MODEL = 'deepseek-flash'
const API_BASE = process.env.AGENT_DESKTOP_MORPH_BASE ?? 'https://api.morphllm.com/v1'
const MAX_TURNS = 6
/** Custom endpoints get a tighter whole-search budget than Morph: they are slower per turn. */
const CUSTOM_TOTAL_TIMEOUT_MS = 90_000
const CUSTOM_TURN_TIMEOUT_MS = 45_000
const MAX_CONTEXT_CHARS = 321_600
const MAX_OUTPUT_LINES = 200
const MAX_LIST_RESULTS = 500
const MAX_GLOB_RESULTS = 100
const MAX_READ_LINES = 800
const MAX_FILE_BYTES = 2_000_000
const MAX_GREP_SCAN_LINES = 5_000
const TRUNCATED_MARKER = '[truncated for context limit]'

const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'bower_components',
  '.pnpm',
  '.yarn',
  'vendor',
  'Pods',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  '.tox',
  '.nox',
  'dist',
  'build',
  'out',
  'target',
  '_build',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.nx',
  '.codegraph',
  '.serena',
  'release'
])

const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'Execute ls or find commands to explore directory structure. Max 500 results. ' +
        'Common junk directories are excluded automatically.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              "Full ls or find command (e.g. ls -la src/, find . -maxdepth 2 -type f -name '*.py', find . -type d, ls -d */)."
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description:
        'Search for a regex pattern in file contents. Returns matching lines with file paths and ' +
        'line numbers. Case-insensitive. Respects common ignore directories.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for in file contents.' },
          path: { type: 'string', description: 'File or directory to search in. Defaults to the project root.' },
          glob: { type: 'string', description: "Glob pattern to filter files (e.g. '*.ts', 'src/**/*.go')." },
          limit: { type: 'integer', description: 'Limit output to first N matching lines.' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files by name/extension using glob patterns. Returns absolute paths sorted by ' +
        'modification time (newest first). Max 100 results.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: "Glob pattern to match files (e.g. '*.ts', 'src/**/*.js')." },
          path: { type: 'string', description: 'Directory to search in. Defaults to the project root.' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read entire files or specific line ranges using absolute paths.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read, using an absolute path.' },
          lines: { type: 'string', description: "Optional line range (e.g. '1-50' or '1-20,45-80')." }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description:
        'Submit final answer with all relevant code locations. Include imports and over-include ' +
        'rather than miss context.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'string',
            description:
              "One file per line as path:lines (e.g. 'src/auth.py:1-15,25-50\\nsrc/user.py'). " +
              'Omit the line range to include the entire file.'
          }
        },
        required: ['files']
      }
    }
  }
] as const

export class WarpGrepError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

interface MorphMessage {
  role: string
  content?: string | null
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/** Resolve a model-supplied path inside the project; anything escaping it is rejected. */
function resolveInside(root: string, candidate: string): string | undefined {
  const target = path.resolve(root, candidate)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return target
}

function globToRegExp(pattern: string): RegExp {
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
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '{') {
      const end = pattern.indexOf('}', index)
      if (end > index) {
        source += `(${pattern.slice(index + 1, end).split(',').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`
        index = end
      } else {
        source += '\\{'
      }
    } else if ('.+^$()|[]\\'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return new RegExp(`^${source}$`, 'i')
}

async function walk(
  root: string,
  visit: (
    file: string,
    stat: { mtimeMs: number; size: number }
  ) => boolean | void | Promise<boolean | void>
): Promise<void> {
  const queue = [root]
  while (queue.length > 0) {
    const dir = queue.pop() as string
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        queue.push(full)
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      if ((await visit(full, { mtimeMs: stat.mtimeMs, size: stat.size })) === false) return
    }
  }
}

function parseRanges(text: string | undefined): Array<[number, number]> {
  if (!text) return []
  const ranges: Array<[number, number]> = []
  for (const part of text.split(',')) {
    const [startRaw, endRaw] = part.trim().split('-')
    const start = Number(startRaw)
    const end = endRaw === undefined ? start : Number(endRaw)
    if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) {
      ranges.push([start, end])
    }
  }
  return ranges
}

async function readLines(
  file: string,
  ranges: Array<[number, number]>
): Promise<{ text: string; truncated: boolean }> {
  const stat = await fs.stat(file)
  if (stat.size > MAX_FILE_BYTES) return { text: '', truncated: true }
  const content = await fs.readFile(file, 'utf8')
  const lines = content.split('\n')
  if (ranges.length === 0) {
    const kept = lines.slice(0, MAX_READ_LINES)
    return {
      text: kept.map((line, index) => `${index + 1}: ${line}`).join('\n'),
      truncated: lines.length > kept.length
    }
  }
  const out: string[] = []
  for (const [start, end] of ranges) {
    for (let line = start; line <= Math.min(end, lines.length); line += 1) {
      if (out.length >= MAX_READ_LINES) return { text: out.join('\n'), truncated: true }
      out.push(`${line}: ${lines[line - 1] ?? ''}`)
    }
  }
  return { text: out.join('\n'), truncated: false }
}

/** Where WarpGrep sends its questions: the hosted Morph model, or a custom endpoint. */
export interface WarpGrepBackend {
  apiKey?: string
  /** OpenAI-compatible base URL (`…/v1`). Absent/empty means the hosted Morph API. */
  baseUrl?: string
  /** Chat model with tool calling; defaults to Morph's model or `deepseek-flash`. */
  model?: string
}

export interface ResolvedWarpGrepBackend {
  baseUrl: string
  model: string
  apiKey: string
  /** True for the hosted Morph model (no system prompt, no nudge, `finish` only). */
  hosted: boolean
}

export function resolveWarpGrepBackend(backend: WarpGrepBackend = {}): ResolvedWarpGrepBackend {
  const configured = backend.baseUrl?.trim()
  const baseUrl = (configured || API_BASE).replace(/\/+$/, '')
  const hosted = !configured || /(^|\.)morphllm\.com/i.test(baseUrl)
  return {
    baseUrl,
    hosted,
    model: backend.model?.trim() || (hosted ? MODEL : CUSTOM_DEFAULT_MODEL),
    apiKey: backend.apiKey?.trim() ?? ''
  }
}

export class WarpGrep {
  private readonly key: string
  private readonly backend: WarpGrepBackend

  constructor(
    private readonly cwd: string,
    backend: WarpGrepBackend = {}
  ) {
    this.backend = backend
    this.key = backend.apiKey?.trim() ?? ''
  }

  private async complete(messages: MorphMessage[], maxTokens: number): Promise<MorphMessage> {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.key}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: TOOL_SPECS,
        tool_choice: 'auto',
        max_tokens: maxTokens
      })
    })
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 400)
      const code =
        response.status === 401 || response.status === 403
          ? 'MORPH_UNAUTHORIZED'
          : response.status === 402
            ? 'MORPH_PAYMENT_REQUIRED'
            : response.status === 429
              ? 'MORPH_RATE_LIMITED'
              : 'MORPH_UNAVAILABLE'
      throw new WarpGrepError(code, `Morph API ${response.status}: ${body || response.statusText}`)
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: MorphMessage }>
    }
    const message = payload.choices?.[0]?.message
    if (!message) throw new WarpGrepError('MORPH_PROTOCOL', 'Morph API 返回了无法识别的响应')
    return message
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'list_directory': {
        const command = String(args.command ?? '')
        const depth = Number(/-maxdepth\s+(\d+)/.exec(command)?.[1] ?? 2)
        const wantFiles = /-type\s+f/.test(command)
        const wantDirs = /-type\s+d/.test(command)
        const namePattern = /-name\s+['"]?([^'"\s]+)['"]?/.exec(command)?.[1]
        const baseArg = command
          .split(/\s+/)
          .slice(1)
          .find((token) => !token.startsWith('-') && !/^\d+$/.test(token) && !token.startsWith("'"))
        const base = baseArg && baseArg !== '.' ? resolveInside(this.cwd, baseArg) : this.cwd
        if (!base) return 'error: path outside the project'
        const matcher = namePattern ? globToRegExp(namePattern) : undefined
        const lines: string[] = []
        const walkDepth = async (dir: string, level: number): Promise<void> => {
          let entries
          try {
            entries = await fs.readdir(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              if (!wantFiles && (!matcher || matcher.test(entry.name)) && (!wantDirs || true)) {
                lines.push(`${toPosix(path.relative(this.cwd, full))}/`)
              }
              if (level < depth && lines.length < MAX_LIST_RESULTS) await walkDepth(full, level + 1)
            } else if (!wantDirs && (!matcher || matcher.test(entry.name))) {
              lines.push(toPosix(path.relative(this.cwd, full)))
            }
            if (lines.length >= MAX_LIST_RESULTS) return
          }
        }
        await walkDepth(base, 0)
        return lines.slice(0, MAX_LIST_RESULTS).join('\n') || '(no entries)'
      }
      case 'grep_search': {
        const pattern = String(args.pattern ?? '')
        let regex: RegExp
        try {
          regex = new RegExp(pattern, 'i')
        } catch (error) {
          return `error: invalid regex (${error instanceof Error ? error.message : String(error)})`
        }
        const scope = args.path ? resolveInside(this.cwd, String(args.path)) : this.cwd
        if (!scope) return 'error: path outside the project'
        const globMatcher = args.glob ? globToRegExp(String(args.glob)) : undefined
        const limit = Math.min(Number(args.limit ?? MAX_OUTPUT_LINES) || MAX_OUTPUT_LINES, MAX_OUTPUT_LINES)
        const matches: string[] = []
        let scanned = 0
        const searchFile = async (file: string): Promise<void> => {
          if (scanned >= MAX_GREP_SCAN_LINES) return
          let content: string
          try {
            content = await fs.readFile(file, 'utf8')
          } catch {
            return
          }
          const lines = content.split('\n')
          for (let index = 0; index < lines.length; index += 1) {
            scanned += 1
            if (regex.test(lines[index])) {
              matches.push(`${toPosix(path.relative(this.cwd, file))}:${index + 1}: ${lines[index].trim().slice(0, 300)}`)
              if (matches.length >= limit) return
            }
            if (scanned >= MAX_GREP_SCAN_LINES) return
          }
        }
        const stat = await fs.stat(scope).catch(() => undefined)
        if (stat?.isFile()) await searchFile(scope)
        else {
          await walk(scope, async (file) => {
            if (globMatcher && !globMatcher.test(toPosix(path.relative(this.cwd, file)))) return
            await searchFile(file)
            return matches.length < limit
          })
        }
        return matches.join('\n') || 'No matches found.'
      }
      case 'glob': {
        const matcher = globToRegExp(String(args.pattern ?? '*'))
        const scope = args.path ? resolveInside(this.cwd, String(args.path)) : this.cwd
        if (!scope) return 'error: path outside the project'
        const found: Array<{ file: string; mtimeMs: number }> = []
        await walk(scope, (file, info) => {
          if (matcher.test(toPosix(path.relative(this.cwd, file)))) {
            found.push({ file, mtimeMs: info.mtimeMs })
          }
          return found.length < MAX_GLOB_RESULTS * 4
        })
        return (
          found
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, MAX_GLOB_RESULTS)
            .map((entry) => entry.file)
            .join('\n') || 'No files found.'
        )
      }
      case 'read': {
        const target = resolveInside(this.cwd, String(args.path ?? ''))
        if (!target) return 'error: path outside the project'
        const { text, truncated } = await readLines(target, parseRanges(args.lines as string | undefined))
        return `${text}${truncated ? `\n${TRUNCATED_MARKER}` : ''}`
      }
      default:
        return `error: unknown tool ${name}`
    }
  }

  /** Run the search loop and return the files the model settled on. */
  /**
   * Run the search and return what the model settled on. The backend decides which loop runs; both
   * return `path:start-end` lines relative to the session directory.
   */
  async search(
    searchString: string
  ): Promise<{ files: string; answer?: string; dropped?: string[] }> {
    const backend = resolveWarpGrepBackend(this.backend)
    if (!backend.apiKey) {
      throw new WarpGrepError(
        'WARP_NO_KEY',
        backend.hosted ? '未配置 Morph API Key' : `未配置 ${new URL(backend.baseUrl).host} 的 API Key`
      )
    }
    if (!backend.hosted) return this.searchCustom(searchString, backend)
    const messages: MorphMessage[] = [{ role: 'user', content: searchString }]
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const size = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0)
      if (size > MAX_CONTEXT_CHARS) {
        for (const message of messages) {
          if (message.role === 'tool' && message.content !== TRUNCATED_MARKER) {
            message.content = TRUNCATED_MARKER
          }
        }
      }
      const reply = await this.complete(messages, 2048)
      const calls = reply.tool_calls ?? []
      if (calls.length === 0) {
        return { files: '', answer: reply.content ?? '' }
      }
      messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: calls })
      for (const call of calls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
        } catch {
          args = {}
        }
        if (call.function.name === 'finish') {
          return { files: String(args.files ?? ''), answer: reply.content ?? undefined }
        }
        const output = await this.executeTool(call.function.name, args)
        messages.push({ role: 'tool', tool_call_id: call.id, content: output })
      }
    }
    throw new WarpGrepError('WARPGREP_INCOMPLETE', 'WarpGrep 在 6 轮内没有给出结论，请缩小问题范围')
  }

  /**
   * Custom endpoint: the same loop the standalone `warpgrep-mcp` server runs. A general chat model
   * needs the system prompt and the `finish` fallback Morph does not, and every path it reports is
   * verified against the filesystem before it reaches the model.
   */
  private async searchCustom(
    searchString: string,
    backend: ResolvedWarpGrepBackend
  ): Promise<{ files: string; answer?: string; dropped?: string[] }> {
    try {
      const result = await searchCodebase(searchString, {
        cwd: this.cwd,
        baseUrl: backend.baseUrl,
        model: backend.model,
        key: backend.apiKey,
        maxTurns: MAX_TURNS,
        turnTimeoutMs: CUSTOM_TURN_TIMEOUT_MS,
        totalTimeoutMs: CUSTOM_TOTAL_TIMEOUT_MS
      })
      return { files: result.files, answer: result.answer, dropped: result.dropped }
    } catch (error) {
      if (error instanceof SearchError) throw new WarpGrepError(error.code, error.message)
      throw error
    }
  }

  /** Read the listed ranges, used by `includeSource`. */
  async sources(files: string, budget: number): Promise<string> {
    const blocks: string[] = []
    let used = 0
    for (const line of files.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const match = /^(.+?)(?::(.+))?$/.exec(trimmed)
      if (!match) continue
      const target = resolveInside(this.cwd, match[1].replace(/:\d.*$/, ''))
      if (!target) continue
      const ranges = parseRanges(match[2])
      let text: string
      try {
        text = (await readLines(target, ranges)).text
      } catch {
        continue
      }
      const block = `<file path="${toPosix(path.relative(this.cwd, target))}">\n${text}\n</file>`
      if (used + block.length > budget) break
      used += block.length
      blocks.push(block)
    }
    return blocks.join('\n\n')
  }
}

export const WARPGREP_TOOL = {
  name: 'codebase_search',
  title: 'WarpGrep codebase search',
  description:
    'Natural-language code search subagent for this project. It runs several rounds of grep, file ' +
    'listing and reads inside the project, then returns the relevant files and line ranges; set ' +
    'includeSource=true to also get their code. Use a targeted question such as "Where are HTTP ' +
    'routes authenticated?", not bare keywords or a symbol name. Results may be partial. File ' +
    'excerpts read during the search are sent to the configured model endpoint.',
  inputSchema: {
    type: 'object',
    properties: {
      search_string: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'What to find or understand, as a specific natural-language question.'
      },
      includeSource: {
        type: 'boolean',
        default: false,
        description:
          'Also return the code of each listed range. By default only file paths and line ranges ' +
          'are returned; read them with your file tools.'
      },
      maxChars: {
        type: 'integer',
        minimum: 1000,
        maximum: 48000,
        default: 12000,
        description: 'Response budget in Unicode characters.'
      }
    },
    required: ['search_string'],
    additionalProperties: false
  }
}

