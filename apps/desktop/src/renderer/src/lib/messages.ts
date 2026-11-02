export interface ToolCallView {
  id: string
  name: string
  args: string
  status: 'running' | 'done' | 'error'
  result?: string
  durationMs?: number
}

export interface MessageImage {
  data: string
  mimeType: string
}

export interface ChatItem {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  thinking?: string
  toolCalls: ToolCallView[]
  images?: MessageImage[]
  streaming?: boolean
  pending?: boolean
  error?: string
  timestamp?: number
}

/** The desktop tool that starts a run: these get a card of their own instead of a generic row. */
export function isSubagentStart(name: string): boolean {
  return name.endsWith('start_subagent')
}

/**
 * A round that only ran tools, with nothing said around them.
 *
 * One model round ends in one assistant message, so a long task arrives as a run of these. Visually
 * they are one block of work: the transcript closes the gap between them and merges their borders
 * instead of drawing a stack of separate answers.
 */
export function isToolOnly(item: ChatItem): boolean {
  return (
    item.role === 'assistant' &&
    !item.pending &&
    !item.error &&
    !item.thinking &&
    !item.text.trim() &&
    item.toolCalls.length > 0 &&
    item.toolCalls.every((call) => !isSubagentStart(call.name))
  )
}

interface RawBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
  data?: string
  mimeType?: string
}

interface RawMessage {
  role?: string
  content?: string | RawBlock[]
  timestamp?: number
  toolCallId?: string
  toolName?: string
  isError?: boolean
  customType?: string
}

function blockText(block: RawBlock): string {
  if (block.type === 'text') return block.text ?? ''
  if (block.type === 'thinking') return block.thinking ?? ''
  return ''
}

export function imagesFromBlocks(content: unknown): MessageImage[] {
  if (!Array.isArray(content)) return []
  return content
    .map((block) => block as RawBlock)
    .filter((block) => block.type === 'image' && typeof block.data === 'string' && block.data)
    .map((block) => ({
      data: block.data!,
      mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png'
    }))
}

function argsText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Custom entries the app injects; only these are shown, other custom types stay hidden. */
export const NOTICE_TYPE = 'subagent_notice'

/** Strip the `<system-reminder>` wrapper so the window shows the notice itself. */
export function noticeText(value: string): string {
  const match = /<system-reminder[^>]*>([\s\S]*?)<\/system-reminder>/i.exec(value)
  const inner = (match ? match[1] : value).trim()
  return inner.replace(/^A subagent you started has finished a turn\. This is not a message from the user\.\n?/, '').trim()
}

export function toChatItems(messages: RawMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  const toolIndex = new Map<string, ToolCallView>()

  for (const message of messages) {
    if (message.role === 'custom' || message.customType === NOTICE_TYPE) {
      if (message.customType !== NOTICE_TYPE) continue
      const text =
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? []).map(blockText).filter(Boolean).join('\n')
      if (!text.trim()) continue
      items.push({
        id: `n-${message.timestamp ?? items.length}-${items.length}`,
        role: 'system',
        text: noticeText(text),
        toolCalls: [],
        timestamp: message.timestamp
      })
      continue
    }
    if (message.role === 'user') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? []).map(blockText).filter(Boolean).join('\n')
      const images = imagesFromBlocks(message.content)
      if (!text.trim() && images.length === 0) continue
      items.push({
        id: `u-${message.timestamp ?? items.length}`,
        role: 'user',
        text,
        images: images.length > 0 ? images : undefined,
        toolCalls: [],
        timestamp: message.timestamp
      })
    } else if (message.role === 'assistant') {
      const blocks = typeof message.content === 'string' ? [] : (message.content ?? [])
      const text = textFromBlocks(message.content)
      const thinking = blocks
        .filter((block) => block.type === 'thinking')
        .map((block) => block.thinking ?? '')
        .join('\n\n')
      const toolCalls: ToolCallView[] = blocks
        .filter((block) => block.type === 'toolCall')
        .map((block) => {
          const call: ToolCallView = {
            id: block.id ?? `${block.name}-${items.length}`,
            name: block.name ?? 'tool',
            args: argsText(block.arguments),
            status: 'done'
          }
          toolIndex.set(call.id, call)
          return call
        })
      if (!text && !thinking && toolCalls.length === 0) continue
      items.push({
        id: `a-${message.timestamp ?? items.length}-${items.length}`,
        role: 'assistant',
        text,
        thinking: thinking || undefined,
        toolCalls,
        timestamp: message.timestamp
      })
    } else if (message.role === 'toolResult' && message.toolCallId) {
      const call = toolIndex.get(message.toolCallId)
      const resultText =
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? []).map(blockText).filter(Boolean).join('\n')
      if (call) {
        call.result = resultText
        call.status = message.isError ? 'error' : 'done'
      }
    }
  }

  return items
}

export function textFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const item = block as RawBlock
        if (item.type === 'text') return item.text ?? ''
        if (item.type === 'thinking') return ''
        if (item.type === 'toolCall') return ''
        return ''
      })
      .join('')
  }
  return ''
}

export function toolCallsFromBlocks(content: unknown): ToolCallView[] {
  if (!Array.isArray(content)) return []
  return content
    .map((block) => block as RawBlock)
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({
      id: block.id ?? `${block.name}`,
      name: block.name ?? 'tool',
      args: argsText(block.arguments),
      status: 'done' as const
    }))
}

export function thinkingFromBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => block as RawBlock)
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking ?? '')
    .join('\n\n')
}
