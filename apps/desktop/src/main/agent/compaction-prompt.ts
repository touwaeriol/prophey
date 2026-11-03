/**
 * How a conversation becomes the checkpoint summary that replaces it.
 *
 * The summary is the only thing the model keeps from a compacted session, so its shape decides
 * whether work can continue afterwards. Three things carry that:
 *
 *   1. **The conversation is serialised to text** and wrapped in `<conversation>` tags instead of
 *      being replayed as real messages. Handing the model its own history makes it answer the last
 *      question or keep talking; a document plus an instruction makes it summarise.
 *   2. **A fixed set of sections** (goal, current request, progress, decisions, next steps, facts).
 *      Prose summaries drift: the same session summarised twice loses different things, and
 *      "continue where we left off" has nothing to read. A checklist does not.
 *   3. **The file lists are extracted by code**, not written by the model. Paths are exactly what a
 *      model mangles when it paraphrases, and they are the single most reused fact afterwards.
 *
 * Rolling compaction keeps the old summary as `<previous-summary>` and merges into it: re-writing a
 * summary from scratch every time erases earlier facts, which is how long sessions go soft.
 */

/** Prefix of the summary message stored in the transcript; the window shows it as a user turn. */
export const SUMMARY_PREFIX = '【此前对话摘要】'

/** Enough of a tool result to see what it said, far too little to blow up the summarisation request. */
const TOOL_RESULT_CHARS = 2000
const TOOL_ARGS_CHARS = 800
const USER_CHARS = 8000
const ASSISTANT_CHARS = 8000
/** The tail is what the work continues from; whatever has to go, goes from the front. */
const KEEP_NEWEST = 12

export const SUMMARY_SYSTEM_PROMPT = `你在压缩一段编码会话的上下文，产出一份结构化的检查点摘要，交给另一个助手接着把活干完。

硬性规则：
- 只输出摘要。不要继续这段对话，不要回答对话里的任何问题，不要寒暄，不要写「好的」「以下是摘要」这类开场白，也不要用代码块把整份摘要包起来。
- 小节标题必须原样使用下面给出的标题，顺序不变。某一节确实没有内容时写「（无）」。
- 对话中出现的文件路径、命令、函数名、接口签名、配置值、错误信息一律逐字复制，不要改写、不要翻译、不要写成「大致是……的意思」。
- 不要复述工具输出的全文，只写「查了哪里、结论是什么」。
- 不写没有信息量的话（「继续进行」「保持关注」「确保正确」这类）。`

type Message = Record<string, unknown>

/**
 * The request that asks for a summary.
 *
 * `previousSummary` is the body of the newest summary, already stripped of its file lists — those
 * are rebuilt from the transcript, so letting the model carry them forward could only duplicate or
 * lose them.
 */
export function summaryRequest(options: {
  conversation: Message[]
  previousSummary?: string
  /** `/compact <提示词>`: the user's own focus for this summary. */
  instructions?: string
  /** Serialised conversation budget in characters; older messages are dropped first. */
  maxChars?: number
}): { systemPrompt: string; prompt: string } {
  const conversation = serializeConversation(options.conversation, options.maxChars)
  const focus = options.instructions?.trim()
    ? `\n\n用户对这次压缩的额外要求：${options.instructions.trim()}`
    : ''
  const prompt = options.previousSummary
    ? `<conversation>\n${conversation}\n</conversation>

<previous-summary>
${options.previousSummary}
</previous-summary>

<conversation> 里是新增的消息。把它们合并进 <previous-summary> 里已有的摘要，用下面这套完全相同的格式输出合并后的完整摘要。

合并规则：
- 旧摘要里的事实只增不减：路径、命令、错误原文、决定都不能丢，也不要换个说法重写一遍。
- 已经做完的条目从「正在进行」移到「已完成」，不要顺手删掉。
- 「当前请求」「下一步」按新消息更新；过时的就替换掉。
- 不要因为旧摘要里某一条看起来不再重要就删掉它。

${SECTIONS}${focus}`
    : `<conversation>
${conversation}
</conversation>

上面是一段编码会话。按下面这套格式输出检查点摘要：

${SECTIONS}${focus}`
  return { systemPrompt: SUMMARY_SYSTEM_PROMPT, prompt }
}

const SECTIONS = `## 目标
用户要实现什么（可能不止一件事）。

## 用户的约束与偏好
- 用户明确提出过的要求、禁止事项、风格偏好

## 当前请求
用户最后一条消息要求做什么。把关键句原文照抄，不要转述成你的话。

## 进展
### 已完成
- [x] …

### 正在进行
- [ ] …

### 受阻
- 卡在哪、缺什么

## 关键决定
- **决定**：为什么这么定

## 下一步
1. 具体到文件与动作

## 继续工作所需的事实
继续工作要用的东西，逐字列出：文件路径、要跑的命令、函数/接口签名、错误原文、版本号、配置值。`

/**
 * Turn the transcript into the document the summariser reads.
 *
 * Thinking blocks are dropped (they are not part of the work), images become a placeholder (a
 * summariser cannot use them and they cost a lot), and every tool result is clipped: one 200K-token
 * log would otherwise crowd out the conversation it is supposed to be summarising.
 */
export function serializeConversation(messages: Message[], maxChars = 0): string {
  const rendered = messages
    .map((message) => renderMessage(message))
    .filter((entry): entry is { key: string; text: string } => Boolean(entry))
  let kept = rendered
  if (maxChars > 0) {
    const size = (index: number): number => rendered[index].text.length
    const total = rendered.reduce((sum, entry) => sum + entry.text.length, 0)
    if (total > maxChars) {
      // Keep the opening request (it holds the goal) and the newest messages (they hold the work in
      // progress), then fill the rest of the budget with whatever fits going backwards.
      const keep = new Set<number>()
      if (rendered.length > 0) keep.add(0)
      let used = rendered.length > 0 ? size(0) : 0
      for (let index = rendered.length - 1; index >= Math.max(1, rendered.length - KEEP_NEWEST); index -= 1) {
        keep.add(index)
        used += size(index)
      }
      for (let index = rendered.length - KEEP_NEWEST - 1; index >= 1; index -= 1) {
        if (used + size(index) > maxChars) break
        keep.add(index)
        used += size(index)
      }
      kept = rendered.filter((_, index) => keep.has(index))
      const dropped = rendered.length - kept.length
      if (dropped > 0) {
        kept = [{ key: 'dropped', text: `（此处省略了更早的 ${dropped} 条消息）` }, ...kept]
      }
    }
  }
  return kept.map((entry) => entry.text).join('\n\n')
}

function renderMessage(message: Message): { key: string; text: string } | undefined {
  const role = typeof message.role === 'string' ? message.role : ''
  const content = message.content
  const blocks = Array.isArray(content)
    ? (content as unknown[])
    : typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : []
  // Tool results are their own shape: one clipped body, no role label, and the clip happens once.
  if (role === 'toolResult') {
    const name = typeof message.toolName === 'string' ? message.toolName : '工具'
    const failed = message.isError === true ? '（失败）' : ''
    const body = textBlocks(blocks).join('\n').trim()
    return {
      key: `toolResult:${String(message.toolCallId ?? '')}`,
      text: `### 工具结果 · ${name}${failed}\n${clip(body || '（无输出）', TOOL_RESULT_CHARS)}`
    }
  }
  const lines: string[] = []
  const calls: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const fields = block as Record<string, unknown>
    const type = typeof fields.type === 'string' ? fields.type : ''
    if (type === 'text' && typeof fields.text === 'string') {
      const text = clip(fields.text, role === 'user' ? USER_CHARS : ASSISTANT_CHARS)
      if (text) lines.push(text)
    } else if (type === 'image') {
      lines.push('[图片]')
    } else if (type === 'toolCall') {
      const name = typeof fields.name === 'string' ? fields.name : '未知工具'
      const args = fields.arguments === undefined ? '' : clip(JSON.stringify(fields.arguments), TOOL_ARGS_CHARS)
      calls.push(`→ ${name} ${args}`)
    }
    // `thinking` and provider signatures are dropped: they are not the work and cannot be reused.
  }
  const body = lines.join('\n').trim()
  const withCalls = [body, ...calls].filter(Boolean).join('\n')
  if (!withCalls) return undefined
  const label = role === 'user' ? '用户' : role === 'assistant' ? '助手' : role || '消息'
  return { key: `${role}:${String(message.timestamp ?? '')}`, text: `### ${label}\n${withCalls}` }
}

/** Text of every text block, used where a message has no structure worth keeping. */
function textBlocks(blocks: unknown[]): string[] {
  const out: string[] = []
  for (const block of blocks) {
    if (typeof block === 'string') out.push(block)
    else if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
      out.push(String((block as { text: string }).text))
    }
  }
  return out
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n…（此处省略 ${trimmed.length - max} 字符）`
}

// --- file operations, extracted instead of remembered ------------------------------------------

/** Tools whose `path` argument means "this file was read". */
const READ_TOOLS = new Set(['read_file', 'read', 'Read'])
/** Tools whose `path` argument means "this file was changed". */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multiedit',
  'multi_edit',
  'write',
  'edit',
  'Write',
  'Edit'
])

export interface FileOperations {
  read: string[]
  modified: string[]
}

/**
 * Files this part of the conversation touched.
 *
 * Only successful calls count: a rejected edit did not change anything, and a path the model never
 * actually read is worse than no path at all — the next turn would skip re-reading it.
 */
export function fileOperations(messages: Message[]): FileOperations {
  const read: string[] = []
  const modified: string[] = []
  const seenRead = new Set<string>()
  const seenModified = new Set<string>()
  for (const message of messages) {
    const content = Array.isArray(message.content) ? (message.content as unknown[]) : []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const fields = block as Record<string, unknown>
      if (fields.type !== 'toolCall' || typeof fields.name !== 'string') continue
      // MCP tools arrive as `<server>__<tool>`; only the leaf name says what the tool does.
      const name = leaf(fields.name)
      const writing = WRITE_TOOLS.has(name)
      if (!writing && !READ_TOOLS.has(name)) continue
      const args = (fields.arguments ?? {}) as Record<string, unknown>
      const raw = args.path ?? args.file_path ?? args.filePath ?? args.file
      if (typeof raw !== 'string' || !raw.trim()) continue
      const path = raw.trim()
      const key = path.split('\\').join('/').toLowerCase()
      const seen = writing ? seenModified : seenRead
      if (seen.has(key)) continue
      seen.add(key)
      ;(writing ? modified : read).push(path)
    }
  }
  return { read: read.slice(-MAX_FILES), modified: modified.slice(-MAX_FILES) }
}

const MAX_FILES = 60

/** `codegraph__codegraph_search` → `codegraph_search`; plain names come back unchanged. */
function leaf(name: string): string {
  const at = name.lastIndexOf('__')
  return at === -1 ? name : name.slice(at + 2)
}

export function formatFileOperations(operations: FileOperations): string {
  const sections: string[] = []
  if (operations.read.length > 0) {
    sections.push(`<read-files>\n${operations.read.map((file) => `- ${file}`).join('\n')}\n</read-files>`)
  }
  if (operations.modified.length > 0) {
    sections.push(
      `<modified-files>\n${operations.modified.map((file) => `- ${file}`).join('\n')}\n</modified-files>`
    )
  }
  return sections.join('\n\n')
}

/** Split the file lists back out of a stored summary so they can be rebuilt, not re-guessed. */
export function stripFileOperations(text: string): { body: string; operations: FileOperations } {
  const operations: FileOperations = { read: [], modified: [] }
  const body = text
    .replace(/<read-files>([\s\S]*?)<\/read-files>/g, (_match, inner: string) => {
      operations.read.push(...lines(inner))
      return ''
    })
    .replace(/<modified-files>([\s\S]*?)<\/modified-files>/g, (_match, inner: string) => {
      operations.modified.push(...lines(inner))
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { body, operations }
}

function lines(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean)
}

/** The summary a transcript message carries, without the marker the window paints. */
export function summaryBody(message: Message): string {
  const raw = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? (message.content as unknown[])
          .map((block) =>
            block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
              ? String((block as { text: string }).text)
              : ''
          )
          .join('')
      : ''
  return raw.startsWith(SUMMARY_PREFIX) ? raw.slice(SUMMARY_PREFIX.length).trim() : raw.trim()
}

/** Merge two file lists: the old ones stay, new ones are appended. */
export function mergeOperations(...parts: FileOperations[]): FileOperations {
  const read: string[] = []
  const modified: string[] = []
  const seen = new Set<string>()
  const push = (list: string[], value: string): void => {
    const key = value.split('\\').join('/').toLowerCase()
    if (seen.has(`${list === read ? 'r' : 'w'}:${key}`)) return
    seen.add(`${list === read ? 'r' : 'w'}:${key}`)
    list.push(value)
  }
  for (const part of parts) {
    for (const value of part.read) push(read, value)
    for (const value of part.modified) push(modified, value)
  }
  return { read, modified }
}
