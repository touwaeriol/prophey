/**
 * Root-aware file tools: the workspace's directories are a first-class argument.
 *
 * A session can cover several folders (a project's repositories). pi's own tools take absolute
 * paths, which works but makes the model responsible for never mixing them up — a relative path in
 * the wrong repository silently reads the wrong file. These tools take a `root` name plus a path
 * relative to it, and refuse anything that resolves outside that root, so a session can work across
 * folders without relying on a prompt convention.
 *
 * Only listed when the session really has more than one root (see `tools/index.mjs`): with one
 * directory, pi's own `read`/`grep` are better and these would just be duplicates.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_READ_BYTES = 96 * 1024
const MAX_MATCHES = 200
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'release',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.codegraph',
  '.serena',
  'coverage',
  '.venv',
  'venv',
  '__pycache__'
])

function roots(context) {
  const raw = context?.roots ? JSON.stringify(context.roots) : process.env.AGENT_DESKTOP_ROOTS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((root) => root && typeof root.path === 'string' && root.path)
      .map((root) => ({
        name: String(root.name ?? path.basename(root.path)),
        path: path.resolve(root.path),
        primary: Boolean(root.primary)
      }))
  } catch {
    return []
  }
}

function rootListText(context) {
  return roots(context)
    .map((root) => `- ${root.name}${root.primary ? '（主目录）' : ''}  ${root.path}`)
    .join('\n')
}

/** The root named by the caller, or the primary one. */
function pickRoot(name, context) {
  const all = roots(context)
  if (all.length === 0) throw new Error('当前会话没有配置工作目录')
  if (name === undefined || name === null || String(name).trim() === '') {
    return all.find((root) => root.primary) ?? all[0]
  }
  const wanted = String(name).trim().toLowerCase()
  const byName = all.find((root) => root.name.toLowerCase() === wanted)
  if (byName) return byName
  const byPath = all.find((root) => root.path.toLowerCase() === path.resolve(String(name)).toLowerCase())
  if (byPath) return byPath
  throw new Error(`没有名为「${name}」的目录。可用目录：\n${rootListText(context)}`)
}

/** Resolve inside the root; anything that escapes it is refused rather than silently followed. */
function inside(root, relative) {
  const target = path.resolve(root.path, relative ?? '')
  const base = root.path.endsWith(path.sep) ? root.path : root.path + path.sep
  if (target !== root.path && !target.startsWith(base)) {
    throw new Error(`路径超出目录「${root.name}」的范围：${relative}`)
  }
  return target
}

function text(value) {
  return { content: [{ type: 'text', text: value }] }
}

function failure(error) {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
}

export const workspaceRoots = {
  name: 'workspace_roots',
  title: 'List the workspace directories',
  description:
    'List the directories this session works on: name, absolute path, and which one is the primary ' +
    'working directory. Other tools take these names as their `root` argument.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async call(_args, context) {
    try {
      const all = roots(context)
      if (all.length === 0) return text('当前会话只有一个工作目录，没有额外目录。')
      return text(`这个会话覆盖 ${all.length} 个目录：\n${rootListText(context)}`)
    } catch (error) {
      return failure(error)
    }
  }
}

export const readFile = {
  name: 'read_file',
  title: 'Read a file in a workspace directory',
  description:
    'Read a text file from one of the workspace directories. `path` is relative to `root` (the ' +
    'directory name listed in the workspace section of the prompt); omit `root` for the primary ' +
    'directory. Paths that would escape the directory are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Directory name; omit for the primary directory.' },
      path: { type: 'string', description: 'Path relative to the directory.' },
      offset: { type: 'number', description: 'First line to return (1-based).' },
      limit: { type: 'number', description: 'Maximum number of lines.' }
    },
    required: ['path'],
    additionalProperties: false
  },
  async call(args, context) {
    try {
      const root = pickRoot(args?.root, context)
      const target = inside(root, args?.path)
      const stat = await fs.stat(target)
      if (stat.isDirectory()) throw new Error(`${args?.path} 是目录，不是文件`)
      const buffer = await fs.readFile(target)
      const truncated = buffer.length > MAX_READ_BYTES
      const body = buffer.subarray(0, MAX_READ_BYTES).toString('utf8')
      const lines = body.split('\n')
      const from = Math.max(0, (Number(args?.offset) || 1) - 1)
      const to = args?.limit ? from + Number(args.limit) : lines.length
      const slice = lines.slice(from, to)
      const header = `${root.name}/${args?.path}（第 ${from + 1}-${from + slice.length} 行${
        truncated ? '，文件较大已截断' : ''
      }）`
      return text(`${header}\n${slice.map((line, index) => `${from + index + 1}\t${line}`).join('\n')}`)
    } catch (error) {
      return failure(error)
    }
  }
}

function runRipgrep(rootPath, pattern, glob, literal, ignoreCase) {
  return new Promise((resolve) => {
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '5000']
    if (literal) args.push('--fixed-strings')
    if (ignoreCase) args.push('--ignore-case')
    if (glob) args.push('--glob', glob)
    args.push(pattern, '.')
    execFile(
      'rg',
      args,
      { cwd: rootPath, maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 30_000 },
      (error, stdout) => {
        // Exit code 1 means "no matches", which is a normal answer rather than a failure.
        if (error && error.code !== 1) {
          resolve(undefined)
          return
        }
        resolve(stdout)
      }
    )
  })
}

async function walkMatches(rootPath, pattern, glob, literal, ignoreCase) {
  const matches = literal
    ? (line) => (ignoreCase ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern))
    : (() => {
        const expression = new RegExp(pattern, ignoreCase ? 'i' : '')
        return (line) => expression.test(line)
      })()
  const suffix = glob && !glob.includes('*') ? glob : glob?.replace(/^\*\*?\/?/, '')
  const hits = []
  const queue = [rootPath]
  while (queue.length > 0 && hits.length < MAX_MATCHES) {
    const dir = queue.pop()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (hits.length >= MAX_MATCHES) break
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full)
        continue
      }
      if (suffix && !entry.name.endsWith(suffix)) continue
      let body
      try {
        const stat = await fs.stat(full)
        if (stat.size > 2 * 1024 * 1024) continue
        body = await fs.readFile(full, 'utf8')
      } catch {
        continue
      }
      body.split('\n').forEach((line, index) => {
        if (hits.length >= MAX_MATCHES) return
        if (!matches(line)) return
        hits.push(`${path.relative(rootPath, full).split(path.sep).join('/')}:${index + 1}:${line.slice(0, 240)}`)
      })
    }
  }
  return hits.join('\n')
}

export const grepFiles = {
  name: 'grep_files',
  title: 'Search text inside a workspace directory',
  description:
    'Search file contents inside one workspace directory. `path`/`glob` narrow the search; results ' +
    'are paths relative to `root`. Uses ripgrep when it is available, so .gitignore is respected.',
  inputSchema: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Directory name; omit for the primary directory.' },
      pattern: { type: 'string', description: 'Text or regular expression to find.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. *.ts.' },
      literal: { type: 'boolean', description: 'Treat the pattern as literal text.' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search.' },
      limit: { type: 'number', description: 'Maximum number of matches (default 200).' }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  async call(args, context) {
    try {
      const root = pickRoot(args?.root, context)
      const pattern = String(args?.pattern ?? '')
      if (!pattern) throw new Error('pattern 不能为空')
      const limit = Math.min(Number(args?.limit) || MAX_MATCHES, MAX_MATCHES)
      const fromRg = await runRipgrep(root.path, pattern, args?.glob, args?.literal, args?.ignoreCase)
      const raw =
        fromRg === undefined
          ? await walkMatches(root.path, pattern, args?.glob, args?.literal, args?.ignoreCase)
          : fromRg
      const lines = raw.split('\n').filter(Boolean)
      if (lines.length === 0) return text(`在「${root.name}」里没有匹配 ${pattern} 的内容`)
      const shown = lines
        .slice(0, limit)
        .map((line) => line.replace(/^\.\//, '').slice(0, 320))
        .join('\n')
      const more = lines.length > limit ? `\n…共 ${lines.length} 条，只显示前 ${limit} 条` : ''
      return text(`「${root.name}」的匹配（${Math.min(lines.length, limit)} 条）：\n${shown}${more}`)
    } catch (error) {
      return failure(error)
    }
  }
}

export const writeFile = {
  name: 'write_file',
  title: 'Write a file in a workspace directory',
  description:
    'Create or overwrite a text file inside one workspace directory. `path` is relative to `root` ' +
    '(omit `root` for the primary directory); parent directories are created. Anything that would ' +
    'escape the directory is refused.',
  inputSchema: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Directory name; omit for the primary directory.' },
      path: { type: 'string', description: 'Path relative to the directory.' },
      content: { type: 'string', description: 'Full file content.' }
    },
    required: ['path', 'content'],
    additionalProperties: false
  },
  async call(args, context) {
    try {
      const root = pickRoot(args?.root, context)
      const target = inside(root, args?.path)
      const content = typeof args?.content === 'string' ? args.content : String(args?.content ?? '')
      let previous = null
      try {
        previous = await fs.readFile(target, 'utf8')
      } catch {
        // a new file is the normal case
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, 'utf8')
      const lines = content.split('\n').length
      const verb = previous === null ? '新建' : previous === content ? '未变' : '覆盖'
      return text(`${verb} ${root.name}/${args?.path}（${lines} 行）`)
    } catch (error) {
      return failure(error)
    }
  }
}

export const editFile = {
  name: 'edit_file',
  title: 'Replace exact text in a file',
  description:
    'Apply exact-text replacements to a file inside one workspace directory. Each `oldText` must ' +
    'match the original file exactly and uniquely; edits are applied to the original content, not ' +
    'incrementally. `path` is relative to `root`.',
  inputSchema: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Directory name; omit for the primary directory.' },
      path: { type: 'string', description: 'Path relative to the directory.' },
      edits: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string', description: 'Exact text to find.' },
            newText: { type: 'string', description: 'Replacement text.' }
          },
          required: ['oldText', 'newText'],
          additionalProperties: false
        }
      }
    },
    required: ['path', 'edits'],
    additionalProperties: false
  },
  async call(args, context) {
    try {
      const root = pickRoot(args?.root, context)
      const target = inside(root, args?.path)
      const original = await fs.readFile(target, 'utf8')
      let next = original
      const edits = Array.isArray(args?.edits) ? args.edits : []
      if (edits.length === 0) throw new Error('edits 不能为空')
      for (const edit of edits) {
        const oldText = String(edit?.oldText ?? '')
        if (!oldText) throw new Error('oldText 不能为空')
        const hits = next.split(oldText).length - 1
        if (hits === 0) throw new Error(`没有找到要替换的文本：${oldText.slice(0, 80)}`)
        if (hits > 1) throw new Error(`要替换的文本出现了 ${hits} 次，请写得更具体：${oldText.slice(0, 80)}`)
        next = next.replace(oldText, String(edit?.newText ?? ''))
      }
      await fs.writeFile(target, next, 'utf8')
      return text(`已修改 ${root.name}/${args?.path}（${edits.length} 处替换）`)
    } catch (error) {
      return failure(error)
    }
  }
}

export const runBash = {
  name: 'run_bash',
  title: 'Run a shell command in a workspace directory',
  description:
    'Run a bash command with the working directory set to one workspace directory (or a ' +
    'subdirectory of it). Unlike pi\'s bash tool this one takes the directory explicitly, so a ' +
    'command cannot accidentally run in the wrong repository.',
  inputSchema: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Directory name; omit for the primary directory.' },
      cwd: { type: 'string', description: 'Subdirectory to run in, relative to root.' },
      command: { type: 'string', description: 'Command to run.' },
      timeout: { type: 'number', description: 'Seconds before the command is killed (default 120).' }
    },
    required: ['command'],
    additionalProperties: false
  },
  async call(args, context) {
    try {
      const root = pickRoot(args?.root, context)
      const cwd = inside(root, args?.cwd)
      const command = String(args?.command ?? '')
      if (!command.trim()) throw new Error('command 不能为空')
      const seconds = Math.min(Math.max(Number(args?.timeout) || 120, 1), 1800)
      if (context?.runBash) {
        return await context.runBash({ ...args, cwd, command, timeout: seconds }, context.signal)
      }
      // The app resolves Git Bash for us: this process does not inherit the fixed PATH.
      const shell = context?.shell || process.env.AGENT_DESKTOP_SHELL || 'bash'
      const result = await new Promise((resolve, reject) => {
        execFile(
          shell,
          ['-lc', command],
          { cwd, signal: context?.signal, timeout: seconds * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            if (error && error.killed) {
              reject(new Error(`命令超时（${seconds} 秒）：${command.slice(0, 120)}`))
              return
            }
            const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0
            const body = [stdout, stderr].filter(Boolean).join('\n').trim()
            resolve({ code, body: body.slice(0, 20000), truncated: body.length > 20000 })
          }
        )
      })
      const header = `${root.name}/${args?.cwd ?? ''} $ ${command}`
      const body = result.body || '（无输出）'
      return {
        content: [
          { type: 'text', text: `${header}\n${body}${result.truncated ? '\n…输出过长已截断' : ''}` }
        ],
        ...(result.code === 0 ? {} : { isError: true })
      }
    } catch (error) {
      return failure(error)
    }
  }
}

export const listFiles = {
  name: 'list_files',
  title: 'List workspace files',
  description: 'List files and directories relative to root. Set recursive for file discovery. Returns at most 200 entries.',
  inputSchema: {
    type: 'object', properties: {
      root: { type: 'string' }, path: { type: 'string' }, recursive: { type: 'boolean' }
    }, additionalProperties: false
  },
  async call(args, context) {
    try {
      const root = pickRoot(args?.root, context)
      const pending = [inside(root, args?.path)]
      const entries = []
      while (pending.length && entries.length < 200) {
        const dir = pending.shift()
        for (const item of await fs.readdir(dir, { withFileTypes: true })) {
          if (entries.length >= 200) break
          if (item.isSymbolicLink() || SKIP_DIRS.has(item.name)) continue
          const full = path.join(dir, item.name)
          entries.push(path.relative(root.path, full).split(path.sep).join('/') + (item.isDirectory() ? '/' : ''))
          if (args?.recursive && item.isDirectory()) pending.push(full)
        }
      }
      return text(entries.join('\n') + (entries.length === 200 ? '\n…最多显示 200 项，请缩小 path' : ''))
    } catch (error) { return failure(error) }
  }
}

export const workspaceTools = [
  workspaceRoots,
  listFiles,
  readFile,
  grepFiles,
  writeFile,
  editFile,
  runBash
]

