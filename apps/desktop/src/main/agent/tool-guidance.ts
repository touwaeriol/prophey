import type { CoreTool } from './core-tools'

/**
 * How the model should use the tools this engine declares.
 *
 * pi gets the same kind of text from `resources/extension/desktop-mcp.js`: a `direct` MCP server
 * cannot carry a system prompt, so the extension injects sections. The own engine owns its prompt,
 * so it builds them here — and it has to say the names it really declares: pi's `mcp__` prefix does
 * not exist on this side (`codegraph__codegraph_search`, `web__web_fetch`, `ask_user_question`).
 *
 * Every block is gated on the tool actually being declared this round. Guidance for a tool the
 * user turned off is worse than no guidance: the model asks for something that is not there.
 */

const ASK_TOOL = 'ask_user_question'
const START_SUBAGENT_TOOL = 'start_subagent'

/**
 * Rules, not a section: they are about how a run uses whatever tools it has. The own engine sends
 * one model request per round and executes every call in that reply, so "one call, one thought"
 * costs an extra round trip and another round of reasoning for nothing.
 *
 * The search rule exists because bash is the slow way to look for text: `grep -rn` walks
 * node_modules and an installed app's bundles, which takes minutes on Windows and then hits
 * whatever timeout the model guessed. The ripgrep-backed tools answer in milliseconds.
 */
function rules(options: { grep?: string; find?: string; bash?: string }): string {
  const lines = [
    '需要多个互不依赖的工具调用时，在同一条回复里一起发（一条 assistant 消息带多个 toolCall）；一次只发一个会多一次往返和一轮推理。',
    '计划没被结果推翻就不要在两次调用之间重述它；只有结果与计划矛盾、出现真正的选择，或下一步不可逆时才重新推敲。'
  ]
  if (options.grep) {
    const both = options.find ? `\`${options.grep}\` / \`${options.find}\`` : `\`${options.grep}\``
    lines.push(
      `搜索用 ${both}：它们跑 ripgrep 并跳过 .gitignore 隐藏的东西（node_modules、dist、out），毫秒级返回。` +
        (options.bash
          ? `\`${options.bash}\` 里的 \`grep -rn\` / \`find\` 会扫进 node_modules，在 Windows 上要几十秒甚至超时——需要靠超时才能活下去的命令就是错的命令。`
          : '不要手动扫 node_modules。')
    )
    lines.push('不要手动搜 node_modules、.git、dist、out 或已安装应用的 resources。')
  }
  return lines.join('\n')
}

/** `ask_user_question` shows the question in the window; there is no timeout and no retry. */
function askGuidance(tool: string): string {
  return [
    `\`${tool}\` 在 Prophey 窗口里向用户提问并等待回答：不会超时，用户什么时候答都可以。`,
    '',
    '当答案会改变你要做什么时才问：需求有歧义、方案之间有真实的取舍、信息无法从仓库推断、偏好只有用户知道。' +
      '依赖这个答案、又代价高或不可逆的工作，先问再做。',
    '读代码或按现有约定就能定的、显而易见的下一步、以及为单次工具调用求许可，都不要问。',
    '给 2–4 个具体选项，每个配一句说明；多个能同时成立时设 `multiSelect`。用户总能自己输入，选项代表性优先于穷举。' +
      '面板一次只显示一个问题，所以一次调用里把要问的问完。结果说用户取消时不要编造答案，问清楚再继续。'
  ].join('\n')
}

function webGuidance(search: string, fetch: string): string {
  return [
    `\`${search}\` 返回标题、URL 和摘要；\`${fetch}\` 抓一个页面并转成 Markdown。用哪个后端由用户的设置决定，不用你选。`,
    '',
    '答案取决于比你更新的信息或本仓库之外的东西时才搜：库的版本与 changelog、API 文档、报错原文、特定版本行为、方案比较。' +
      '仓库本身能回答的不要搜。',
    `摘要不是来源：搜完用 \`${fetch}\` 打开最有希望的一两个 URL，按页面内容作答并给出 URL。页面不支持结论就直说，不要用记忆补空白。`,
    'localhost 和内网地址按设计会被拒绝；那些内容用 read_file / run_bash 拿。'
  ].join('\n')
}

function codegraphGuidance(options: {
  /** One per repository: `codegraph` for the primary root, `codegraph__<repo>` for the others. */
  prefixes: string[]
  grep?: string
  status?: string
  files?: string
}): string {
  const text = `全文和字符串搜索用 ${options.grep ? `\`${options.grep}\`` : 'read_file'}`
  return [
    `CodeGraph（\`${options.prefixes[0]}__*\`）是符号索引，只覆盖源码文件：` +
      `查定义、调用者/被调用者、改动的波及面用它，${text}。`,
    '这些工具默认不返回源码，只给符号名、签名和 `file:line`：要看实现就用 read_file 打开那一小段，不要一次拉上万字符。',
    ...(options.status || options.files
      ? [
          '索引状态和文件清单在 ' +
            [options.status, options.files]
              .filter(Boolean)
              .map((name) => `\`${name}\``)
              .join(' / ') +
            '；配置、文档和未索引的目录用 read_file。'
        ]
      : []),
    ...(options.prefixes.length > 1
      ? [
          `每个仓库一套工具（${options.prefixes.map((prefix) => `\`${prefix}__*\``).join('、')}），` +
            '按仓库选对再搜。'
        ]
      : [])
  ].join('\n')
}

function warpgrepGuidance(options: { tool: string; codegraph: boolean; grep?: string }): string {
  return [
    `\`${options.tool}\` 用自然语言描述要找的逻辑或流程（「某个功能在哪儿实现」），返回已校验存在的 \`path:start-end\`。`,
    `${options.codegraph ? '精确符号名用 CodeGraph、' : '精确符号名和'}已知字符串用 ${
      options.grep ? `\`${options.grep}\`` : 'read_file'
    }：它把一个搜索回合交给搜索模型跑完，比 grep 慢。`,
    '它读到的文件片段会发给搜索后端，敏感代码谨慎使用。'
  ].join('\n')
}

/** `codegraph__git__codegraph_search` → `codegraph__git`; the desktop tools have no server part. */
function serverPrefix(name: string): string | undefined {
  const index = name.lastIndexOf('__')
  return index > 0 ? name.slice(0, index) : undefined
}

export function toolGuidance(options: {
  /** This round's declarations: guidance only mentions what the model can actually call. */
  tools: CoreTool[]
  /** The app's subagent section (`agents.renderAgentsSection`), when subagents are switched on. */
  agentsSection?: string
}): string {
  const names = options.tools.map((tool) => tool.name)
  /** The tool's own name without the server prefix; the desktop tools have no prefix at all. */
  const leaf = (name: string) => {
    const index = name.lastIndexOf('__')
    return index > 0 ? name.slice(index + 2) : name
  }
  /** The declared name of a tool, looked up by its leaf: pi's server prefix is not ours to guess. */
  const named = (wanted: string) => names.find((name) => leaf(name) === wanted)
  const blocks = [
    rules({ grep: named('grep_files'), find: named('list_files'), bash: named('run_bash') })
  ]

  const ask = named(ASK_TOOL)
  if (ask) blocks.push(askGuidance(ask))

  const search = named('web_search')
  const fetch = named('web_fetch')
  if (search && fetch) blocks.push(webGuidance(search, fetch))

  const codegraph = [
    ...new Set(
      names
        .filter((name) => leaf(name).startsWith('codegraph_'))
        .map(serverPrefix)
        .filter((prefix): prefix is string => Boolean(prefix))
    )
  ]
  if (codegraph.length > 0) {
    blocks.push(
      codegraphGuidance({
        prefixes: codegraph,
        grep: named('grep_files'),
        status: named('codegraph_status'),
        files: named('codegraph_files')
      })
    )
  }

  const warpgrep = named('codebase_search')
  if (warpgrep) {
    blocks.push(warpgrepGuidance({ tool: warpgrep, codegraph: codegraph.length > 0, grep: named('grep_files') }))
  }

  // Presets are the app's data; this engine only decides where the text goes. Gated on the tool,
  // because a preset list without `start_subagent` is a dead end.
  const start = named(START_SUBAGENT_TOOL)
  if (options.agentsSection && start) blocks.push(options.agentsSection)

  // One blank line between topics: the prompt is read as paragraphs, not as a wall of lines.
  return blocks.filter((block) => block !== '').join('\n\n')
}
