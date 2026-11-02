/**
 * Probe: can DeepSeek drive the same grep/read/finish loop WarpGrep uses?
 * Uses the DeepSeek key already configured for pi (~/.pi/agent/auth.json) and searches THIS repo.
 * Run: node artifacts/deepseek-warpgrep-probe.cjs [model]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SCOPE = path.join(ROOT, 'apps/desktop/src')
const MODEL = process.argv[2] ?? 'deepseek-flash'
const API = 'https://api.deepseek.com/v1/chat/completions'
const key = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8')).deepseek.key

const SYSTEM = [
  'You are a code search agent. You answer one question about a repository by running tools, then stop.',
  'Rules:',
  '- Start with grep_search on 1-2 distinctive identifiers or strings; do not guess file contents.',
  '- Use read with explicit line ranges to confirm a hit before reporting it.',
  '- Maximum 6 tool calls total. Never read a whole large file.',
  '- Stop by calling finish with files="relative/path.ts:12-40" lines, one per line, most relevant first.',
  '- If nothing matches, call finish with files="".'
].join('\n')

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search file contents by regex (case-insensitive). Returns path:line: text.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          glob: { type: 'string', description: "e.g. '*.tsx'" },
          limit: { type: 'integer' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read an absolute or repo-relative file, optionally a line range like "12-40".',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, lines: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Stop searching and report the files that answer the question.',
      parameters: {
        type: 'object',
        properties: { files: { type: 'string', description: 'path:start-end per line' }, answer: { type: 'string' } },
        required: ['files']
      }
    }
  }
]

const SKIP = new Set(['node_modules', '.git', 'out', 'dist', 'release', 'artifacts', '_codegraph'])
function walk(dir, visit) {
  const queue = [dir]
  while (queue.length) {
    const current = queue.pop()
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile() && visit(full) === false) return
    }
  }
}

function grep(pattern, glob, limit) {
  const regex = new RegExp(pattern, 'i')
  const globRe = glob ? new RegExp('^' + glob.replace(/[.+^$()|[\]\\]/g, (c) => '\\' + c).replace(/\*/g, '.*') + '$', 'i') : undefined
  const out = []
  walk(SCOPE, (file) => {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    if (globRe && !globRe.test(path.basename(file))) return
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { return }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
        if (out.length >= (limit || 40)) return false
      }
    }
  })
  return out.join('\n') || 'No matches found.'
}

function read(file, ranges) {
  const target = path.isAbsolute(file) ? file : path.join(ROOT, file)
  if (!target.startsWith(ROOT)) return 'error: outside the repo'
  const lines = fs.readFileSync(target, 'utf8').split('\n')
  const m = /^(\d+)-(\d+)$/.exec(ranges ?? '')
  const from = m ? Number(m[1]) : 1
  const to = m ? Math.min(Number(m[2]), lines.length) : Math.min(120, lines.length)
  const body = []
  for (let i = from; i <= to; i++) body.push(`${i}: ${lines[i - 1] ?? ''}`)
  return body.join('\n')
}

async function complete(messages, stats) {
  const started = Date.now()
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', max_tokens: 2048 })
  })
  const body = await response.text()
  if (!response.ok) throw Error(`DeepSeek ${response.status}: ${body.slice(0, 300)}`)
  const payload = JSON.parse(body)
  stats.push({ ms: Date.now() - started, usage: payload.usage })
  return payload.choices?.[0]?.message
}

;(async () => {
  const question = '侧栏折叠/展开的状态存在哪里，读写它的函数是什么？'
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: question }
  ]
  const stats = []
  try {
    for (let turn = 0; turn < 6; turn++) {
      const reply = await complete(messages, stats)
      const calls = reply?.tool_calls ?? []
      if (!calls.length) {
        console.log(`turn ${turn + 1}: no tool call, content=${JSON.stringify((reply?.content ?? '').slice(0, 300))}`)
        return
      }
      messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: calls })
      for (const call of calls) {
        const args = JSON.parse(call.function.arguments || '{}')
        if (call.function.name === 'finish') {
          console.log('\n=== finish ===\nfiles:\n' + args.files + '\nanswer: ' + (args.answer ?? ''))
          printStats(stats)
          return
        }
        const result =
          call.function.name === 'grep_search'
            ? grep(args.pattern, args.glob, args.limit)
            : call.function.name === 'read'
              ? read(args.path, args.lines)
              : 'error: unknown tool'
        console.log(`turn ${turn + 1}: ${call.function.name}(${JSON.stringify(args).slice(0, 120)}) -> ${result.split('\n').length} lines`)
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
    }
    console.log('no finish within 6 turns; last content:', JSON.stringify(messages.at(-1)?.content ?? '').slice(0, 400))
    printStats(stats)
  } catch (error) {
    console.error(error.message)
    printStats(stats)
    process.exitCode = 1
  }
})()

function printStats(stats) {
  const total = stats.reduce((sum, s) => sum + s.ms, 0)
  const usage = stats.reduce((sum, s) => sum + (s.usage?.total_tokens ?? 0), 0)
  const prompt = stats.reduce((sum, s) => sum + (s.usage?.prompt_tokens ?? 0), 0)
  const cached = stats.reduce((sum, s) => sum + (s.usage?.prompt_cache_hit_tokens ?? 0), 0)
  console.log(`\n[stats] model=${MODEL} turns=${stats.length} total=${total}ms perTurn=${Math.round(total / Math.max(stats.length, 1))}ms tokens=${usage} prompt=${prompt} cached=${cached}`)
}
