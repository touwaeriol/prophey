/**
 * The search loop: a question in, a verified file list (and optionally their code) out.
 *
 * Transport is plain `POST /chat/completions` with `tools`, so DeepSeek, OpenAI, a local vLLM or a
 * proxy all work — only the model id and base URL change. Two things make a general model behave
 * like a search specialist: the system prompt (see `prompt.mjs`) and the guarantees below.
 *
 * Guarantees, in the order they bite:
 * - Every tool call is clamped by `workspace.mjs` (no shell, nothing outside the root).
 * - A tool-call budget, a per-call timeout and a total deadline; all three fail with a code.
 * - `finish` is not taken on faith: paths that do not exist are dropped, not reported.
 * - A model that stops without calling `finish` is asked once, then its prose is parsed for
 *   `path:line` pairs — an answer is never lost because the model forgot the protocol.
 */
import { systemPrompt, PROMPT_VERSION } from './prompt.mjs'
import * as workspace from './workspace.mjs'

export const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description:
        'Search file contents by regex (case-insensitive). Returns `path:line: text` for each hit. ' +
        'Common junk directories are skipped. Prefer distinctive identifiers over generic words.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex to search for.' },
          path: { type: 'string', description: 'File or directory to search in. Defaults to the root.' },
          glob: { type: 'string', description: "Only search files matching this glob, e.g. '*.ts'." },
          limit: { type: 'integer', description: 'Maximum matching lines (default 200).' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files by name pattern. Returns repository-relative paths, newest first.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: "Glob, e.g. '*.tsx' or 'src/**/*.test.ts'." },
          path: { type: 'string', description: 'Directory to search in. Defaults to the root.' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List a directory (junk directories skipped). Directories end with "/".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list. Defaults to the root.' },
          depth: { type: 'integer', description: 'How many levels to descend (1-3, default 1).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file, or specific line ranges, with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the repository root.' },
          lines: { type: 'string', description: 'Line ranges like "12-40" or "3,90-120". Optional.' }
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
        'Stop searching and report the files that answer the question. Call this as soon as you ' +
        'have enough locations; do not keep searching for completeness.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'string',
            description: 'One `path:start-end` (or plain `path`) per line, most relevant first. "" if none.'
          },
          answer: { type: 'string', description: 'One sentence answering the question.' }
        },
        required: ['files']
      }
    }
  }
]

export class SearchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SearchError'
    this.code = code
  }
}

const TRUNCATED_MARKER = workspace.TRUNCATED_MARKER
const MAX_CONTEXT_CHARS = 321_600

function runTool(root, name, args) {
  switch (name) {
    case 'grep_search':
      return workspace.grep(root, args)
    case 'glob':
      return workspace.glob(root, args)
    case 'list_directory':
      return workspace.listDirectory(root, args)
    case 'read':
      return workspace.read(root, args)
    default:
      return `error: unknown tool ${name}`
  }
}

function statusCode(status) {
  if (status === 401 || status === 403) return 'UNAUTHORIZED'
  if (status === 402 || status === 400) return 'REJECTED'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'UNAVAILABLE'
  return 'HTTP_ERROR'
}

/** One model call. Retries a 429/5xx once: providers hiccup, and the loop is cheap to redo. */
async function complete(config, messages, { signal, attempt = 0 } = {}) {
  let response
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
      body: JSON.stringify({
        model: config.model,
        messages,
        tools: TOOL_SPECS,
        tool_choice: 'auto',
        max_tokens: 2048
      }),
      signal
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new SearchError('TIMEOUT', `模型调用超时（${config.turnTimeoutMs}ms）`)
    }
    throw new SearchError('NETWORK', `模型接口不可达：${error.message}`)
  }
  if (response.status === 429 || response.status >= 500) {
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      return complete(config, messages, { signal, attempt: 1 })
    }
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 300)
    throw new SearchError(
      statusCode(response.status),
      `模型接口返回 ${response.status}: ${body || response.statusText}`
    )
  }
  const payload = await response.json().catch(() => undefined)
  const message = payload?.choices?.[0]?.message
  if (!message || typeof message !== 'object') {
    throw new SearchError('PROTOCOL', '模型返回了无法识别的响应（缺少 choices[0].message）')
  }
  return { message, usage: payload.usage }
}

/** `path:12-40` / `- path` lines in free text → a file list, when the model never called finish. */
export function filesFromProse(text) {
  const found = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim().replace(/^[-*\d.)\s]+/, '')
    const match = /^([\w@./-]+\.[A-Za-z0-9]{1,12})(?::(\d+(?:-\d+)?))?$/.exec(line)
    if (match) found.push(match[2] ? `${match[1]}:${match[2]}` : match[1])
  }
  return found.join('\n')
}

/**
 * Run the loop. Returns `{ files, answer, dropped, turns, usage }` where `files` only ever
 * contains paths that exist inside the workspace.
 */
export async function searchCodebase(question, config, { onEvent } = {}) {
  // Defaults so an in-process caller (the desktop gateway) can pass only what it cares about.
  config = {
    ...config,
    maxTurns: config.maxTurns ?? 6,
    turnTimeoutMs: config.turnTimeoutMs ?? 45_000,
    totalTimeoutMs: config.totalTimeoutMs ?? 100_000
  }
  const trimmed = String(question ?? '').trim()
  if (!trimmed) throw new SearchError('INPUT', 'search_string 不能为空')
  if (!config.key) {
    throw new SearchError(
      'NO_KEY',
      '没有可用的 API Key：设置 WARPGREP_API_KEY / DEEPSEEK_API_KEY，或先在服务商设置里登录'
    )
  }

  const deadline = Date.now() + config.totalTimeoutMs
  // `systemPrompt: null` reproduces the fine-tuned-Morph behaviour exactly: no system message and
  // no follow-up nudge, because that model already speaks the finish protocol.
  const messages = [
    ...(config.systemPrompt === null
      ? []
      : [{ role: 'system', content: config.systemPrompt ?? systemPrompt({ maxTurns: config.maxTurns }) }]),
    { role: 'user', content: trimmed }
  ]
  const nudge = config.nudge !== false
  const usage = { prompt: 0, completion: 0, cached: 0 }
  let nudged = false
  let turns = 0
  let toolCalls = 0

  const finish = (files, answer) => {
    const verified = workspace.verifyFiles(config.cwd, files)
    return {
      files: verified.files,
      dropped: verified.dropped,
      answer: answer?.trim() || undefined,
      turns,
      usage
    }
  }

  for (let turn = 0; turn < config.maxTurns; turn += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new SearchError('TIMEOUT', `整体搜索超时（${config.totalTimeoutMs}ms）`)
    const size = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0)
    if (size > MAX_CONTEXT_CHARS) {
      for (const message of messages) {
        if (message.role === 'tool' && message.content !== TRUNCATED_MARKER) message.content = TRUNCATED_MARKER
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(config.turnTimeoutMs, remaining)
    )
    let reply
    try {
      reply = await complete(config, messages, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    turns += 1
    usage.prompt += reply.usage?.prompt_tokens ?? 0
    usage.completion += reply.usage?.completion_tokens ?? 0
    usage.cached += reply.usage?.prompt_cache_hit_tokens ?? 0
    const message = reply.message
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []

    if (calls.length === 0) {
      // The model answered in prose instead of calling finish.
      const fromProse = filesFromProse(message.content)
      if (fromProse) return finish(fromProse, message.content)
      if (!nudged && nudge) {
        nudged = true
        messages.push({ role: 'assistant', content: message.content ?? '' })
        messages.push({ role: 'user', content: 'Call finish now with the files you found (files="" if none).' })
        continue
      }
      return finish('', message.content)
    }

    messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls })
    for (const call of calls) {
      const name = call.function?.name
      let args = {}
      try {
        args = JSON.parse(call.function?.arguments || '{}')
      } catch {
        args = {}
      }
      if (name === 'finish') {
        const result = finish(args.files ?? '', args.answer ?? message.content)
        onEvent?.({ type: 'finish', ...result })
        return result
      }
      toolCalls += 1
      const output = runTool(config.cwd, name, args)
      onEvent?.({ type: 'tool', name, args, output })
      messages.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
    // The budget is enforced between messages, never mid-message: an assistant message whose
    // `tool_calls` lack matching `tool` replies is rejected (400) by OpenAI-compatible endpoints.
    if (toolCalls >= config.maxTurns) {
      messages.push({
        role: 'user',
        content: 'Tool budget exhausted. Call finish now with what you have (files="" if none).'
      })
    }
  }

  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  return finish(filesFromProse(last?.content), last?.content)
}
