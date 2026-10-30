/**
 * Subagent tools: run independent workers using the parent engine (Prophey or pi).
 *
 * Output is Markdown by default. These tools are read by a model, not parsed by code, so JSON keys
 * would only burn tokens; pass `format: "json"` when a caller really wants the raw shape.
 */

const DEFAULT_WAIT_MS = 120_000
const MAX_TEXT = 4000

function text(value) {
  return { content: [{ type: 'text', text: value }] }
}

function failure(message) {
  return { content: [{ type: 'text', text: `错误：${message}` }], isError: true }
}

async function callBridge(context, method, path, payload) {
  const response = await context.request(method, path, payload, context.signal)
  if (!response || response.ok !== true) {
    const code = response?.code ? `${response.code}: ` : ''
    throw new Error(`${code}${response?.message ?? '桥接返回了无效响应'}`)
  }
  return response
}

function truncate(value, limit = MAX_TEXT) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? `${value.slice(0, limit)}\n…已截断（${value.length} 字符）` : value
}

function duration(ms) {
  if (typeof ms !== 'number') return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function tokens(count) {
  if (typeof count !== 'number') return ''
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k tokens` : `${count} tokens`
}

function contextLabel(window) {
  if (typeof window !== 'number' || window <= 0) return ''
  if (window >= 1_000_000) return `${Number((window / 1_000_000).toFixed(1))}M`
  return `${Math.round(window / 1000)}K`
}

/**
 * The subagent's own meter, the same one the panel shows: percent of its window, used / window.
 *
 * A subagent burns a context of its own; when that fills up its answer gets worse or it compacts
 * on its own, so the parent should be able to see it before it starts a sibling.
 */
function usageLabel(record) {
  const usage = record?.contextUsage
  if (!usage) return ''
  const percent =
    typeof usage.percent === 'number' ? `${Math.round(usage.percent)}%` : ''
  const used = contextLabel(usage.tokens)
  const window = contextLabel(usage.contextWindow)
  const pair = used && window ? `${used}/${window}` : ''
  if (!percent && !pair) return ''
  return `上下文 ${[percent, pair].filter(Boolean).join(' ')}`
}

const STATUS_LABEL = {
  starting: 'starting',
  idle: 'idle',
  streaming: 'streaming',
  error: 'error',
  stopped: 'stopped'
}

function statusLine(record) {
  const parts = [
    record.id,
    record.engine ? `· ${record.engine}` : '',
    STATUS_LABEL[record.status] ?? record.status,
    record.agent ? `· ${record.agent}` : '',
    record.mode ? `· ${record.mode}` : '',
    record.model ? `· ${record.model.provider}/${record.model.id}` : '',
    duration(record.runtimeMs) ? `· ${duration(record.runtimeMs)}` : '',
    usageLabel(record) ? `· ${usageLabel(record)}` : tokens(record.tokens) ? `· ${tokens(record.tokens)}` : '',
    record.restored ? '· 历史' : ''
  ]
  return parts.filter(Boolean).join(' ')
}

/** `call.summary` is what the call touched: a path, a command, or a search pattern. */
function summaryChanges(record) {
  const edits = new Map()
  const reads = new Set()
  const commands = []
  for (const call of record.calls ?? []) {
    const target = typeof call.summary === 'string' && call.summary ? call.summary : undefined
    if (['edit', 'write', 'apply_patch', 'edit_file', 'write_file'].includes(call.tool)) {
      const file = target ?? '未知文件'
      const entry = edits.get(file) ?? { path: file, calls: 0, lastTool: call.tool }
      entry.calls += 1
      entry.lastTool = call.tool
      edits.set(file, entry)
    } else if (['read', 'read_file'].includes(call.tool)) {
      if (target) reads.add(target)
    } else if (['bash', 'powershell', 'run_bash'].includes(call.tool)) {
      commands.push({ command: target ?? call.tool, ok: call.ok })
    }
  }
  return { edits: [...edits.values()], reads: [...reads], commands }
}

function renderChanges(record) {
  const changes = summaryChanges(record)
  const lines = []
  if (changes.edits.length === 0 && changes.reads.length === 0 && changes.commands.length === 0) {
    return '### 改动\n- 没有工具调用记录'
  }
  lines.push('### 编辑')
  lines.push(
    changes.edits.length > 0
      ? changes.edits.map((edit) => `- ${edit.path} · ${edit.calls} 次 · 最后 ${edit.lastTool}`).join('\n')
      : '- 无'
  )
  if (changes.reads.length > 0) {
    lines.push('', '### 读取')
    lines.push(changes.reads.map((file) => `- ${file}`).join('\n'))
  }
  if (changes.commands.length > 0) {
    lines.push('', '### 命令')
    lines.push(
      changes.commands
        .map((entry) => `- ${entry.command} · ${entry.ok ? 'ok' : 'failed'}`)
        .join('\n')
    )
  }
  return truncate(lines.join('\n'), 1800)
}

function messagePage(record, since = 0, offset = 0) {
  const index = Math.max(0, Math.floor(Number(since) || 0))
  const message = record.messages?.[index]
  if (!message) return { messages: [], next_since: index, next_offset: 0 }
  const body = message.text ?? ''
  const start = Math.min(body.length, Math.max(0, Math.floor(Number(offset) || 0)))
  const end = Math.min(body.length, start + MAX_TEXT)
  return {
    messages: [{ ...message, text: body.slice(start, end), toolCalls: message.toolCalls?.slice(0, 20) }],
    next_since: end === body.length ? index + 1 : index,
    next_offset: end === body.length ? 0 : end
  }
}

function renderMessages(record, since = 0, offset = 0) {
  const page = messagePage(record, since, offset)
  const message = page.messages[0]
  if (!message) return '（没有新消息）'
  return [
    `### ${message.role}`,
    message.text || '（无文本）',
    message.toolCalls?.length ? `tools: ${message.toolCalls.join(', ')}` : '',
    `下一页：since=${page.next_since}, offset=${page.next_offset}（共 ${record.messages?.length ?? 0} 条消息）`
  ].filter(Boolean).join('\n')
}

function compactRecord(record, options = {}) {
  const { messages, calls, finalText, ...status } = record
  return {
    ...status, finalText: truncate(finalText), messageCount: messages?.length ?? 0,
    callCount: calls?.length ?? 0,
    ...(options.include?.includes('messages') ? messagePage(record, options.since, options.offset) : {})
  }
}

function renderSubagent(record, options = {}) {
  const include = options.include ?? []
  const lines = [statusLine(record)]
  if (record.label) lines.push(`label: ${record.label}`)
  if (record.cwd) lines.push(`cwd: ${record.cwd}`)
  if (record.tools?.length) lines.push(`tools: ${record.tools.join(', ')}`)
  if (record.error) lines.push(`错误：${record.error}`)
  if (record.restored) {
    lines.push('历史记录：进程已结束，结果仍可读取，但不能再发消息（需要继续就在同一目录重新 start_subagent）。')
  }

  if (include.includes('messages')) {
    lines.push('', renderMessages(record, options.since ?? 0, options.offset ?? 0))
  } else if (include.includes('last')) {
    const last = [...(record.messages ?? [])].reverse().find((message) => message.role === 'assistant')
    lines.push('', '### 最近一条', last?.text ? truncate(last.text) : '（还没有回复）')
  } else if (record.status === 'streaming' || record.status === 'starting') {
    lines.push('（运行中，完成后用 get_subagent 取结论；要看过程传 include: ["last"]）')
  } else if (record.finalText) {
    lines.push('', '### 结论', truncate(record.finalText))
  } else if (record.status === 'error') {
    lines.push('（子代理失败，没有结论）')
  }

  if (include.includes('changes') || (!include.includes('messages') && !include.includes('last'))) {
    if (record.status !== 'streaming' && record.status !== 'starting') {
      lines.push('', renderChanges(record))
    }
  }
  return lines.join('\n')
}

export const searchAgents = {
  name: 'search_agents',
  title: 'Find subagent presets',
  description:
    'List the subagent presets this app can start (built-in and user-defined). Pass `query` to rank ' +
    'them by intent, e.g. "审查改动" or "run the tests". The returned ids can be passed straight to ' +
    '`start_subagent` — there is no loading step.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the subagent should do. Omit to list all presets.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 }
    },
    additionalProperties: false
  },
  async call(args, context) {
    const params = new URLSearchParams()
    if (typeof args?.query === 'string' && args.query.trim()) params.set('q', args.query.trim())
    params.set('limit', String(args?.limit ?? 5))
    const response = await callBridge(context, 'GET', `/agents?${params.toString()}`)
    const agents = response.agents ?? []
    if (agents.length === 0) {
      return text('没有可用的子代理预设。')
    }
    const lines = [`预设子代理（${agents.length}/${response.total ?? agents.length}）：`]
    for (const agent of agents) {
      const ability = agent.tools?.length
        ? agent.tools.some((tool) => ['edit', 'write', 'bash', 'powershell'].includes(tool))
          ? '可写'
          : '只读'
        : '全量工具'
      lines.push(`- ${agent.id} · ${agent.mode ?? 'background'} · ${ability} — ${agent.description}`)
    }
    return text(lines.join('\n'))
  }
}

export const listModels = {
  name: 'list_models',
  title: 'List providers and models',
  description:
    'List the providers configured in this app and their models, for choosing a subagent model. ' +
    'Only providers with credentials are returned unless `configuredOnly` is false.',
  inputSchema: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Only this provider id.' },
      configuredOnly: { type: 'boolean', default: true },
      format: { type: 'string', enum: ['md', 'json'], default: 'md' }
    },
    additionalProperties: false
  },
  async call(args, context) {
    const params = new URLSearchParams()
    if (typeof args?.provider === 'string' && args.provider.trim()) params.set('provider', args.provider.trim())
    params.set('configuredOnly', args?.configuredOnly === false ? '0' : '1')
    const response = await callBridge(context, 'GET', `/models?${params.toString()}`)
    const providers = response.providers ?? []
    if (args?.format === 'json') return text(JSON.stringify({ providers }, null, 2))
    if (providers.length === 0) return text('没有已配置的服务商。')
    const lines = []
    for (const entry of providers) {
      lines.push(`## ${entry.providerName} (${entry.provider})`)
      for (const model of entry.models ?? []) {
        const context = contextLabel(model.contextWindow)
        lines.push(`- ${model.id}${model.name ? ` · ${model.name}` : ''}${context ? ` · ${context}` : ''}`)
      }
      lines.push('')
    }
    return text(lines.join('\n').trim())
  }
}

export const startSubagent = {
  name: 'start_subagent',
  title: 'Start a subagent',
  description:
    'Start a subagent using the current engine (Prophey or pi) for a task in this project. It starts ' +
    'blind, so the task must carry the goal, paths and constraints. Worth it for self-contained ' +
    'work that would flood this context (broad exploration, long test loops, a diff review) and ' +
    'for independent slices run in parallel; do small or context-dependent work yourself. With ' +
    '`mode: "sync"` it returns the final answer when it finishes; with `mode: "background"` it ' +
    'returns immediately, and a notice is appended to this session when it finishes (`notify`). ' +
    'Every parameter overrides the preset: model, tools, mode, cwd.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'What the subagent should do, in full.' },
      agent: { type: 'string', description: 'Preset id from `search_agents`, e.g. "explorer".' },
      mode: { type: 'string', enum: ['sync', 'background'], description: 'Defaults to the preset value.' },
      provider: { type: 'string', description: 'Provider id from `list_models`, overrides the preset model.' },
      model: {
        type: 'string',
        description:
          'Model id from `list_models`, overrides the preset model. Works without `provider` when the ' +
          'id is unique among configured providers; an unknown id is rejected instead of running empty.'
      },
      thinking: { type: 'string', description: 'Thinking level, e.g. "high".' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tool allowlist for the subagent, e.g. ["read","grep"].'
      },
      cwd: { type: 'string', description: 'Working directory, defaults to this session directory.' },
      label: { type: 'string', description: 'Short name for the subagent.' },
      timeoutMs: { type: 'integer', description: 'Hard runtime limit. Default 15 minutes.' },
      waitMs: { type: 'integer', description: 'How long sync mode waits. Default 120s, max 300s.' },
      notify: {
        type: 'string',
        enum: ['wake', 'queue', 'none'],
        description:
          'How you learn it finished. wake (default for background): a notice is appended and a ' +
          'turn starts right away, so you continue without being prompted. queue: the notice waits ' +
          'in the transcript until your next turn. none: only wait_subagent / get_subagent report ' +
          'it (default for sync).'
      },
      format: { type: 'string', enum: ['md', 'json'], default: 'md' }
    },
    required: ['task'],
    additionalProperties: false
  },
  async call(args, context) {
    const payload = { task: args?.task }
    for (const key of [
      'agent',
      'mode',
      'provider',
      'model',
      'thinking',
      'cwd',
      'label',
      'timeoutMs',
      'waitMs',
      'notify'
    ]) {
      if (args?.[key] !== undefined) payload[key] = args[key]
    }
    if (Array.isArray(args?.tools)) payload.tools = args.tools
    const response = await callBridge(context, 'POST', '/subagents', payload)
    if (args?.format === 'json') {
      return text(JSON.stringify({ subagent: compactRecord(response.subagent), resolved: response.resolved }, null, 2))
    }
    const record = response.subagent
    const lines = [statusLine(record)]
    if (record.label) lines.push(`label: ${record.label}`)
    lines.push(`tools: ${record.tools?.length ? record.tools.join(', ') : '全量'}`)
    lines.push(`cwd: ${record.cwd}`)
    if (response.timedOut) {
      lines.push('', `仍在运行：已等 ${duration(args?.waitMs ?? DEFAULT_WAIT_MS)}，用 wait_subagent 或 get_subagent 继续。`)
      return text(lines.join('\n'))
    }
    if (record.mode === 'background') {
      const notify = record.notify ?? 'wake'
      lines.push(
        '',
        notify === 'none'
          ? '后台运行中。完成后用 `wait_subagent` 取结论。'
          : notify === 'wake'
            ? '后台运行中。结束后会唤醒你继续（不必轮询，也不要空等）；只想安静收集就传 notify: "queue"。'
            : '后台运行中。结束后本会话会收到一条通知，下个回合即可看到；也可用 `wait_subagent`。'
      )
      return text(lines.join('\n'))
    }
    lines.push('', '### 结论', record.finalText ? truncate(record.finalText) : '（没有结论）')
    lines.push('', renderChanges(record))
    return text(lines.join('\n'))
  }
}

export const getSubagent = {
  name: 'get_subagent',
  title: 'Get a subagent result',
  description:
    'Status of a subagent plus its final answer and a summary of what it touched. Pass ' +
    '`include: ["messages"]` for a bounded transcript page (follow next since/offset) or `["last"]` for the latest assistant text.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Subagent id, e.g. "sa_1a2b3c4d".' },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['status', 'messages', 'last', 'changes'] },
        description: 'Extra sections. Default: status + final answer + change summary.'
      },
      since: { type: 'integer', minimum: 0, description: 'Message index to start from, for include:["messages"].' },
      offset: { type: 'integer', minimum: 0, description: 'Character offset within that message, from the previous page.' },
      format: { type: 'string', enum: ['md', 'json'], default: 'md' }
    },
    required: ['id'],
    additionalProperties: false
  },
  async call(args, context) {
    const include = Array.isArray(args?.include) ? args.include : []
    const params = new URLSearchParams()
    if (include.length > 0) params.set('include', include.join(','))
    const response = await callBridge(context, 'GET', `/subagents/${encodeURIComponent(args.id)}?${params.toString()}`)
    const options = { include, since: args?.since ?? 0, offset: args?.offset ?? 0 }
    if (args?.format === 'json') return text(JSON.stringify({ subagent: compactRecord(response.subagent, options) }, null, 2))
    return text(renderSubagent(response.subagent, options))
  }
}

export const listSubagents = {
  name: 'list_subagents',
  title: 'List subagent runs',
  description:
    'Every subagent this app has run, newest first — including runs from before a restart. Use it ' +
    'to find an earlier result by label or task text, then `get_subagent` for the full answer. ' +
    'Filter with `q` (matches id, label, preset, cwd and final answer), `status` or `agent`.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Free-text filter over id, label, preset, cwd, final answer.' },
      status: {
        type: 'string',
        enum: ['starting', 'streaming', 'idle', 'error', 'stopped'],
        description: 'Only runs in this state. `idle` means it finished and has an answer.'
      },
      agent: { type: 'string', description: 'Only runs started from this preset id.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      format: { type: 'string', enum: ['md', 'json'], default: 'md' }
    },
    additionalProperties: false
  },
  async call(args, context) {
    const params = new URLSearchParams()
    if (typeof args?.q === 'string' && args.q.trim()) params.set('q', args.q.trim())
    if (typeof args?.status === 'string') params.set('status', args.status)
    if (typeof args?.agent === 'string') params.set('agent', args.agent)
    params.set('limit', String(args?.limit ?? 10))
    const response = await callBridge(context, 'GET', `/subagents?${params.toString()}`)
    if (args?.format === 'json') {
      return text(JSON.stringify({ total: response.total, subagents: (response.subagents ?? []).map(record => ({
        ...compactRecord(record), finalText: truncate(record.finalText, 120)
      })) }, null, 2))
    }
    const runs = response.subagents ?? []
    if (runs.length === 0) {
      return text(
        response.total
          ? `没有匹配的子代理（共 ${response.total} 个记录），放宽 q / status 再试。`
          : '还没有任何子代理记录。'
      )
    }
    const lines = [`子代理记录（${runs.length}/${response.total ?? runs.length}）：`]
    for (const record of runs) {
      const head = [
        record.id,
        record.status,
        record.label ? `· ${record.label}` : '',
        record.agent ? `· ${record.agent}` : '',
        duration(record.runtimeMs) ? `· ${duration(record.runtimeMs)}` : '',
        tokens(record.tokens) ? `· ${tokens(record.tokens)}` : '',
        record.restored ? '· 历史' : ''
      ]
        .filter(Boolean)
        .join(' ')
      const gist = (record.finalText ?? record.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      lines.push(`- ${head}${gist ? ` — ${gist}` : ''}`)
    }
    lines.push('', '详情用 `get_subagent`（id 同上）。历史记录的进程已结束，只能读结果。')
    return text(lines.join('\n'))
  }
}

export const waitSubagent = {  name: 'wait_subagent',
  title: 'Wait for a subagent',
  description:
    'Wait until the subagent stops running (or the timeout passes) and return its final answer. ' +
    'Use this instead of polling `get_subagent` in a loop.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 60000 },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['messages', 'last', 'changes'] }
      }
    },
    required: ['id'],
    additionalProperties: false
  },
  async call(args, context) {
    const include = Array.isArray(args?.include) ? args.include : []
    const response = await callBridge(context, 'POST', `/subagents/${encodeURIComponent(args.id)}/wait`, {
      timeoutMs: args?.timeoutMs ?? 60_000
    })
    const record = response.subagent
    if (response.timedOut) {
      return text(
        `${statusLine(record)}\n仍在运行（已等 ${duration(args?.timeoutMs ?? 60_000)}），继续等或用 send_subagent_prompt 问进度。`
      )
    }
    return text(renderSubagent(record, { include }))
  }
}

export const sendSubagentPrompt = {
  name: 'send_subagent_prompt',
  title: 'Send a prompt to a subagent',
  description:
    'Send more instructions to a running subagent. `steer` inserts the message into the current ' +
    'turn (use it to ask for progress), `follow-up` queues it for after the turn, `interrupt` ' +
    'aborts the current turn and starts a new one with this message. Prophey supports interrupt while busy; steer and follow-up require pi.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      text: { type: 'string', description: 'The message to send.' },
      mode: { type: 'string', enum: ['steer', 'follow-up', 'interrupt'], default: 'steer' }
    },
    required: ['id', 'text'],
    additionalProperties: false
  },
  async call(args, context) {
    const response = await callBridge(context, 'POST', `/subagents/${encodeURIComponent(args.id)}/prompt`, {
      text: args?.text,
      mode: args?.mode ?? 'steer'
    })
    const label = args?.mode === 'interrupt' ? '已打断并发送' : args?.mode === 'follow-up' ? '已排队' : '已注入当前回合'
    return text(`${statusLine(response.subagent)} · ${label}`)
  }
}

export const stopSubagent = {
  name: 'stop_subagent',
  title: 'Stop a subagent',
  description: 'Abort the subagent and stop its process. Its messages stay available unless you pass keepMessages: false.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      keepMessages: { type: 'boolean', default: true }
    },
    required: ['id'],
    additionalProperties: false
  },
  async call(args, context) {
    const response = await callBridge(context, 'POST', `/subagents/${encodeURIComponent(args.id)}/stop`, {
      keepMessages: args?.keepMessages !== false
    })
    const kept = args?.keepMessages === false ? 0 : (response.subagent.messages ?? []).length
    return text(`${statusLine(response.subagent)} · 保留 ${kept} 条消息`)
  }
}

export const getSubagentChanges = {
  name: 'get_subagent_changes',
  title: 'Inspect what a subagent changed',
  description:
    'Files the subagent edited or read, and the commands it ran, aggregated from its tool calls. ' +
    'Pass `detail: "calls"` for the individual calls.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      detail: { type: 'string', enum: ['summary', 'calls'], default: 'summary' }
    },
    required: ['id'],
    additionalProperties: false
  },
  async call(args, context) {
    const detail = args?.detail === 'calls' ? 'calls' : 'summary'
    const response = await callBridge(
      context,
      'GET',
      `/subagents/${encodeURIComponent(args.id)}/changes?detail=${detail}`
    )
    const record = response.subagent
    const lines = [`${statusLine(record)} · 改动`]
    if (detail === 'calls') {
      const calls = (record.calls ?? []).slice(-30)
      lines.push(
        calls.length === 0
          ? '- 没有工具调用记录'
          : calls
              .map((call) => {
                const stamp = new Date(call.ts ?? Date.now())
                const time = `${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`
                return `- ${time} ${call.tool}${call.summary ? ` ${call.summary}` : ''}${call.ok ? '' : ' (failed)'}`
              })
              .join('\n')
      )
      return text(truncate(lines.join('\n'), 6000) + `\n（最近 ${calls.length}/${record.calls?.length ?? 0} 次调用）`)
    }
    lines.push('', renderChanges(record))
    return text(lines.join('\n'))
  }
}

export const subagentTools = [
  searchAgents,
  listModels,
  startSubagent,
  listSubagents,
  getSubagent,
  waitSubagent,
  sendSubagentPrompt,
  stopSubagent,
  getSubagentChanges
]
