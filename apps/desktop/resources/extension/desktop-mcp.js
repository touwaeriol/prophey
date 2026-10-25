/**
 * Registers the Prophey built-in MCP servers for the current pi session.
 *
 * Loaded with `--extension <this file>` by the desktop app only. Everything comes from the
 * environment the desktop passes to the pi child process, so nothing is written to
 * `~/.pi/agent/mcp.json` and terminal pi sessions stay untouched:
 *
 * - `AGENT_DESKTOP_MCP_URL` / `AGENT_DESKTOP_MCP_TOKEN` — loopback bridge of the window
 * - `AGENT_DESKTOP_MCP_CORE_SCRIPT` — core interaction server (`packages/mcp-core/server.mjs`)
 * - `AGENT_DESKTOP_MCP_ENGINES` — JSON array of CodeGraph / LSP server specs
 * - `AGENT_DESKTOP_MCP_TOGGLES` — `{ server: { tool: false } }`, tools the user turned off
 */

const CORE_SERVER = 'desktop'
const ASK_TOOL = 'mcp__desktop__ask_user_question'
const START_SUBAGENT_TOOL = 'mcp__desktop__start_subagent'
const WEB_SEARCH_TOOL = 'mcp__web__web_search'
const WEB_FETCH_TOOL = 'mcp__web__web_fetch'
const PROMPT_SECTION = 'desktop_tools'
const AGENTS_SECTION = 'subagents'
const WEB_SECTION = 'web_tools'
const PROJECT_SECTION = 'project'
const CONVENTIONS_SECTION = 'conventions'

/**
 * Guidelines, not a section: `systemPromptOptions.promptGuidelines` are rendered as bullets in the
 * system prompt's `<rules>` block, right next to pi's own rules. A model follows that list far more
 * reliably than a tag it has to decide to read.
 *
 * pi sends one model request per turn and executes every tool call in that response, so the cost of
 * "one tool call, one thought" is one extra round trip per call — measured on a real session,
 * roughly 1.2 calls per assistant message over 131 turns.
 */
const BATCH_GUIDELINES = [
  'When a step needs several independent tool calls, send them together in one response (multiple tool calls in one assistant message). One call per turn costs an extra round trip and another round of reasoning for no gain.',
  'Keep working from the plan you already have instead of restating it between calls. Think again only when a result contradicts the plan, a real decision appears, or the next step is irreversible.'
]

/**
 * Search failures are the most common wasted turn: `bash grep -rn` walks `node_modules` and an
 * installed app's unpacked bundles, which takes minutes on Windows and then hits whatever timeout
 * the model guessed. pi's own `grep`/`find` tools run ripgrep and skip `.gitignore`, so the same
 * query is ~180x faster here (78ms vs 14s over this repository, warm cache).
 */
const SEARCH_GUIDELINES = [
  'Search with the `grep` and `find` tools, not `bash grep -rn` / `bash find`: they run ripgrep, skip whatever .gitignore hides (node_modules, dist, out) and answer in milliseconds. Keep bash for builds, tests and one-off commands.',
  'Never search node_modules, .git, dist, out or an installed app\'s resources by hand. If a command needs a timeout to survive, it is the wrong command — narrow it instead.'
]

const EXTRA_GUIDELINES = [...BATCH_GUIDELINES, ...SEARCH_GUIDELINES]

/**
 * Guidance for the model. An MCP server cannot supply a system prompt: pi only uses a server's
 * `instructions` for codemode namespaces and the `mcp_servers` section, and neither applies to a
 * server exposed as `direct`. So the extension injects the section instead, and only while the
 * tool is actually declared to the model (see below).
 */
const GUIDANCE = [
  '`mcp__desktop__ask_user_question` shows questions in the Prophey window and waits for the user.',
  'It never times out, so the user can answer whenever they like.',
  '',
  'Use it when the answer changes what you build: ambiguous requirements, a real tradeoff between',
  'approaches, information you cannot derive from the repository, or a preference only the user knows.',
  'Ask before doing expensive or hard-to-reverse work that depends on that answer.',
  '',
  'Do not use it for decisions you can settle by reading the code or following existing conventions,',
  'to confirm an obvious next step, or to ask permission for individual tool calls.',
  '',
  'Offer 2-4 concrete options with a short description each, and set `multiSelect` when several choices',
  'can apply. The user can always type their own answer, so keep options representative rather than',
  'exhaustive. Questions are shown one at a time: ask everything you need in one call instead of several.',
  'If the result says the user cancelled, do not invent an answer; ask how to proceed.'
].join('\n')

/**
 * Guidance for the web gateway. Same reason as above: a `direct` MCP server cannot bring a system
 * prompt, so the extension injects one — only while the tools are actually declared.
 */
const WEB_GUIDANCE = [
  '`mcp__web__web_search` returns titles, URLs and snippets; `mcp__web__web_fetch` downloads one',
  'page and converts it to Markdown. Both run on the user\'s configured backend; you never pick one.',
  '',
  'Search when the answer depends on something newer than your weights or outside this repository:',
  'library releases and changelogs, API docs, error messages, version-specific behavior, comparisons.',
  'Do not search for things the repository already answers.',
  '',
  'A snippet is not a source: after searching, fetch the one or two most promising URLs and answer',
  'from their content. Give the URL for every claim you took from the web, and say plainly when the',
  'pages do not support an answer instead of filling the gap from memory.',
  '',
  'Local and private addresses are refused by design; use the repository tools or bash for those.'
].join('\n')

/**
 * The project section, for a window that works across several repositories.
 *
 * pi has one working directory; its tools do not care (read/edit take absolute paths, grep/find
 * take a `path`, bash can `cd`). What the model cannot know on its own is *which* repositories
 * belong together and where they live, so the app sends that list and this renders it. Absent for a
 * single-repository session, which needs no explanation.
 */
function projectSection(raw, engineSpecs) {
  const project = parseJson(raw, undefined)
  const roots = Array.isArray(project?.roots) ? project.roots : []
  if (roots.length <= 1) return undefined
  const primary = roots.find((root) => root?.primary) ?? roots[0]
  // Code search runs once per repository, so the model has to know which tool set belongs to which.
  const servers = (Array.isArray(engineSpecs) ? engineSpecs : [])
    .filter((spec) => typeof spec?.label === 'string' && spec.label)
    .map((spec) => `\`mcp__${String(spec.name).replace(/[^a-zA-Z0-9_]/g, '_')}__*\` → ${spec.label}`)
  return [
    `当前项目「${String(project.name ?? '')}」包含 ${roots.length} 个仓库，你的工作目录是主仓库 ${
      primary?.name ?? ''
    }（${primary?.path ?? ''}）：`,
    ...roots.map((root) =>
      root?.primary
        ? `- ${String(root.name ?? '')}（主仓库）  ${String(root.path ?? '')}`
        : `- ${String(root.name ?? '')}  ${String(root.path ?? '')}`
    ),
    '',
    '跨仓库引用文件一律写绝对路径，不要按工作目录去推算相对路径，也不要把别的仓库当成子目录。',
    '每条 bash 命令都是新的 shell，cd 不会保留：要进哪个仓库就先 `cd <仓库路径> && …`。',
    '跨仓库搜索用 grep 工具的 `path` 参数指向仓库目录，不要用 `bash grep -rn` 扫整个磁盘。',
    ...(servers.length > 0
      ? ['', `代码搜索按仓库分成独立工具集，按仓库选对再搜：${servers.join('，')}。`]
      : []),
    '',
    '跨目录读写文件优先用 `mcp__desktop__workspace_roots` / `mcp__desktop__read_file` / ' +
      '`mcp__desktop__grep_files`：它们带 `root` 参数、路径相对该目录，越界会被拒绝，' +
      '不会像绝对路径那样容易串到别的仓库。'
  ].join('\n')
}

function parseJson(value, fallback) {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Processing tier, sent with every request.
 *
 * Both vendors put it in the request body, but under different names, and Anthropic additionally
 * gates it behind a beta header:
 *
 * - OpenAI (`openai-responses` / `openai-completions`): `service_tier` — `fast` (the old
 *   `priority`, ~2.5× faster) or `ultrafast` (GPT-6 Astra / GPT-6.1 Sol only).
 * - Anthropic (`anthropic-messages`): `speed: "fast"` + `anthropic-beta: fast-mode-2026-02-01`,
 *   Opus 5.5 / 5 / 4.8 only.
 *
 * The tier is refused outright on unsupported models, so the model is checked here as well as in
 * the window: a model switch mid-session must not turn into a failing request.
 */
const FAST_BETA = 'fast-mode-2026-02-01'
const ULTRAFAST_MODELS = /^(gpt-6-astra|gpt-6\.1-sol)$/i
const FAST_OPUS = /^claude-opus-(5-5|5|4-8)(-|$)/i

function registerSpeed(pi) {
  const mode = process.env.AGENT_DESKTOP_SPEED
  if (mode !== 'fast' && mode !== 'ultrafast') return

  /** How this request should be served, or undefined when the model cannot honour it. */
  const tierFor = (ctx) => {
    const model = ctx?.model
    const provider = typeof model?.provider === 'string' ? model.provider : ''
    const api = typeof model?.api === 'string' ? model.api : ''
    const id = typeof model?.id === 'string' ? model.id : ''
    // Provider first: every OpenAI-compatible vendor (DeepSeek, Moonshot, Z.AI, …) reports an
    // `openai-*` api but does not implement `service_tier`.
    if (provider === 'openai' && api.startsWith('openai')) {
      if (mode === 'ultrafast' && !ULTRAFAST_MODELS.test(id)) return undefined
      return { api: 'openai', tier: mode }
    }
    if (provider === 'anthropic' && api === 'anthropic-messages') {
      // No ultrafast on Anthropic, and fast is limited to the Opus models that support it.
      if (mode !== 'fast' || !FAST_OPUS.test(id)) return undefined
      return { api: 'anthropic', tier: 'fast' }
    }
    return undefined
  }

  pi.on('before_provider_request', (event, ctx) => {
    const tier = tierFor(ctx)
    const payload = event?.payload
    if (!tier || !payload || typeof payload !== 'object') return payload
    if (tier.api === 'openai') payload.service_tier = tier.tier
    else payload.speed = 'fast'
    return payload
  })

  pi.on('before_provider_headers', (event, ctx) => {
    const tier = tierFor(ctx)
    const headers = event?.headers
    if (!tier || tier.api !== 'anthropic' || !headers || typeof headers !== 'object') return
    const key = Object.keys(headers).find((name) => name.toLowerCase() === 'anthropic-beta')
    const current = typeof headers[key] === 'string' ? headers[key] : ''
    const betas = current.split(',').map((value) => value.trim()).filter(Boolean)
    if (!betas.includes(FAST_BETA)) betas.push(FAST_BETA)
    headers[key ?? 'anthropic-beta'] = betas.join(',')
  })
}

/** Tools the user disabled in Settings, hidden from the model. */
function hiddenTools(toggles, server) {
  const tools = toggles[server]
  if (!tools || typeof tools !== 'object') return {}
  return Object.fromEntries(
    Object.entries(tools)
      .filter(([, enabled]) => enabled === false)
      .map(([tool]) => [tool, 'hidden'])
  )
}

export default function desktopMcp(pi) {  const url = process.env.AGENT_DESKTOP_MCP_URL
  const token = process.env.AGENT_DESKTOP_MCP_TOKEN ?? ''
  const coreScript = process.env.AGENT_DESKTOP_MCP_CORE_SCRIPT
  const engines = parseJson(process.env.AGENT_DESKTOP_MCP_ENGINES, [])
  const toggles = parseJson(process.env.AGENT_DESKTOP_MCP_TOGGLES, {})
  const subagentsEnabled = process.env.AGENT_DESKTOP_SUBAGENTS === '1'
  const agentsSection = process.env.AGENT_DESKTOP_AGENTS_SECTION ?? ''
  const projectText = projectSection(process.env.AGENT_DESKTOP_PROJECT, engines)
  // Rules the repository wrote for Cursor / Copilot / Gemini / Cline / Aider and friends. pi itself
  // only loads AGENTS.md and CLAUDE.md, so the desktop reads these and hands them over here.
  const conventionsText = process.env.AGENT_DESKTOP_CONVENTIONS ?? ''
  // Several engines can be alive at once (a run parked in the background). Subagent notices are
  // addressed to one session, so this process has to know which one it is.
  let sessionFile
  pi.on('session_start', (_event, ctx) => {
    try {
      sessionFile = ctx?.sessionManager?.getSessionFile?.()
    } catch {
      sessionFile = undefined
    }
  })
  // Prompt- and request-level, so neither may depend on the bridge: the built-in servers can be off.
  registerSpeed(pi)
  if (projectText || conventionsText) {
    pi.on('before_agent_start', (event) => {
      if (projectText) event.systemPromptOptions.sections[PROJECT_SECTION] = projectText
      if (conventionsText) event.systemPromptOptions.sections[CONVENTIONS_SECTION] = conventionsText
    })
  }
  if (!url) return

  if (coreScript) {
    pi.registerMcpServer(CORE_SERVER, {
      command: process.execPath,
      args: [coreScript],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        AGENT_DESKTOP_MCP_URL: url,
        AGENT_DESKTOP_MCP_TOKEN: token,
        AGENT_DESKTOP_SUBAGENTS: subagentsEnabled ? '1' : '0',
        // Root-aware file tools only exist for a session that covers several directories.
        AGENT_DESKTOP_ROOTS: process.env.AGENT_DESKTOP_ROOTS ?? '',
        AGENT_DESKTOP_SHELL: process.env.AGENT_DESKTOP_SHELL ?? ''
      },
      exposure: 'direct',
      // No timeout: pi skips arming its request timer when timeoutMs is not finite
      // (see McpClient.armTimeout), so waiting for the user never expires.
      timeout: Number.POSITIVE_INFINITY,
      toolExposure: hiddenTools(toggles, CORE_SERVER),
      description:
        'Desktop interaction tools for the Prophey window (ask_user_question: ' +
        'single choice, multi-select, or free-form input).'
    })
  }

  for (const spec of Array.isArray(engines) ? engines : []) {
    if (!spec || typeof spec.name !== 'string') continue
    const shared = {
      exposure: spec.exposure === 'direct' ? 'direct' : 'deferred',
      timeout: typeof spec.timeout === 'number' && spec.timeout > 0 ? spec.timeout : 120,
      toolExposure: { ...(spec.toolExposure ?? {}), ...hiddenTools(toggles, spec.name) },
      description: typeof spec.description === 'string' ? spec.description : undefined
    }
    if (typeof spec.url === 'string' && spec.url) {
      // Gateway endpoint on the loopback bridge: the app forwards to the real engine and controls
      // which tools exist at all.
      pi.registerMcpServer(spec.name, {
        ...shared,
        url: spec.url,
        headers: spec.headers && typeof spec.headers === 'object' ? spec.headers : {}
      })
    } else if (typeof spec.command === 'string' && spec.command) {
      // Direct stdio server, used when no gateway is configured.
      pi.registerMcpServer(spec.name, {
        ...shared,
        command: spec.command,
        args: Array.isArray(spec.args) ? spec.args : [],
        env: spec.env && typeof spec.env === 'object' ? spec.env : {}
      })
    }
  }

  let reported = ''

  /** Tell the window which tools each built-in server offers, for the per-tool switches. */
  const reportTools = () => {
    let tools
    try {
      tools = pi.getAllTools()
    } catch {
      // `new_session`, `clone`, `switch_session` and `reload` invalidate this captured ctx. A timer
      // callback that throws here kills the whole pi process, so bail out instead: the next run
      // reports again from `before_agent_start`.
      return
    }
    const servers = {}
    // A server name can contain `__` (`codegraph__Git` for a project's second repository), so the
    // split has to try the names we registered, longest first, instead of a lazy regex that would
    // file those tools under `codegraph` with a `Git__…` tool name.
    const known = [CORE_SERVER, ...(Array.isArray(engines) ? engines.map((spec) => spec?.name) : [])]
      .filter((name) => typeof name === 'string' && name)
      .sort((a, b) => b.length - a.length)
    for (const tool of tools) {
      if (typeof tool?.name !== 'string' || !tool.name.startsWith('mcp__')) continue
      const rest = tool.name.slice(5)
      const server = known.find((name) => rest.startsWith(`${name}__`))
      if (!server) continue
      const name = rest.slice(server.length + 2)
      if (!servers[server]) servers[server] = []
      servers[server].push({ name, exposure: tool.exposure })
    }
    const payload = JSON.stringify({ servers })
    if (payload === reported) return
    reported = payload
    void fetch(`${url}/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-desktop-token': token },
      body: payload
    }).catch(() => {
      reported = ''
    })
  }

  // Servers connect asynchronously, so the first report may see only part of the tool list. Report
  // again shortly after load; `reportTools` skips identical payloads.
  setTimeout(reportTools, 2500)
  setTimeout(reportTools, 8000)

  if (subagentsEnabled) void pumpEvents(pi, url, token, () => sessionFile)

  pi.on('before_agent_start', (event) => {
    // Only while the desktop MCP server is connected and its tool is declared to the model, so a
    // disabled MCP, a disabled desktop tool, a hidden tool, or a failed server leaves the prompt
    // untouched. The section is recomputed every run, and pi's section diff drops it when unset.
    const { sections } = event.systemPromptOptions
    const active = pi.getActiveTools()
    if (active.includes(ASK_TOOL)) sections[PROMPT_SECTION] = GUIDANCE
    else delete sections[PROMPT_SECTION]

    // The preset list comes from the app (agents.exposure: prompt) and is only injected while the
    // subagent tool is really declared, so a disabled feature leaves no dangling section.
    if (agentsSection && active.includes(START_SUBAGENT_TOOL)) sections[AGENTS_SECTION] = agentsSection
    else delete sections[AGENTS_SECTION]

    // Same rule for the web gateway: no search tool declared, no guidance.
    if (active.includes(WEB_SEARCH_TOOL) || active.includes(WEB_FETCH_TOOL)) {
      sections[WEB_SECTION] = WEB_GUIDANCE
    } else delete sections[WEB_SECTION]

    // Unconditional: these are about how the run uses whatever tools it has. Guidelines land in
    // `<rules>`; pushing the same strings twice would duplicate them, so check first.
    const guidelines = event.systemPromptOptions.promptGuidelines
    if (Array.isArray(guidelines)) {
      for (const rule of EXTRA_GUIDELINES) {
        if (!guidelines.includes(rule)) guidelines.push(rule)
      }
    }

    reportTools()
  })
}

/**
 * Collect subagent notices from the app and hand them to the model.
 *
 * A tool call cannot be resumed after it returned, so a finished background subagent has no way
 * back into the conversation. The app therefore queues a notice and this loop delivers it as a
 * custom message: it stays a `custom` entry in the session (not something the user said), and
 * `triggerTurn` decides whether the parent starts a turn now or reads it on its next one.
 */
async function pumpEvents(pi, url, token, sessionFile) {
  let backoff = 2000
  while (true) {
    try {
      const response = await fetch(`${url}/events?wait=25000`, {
        headers: { 'x-agent-desktop-token': token }
      })
      if (!response.ok) throw new Error(`events ${response.status}`)
      const payload = await response.json()
      backoff = 2000
      for (const event of payload.events ?? []) deliverNotice(pi, event, sessionFile())
    } catch {
      await new Promise((resolve) => setTimeout(resolve, backoff))
      backoff = Math.min(backoff * 2, 30000)
    }
  }
}

/** Windows paths differ only by slash/case, and native ids are opaque. */
function sameSession(left, right) {
  return String(left).replace(/\\/g, '/').toLowerCase() === String(right).replace(/\\/g, '/').toLowerCase()
}

function deliverNotice(pi, event, currentSession) {
  if (!event || event.type !== 'subagent_settled' || typeof event.text !== 'string') return
  // The notice belongs to one parent session; other live engines must not deliver it too.
  if (event.session && currentSession && !sameSession(event.session, currentSession)) return
  const text = [
    '<system-reminder source="agent-desktop">',
    'A subagent you started has finished a turn. This is not a message from the user.',
    event.text,
    '</system-reminder>'
  ].join('\n')
  try {
    pi.sendMessage(
      {
        customType: 'subagent_notice',
        display: true,
        content: [{ type: 'text', text }]
      },
      event.wake ? { triggerTurn: true } : {}
    )
  } catch {
    // pi is shutting down or the session is between runs; the notice stays in the app's queue.
  }
}
